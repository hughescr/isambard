import { logger } from '@hughescr/logger';
import { type DiscordChannelCheckpoint, discordChannelCheckpointSchema  } from './types';
import { InvariantViolationError } from '@/errors';
import type { ChannelId, GuildId } from '@/integrations/discord/types';
import { type MemoryToolBackend, type MemoryPath, createMemoryPath  } from '@/storage';

/**
 * Options for creating a CheckpointManager.
 */
interface CheckpointManagerOptions {
    backend: MemoryToolBackend
}

/**
 * Manages Discord channel checkpoints for tracking last-seen messages.
 * Uses the memory tool backend for persistent storage.
 *
 * Checkpoints are stored at: `/state/services/discord/channels/{channelId}/checkpoint`
 * Each checkpoint tracks:
 * - Last seen timestamp (when the bot last processed messages)
 * - Last seen message ID (optional - the most recent message processed)
 * - Channel and guild identifiers
 *
 * @example
 * ```ts
 * const manager = new CheckpointManager({ backend });
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
    private readonly backend: MemoryToolBackend;

    /**
     * Per-channel write serialisation. Each entry is a promise chain (settled, never rejects)
     * that the next write for that channel is appended to, so a receipt write (updateLastSeen)
     * and a handled write (updateHandled) for the same channel can never interleave their
     * get/update cycles — each write's full read-modify-write completes before the next starts.
     */
    private readonly channelWriteChains = new Map<ChannelId, Promise<unknown>>();

    constructor(options: CheckpointManagerOptions) {
        this.backend = options.backend;
    }

    /**
     * Gets the memory path for a channel checkpoint.
     * Path format: `/state/services/discord/channels/{channelId}/checkpoint`
     *
     * @param channelId - Discord channel ID
     * @returns Validated memory path for the checkpoint
     */
    private getCheckpointPath(channelId: ChannelId): MemoryPath {
        return createMemoryPath(`/state/services/discord/channels/${channelId}/checkpoint`);
    }

    /**
     * Runs `fn` after every previously-queued write for `channelId` has settled (resolved or
     * rejected), and queues `fn`'s own (swallowed) completion as the new tail so the next call
     * waits for this one. The promise returned to the caller carries `fn`'s real outcome.
     */
    private serializeChannelWrites<T>(channelId: ChannelId, fn: () => Promise<T>): Promise<T> {
        const previous = this.channelWriteChains.get(channelId) ?? Promise.resolve();
        // eslint-disable-next-line no-restricted-syntax -- sequencing only: a prior write's failure must not block this write from starting; that prior write's own error already propagated to its own caller via the promise `serializeChannelWrites` returned for it
        const settled = previous.catch(() => undefined);
        const result = settled.then(fn);
        // eslint-disable-next-line no-restricted-syntax -- sequencing only: stored purely as a tail marker so the NEXT write for this channel waits for this one; this write's real outcome is returned to its own caller via `result`, not swallowed
        this.channelWriteChains.set(channelId, result.catch(() => undefined));
        return result;
    }

    /**
     * Parses and validates a raw checkpoint item's content, logging distinctly for corrupt JSON
     * vs corrupt schema. Returns undefined for either failure.
     */
    private parseCheckpoint(channelId: ChannelId, content: string): DiscordChannelCheckpoint | undefined {
        let rawParsed: unknown;
        // Stryker disable BlockStatement: catch block is equivalent to empty — both paths return undefined via schema failure, differing only in which warn message fires
        try {
            rawParsed = JSON.parse(content);
        } catch (error) {
            // Stryker disable next-line ObjectLiteral: Logger warn object for observability
            logger.warn({
                channelId,
                err: error,
                // Stryker disable next-line StringLiteral: log message is informational only
                msg: 'Checkpoint data is corrupt: failed to parse JSON',
            });
            return undefined;
        }
        // Stryker restore BlockStatement

        const parseResult = discordChannelCheckpointSchema.safeParse(rawParsed);
        if(!parseResult.success) {
            // Stryker disable next-line ObjectLiteral: Logger warn object for observability
            logger.warn({
                channelId,
                issues: parseResult.error.issues,
                // Stryker disable next-line StringLiteral: log message is informational only
                msg:    'Checkpoint data is corrupt: schema validation failed',
            });
            return undefined;
        }

        return parseResult.data;
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
        const path = this.getCheckpointPath(channelId);
        const item = await this.backend.get(path);

        if(!item) {
            return undefined;
        }

        return this.parseCheckpoint(channelId, item.content);
    }

    /**
     * Saves a checkpoint for a channel.
     * Creates or updates the checkpoint as needed.
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
        const path = this.getCheckpointPath(checkpoint.channelId);
        const content = JSON.stringify(checkpoint);

        // Check if checkpoint exists
        const existing = await this.backend.get(path);

        await (existing
            ? this.backend.update(path, { content })
            : this.backend.create({
                path,
                content,
                contentType: 'application/json',
            }));
    }

    /**
     * Initializes a checkpoint if one doesn't exist.
     * Sets lastSeenAt to current time (no catchup needed for new channels).
     *
     * @param channelId - Discord channel ID
     * @param guildId - Guild ID or 'DM' for direct messages
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
        guildId: GuildId | 'DM'
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
     * Read-modify-write: loads the existing item first so an in-flight `handled` watermark
     * (see {@link updateHandled}) is preserved across a receipt-time lastSeen update rather than
     * being clobbered by a checkpoint object that doesn't carry it. Serialised per channel with
     * {@link serializeChannelWrites} so this cannot interleave with a concurrent updateHandled
     * for the same channel.
     *
     * @param channelId - Discord channel ID
     * @param guildId - Guild ID or 'DM' for direct messages
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
        guildId: GuildId | 'DM',
        lastSeenAt: string,
        lastSeenMessageId?: string
    ): Promise<DiscordChannelCheckpoint> {
        return this.serializeChannelWrites(channelId, async () => {
            const path = this.getCheckpointPath(channelId);
            const existingItem = await this.backend.get(path);
            const existingCheckpoint = existingItem ? this.parseCheckpoint(channelId, existingItem.content) : undefined;

            const checkpoint: DiscordChannelCheckpoint = {
                service:   'discord',
                channelId,
                guildId,
                lastSeenAt,
                lastSeenMessageId,
                updatedAt: new Date().toISOString(),
                handled:   existingCheckpoint?.handled,
            };

            const content = JSON.stringify(checkpoint);
            await (existingItem
                ? this.backend.update(path, { content })
                : this.backend.create({ path, content, contentType: 'application/json' }));

            return checkpoint;
        });
    }

    /**
     * Advances the per-channel HANDLED watermark: the newest message whose batch has finished
     * being handled (sent, `@@NO_RESPONSE@@` skip, or outbox-queued). Read-modify-write,
     * preserving lastSeenAt/lastSeenMessageId/guildId from the existing item.
     *
     * No-ops (returns the existing checkpoint unchanged) when the existing watermark's messageId
     * is already >= the new one (compared numerically as Discord snowflakes, not lexically), so
     * an older batch that finishes handling later cannot regress a newer watermark.
     *
     * Throws {@link InvariantViolationError} when no checkpoint item exists for the channel —
     * receipt (updateLastSeen/initializeIfMissing) always initialises the item first, so a
     * missing item here indicates a logic error in the caller.
     *
     * @param channelId - Discord channel ID
     * @param messageId - Discord message ID (snowflake) of the newest message in the handled batch
     * @param at - ISO 8601 timestamp when the batch was handled
     * @returns The updated (or, on no-op, existing) checkpoint
     */
    async updateHandled(channelId: ChannelId, messageId: string, at: string): Promise<DiscordChannelCheckpoint> {
        return this.serializeChannelWrites(channelId, async () => {
            const path = this.getCheckpointPath(channelId);
            const existingItem = await this.backend.get(path);
            if(!existingItem) {
                throw new InvariantViolationError('updateHandled', `no checkpoint exists for channel ${channelId}; receipt must initialise it first`);
            }

            const existingCheckpoint = this.parseCheckpoint(channelId, existingItem.content);
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

            await this.backend.update(path, { content: JSON.stringify(checkpoint) });
            return checkpoint;
        });
    }

    /**
     * Lists all channel checkpoints.
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
        const result = await this.backend.list('/state/services/discord/channels');
        const checkpoints: DiscordChannelCheckpoint[] = [];

        for(const item of result.items) {
            // Only include checkpoint files (not other items in channel directories) - tested with non-checkpoint path test
            // Stryker disable next-line StringLiteral: path.endsWith('') is always true - equivalent mutant; ConditionalExpression tested by 'should skip non-checkpoint items' test
            if(item.path.endsWith('/checkpoint')) {
                // Stryker disable BlockStatement: Error handling for corrupted/invalid data - tested with invalid JSON test case
                try {
                    // Parse and validate with Zod
                    const parsed: unknown = JSON.parse(item.content);
                    const checkpoint = discordChannelCheckpointSchema.parse(parsed);
                    checkpoints.push(checkpoint);
                } catch{
                    // Silent: malformed or schema-invalid checkpoint data (truncated write,
                    // format migration). Skipping the item and continuing means the inbox
                    // will re-scan that channel from scratch rather than crashing startup.
                    // The channel will catch up normally on the next session.
                    continue;
                }
                // Stryker restore BlockStatement
            }
        }

        return checkpoints;
    }
}
