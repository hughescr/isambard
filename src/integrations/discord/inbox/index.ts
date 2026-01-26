/**
 * Discord Inbox Module
 *
 * Provides session gap tracking functionality for the Discord bot.
 * Tracks unread messages when the bot is offline and provides them
 * to the agent via MCP tools.
 *
 * Key components:
 * - CheckpointManager: Persists last-seen timestamps per channel
 * - InboxManager: Manages in-memory unread message queue
 * - Types: Zod schemas for checkpoints, messages, and summaries
 */

// Types
export {
    discordChannelCheckpointSchema,
    type DiscordChannelCheckpoint,
    unreadMessageSchema,
    type UnreadMessage,
    channelSummarySchema,
    type ChannelSummary,
    messageMetadataSchema,
    type MessageMetadata,
    channelSummaryResponseSchema,
    type ChannelSummaryResponse,
    unreadOverviewSchema,
    type UnreadOverview
} from './types';

// Configuration
export {
    inboxConfigSchema,
    type InboxConfig,
    DEFAULT_INBOX_CONFIG
} from './config';

// Checkpoint Manager
export {
    CheckpointManager,
    type CheckpointManagerOptions
} from './checkpoint-manager';

// Inbox Manager
export {
    InboxManager,
    type InboxManagerOptions,
    type TrackedChannel
} from './inbox-manager';
