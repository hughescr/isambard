import { logger } from '@hughescr/logger';
import { type DiscordChannelCheckpoint, discordChannelCheckpointSchema  } from './types';
import { InvariantViolationError } from '@/errors';
import type { ChannelId, ChannelScope } from '@/integrations/discord/types';
import type { OperationalStateKey, OperationalStateRead, OperationalStateStore } from '@/storage';

/**
 * Options for creating a CheckpointManager.
 */
interface CheckpointManagerOptions {
    store: OperationalStateStore
}

/** Every Discord channel checkpoint key starts with this name prefix in the `discord` partition. */
const CHANNEL_CHECKPOINT_PREFIX: OperationalStateKey = { owner: 'discord', name: 'channels/' };

/**
 * Manages Discord channel checkpoints for tracking last-seen messages.
 * Persists them in the operational-state store (src/storage/operational-state), not as memories.
 *
 * Checkpoints are keyed `{ owner: 'discord', name: 'channels/{channelId}/checkpoint' }`.
 * Each checkpoint tracks:
 * - Last seen timestamp (when the bot last processed messages)
 * - Last seen message ID (optional - the most recent message processed)
 * - Channel and guild identifiers
 *
 * @example
 * ```ts
 * const manager = new CheckpointManager({ store });
 *
 * // Initialize checkpoint for a new channel
 * const checkpoint = await manager.initializeIfMissing(channelId, guildId);
 *
 * // Update after processing messages
 * await manager.updateLastSeen(channelId, guildId, new Date().toISOString(), lastMessageId);
 *
 * // Load checkpoint to check for new messages
 * const checkpoint = await manager.load(channelId);
 * if (checkpoint) {
 *   console.log(`Last seen: ${checkpoint.lastSeenAt}`);
 * }
 * ```
 */
export class CheckpointManager {
    private readonly store: OperationalStateStore;

    /**
     * Per-channel write serialisation. Each entry is a promise chain (settled, never rejects)
     * that the next write for that channel is appended to, so a receipt write (updateLastSeen)
     * and a handled write (updateHandled) for the same channel can never interleave their
     * read/put cycles — each write's full read-modify-write completes before the next starts.
     * The store's reads are strongly consistent, so each cycle sees the previous cycle's put.
     */
    private readonly channelWriteChains = new Map<ChannelId, Promise<unknown>>();

    constructor(options: CheckpointManagerOptions) {
        this.store = options.store;
    }

    /**
     * The operational-state key for a channel checkpoint:
     * `{ owner: 'discord', name: 'channels/{channelId}/checkpoint' }`.
     *
     * @param channelId - Discord channel ID
     * @returns The checkpoint's operational-state key
     */
    private checkpointKey(channelId: ChannelId): OperationalStateKey {
        return { owner: 'discord', name: `channels/${channelId}/checkpoint` };
    }

    /**
     * Runs `fn` after every previously-queued write for `channelId` has settled (resolved or
     * rejected), and queues `fn`'s own (swallowed) completion as the new tail so the next call
     * waits for this one. The promise returned to the caller carries `fn`'s real outcome.
     */
    private serializeChannelWrites<T>(channelId: ChannelId, fn: () => Promise<T>): Promise<T> {
        const previous = this.channelWriteChains.get(channelId) ?? Promise.resolve();
        // The stored tail below always resolves, including when its caller's write rejects.
        const result = previous.then(fn);
        // eslint-disable-next-line no-restricted-syntax -- sequencing only: stored purely as a tail marker so the NEXT write for this channel waits for this one; this write's real outcome is returned to its own caller via `result`, not swallowed
        this.channelWriteChains.set(channelId, result.catch(() => undefined));
        return result;
    }

    /** Reads a channel's checkpoint from the store. */
    private async readCheckpoint(channelId: ChannelId): Promise<OperationalStateRead<DiscordChannelCheckpoint>> {
        return this.store.read(this.checkpointKey(channelId), discordChannelCheckpointSchema);
    }

    /**
     * The checkpoint a read yields, logging distinctly for corrupt JSON vs corrupt schema.
     * Returns undefined for an absent or corrupt row.
     */
    private checkpointFrom(channelId: ChannelId, read: OperationalStateRead<DiscordChannelCheckpoint>): DiscordChannelCheckpoint | undefined {
        if(read.status === 'invalid') {
            logger.warn({
                channelId,
                err: read.error,
                msg: read.reason === 'json'
                    ? 'Checkpoint data is corrupt: failed to parse JSON'
                    : 'Checkpoint data is corrupt: schema validation failed',
            });
        }
        return read.value;
    }

    /**
     * Loads the checkpoint for a channel.
     *
     * @param channelId - Discord channel ID to load checkpoint for
     * @returns The checkpoint data, or undefined if not found
     *
     * @example
     * ```ts
     * const checkpoint = await manager.load(channelId);
     * if (checkpoint) {
     *   const lastSeen = new Date(checkpoint.lastSeenAt);
     *   console.log(`Last seen: ${lastSeen.toLocaleString()}`);
     * }
     * ```
     */
    async load(channelId: ChannelId): Promise<DiscordChannelCheckpoint | undefined> {
        return this.checkpointFrom(channelId, await this.readCheckpoint(channelId));
    }

    /**
     * Saves a checkpoint for a channel (an idempotent upsert — no pre-read).
     *
     * @param checkpoint - The checkpoint data to save
     *
     * @example
     * ```ts
     * const checkpoint: DiscordChannelCheckpoint = {
     *   service: 'discord',
     *   channelId,
     *   guildId,
     *   lastSeenAt: new Date().toISOString(),
     *   lastSeenMessageId: messageId,
     *   updatedAt: new Date().toISOString(),
     * };
     * await manager.save(checkpoint);
     * ```
     */
    async save(checkpoint: DiscordChannelCheckpoint): Promise<void> {
        await this.store.put(this.checkpointKey(checkpoint.channelId), checkpoint);
    }

    /**
     * Initializes a checkpoint if one doesn't exist.
     * Sets lastSeenAt to current time (no catchup needed for new channels).
     *
     * @param channelId - Discord channel ID
     * @param guildId - channel scope where the channel exists
     * @returns The existing or newly created checkpoint
     *
     * @example
     * ```ts
     * // On bot startup, initialize checkpoints for all channels
     * const checkpoint = await manager.initializeIfMissing(channelId, guildId);
     * console.log(`Checkpoint initialized: ${checkpoint.lastSeenAt}`);
     * ```
     */
    async initializeIfMissing(
        channelId: ChannelId,
        guildId: ChannelScope
    ): Promise<DiscordChannelCheckpoint> {
        const existing = await this.load(channelId);
        if(existing) {
            return existing;
        }

        const now = new Date().toISOString();
        const checkpoint: DiscordChannelCheckpoint = {
            service:    'discord',
            channelId,
            guildId,
            lastSeenAt: now,
            updatedAt:  now,
        };

        await this.save(checkpoint);
        return checkpoint;
    }

    /**
     * Updates the lastSeenAt and optionally lastSeenMessageId for a channel.
     * Creates the checkpoint if it doesn't exist.
     *
     * Read-modify-write: reads the existing checkpoint first so an in-flight `handled` watermark
     * (see {@link updateHandled}) is preserved across a receipt-time lastSeen update rather than
     * being clobbered by a checkpoint object that doesn't carry it. Serialised per channel with
     * {@link serializeChannelWrites} so this cannot interleave with a concurrent updateHandled
     * for the same channel.
     *
     * @param channelId - Discord channel ID
     * @param guildId - channel scope where the channel exists
     * @param lastSeenAt - ISO 8601 timestamp of last seen time
     * @param lastSeenMessageId - Optional message ID of last seen message
     * @returns The updated checkpoint
     *
     * @example
     * ```ts
     * // After processing messages in a channel
     * const latestMessage = messages[messages.length - 1];
     * await manager.updateLastSeen(
     *   channelId,
     *   guildId,
     *   latestMessage.timestamp,
     *   latestMessage.id
     * );
     * ```
     */
    async updateLastSeen(
        channelId: ChannelId,
        guildId: ChannelScope,
        lastSeenAt: string,
        lastSeenMessageId?: string
    ): Promise<DiscordChannelCheckpoint> {
        return this.serializeChannelWrites(channelId, async () => {
            const existingCheckpoint = await this.load(channelId);

            const checkpoint: DiscordChannelCheckpoint = {
                service:   'discord',
                channelId,
                guildId,
                lastSeenAt,
                lastSeenMessageId,
                updatedAt: new Date().toISOString(),
                handled:   existingCheckpoint?.handled,
            };

            await this.save(checkpoint);
            return checkpoint;
        });
    }

    /**
     * Advances the per-channel HANDLED watermark: the newest message whose batch has finished
     * being handled (sent, `@@NO_RESPONSE@@` skip, or outbox-queued). Read-modify-write,
     * preserving lastSeenAt/lastSeenMessageId/guildId from the existing checkpoint.
     *
     * No-ops (returns the existing checkpoint unchanged) when the existing watermark's messageId
     * is already >= the new one (compared numerically as Discord snowflakes, not lexically), so
     * an older batch that finishes handling later cannot regress a newer watermark.
     *
     * Throws {@link InvariantViolationError} when no checkpoint exists for the channel —
     * receipt (updateLastSeen/initializeIfMissing) always initialises it first, so a missing
     * checkpoint here indicates a logic error in the caller — or when the stored one is corrupt.
     *
     * @param channelId - Discord channel ID
     * @param messageId - Discord message ID (snowflake) of the newest message in the handled batch
     * @param at - ISO 8601 timestamp when the batch was handled
     * @returns The updated (or, on no-op, existing) checkpoint
     */
    async updateHandled(channelId: ChannelId, messageId: string, at: string): Promise<DiscordChannelCheckpoint> {
        return this.serializeChannelWrites(channelId, async () => {
            const read = await this.readCheckpoint(channelId);
            if(read.status === 'absent') {
                throw new InvariantViolationError('updateHandled', `no checkpoint exists for channel ${channelId}; receipt must initialise it first`);
            }

            const existingCheckpoint = this.checkpointFrom(channelId, read);
            if(!existingCheckpoint) {
                throw new InvariantViolationError('updateHandled', `checkpoint for channel ${channelId} is corrupt`);
            }

            if(existingCheckpoint.handled && BigInt(existingCheckpoint.handled.messageId) >= BigInt(messageId)) {
                return existingCheckpoint;
            }

            const checkpoint: DiscordChannelCheckpoint = {
                ...existingCheckpoint,
                handled:   { messageId, at },
                updatedAt: new Date().toISOString(),
            };

            await this.save(checkpoint);
            return checkpoint;
        });
    }

    /**
     * Lists all channel checkpoints in the `discord` operational-state partition. The partition
     * holds only checkpoints, and the store skips (and logs) any row that fails to decode.
     *
     * Legacy `/state/services/discord/channels/...` memory rows are not listed: a channel whose
     * checkpoint has not been rewritten since the operational-state store shipped is not
     * replayed until its next write (the legacy listing never found nested checkpoints either).
     *
     * @returns Array of all stored checkpoints
     *
     * @example
     * ```ts
     * const allCheckpoints = await manager.listAll();
     * console.log(`Tracking ${allCheckpoints.length} channels`);
     * for (const checkpoint of allCheckpoints) {
     *   console.log(`${checkpoint.channelId}: ${checkpoint.lastSeenAt}`);
     * }
     * ```
     */
    async listAll(): Promise<DiscordChannelCheckpoint[]> {
        return this.store.listByPrefix(CHANNEL_CHECKPOINT_PREFIX, discordChannelCheckpointSchema);
    }
}
