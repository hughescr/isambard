/**
 * Discord Infrastructure Module
 *
 * Provides factory function for creating all Discord-related infrastructure:
 * - Discord client
 * - Channel registry (backend + manager)
 * - Message history (fetcher + summarizer + search service)
 * - Inbox system (checkpoint manager + inbox manager)
 * - Bot state manager
 *
 * This module wires together the Discord integration subsystems that are
 * required for the bot to function. It does NOT create MCP servers - those
 * are created separately in Phase 5.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Client } from 'discord.js';
import { logger } from '@hughescr/logger';
import type { DiscordConfig } from '@/config/schemas';
import type { MemoryToolBackend } from '@/storage/memory-tool';
import { createDiscordClient } from '@/integrations/discord/client';
import { ChannelRegistryBackend, ChannelRegistryManager } from '@/integrations/discord/channel-registry';
import type { ChannelRegistryManager as ChannelRegistryManagerType } from '@/integrations/discord/channel-registry';
import { createMessageFetcher } from '@/integrations/discord/message-history/fetcher';
import type { MessageFetcher } from '@/integrations/discord/message-history/fetcher';
import { createMessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import type { MessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import { createMessageSearchService } from '@/integrations/discord/message-history/search';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import { CheckpointManager, InboxManager } from '@/integrations/discord/inbox';
import type { InboxManager as InboxManagerType } from '@/integrations/discord/inbox';
import { BotStateManagerImpl } from '@/integrations/discord/state';
import type { BotStateManager } from '@/integrations/discord/state';

/**
 * Options for creating Discord infrastructure.
 */
export interface DiscordInfrastructureOptions {
    /** Discord configuration (bot token, home guild, etc.) */
    discordConfig: DiscordConfig
    /** DynamoDB document client for channel registry backend */
    docClient:     DynamoDBDocumentClient
    /** DynamoDB table name for channel registry */
    tableName:     string
    /** Memory tool backend for checkpoint manager */
    memoryBackend: MemoryToolBackend
}

/**
 * Discord infrastructure components.
 */
export interface DiscordInfrastructure {
    /** Discord.js client (not logged in yet) */
    discordClient:        Client
    /** Channel registry manager for tracking Discord channels */
    channelRegistry:      ChannelRegistryManagerType
    /** Message search service for fetching Discord message history */
    messageSearchService: MessageSearchService
    /** Inbox manager for tracking unread messages */
    inboxManager:         InboxManagerType
    /** Bot state manager for operational mode and activity phase tracking */
    botStateManager:      BotStateManager
}

/**
 * Creates all Discord infrastructure components.
 *
 * This factory wires together:
 * 1. Discord client (for Discord API access)
 * 2. Channel registry (backend + manager with caching)
 * 3. Message history chain (fetcher → summarizer → search service)
 * 4. Inbox system (checkpoint manager + inbox manager)
 * 5. Bot state manager (for presence and context injection)
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
 *   memoryBackend,
 * });
 *
 * // Later: log in to Discord
 * await discordInfra.discordClient.login(discordConfig.botToken);
 * ```
 */
export function createDiscordInfrastructure(options: DiscordInfrastructureOptions): DiscordInfrastructure {
    const { discordConfig, docClient, tableName, memoryBackend } = options;

    // Create Discord client early (shared with bot and channel registry)
    const discordClient = createDiscordClient(discordConfig);

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

    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Discord message history enabled');

    // Create checkpoint manager for inbox
    const checkpointManager = new CheckpointManager({ backend: memoryBackend });

    // Create inbox manager with channel registry
    const inboxManager: InboxManagerType = new InboxManager({
        checkpointManager,
        messageSearchService,
        channelRegistry,
        config: discordConfig.inbox,  // Optional inbox config from Discord config
    });

    // Create bot state manager (shared between inbox MCP server and bot)
    const botStateManager: BotStateManager = new BotStateManagerImpl({
        logger,
        updateThrottleMs: discordConfig.presence?.updateThrottleMs,
    });

    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Inbox system initialized');

    return {
        discordClient,
        channelRegistry,
        messageSearchService,
        inboxManager,
        botStateManager,
    };
}
