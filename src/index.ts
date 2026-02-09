import { Resource } from 'sst';
import env from 'env-var';
import { stat, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadConfig, loadDynamoDBConfig } from './config/loader';
import { createClaudeAgent } from './agent/agent';
import { loadPlugins } from './agent/plugin-loader';
import { createQuestionRegistry } from './agent/question-registry';
import { cleanupAllStaleSessions } from './agent/session-cleanup';
import { syncAgentsAndSkills } from './agent/skill-agent-loader';
import { createStorageLayer } from './app/storage-layer';
import { createContextLayer } from './app/context-layer';
import { createDiscordInfrastructure } from './app/discord-infrastructure';
import { createMCPServers } from './app/mcp-servers';
import { loadIdentityContext } from './app/identity-loader';
import { createOnMessageHandler } from './app/on-message-handler';
import { createDiscordBot } from './integrations/discord/bot';
import type { DiscordBot } from './integrations/discord/bot';
import { resolveTimezone } from './utils/time';
import { logger, setTimezone } from '@hughescr/logger';
import { createCatchUpSignalAdapter } from './app/catchup-signal-adapter';

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
 * 4. Create memory system (context builder + MCP server) if DynamoDB is available
 * 5. Create Claude agent with hybrid memory support
 * 6. Create Discord bot with agent as message handler
 *
 * Error handling:
 * - Missing required config (Discord, OAuth token) throws immediately
 * - Factory functions throw with descriptive errors if initialization fails
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

    // Create infrastructure layers
    const storage = createStorageLayer(dynamoDBConfig, config.reconciliation);
    const contextLayer = createContextLayer(storage.memoryBackend);
    const discordInfra = createDiscordInfrastructure({
        discordConfig: config.discord,
        docClient:     storage.docClient,
        tableName:     storage.tableName,
        memoryBackend: storage.memoryBackend,
    });
    const mcpServers = createMCPServers({
        memoryBackend:        storage.memoryBackend,
        messageSearchService: discordInfra.messageSearchService,
        discordClient:        discordInfra.discordClient,
        questionRegistry,
        channelRegistry:      discordInfra.channelRegistry,
        inboxManager:         discordInfra.inboxManager,
        botStateManager:      discordInfra.botStateManager,
        timezone:             resolveTimezone(),
    });

    // Load plugins and create agent
    const plugins = await loadPlugins(join(resolve(import.meta.dir, '..'), 'agents-skills-plugins', 'plugins'));
    const agent = createClaudeAgent({
        contextBuilder:             contextLayer.contextBuilder,
        memoryMcpServer:            mcpServers.memoryMcpServer,
        discordMcpServer:           mcpServers.discordMcpServer,
        inboxMcpServer:             mcpServers.inboxMcpServer,
        plugins,
        taskPersistenceCoordinator: storage.taskPersistenceCoordinator,
    });

    // Load identity and create message handler
    const identityContext = await loadIdentityContext(config.agent.oauthToken, contextLayer.contextBuilder);
    const onMessage = createOnMessageHandler({
        agent,
        channelRegistry: discordInfra.channelRegistry,
        discordClient:   discordInfra.discordClient,
    });

    // Create Discord bot
    const bot: DiscordBot = createDiscordBot({
        config:            config.discord,
        perchConfig:       config.perch,
        onMessage,
        identityContext,
        agent,
        client:            discordInfra.discordClient,
        questionRegistry,
        inboxManager:      discordInfra.inboxManager,
        botStateManager:   discordInfra.botStateManager,
        channelRegistry:   discordInfra.channelRegistry,
        eventDeltaTracker: contextLayer.eventDeltaTracker,
        memoryBackend:     createCatchUpSignalAdapter(storage.memoryBackend),
    });

    let isStopping = false;

    return {
        start: async () => {
            isStopping = false;
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Starting Isambard application...');
            await bot.start();
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional startup - equivalent mutant
            if(storage.reconciliationScheduler) {
                storage.reconciliationScheduler.start();
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Tag index reconciliation scheduler started');
            }
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
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(storage.reconciliationScheduler) {
                storage.reconciliationScheduler.stop();
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Tag index reconciliation scheduler stopped');
            }
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
    const scratchDirFromEnv = env.get('SCRATCH_DIR').asString();
    const scratchDir = scratchDirFromEnv
        ? resolve(process.cwd(), scratchDirFromEnv)
        : resolve(import.meta.dir, '..', 'scratch');
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

    // Configure logger timezone (env var or system default)
    const logTimezone = env.get('LOG_TIMEZONE').asString()
      ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimezone(logTimezone);

    logger.info('Isambard starting...');

    // Copy agents and skills to scratch/.claude/ for SDK filesystem discovery
    const aspSourceRoot = resolve(import.meta.dir, '..', 'agents-skills-plugins');
    const targetClaudeDir = join(process.cwd(), '.claude');
    await syncAgentsAndSkills(aspSourceRoot, targetClaudeDir);

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
