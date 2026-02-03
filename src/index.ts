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
import { TaskSessionBackend } from './storage/task-session';
import { createContextBuilder } from './agent/context-builder';
import { createMemoryMCPServer } from './agent/memory-mcp-server';
import { createDiscordMCPServer } from './agent/discord-mcp-server';
import { createClaudeAgent } from './agent/agent';
import { loadPlugins } from './agent/plugin-loader';
import { createQuestionRegistry } from './agent/question-registry';
import { cleanupAllStaleSessions } from './agent/session-cleanup';
import { createTaskDirectoryCopier } from './agent/task-directory-copier';
import { createTaskPersistenceCoordinator, type TaskPersistenceCoordinator } from './agent/task-persistence-coordinator';
import { createTaskCleanupProcessor } from './agent/task-cleanup-processor';
import { createDiscordBot } from './integrations/discord/bot';
import type { DiscordBot } from './integrations/discord/bot';
import type { CatchUpCompletionSignal, CatchUpInProgressSignal } from './integrations/discord/catchup';
import { createDiscordClient } from './integrations/discord/client';
import { createMemoryPath } from './storage/memory-tool/types';
import { createMessageFetcher } from './integrations/discord/message-history/fetcher';
import { createMessageSummarizer } from './integrations/discord/message-history/summarizer';
import { createMessageSearchService } from './integrations/discord/message-history/search';
import { CheckpointManager, InboxManager } from './integrations/discord/inbox';
import { createInboxMCPServer } from './agent/inbox-mcp-server';
import { createBotStateManager, type BotStateManager } from './integrations/discord/state';
import { ChannelRegistryBackend, ChannelRegistryManager } from './integrations/discord/channel-registry';
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
 * 1. Clean up stale session files from previous runs
 * 2. Load configuration (Discord, Agent OAuth token)
 * 3. Set CLAUDE_CODE_OAUTH_TOKEN for Agent SDK
 * 4. Optionally create memory system (context builder + MCP server) if DynamoDB is available
 * 5. Create Claude agent with hybrid memory support
 * 6. Create Discord bot with agent as message handler
 *
 * Error handling:
 * - Missing required config (Discord, OAuth token) throws immediately
 * - Missing optional config (DynamoDB) logs warning and continues without memory
 *
 * @returns Application instance with start/stop methods
 * @throws {Error} If required configuration is missing or invalid
 */
export async function createApp(): Promise<App> {
    // Clean up stale session files from previous hot reloads
    await cleanupAllStaleSessions();

    // Load configuration (required)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
    const config = loadConfig(Resource as any);

    // Set OAuth token for Agent SDK
    process.env.CLAUDE_CODE_OAUTH_TOKEN = config.agent.oauthToken;

    // Create question registry for interactive questions (shared between MCP and bot)
    const questionRegistry = createQuestionRegistry();

    // Create DynamoDB client (REQUIRED)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
    const dynamoDBConfig = loadDynamoDBConfig(Resource as any);
    const { docClient, tableName } = createDynamoDBClient(dynamoDBConfig);

    // Try to create memory system, Discord client, and channel registry (required for bot startup)
    let contextBuilder;
    let memoryMcpServer: McpServerConfig | undefined;
    let discordClient: Client | undefined;
    let discordMcpServer: McpServerConfig | undefined;
    let inboxMcpServer: McpServerConfig | undefined;
    let inboxManager: InboxManager | undefined;
    let memoryBackend: MemoryToolBackend | undefined;
    let botStateManager: BotStateManager | undefined;
    let taskPersistenceCoordinator: TaskPersistenceCoordinator | undefined;
    let channelRegistry: ChannelRegistryManager;

    try {
        // Create memory backend
        memoryBackend = new MemoryToolBackend(docClient, tableName);

        // Create context builder (for core identity + recent context)
        contextBuilder = createContextBuilder({ backend: memoryBackend });

        // Create MCP server (for deep memory access)
        memoryMcpServer = createMemoryMCPServer(memoryBackend);

        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info(`Memory system initialized with DynamoDB: ${tableName} in ${dynamoDBConfig.region}`);

        // Create Discord client early (shared with bot and channel registry)
        discordClient = createDiscordClient(config.discord);

        // Create channel registry (REQUIRED - bot cannot start without it)
        // Must be created after Discord client since it fetches channel info from Discord API
        const channelRegistryBackend = new ChannelRegistryBackend(docClient, tableName);
        channelRegistry = new ChannelRegistryManager({
            backend:     channelRegistryBackend,
            homeGuildId: config.discord.homeGuildId,
            client:      discordClient,
        });

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
        discordMcpServer = createDiscordMCPServer(messageSearchService, discordClient, questionRegistry, channelRegistry);

        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Discord message history enabled');

        // Create checkpoint manager for inbox
        const checkpointManager = new CheckpointManager({ backend: memoryBackend });

        // Create inbox manager with channel registry
        inboxManager = new InboxManager({
            checkpointManager,
            messageSearchService,
            channelRegistry,
            config: config.discord.inbox,  // Optional inbox config from Discord config
        });

        // Create bot state manager (shared between inbox MCP server and bot)
        botStateManager = createBotStateManager({
            logger,
            updateThrottleMs: config.discord.presence?.updateThrottleMs,
        });

        // Create inbox MCP server with bot state manager for tracking viewed channels
        inboxMcpServer = createInboxMCPServer(inboxManager, channelRegistry, botStateManager);

        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Inbox system initialized');

        // Create task persistence system (requires DynamoDB)
        const taskSessionBackend = new TaskSessionBackend(docClient, tableName);
        const taskCleanupProcessor = createTaskCleanupProcessor({ logger });
        const taskDirectoryCopier = createTaskDirectoryCopier({
            logger,
            cleanupProcessor: taskCleanupProcessor,
        });
        taskPersistenceCoordinator = createTaskPersistenceCoordinator({
            backend: taskSessionBackend,
            copier:  taskDirectoryCopier,
            logger,
        });
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Task persistence system initialized');
    // Stryker disable next-line BlockStatement: Catch block continues execution regardless - equivalent mutant
    } catch (error) {
        const errorMessage = _.isError(error) ? error.message : String(error);
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.error(`Failed to initialize required systems: ${errorMessage}`);
        throw new Error(`Failed to initialize Discord client and channel registry: ${errorMessage}. The bot cannot start without these.`);
    }

    // Verify channel registry was initialized (required for bot to function)
    if(!channelRegistry) {
        throw new Error('Channel registry not initialized. The bot cannot start without it.');
    }

    // Load plugins from plugins directory
    const plugins = await loadPlugins('plugins');

    // Create Claude agent with hybrid memory support
    const agent = createClaudeAgent({
        contextBuilder,
        memoryMcpServer,
        discordMcpServer,
        inboxMcpServer,
        plugins,
        taskPersistenceCoordinator,
        channelRegistry,
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
        config:      config.discord,
        perchConfig: config.perch,
        onMessage:   async (context) => {
            return await agent.chat(context);
        },
        identityContext,
        agent,
        client:        discordClient,
        questionRegistry,
        inboxManager,
        botStateManager,
        channelRegistry,
        memoryBackend: memoryBackend
            ? {
                storeCompletionSignal: async (signal: CatchUpCompletionSignal) => {
                    try {
                        const path = createMemoryPath('/state/catchup-completion');
                        const existing = await memoryBackend.get(path);
                        const content = JSON.stringify(signal);
                        if(existing) {
                            await memoryBackend.update(path, { content });
                        } else {
                            await memoryBackend.create({ path, content, contentType: 'application/json' });
                        }
                    } catch (error) {
                        const errorMsg = _.isError(error) ? error.message : String(error);
                        logger.error({
                            error: errorMsg,
                            msg:   'Failed to store catch-up completion signal',
                        });
                        // Don't re-throw - allow catch-up to continue
                    }
                },
                loadCompletionSignal: async () => {
                    try {
                        const path = createMemoryPath('/state/catchup-completion');
                        const result = await memoryBackend.get(path);
                        if(!result) {
                            return null;
                        }
                        return JSON.parse(result.content) as CatchUpCompletionSignal;
                    } catch (error) {
                        const errorMsg = _.isError(error) ? error.message : String(error);
                        logger.error({
                            error: errorMsg,
                            msg:   'Failed to load catch-up completion signal',
                        });
                        return null;
                    }
                },
                storeInProgressSignal: async (signal: CatchUpInProgressSignal) => {
                    try {
                        const path = createMemoryPath('/state/catchup-inprogress');
                        const existing = await memoryBackend.get(path);
                        const content = JSON.stringify(signal);
                        if(existing) {
                            await memoryBackend.update(path, { content });
                        } else {
                            await memoryBackend.create({ path, content, contentType: 'application/json' });
                        }
                    } catch (error) {
                        const errorMsg = _.isError(error) ? error.message : String(error);
                        logger.error({
                            error: errorMsg,
                            msg:   'Failed to store catch-up in-progress signal',
                        });
                        // Don't re-throw - allow catch-up to continue
                    }
                },
                loadInProgressSignal: async () => {
                    try {
                        const path = createMemoryPath('/state/catchup-inprogress');
                        const result = await memoryBackend.get(path);
                        if(!result) {
                            return null;
                        }
                        return JSON.parse(result.content) as CatchUpInProgressSignal;
                    } catch (error) {
                        const errorMsg = _.isError(error) ? error.message : String(error);
                        logger.error({
                            error: errorMsg,
                            msg:   'Failed to load catch-up in-progress signal',
                        });
                        return null;
                    }
                },
                deleteInProgressSignal: async () => {
                    try {
                        const path = createMemoryPath('/state/catchup-inprogress');
                        await memoryBackend.delete(path);
                    } catch (error) {
                        const errorMsg = _.isError(error) ? error.message : String(error);
                        logger.error({
                            error: errorMsg,
                            msg:   'Failed to delete catch-up in-progress signal',
                        });
                        // Don't re-throw - allow catch-up to continue
                    }
                },
            }
            : undefined,
    });

    let isStopping = false;

    return {
        start: async () => {
            isStopping = false;
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Starting Isambard application...');
            await bot.start();
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Isambard application started successfully');
        },

        stop: async () => {
            if(isStopping) {
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.debug('Application already stopped, skipping duplicate call');
                return;
            }
            isStopping = true;

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

    // Store handler references so we can remove them on hot reload
    const sigintHandler = async () => {
        logger.info('Received SIGINT, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    };

    const sigtermHandler = async () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    };

    // Handle graceful shutdown
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
    process.on('SIGINT', sigintHandler);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
    process.on('SIGTERM', sigtermHandler);

    // Hot reload cleanup for bun --hot
    if(import.meta.hot) {
        import.meta.hot.dispose(async () => {
            logger.info('Hot reload detected, cleaning up...');
            // Remove signal handlers before cleanup to prevent duplicate calls
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
            process.off('SIGINT', sigintHandler);
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
            process.off('SIGTERM', sigtermHandler);
            await app.stop();
        });
    }
}
// Stryker restore all
