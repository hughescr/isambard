/**
 * Discord Integration Exports
 *
 * Public API: createDiscordBot, DiscordBot
 * Most other exports are internal implementation details used by the bot or agent's Discord-specific MCP servers.
 */

export { createDiscordClient } from './client';

export {
    splitMessage
} from './messages';

export {
    type DiscordBot,
    createDiscordBot
} from './bot';

export {
    buildQuestionButtons
} from './button-builder';

// State management (explicit — conflicts: TransitionError, AgentConfig)
export {
    BotStateManagerImpl,
    type BotStateManager
} from './state';

// Channel Registry (explicit — conflicts: ChannelNotFoundError alias, error classes moved to @/errors block)
export {
    ChannelRegistryBackend,
    ChannelRegistryManager,
    DMTracker,
    resolveChannelId
} from './channel-registry';
export type { ResolvedUser, UserResolveResult } from './channel-registry';

// Inbox (no conflicts — safe for export *)
export * from './inbox';

// Catchup (no conflicts — safe for export *)
export * from './catchup';

// Attachments (no conflicts — safe for export *)
export * from './attachments';

// Message History (explicit — no sub-barrel, import from individual files)
export {
    createMessageFetcher,
    type MessageFetcher
} from './message-history/fetcher';

export {
    createMessageSummarizer,
    type MessageSummarizer
} from './message-history/summarizer';

export {
    createMessageSearchService,
    type MessageSearchService
} from './message-history/search';

// Retry
export {
    withDiscordRetry
} from './retry';

// Email setup
export {
    setupEmail,
    type EmailSetupResult
} from './setup/email-setup';

// Bsky setup
export {
    setupBsky,
    type BskySetupResult
} from './setup/bsky-setup';
