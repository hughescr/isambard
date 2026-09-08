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

// Channel Registry (explicit — conflicts: ChannelNotFoundError alias, error classes moved to @/errors block)
export {
    ChannelRegistryBackend,
    ChannelRegistryManager,
    DMTracker,
    resolveChannelId
} from './channel-registry';

// Inbox (no conflicts — safe for export *)
export * from './inbox';

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

// P9: conversation conductor for Discord turns
export {
    createConductorProcessor,
    type CreateConductorProcessorParams,
    type DiscordEnvelopeProvider
} from './setup/conductor-processor';

export {
    CHANNEL_LIST_HYDRATING_MARKER,
    channelListProvider,
    resolveNames,
    toEnvelopeInput,
    type ResolvedDiscordNames
} from './setup/discord-envelope-provider';

// Contact commands
export {
    ContactCommandHandler,
    ContactApprovalHandler,
    buildContactApprovalEmbed,
    buildContactCommand
} from './contact-commands';

// Allowlist commands
export {
    AllowlistCommandHandler,
    buildAllowlistCommand
} from './allowlist-commands';

// Allowlist interaction handler (saga-based flow)
export {
    AllowlistInteractionHandler
} from './allowlist-interaction-handler';

// Consolidated slash command registration
export {
    registerAllCommands
} from './register-commands';

// History provider
export { DiscordHistoryProvider } from './history-provider';

// Discord capability facade
export { DiscordCapabilityImpl } from './capability';
