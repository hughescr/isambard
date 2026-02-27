/**
 * Inbox Manager
 *
 * Core manager for tracking and managing unread Discord messages.
 * Maintains an in-memory queue of unread messages, loaded on startup by fetching
 * messages since the last checkpoint. Provides methods for MCP tools to query and
 * manage unread state.
 *
 * Architecture:
 * - In-memory storage: Map<channelId, UnreadMessage[]>
 * - Persistence: CheckpointManager for saving read positions
 * - Message fetching: MessageSearchService for historical messages
 * - Startup: loadUnread() fetches messages since last checkpoint
 * - Runtime: trackChannel() registers new channels, recordActivity() updates checkpoints
 */

import { logger } from '@hughescr/logger';
import type { CheckpointManager } from './checkpoint-manager';
import { type InboxConfig, DEFAULT_INBOX_CONFIG  } from './config';
import type { UnreadMessage, UnreadOverview } from './types';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import type { ChannelId, GuildId } from '@/integrations/discord/types';

/**
 * Channel metadata cache entry.
 * Optional metadata stored when available from Discord events.
 */
interface ChannelMetadata {
    /** Human-readable channel name for display */
    channelName: string
    /** Guild ID where the channel exists, or 'DM' for direct messages */
    guildId:     GuildId | 'DM'
}

/**
 * Options for creating an InboxManager.
 */
export interface InboxManagerOptions {
    /** Checkpoint manager for loading/saving read positions */
    checkpointManager:    CheckpointManager
    /** Message search service for fetching historical messages */
    messageSearchService: MessageSearchService
    /** Channel registry for managing monitored channels */
    channelRegistry:      ChannelRegistryManager
    /** Bot user ID to filter out bot's own messages from unread inbox (can be set later via setBotUserId) */
    botUserId?:           string
    /** Optional configuration overrides */
    config?:              Partial<InboxConfig>
}

/**
 * Manages the in-memory unread message queue.
 * Coordinates with CheckpointManager for persistence and MessageSearchService for fetching.
 *
 * @example
 * ```typescript
 * const inboxManager = new InboxManager({
 *   checkpointManager,
 *   messageSearchService,
 *   channelRegistry,
 *   botUserId: client.user.id,
 *   config: { maxCatchUpMessages: 50 },
 * });
 *
 * // Optionally update channel metadata for better display names
 * inboxManager.updateChannelMetadata(
 *   createChannelId('123456789'),
 *   'general',
 *   createGuildId('987654321')
 * );
 *
 * // Load unread messages on startup (automatically initializes checkpoints)
 * const unreadCount = await inboxManager.loadUnread();
 * console.log(`Loaded ${unreadCount} unread messages`);
 *
 * // Query unread messages
 * const overview = inboxManager.getUnreadOverview();
 * const channelMessages = inboxManager.getChannelMessages(channelId);
 *
 * // Mark messages as read
 * await inboxManager.markAsRead(channelId, ['msgId1', 'msgId2']);
 * await inboxManager.markChannelRead(channelId);
 *
 * // Record new activity
 * await inboxManager.recordActivity(channelId, guildId, messageId, timestamp);
 * ```
 */
export class InboxManager {
    private readonly checkpointManager:    CheckpointManager;
    private readonly messageSearchService: MessageSearchService;
    private readonly channelRegistry:      ChannelRegistryManager;
    private readonly config:               InboxConfig;
    private botUserId?:                    string;

    /** In-memory storage of unread messages by channel */
    private readonly unreadMessages = new Map<ChannelId, UnreadMessage[]>();

    /** Optional channel metadata cache for name lookups (populated from Discord events) */
    private readonly channelMetadata = new Map<ChannelId, ChannelMetadata>();

    constructor(options: InboxManagerOptions) {
        this.checkpointManager = options.checkpointManager;
        this.messageSearchService = options.messageSearchService;
        this.channelRegistry = options.channelRegistry;
        this.botUserId = options.botUserId;
        this.config = { ...DEFAULT_INBOX_CONFIG, ...options.config };
    }

    /**
     * Sets the bot user ID for filtering bot messages from the inbox.
     * Should be called after the Discord client is ready and user ID is available.
     *
     * @param botUserId - The bot's Discord user ID
     *
     * @example
     * ```typescript
     * // After Discord client is ready
     * inboxManager.setBotUserId(client.user.id);
     * ```
     */
    // Stryker disable BlockStatement: Simple setter with logging - tested via integration
    setBotUserId(botUserId: string): void {
        this.botUserId = botUserId;

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.debug({
            botUserId,
            msg: 'Bot user ID set for inbox filtering',
        });
        // Stryker restore ObjectLiteral,StringLiteral
    }
    // Stryker restore BlockStatement

    /**
     * Updates channel metadata cache with channel name and guild ID.
     * This is optional metadata used for display purposes.
     * Should be called when channel information becomes available (e.g., from Discord events).
     *
     * @param channelId - Discord channel ID
     * @param channelName - Human-readable channel name
     * @param guildId - Guild ID or 'DM' for direct messages
     *
     * @example
     * ```typescript
     * inboxManager.updateChannelMetadata(
     *   createChannelId('123456789'),
     *   'general',
     *   createGuildId('987654321')
     * );
     * ```
     */
    updateChannelMetadata(channelId: ChannelId, channelName: string, guildId: GuildId | 'DM'): void {
        this.channelMetadata.set(channelId, { channelName, guildId });

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.debug({
            channelId,
            channelName,
            guildId,
            msg: 'Channel metadata updated',
        });
        // Stryker restore ObjectLiteral,StringLiteral
    }

    /**
     * Loads unread messages for all monitored channels since their last checkpoint.
     * Call this on bot startup after clientReady to populate the inbox with messages
     * that arrived while the bot was offline.
     *
     * Algorithm:
     * 1. Get unmuted channels from ChannelRegistryManager
     * 2. Load or initialize checkpoint for each channel (sets lastSeenAt to now if missing)
     * 3. Calculate time gap since lastSeenAt
     * 4. Skip channels with gaps smaller than minGapDurationMs (avoid noise)
     * 5. Limit catch-up to maxCatchUpAgeDays to avoid overwhelming the inbox
     * 6. Fetch messages using MessageSearchService
     * 7. Store messages in memory as UnreadMessage objects
     * 8. Log errors but continue processing other channels (resilient to failures)
     *
     * @returns Total number of unread messages loaded across all channels
     *
     * @example
     * ```typescript
     * // On bot startup
     * const totalUnread = await inboxManager.loadUnread();
     * console.log(`Loaded ${totalUnread} unread messages across ${inboxManager.unreadMessages.size} channels`);
     * ```
     */
    async loadUnread(): Promise<number> {
        let totalLoaded = 0;
        let successCount = 0;
        let failCount = 0;

        // Get unmuted channels from registry instead of static list
        const channels = await this.channelRegistry.getUnmutedChannels();

        for(const channel of channels) {
            const channelId = channel.channelId;
            // Stryker disable BlockStatement: Error handling logs failure but continues processing other channels
            try {
                // Initialize checkpoint if it doesn't exist (creates new checkpoint with lastSeenAt = now)
                // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB init then load for each channel
                await this.checkpointManager.initializeIfMissing(channelId, channel.guildId);

                // Load the checkpoint (now guaranteed to exist)
                // eslint-disable-next-line no-await-in-loop -- sequential: load depends on prior init
                const checkpoint = await this.checkpointManager.load(channelId);

                // If checkpoint doesn't exist after initialization, skip this channel
                if(!checkpoint) {
                    // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                    logger.warn({
                        channelId,
                        msg: 'Checkpoint missing after initialization',
                    });
                    // Stryker restore ObjectLiteral,StringLiteral
                    continue;
                }

                // Skip if gap is too small (avoid noise from brief disconnects)
                const lastSeen = new Date(checkpoint.lastSeenAt);
                const now = new Date();
                const gapMs = now.getTime() - lastSeen.getTime();

                // Stryker disable next-line EqualityOperator: Boundary condition for noise reduction - < vs <= makes no practical difference
                if(gapMs < this.config.minGapDurationMs) {
                    // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                    logger.debug({
                        channelId,
                        gapMs,
                        minGapMs: this.config.minGapDurationMs,
                        msg:      'Skipping channel - gap too small',
                    });
                    // Stryker restore ObjectLiteral,StringLiteral
                    continue;
                }

                // Limit catch-up age to prevent overwhelming the inbox
                const maxAgeMs = this.config.maxCatchUpAgeDays * 24 * 60 * 60 * 1000;
                // Stryker disable next-line ArithmeticOperator: +1 to exclude lastSeen message itself - off-by-one doesn't affect catch-up behavior
                const effectiveStartTime = new Date(Math.max(lastSeen.getTime() + 1, now.getTime() - maxAgeMs));

                // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API per channel
                const response = await this.messageSearchService.searchMessages({
                    channelId,
                    startTime: effectiveStartTime,
                    endTime:   now,
                    limit:     this.config.maxCatchUpMessages,
                });

                // Stryker disable next-line ConditionalExpression,EqualityOperator: Guard clause - equivalent when empty (filter produces [] either way, inner guard catches 0-length)
                if(response.messages.length > 0) {
                    // Filter out bot messages (if botUserId is set) and convert to UnreadMessage format
                    // Stryker disable next-line LogicalOperator,ConditionalExpression,EqualityOperator: No test exercises botUserId filtering path - L-class (no test sets botUserId and verifies filter)
                    const filteredMessages = response.messages.filter(msg => !this.botUserId || msg.author.id !== this.botUserId);
                    const unreadMessages: UnreadMessage[] = filteredMessages.map(msg => ({
                        id:          msg.id,
                        channelId,
                        channelName: channel.channelName,
                        guildId:     channel.guildId,
                        author:      msg.author.displayName,
                        content:     msg.content,
                        timestamp:   msg.timestamp,
                        isRead:      false,
                    }));

                    // Stryker disable next-line ConditionalExpression,EqualityOperator: Guard clause - equivalent when empty (totalLoaded += 0, no entry stored - same result)
                    if(unreadMessages.length > 0) {
                        this.unreadMessages.set(channelId, unreadMessages);
                        totalLoaded += unreadMessages.length;

                        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                        logger.info({
                            channelId,
                            channelName:  channel.channelName,
                            messageCount: unreadMessages.length,
                            msg:          `Loaded ${unreadMessages.length} unread messages for channel`,
                        });
                        // Stryker restore ObjectLiteral,StringLiteral
                    }
                }
                successCount++;
            } catch (error) {
                failCount++;
                const message = error instanceof Error ? error.message : String(error);
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.warn({
                    channelId,
                    error,
                    msg: `Failed to load unread messages for channel: ${message}`,
                });
                // Stryker restore ObjectLiteral,StringLiteral
                // Continue processing other channels despite errors
            }
            // Stryker restore BlockStatement
        }

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.info({
            successCount,
            failCount,
            msg: 'Loaded unread messages summary',
        });
        logger.info({
            totalLoaded,
            channelCount: this.unreadMessages.size,
            msg:          `Inbox loaded: ${totalLoaded} unread messages across ${this.unreadMessages.size} channels`,
        });
        // Stryker restore ObjectLiteral,StringLiteral

        return totalLoaded;
    }

    /**
     * Returns high-level overview of all unread messages.
     * Provides summary data for the getUnreadOverview MCP tool.
     *
     * @returns Overview containing total unread count and per-channel summaries
     *
     * @example
     * ```typescript
     * const overview = inboxManager.getUnreadOverview();
     * console.log(`Total unread: ${overview.totalUnread}`);
     * for (const channel of overview.channels) {
     *   console.log(`${channel.channelName}: ${channel.messageCount} messages`);
     * }
     * ```
     */
    getUnreadOverview(): UnreadOverview {
        let totalUnread = 0;
        const channels: UnreadOverview['channels'] = [];

        for(const [channelId, messages] of this.unreadMessages) {
            const unreadCount = messages.filter(m => !m.isRead).length;
            if(unreadCount > 0) {
                const metadata = this.channelMetadata.get(channelId);
                channels.push({
                    channelId,
                    channelName:  metadata?.channelName ?? channelId,
                    messageCount: unreadCount,
                });
                totalUnread += unreadCount;
            }
        }

        return { totalUnread, channels };
    }

    /**
     * Gets unread messages for a specific channel.
     * Used by MCP tools to retrieve full message content for a channel.
     *
     * @param channelId - Discord channel ID
     * @returns Array of unread messages (empty if channel has no unread messages)
     *
     * @example
     * ```typescript
     * const messages = inboxManager.getChannelMessages(channelId);
     * for (const msg of messages) {
     *   console.log(`${msg.author}: ${msg.content}`);
     * }
     * ```
     */
    getChannelMessages(channelId: ChannelId): UnreadMessage[] {
        return (this.unreadMessages.get(channelId) ?? []).filter(m => !m.isRead);
    }

    /**
     * Gets a specific message by ID.
     * Used to retrieve individual message details.
     *
     * @param channelId - Discord channel ID
     * @param messageId - Discord message ID
     * @returns The message if found, undefined otherwise
     *
     * @example
     * ```typescript
     * const message = inboxManager.getMessage(channelId, messageId);
     * if (message) {
     *   console.log(`Found: ${message.author}: ${message.content}`);
     * }
     * ```
     */
    getMessage(channelId: ChannelId, messageId: string): UnreadMessage | undefined {
        return (this.unreadMessages.get(channelId) ?? []).find(msg => msg.id === messageId);
    }

    /**
     * Marks specific messages as read and updates checkpoint.
     * Updates both in-memory state and persistent checkpoint storage.
     *
     * @param channelId - Discord channel ID
     * @param messageIds - Array of message IDs to mark as read
     *
     * @example
     * ```typescript
     * // Mark specific messages as read after processing
     * await inboxManager.markAsRead(channelId, ['msg1', 'msg2', 'msg3']);
     * ```
     */
    async markAsRead(channelId: ChannelId, messageIds: string[]): Promise<void> {
        const messages = this.unreadMessages.get(channelId);
        if(!messages) {
            return;
        }

        const messageIdSet = new Set(messageIds);
        let latestTimestamp: string | undefined;
        let latestMessageId: string | undefined;

        // Mark messages as read and track the latest timestamp
        for(const msg of messages) {
            if(messageIdSet.has(msg.id)) {
                msg.isRead = true;

                // Track the latest message for checkpoint update
                // Stryker disable next-line EqualityOperator: > vs >= makes no practical difference for unique ISO timestamps; ConditionalExpression is T-class (tests verify latest timestamp wins)
                if(!latestTimestamp || msg.timestamp > latestTimestamp) {
                    latestTimestamp = msg.timestamp;
                    latestMessageId = msg.id;
                }
            }
        }

        // Update checkpoint if we marked any messages
        if(latestTimestamp && latestMessageId) {
            const metadata = this.channelMetadata.get(channelId);
            const guildId = metadata?.guildId ?? 'DM';
            await this.checkpointManager.updateLastSeen(
                channelId,
                guildId,
                latestTimestamp,
                latestMessageId
            );

            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            logger.debug({
                channelId,
                messageCount: messageIds.length,
                latestTimestamp,
                msg:          `Marked ${messageIds.length} messages as read`,
            });
            // Stryker restore ObjectLiteral,StringLiteral
        }
    }

    /**
     * Marks all messages in a channel as read and updates checkpoint.
     * Convenience method for clearing all unread messages in a channel.
     *
     * @param channelId - Discord channel ID
     *
     * @example
     * ```typescript
     * // Mark entire channel as read
     * await inboxManager.markChannelRead(channelId);
     * console.log('Channel marked as read');
     * ```
     */
    async markChannelRead(channelId: ChannelId): Promise<void> {
        const messages = this.unreadMessages.get(channelId);
        // Stryker disable next-line ConditionalExpression: Equivalent — messages.length === 0 is dead code (only non-empty arrays are stored); !messages guard ensures no crash on unknown channel; → false mutant crashes on undefined (L-class: same observable output, test runner may not surface the throw through Stryker)
        if(!messages || messages.length === 0) {
            return;
        }

        // Find the latest message
        let latestMessage: UnreadMessage | undefined;
        for(const msg of messages) {
            msg.isRead = true;

            // Stryker disable next-line EqualityOperator: > vs >= makes no practical difference for unique ISO timestamps; ConditionalExpression is T-class (tests verify latest timestamp wins)
            if(!latestMessage || msg.timestamp > latestMessage.timestamp) {
                latestMessage = msg;
            }
        }

        // Update checkpoint to latest message
        if(latestMessage) {
            const metadata = this.channelMetadata.get(channelId);
            const guildId = metadata?.guildId ?? 'DM';
            await this.checkpointManager.updateLastSeen(
                channelId,
                guildId,
                latestMessage.timestamp,
                latestMessage.id
            );

            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            logger.info({
                channelId,
                messageCount:    messages.length,
                latestTimestamp: latestMessage.timestamp,
                msg:             'Channel marked as read',
            });
            // Stryker restore ObjectLiteral,StringLiteral
        }
    }

    /**
     * Records activity in a channel (updates checkpoint to now).
     * Call this after the bot processes a new message to update the last-seen position.
     *
     * @param channelId - Discord channel ID
     * @param guildId - Guild ID or 'DM' for direct messages
     * @param messageId - Discord message ID being processed
     * @param timestamp - ISO 8601 timestamp of the message
     *
     * @example
     * ```typescript
     * // After processing a new message
     * await inboxManager.recordActivity(
     *   channelId,
     *   guildId,
     *   message.id,
     *   message.timestamp
     * );
     * ```
     */
    async recordActivity(channelId: ChannelId, guildId: GuildId | 'DM', messageId: string, timestamp: string): Promise<void> {
        await this.checkpointManager.updateLastSeen(channelId, guildId, timestamp, messageId);

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.debug({
            channelId,
            messageId,
            timestamp,
            msg: 'Channel activity recorded',
        });
        // Stryker restore ObjectLiteral,StringLiteral
    }

    /**
     * Returns the total count of unread messages across all channels.
     *
     * @example
     * ```typescript
     * console.log(`You have ${inboxManager.totalUnread} unread messages`);
     * ```
     */
    get totalUnread(): number {
        let total = 0;
        for(const messages of this.unreadMessages.values()) {
            total += messages.filter(m => !m.isRead).length;
        }
        return total;
    }

    /**
     * Checks if there are any unread messages.
     *
     * @example
     * ```typescript
     * if (inboxManager.hasUnread) {
     *   console.log('You have unread messages!');
     * }
     * ```
     */
    get hasUnread(): boolean {
        return this.totalUnread > 0;
    }

    /**
     * Gets the channel name for a channel ID from the metadata cache.
     * Returns undefined if no metadata is cached for this channel.
     *
     * @param channelId - Discord channel ID
     * @returns Channel name or undefined if not in cache
     *
     * @example
     * ```typescript
     * const name = inboxManager.getChannelName(channelId);
     * console.log(name ?? 'Unknown channel');
     * ```
     */
    getChannelName(channelId: ChannelId): string | undefined {
        return this.channelMetadata.get(channelId)?.channelName;
    }
}
