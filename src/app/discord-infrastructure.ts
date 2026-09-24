/**
 * Discord Infrastructure Module
 *
 * Provides factory function for creating all Discord-related infrastructure:
 * - Discord client
 * - Channel registry (backend + manager)
 * - Message history (fetcher + summarizer + search service)
 * - Inbox system (checkpoint manager + inbox manager)
 *
 * This module wires together the Discord integration subsystems that are
 * required for the bot to function. It does NOT create MCP servers - those
 * are created separately in Phase 5.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import type { DiscordConfig } from '@/config';
import {
    createDiscordClient,
    ChannelRegistryBackend,
    ChannelRegistryManager,
    createMessageFetcher,
    createMessageSummarizer,
    createMessageSearchService,
    CheckpointManager,
    InboxManager,
    type ChannelRegistryManager as ChannelRegistryManagerType,
    type MessageFetcher,
    type MessageSummarizer,
    type MessageSearchService,
    type InboxManager as InboxManagerType
} from '@/integrations/discord';
import type { DynamoDBClientHolder, OperationalStateStore } from '@/storage';

/**
 * Options for creating Discord infrastructure.
 */
interface DiscordInfrastructureOptions {
    /** Discord configuration (bot token, home guild, etc.) */
    discordConfig:         DiscordConfig
    /** DynamoDB document client or holder for channel registry backend */
    docClient:             DynamoDBDocumentClient | DynamoDBClientHolder
    /** DynamoDB table name for channel registry */
    tableName:             string
    /** Operational-state store for the inbox checkpoint manager */
    operationalStateStore: OperationalStateStore
    /** Optional construction owner; called as soon as the client is acquired. */
    onClientCreated?:      (client: Client) => void
}

/**
 * Discord infrastructure components.
 */
interface DiscordInfrastructure {
    /** Discord.js client (not logged in yet) */
    discordClient:        Client
    /** Channel registry manager for tracking Discord channels */
    channelRegistry:      ChannelRegistryManagerType
    /** Message search service for fetching Discord message history */
    messageSearchService: MessageSearchService
    /** Inbox manager for tracking unread messages */
    inboxManager:         InboxManagerType
}

/**
 * Creates all Discord infrastructure components.
 *
 * This factory wires together:
 * 1. Discord client (for Discord API access)
 * 2. Channel registry (backend + manager with caching)
 * 3. Message history chain (fetcher → summarizer → search service)
 * 4. Inbox system (checkpoint manager + inbox manager)
 *
 * The Discord client is created but NOT logged in - the caller must call
 * client.login(token) when ready to connect to Discord.
 *
 * @param options - Configuration options
 * @returns Discord infrastructure components
 * @throws If any component fails to initialize
 *
 * @example
 * ```typescript
 * const discordInfra = createDiscordInfrastructure({
 *   discordConfig,
 *   docClient,
 *   tableName,
 *   operationalStateStore,
 * });
 *
 * // Later: log in to Discord
 * await discordInfra.discordClient.login(discordConfig.botToken);
 * ```
 */
export function createDiscordInfrastructure(options: DiscordInfrastructureOptions): DiscordInfrastructure {
    const { discordConfig, docClient, tableName, operationalStateStore, onClientCreated } = options;

    // Create Discord client early (shared with bot and channel registry)
    const discordClient = createDiscordClient(discordConfig);
    let ownershipRegistered = false;
    try {
        // Stryker disable next-line llm: options.onClientCreated is a function or absent, so the optional call and the && form skip it for exactly the same values and invoke it identically otherwise
        onClientCreated?.(discordClient);
        ownershipRegistered = onClientCreated !== undefined;
        // Create channel registry (REQUIRED - bot cannot start without it)
        // Must be created after Discord client since it fetches channel info from Discord API
        const channelRegistryBackend = new ChannelRegistryBackend(docClient, tableName);
        const channelRegistry = new ChannelRegistryManager({
            backend:     channelRegistryBackend,
            homeGuildId: discordConfig.homeGuildId,
            client:      discordClient,
        });

        // Create message history components
        const messageFetcher: MessageFetcher = createMessageFetcher(discordClient);
        const messageSummarizer: MessageSummarizer = createMessageSummarizer({});

        // Create message search service
        const messageSearchService: MessageSearchService = createMessageSearchService({
            fetcher:    messageFetcher,
            summarizer: messageSummarizer,
        });

        logger.info('Discord message history enabled');

        // Create checkpoint manager for inbox
        const checkpointManager = new CheckpointManager({ store: operationalStateStore });

        // Create inbox manager with channel registry
        const inboxManager: InboxManagerType = new InboxManager({
            checkpointManager,
            messageSearchService,
            channelRegistry,
            config: discordConfig.inbox,  // Optional inbox config from Discord config
        });

        logger.info('Inbox system initialized');

        return {
            discordClient,
            channelRegistry,
            messageSearchService,
            inboxManager,
        };
    } catch (error) {
        // Ownership has not reached the caller. Do not mask the constructor error
        // if discord.js also fails while releasing the partially built client.
        if(!ownershipRegistered) {
            void Promise.resolve().then(() => discordClient.destroy()).catch(() => {
                /* Preserve the constructor error, including synchronous destroy failures. */
            });
        }
        throw error;
    }
}
