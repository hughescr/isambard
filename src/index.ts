import { Resource } from 'sst';
import _ from 'lodash';
import type { Client } from 'discord.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { stat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, loadDynamoDBConfig } from './config/loader';
import { createDynamoDBClient } from './storage/client';
import { MemoryToolBackend } from './storage/memory-tool';
import { MessageCache } from './storage/message-cache/cache';
import { createContextBuilder } from './agent/context-builder';
import { createMemoryMCPServer } from './agent/memory-mcp-server';
import { createDiscordMCPServer } from './agent/discord-mcp-server';
import { createClaudeAgent } from './agent/agent';
import { loadPlugins } from './agent/plugin-loader';
import { createDiscordBot } from './integrations/discord/bot';
import type { DiscordBot } from './integrations/discord/bot';
import { createDiscordClient } from './integrations/discord/client';
import { createMessageFetcher } from './integrations/discord/message-history/fetcher';
import { createMessageSummarizer } from './integrations/discord/message-history/summarizer';
import { createMessageSearchService } from './integrations/discord/message-history/search';
import { logger } from '@hughescr/logger';

export interface App {
    /**
     * Start the application (Discord bot and Claude agent).
     */
    start: () => Promise<void>

    /**
     * Stop the application gracefully.
     */
    stop: () => Promise<void>
}

/**
 * Creates the Isambard application with all components wired together.
 *
 * Initialization flow:
 * 1. Load configuration (Discord, Agent OAuth token)
 * 2. Set CLAUDE_CODE_OAUTH_TOKEN for Agent SDK
 * 3. Optionally create memory system (context builder + MCP server) if DynamoDB is available
 * 4. Create Claude agent with hybrid memory support
 * 5. Create Discord bot with agent as message handler
 *
 * Error handling:
 * - Missing required config (Discord, OAuth token) throws immediately
 * - Missing optional config (DynamoDB) logs warning and continues without memory
 *
 * @returns Application instance with start/stop methods
 * @throws {Error} If required configuration is missing or invalid
 */
export async function createApp(): Promise<App> {
    // Load configuration (required)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
    const config = loadConfig(Resource as any);

    // Set OAuth token for Agent SDK
    process.env.CLAUDE_CODE_OAUTH_TOKEN = config.agent.oauthToken;

    // Try to create memory system and Discord MCP (optional - requires DynamoDB)
    let contextBuilder;
    let memoryMcpServer: McpServerConfig | undefined;
    let discordClient: Client | undefined;
    let discordMcpServer: McpServerConfig | undefined;

    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
        const dynamoDBConfig = loadDynamoDBConfig(Resource as any);
        const { docClient, tableName } = createDynamoDBClient(dynamoDBConfig);

        // Create memory backend
        const memoryBackend = new MemoryToolBackend(docClient, tableName);

        // Create context builder (for core identity + recent context)
        contextBuilder = createContextBuilder({ backend: memoryBackend });

        // Create MCP server (for deep memory access)
        memoryMcpServer = createMemoryMCPServer(memoryBackend);

        logger.info(`Memory system initialized with DynamoDB: ${tableName} in ${dynamoDBConfig.region}`);

        // Create Discord client early (shared with bot)
        discordClient = createDiscordClient(config.discord);

        // Create message history components
        const messageFetcher = createMessageFetcher(discordClient);
        const messageCache = new MessageCache(docClient, tableName);
        const messageSummarizer = createMessageSummarizer({});

        // Create message search service
        const messageSearchService = createMessageSearchService({
            fetcher:    messageFetcher,
            cache:      messageCache,
            summarizer: messageSummarizer,
        });

        // Create Discord MCP server
        discordMcpServer = createDiscordMCPServer(messageSearchService);

        logger.info('Discord message history enabled');
    } catch (error) {
        const errorMessage = _.isError(error) ? error.message : String(error);
        logger.warn(`Memory not configured, continuing without persistent memory: ${errorMessage}`);
        // Continue without memory system
    }

    // Load plugins from plugins directory
    const plugins = await loadPlugins('plugins');

    // Create Claude agent with hybrid memory support
    const agent = createClaudeAgent({
        contextBuilder,
        memoryMcpServer,
        discordMcpServer,
        plugins,
    });

    // Load identity context for presence idle status generation (if API key available)
    let identityContext: string | undefined;

    if(config.agent.oauthToken) {
        // Try to load identity context from memory system
        if(contextBuilder) {
            try {
                identityContext = await contextBuilder.loadCoreIdentity() || 'Isambard - AI Assistant';
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                logger.warn(`Failed to load identity context: ${errorMessage}`);
                identityContext = 'Isambard - AI Assistant';
            }
        } else {
            identityContext = 'Isambard - AI Assistant';
        }
    }

    // Create Discord bot with agent as message handler
    // Use the pre-created client if available (shared with message fetcher)
    const bot: DiscordBot = createDiscordBot({
        config:    config.discord,
        onMessage: async (context) => {
            return await agent.chat(context);
        },
        identityContext,
        agent,
        client: discordClient,
    });

    return {
        start: async () => {
            logger.info('Starting Isambard application...');
            await bot.start();
            logger.info('Isambard application started successfully');
        },

        stop: async () => {
            logger.info('Stopping Isambard application...');
            await bot.stop();
            logger.info('Isambard application stopped');
        },
    };
}

// Application entry point - only run if this is the main module
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- import.meta.main is required for Bun
if(import.meta.main) {
    // Change to scratch directory for containment
    const scratchDir = 'scratch';
    try {
        await stat(scratchDir);
    } catch{
        logger.info(`Creating scratch directory: ${scratchDir}`);
        await mkdir(scratchDir);
    }
    logger.info(`Changing working directory to: ${resolve(scratchDir)}`);
    process.chdir(scratchDir);

    logger.info('Isambard starting...');

    const app = await createApp();

    // Start the application
    await app.start();

    // Handle graceful shutdown
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
    process.on('SIGINT', async () => {
        logger.info('Received SIGINT, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
    process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    });
}
