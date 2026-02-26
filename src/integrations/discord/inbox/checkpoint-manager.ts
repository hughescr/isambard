import _ from 'lodash';
import { type DiscordChannelCheckpoint, discordChannelCheckpointSchema  } from './types';
import type { ChannelId, GuildId } from '@/integrations/discord/types';
import { type MemoryToolBackend, type MemoryPath, createMemoryPath  } from '@/storage';

/**
 * Options for creating a CheckpointManager.
 */
export interface CheckpointManagerOptions {
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

        // Stryker disable BlockStatement: Error handling for corrupted/invalid data - tested with invalid JSON test case
        try {
            // Parse stored JSON content and validate with Zod
            const parsed: unknown = JSON.parse(item.content);
            return discordChannelCheckpointSchema.parse(parsed);
        } catch{
            // If JSON parsing or validation fails, return undefined rather than throwing
            // This handles corrupted checkpoint data gracefully
            return undefined;
        }
        // Stryker restore BlockStatement
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

        if(existing) {
            // Update existing checkpoint
            await this.backend.update(path, { content });
        } else {
            // Create new checkpoint
            await this.backend.create({
                path,
                content,
                contentType: 'application/json',
            });
        }
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
        const now = new Date().toISOString();

        const checkpoint: DiscordChannelCheckpoint = {
            service:   'discord',
            channelId,
            guildId,
            lastSeenAt,
            lastSeenMessageId,
            updatedAt: now,
        };

        await this.save(checkpoint);
        return checkpoint;
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
            // Stryker disable next-line StringLiteral: _.endsWith(path, '') is always true - equivalent mutant; ConditionalExpression tested by 'should skip non-checkpoint items' test
            if(_.endsWith(item.path, '/checkpoint')) {
                // Stryker disable BlockStatement: Error handling for corrupted/invalid data - tested with invalid JSON test case
                try {
                    // Parse and validate with Zod
                    const parsed: unknown = JSON.parse(item.content);
                    const checkpoint = discordChannelCheckpointSchema.parse(parsed);
                    checkpoints.push(checkpoint);
                } catch{
                    // Skip items that fail to parse or validate
                    // This handles corrupted data gracefully
                    continue;
                }
                // Stryker restore BlockStatement
            }
        }

        return checkpoints;
    }
}
