/**
 * Discord Integration Exports
 *
 * Public API: createDiscordBot, DiscordBot
 * Most other exports are internal implementation details used by the bot or agent's Discord-specific MCP servers.
 */

export {
    guildIdSchema,
    type GuildId,
    channelIdSchema,
    type ChannelId,
    userIdSchema,
    type UserId,
    messageIdSchema,
    type MessageId,
    discordMessageContextSchema,
    type DiscordMessageContext,
    createGuildId,
    createChannelId,
    createUserId,
    createMessageId,
    isGuildId,
    isChannelId,
    isUserId,
    isMessageId
} from './types';

export {
    DiscordError,
    DiscordError as DiscordIntegrationError,
    InvalidTokenError,
    PermissionError,
    ChannelNotFoundByIdError,
    ChannelNotFoundByIdError as ChannelNotFoundError,
    RateLimitError,
    MessageFetchError,
    InvalidSnowflakeError,
    ChannelNotAccessibleError,
    ChannelRegistryError,
    ChannelNotFoundByNameError,
    AmbiguousChannelError,
    WellKnownChannelNotFoundError,
    PresenceError,
    StatusGenerationError,
    TransitionError
} from '@/errors';

export { createDiscordClient } from './client';

export {
    extractAttachmentMetadata,
    createReadyHandler,
    createErrorHandler,
    type MessageHandlerOptions,
    createMessageHandler
} from './handlers';

export {
    DISCORD_MAX_LENGTH,
    DISCORD_SAFE_LENGTH,
    exceedsLimit,
    splitMessage
} from './messages';

export {
    type ProcessResult,
    type MessageProcessor,
    type MessageCoordinatorConfig,
    type TypingChannel,
    MessageCoordinator
} from './message-coordinator';

export {
    type DiscordBotOptions,
    type DiscordBot,
    createDiscordBot
} from './bot';

export {
    type ButtonBuilderConfig,
    buildQuestionButtons
} from './button-builder';

export {
    type InteractionHandlerConfig,
    type InteractionHandler,
    createInteractionHandler
} from './interactions';

// State management (explicit — conflicts: TransitionError, SessionType, AgentConfig)
export {
    operationalModeSchema,
    activityPhaseSchema,
    botStateSchema,
    stateChangeSchema,
    modeContextSchema,
    idleModeContextSchema,
    catchingUpModeContextSchema,
    processingMessageModeContextSchema,
    perchingModeContextSchema,
    interruptingMessageDetailsSchema,
    isActivityPhase,
    isModeContext,
    createDefaultBotState,
    VALID_TRANSITIONS,
    isValidTransition,
    assertValidTransition,
    getModeEmoji,
    BotStateManagerImpl,
    createStatusContextBuilder,
    createAgentContextBuilder,
    type OperationalMode,
    type ActivityPhase,
    type BotState,
    type StateChange,
    type IdleModeContext,
    type CatchingUpModeContext,
    type ProcessingMessageModeContext,
    type PerchingModeContext,
    type ModeContext,
    type BotStateManager,
    type InterruptingMessageDetails,
    type SessionType,
    type BotStateManagerDeps,
    type StatusGenerationStrategy,
    type StatusContext,
    type StatusPromptContext,
    type CatchUpPromptContext,
    type StatusContextBuilder,
    type StatusContextBuilderDeps,
    type AgentConfig,
    type McpServerConfig,
    type ContextInjection,
    type CatchUpContextInjection,
    type AgentContextBuilder,
    type AgentContextBuilderDeps
} from './state';

// Channel Registry (explicit — conflicts: ChannelNotFoundError alias, SessionType, error classes moved to @/errors block)
export {
    wellKnownChannelSchema,
    channelMetadataSchema,
    WELL_KNOWN_CHANNELS,
    createChannelMetadata,
    isChannelMetadata,
    ChannelRegistryKeyGenerator,
    ChannelRegistryBackend,
    ChannelRegistryManager,
    formatDMChannelName,
    isDMChannelName,
    DMTracker,
    resolveChannelId,
    NO_RESPONSE_SENTINEL,
    hasSentinel,
    stripSentinel,
    processResponse,
    ResponseRouter,
    discoverAllChannels,
    setupChannelEventHandlers,
    type WellKnownChannel,
    type ChannelMetadata,
    type ChannelRegistryKeys,
    type ChannelRegistryManagerConfig,
    type RoutingResult,
    type ResponseRouterConfig,
    type DiscoveryResult
} from './channel-registry';

// Presence (explicit — conflicts: PresenceError, StatusGenerationError moved to @/errors block)
export {
    ToolStatusMap,
    ToolDescriptions,
    getToolDescription,
    PresenceConfigSchema,
    createActiveStatusGenerator,
    createDynamicStatusGenerator,
    resetCooldownState,
    createIdleStatusGenerator,
    PresenceManager,
    createStatusMiddleware,
    createStreamEventHandler,
    type PresencePhase,
    type PresenceDisplayMode,
    type SynopsisContext,
    type CatchUpSynopsisContext,
    type StatusUpdate,
    type PresenceConfig,
    type IdleStatusGeneratorDeps,
    type PresenceManagerDeps,
    type StreamEventHandler,
    type StreamEventHandlerDeps
} from './presence';

// Inbox (no conflicts — safe for export *)
export * from './inbox';

// Catchup (no conflicts — safe for export *)
export * from './catchup';

// Attachments (no conflicts — safe for export *)
export * from './attachments';

// Message History (explicit — no sub-barrel, import from individual files)
export {
    discordAuthorSchema,
    discordAttachmentSchema,
    discordEmbedSchema,
    discordReactionSchema,
    discordSearchResultSchema,
    overflowSummarySchema,
    batchOverflowSummarySchema,
    searchResponseSchema,
    searchParamsSchema,
    type DiscordAuthor,
    type DiscordAttachment,
    type DiscordEmbed,
    type DiscordReaction,
    type DiscordSearchResult,
    type OverflowSummary,
    type BatchOverflowSummary,
    type SearchResponse,
    type SearchParams
} from './message-history/types';

export {
    createMessageFetcher,
    type FetchOptions,
    type FetchResult,
    type MessageFetcher
} from './message-history/fetcher';

export {
    createMessageSummarizer,
    type SummarizerOptions,
    type MessageSummarizer
} from './message-history/summarizer';

export {
    DISCORD_EPOCH,
    snowflakeSchema,
    snowflakeToTimestamp,
    timestampToSnowflake
} from './message-history/snowflake';

export {
    type SearchParamsInput,
    createMessageSearchService,
    type MessageSearchServiceOptions,
    type MessageSearchService
} from './message-history/search';

// Retry
export {
    classifyDiscordError,
    discordErrorClassifier,
    withDiscordRetry,
    type DiscordRetryOptions
} from './retry';

// Response sender
export {
    sendResponse,
    sendResponseToWellKnownChannel,
    type SendResponseConfig,
    type SendResponseResult,
    type SendToWellKnownConfig
} from './response-sender';

// Content type
export { inferImageContentType } from './content-type';

// Rate limiter
export {
    DiscordRateLimiter,
    type LimitFunction,
    type DiscordRateLimiterOptions
} from './rate-limiter';

// Email setup
export {
    setupEmail,
    type EmailSetupOptions,
    type EmailSetupResult
} from './setup/email-setup';
