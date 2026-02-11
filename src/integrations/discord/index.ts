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
    RateLimitError
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
