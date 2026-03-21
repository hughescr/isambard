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

// Checkpoint Manager
export { CheckpointManager } from './checkpoint-manager';

// Inbox Manager
export { InboxManager } from './inbox-manager';
