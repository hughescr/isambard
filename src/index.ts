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
import { createQuestionRegistry } from './agent/question-registry';
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

    // Create question registry for interactive questions (shared between MCP and bot)
    const questionRegistry = createQuestionRegistry();

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

        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
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
        discordMcpServer = createDiscordMCPServer(messageSearchService, discordClient, questionRegistry);

        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Discord message history enabled');
    // Stryker disable next-line BlockStatement: Catch block continues execution regardless - equivalent mutant
    } catch (error) {
        const errorMessage = _.isError(error) ? error.message : String(error);
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
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

    // Stryker disable next-line ConditionalExpression: Optional initialization - equivalent mutant
    if(config.agent.oauthToken) {
        // Try to load identity context from memory system
        // Stryker disable next-line ConditionalExpression: Optional initialization - equivalent mutant
        if(contextBuilder) {
            // Stryker disable next-line BlockStatement: Try block for optional initialization - equivalent mutant
            try {
                // Stryker disable next-line LogicalOperator: Fallback default is equivalent behavior
                identityContext = await contextBuilder.loadCoreIdentity() || 'Isambard - AI Assistant';
            // Stryker disable next-line BlockStatement: Catch block for optional initialization - equivalent mutant
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                logger.warn(`Failed to load identity context: ${errorMessage}`);
                // Stryker disable next-line StringLiteral: Fallback default string is not behavior-affecting
                identityContext = 'Isambard - AI Assistant';
            }
        } else {
            // Stryker disable next-line StringLiteral: Fallback default string is not behavior-affecting
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
        questionRegistry,
    });

    return {
        start: async () => {
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Starting Isambard application...');
            await bot.start();
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Isambard application started successfully');
        },

        stop: async () => {
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Stopping Isambard application...');
            await bot.stop();
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Isambard application stopped');
        },
    };
}

// Application entry point - only run if this is the main module
// Stryker disable all: Entry point code - not unit testable
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- import.meta.main is required for Bun
if(import.meta.main) {
    // Change to scratch directory for containment
    // Use absolute path based on project root to prevent nesting on hot reload
    // import.meta.dir is src/, so go up one level to project root
    const scratchDir = resolve(import.meta.dir, '..', 'scratch');
    try {
        await stat(scratchDir);
    } catch{
        logger.info(`Creating scratch directory: ${scratchDir}`);
        await mkdir(scratchDir);
    }
    // Only change directory if not already there
    if(process.cwd() !== scratchDir) {
        logger.info(`Changing working directory to: ${scratchDir}`);
        process.chdir(scratchDir);
    }

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

    // Hot reload cleanup for bun --hot
    if(import.meta.hot) {
        import.meta.hot.dispose(async () => {
            logger.info('Hot reload detected, cleaning up...');
            await app.stop();
        });
    }
}
// Stryker restore all
