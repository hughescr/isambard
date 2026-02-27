import { stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger, setTimezone } from '@hughescr/logger';
import env from 'env-var';
import { Resource } from 'sst';
import { createClaudeAgent, loadPlugins, QuestionRegistry, cleanupAllStaleSessions, syncAgentsAndSkills } from '@/agent';
import { createStorageLayer, createContextLayer, createDiscordInfrastructure, createMCPServers, loadIdentityContext, createCatchUpSignalAdapter } from '@/app';
import { loadConfig, loadDynamoDBConfig } from '@/config';
import { createDiscordBot, setupEmail, type DiscordBot, type EmailSetupResult } from '@/integrations/discord';
import { resolveTimezone, safeAsyncHandler } from '@/utils';

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
    const questionRegistry = new QuestionRegistry();

    // Create DynamoDB client (REQUIRED)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
    const dynamoDBConfig = loadDynamoDBConfig(Resource as any);

    // Create infrastructure layers
    const storage = createStorageLayer(dynamoDBConfig, config.reconciliation);
    const discordInfra = createDiscordInfrastructure({
        discordConfig: config.discord,
        docClient:     storage.docClient,
        tableName:     storage.tableName,
        memoryBackend: storage.memoryBackend,
    });

    // Set up email integration if email config is present (conditional — non-fatal)
    // Must happen before contextLayer so the email service can be wired into the perch prompt
    let emailSetup: EmailSetupResult | undefined;
    if(config.email) {
        // Stryker disable BlockStatement: try-catch wraps email setup - error handling
        try {
            emailSetup = await setupEmail({
                emailConfig:   config.email,
                docClient:     storage.docClient,
                tableName:     storage.tableName,
                client:        discordInfra.discordClient,
                botToken:      config.discord.botToken,
                applicationId: config.discord.applicationId,
            });
        } catch (err) {
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Email integration setup failed, continuing without email',
            });
        }
        // Stryker enable BlockStatement
    }

    // Build email service from emailSetup components (if available)
    const emailService = emailSetup
        ? { wildDuckClient: emailSetup.wildDuckClient }
        : undefined;

    const contextLayer = createContextLayer(storage.memoryBackend, emailService);
    const mcpServers = createMCPServers({
        memoryBackend:        storage.memoryBackend,
        messageSearchService: discordInfra.messageSearchService,
        discordClient:        discordInfra.discordClient,
        questionRegistry,
        channelRegistry:      discordInfra.channelRegistry,
        inboxManager:         discordInfra.inboxManager,
        botStateManager:      discordInfra.botStateManager,
        timezone:             resolveTimezone(),
        recordAccess:         contextLayer.contextBuilder.recordAccess,
    });

    // Load plugins and create agent
    const plugins = await loadPlugins(path.join(path.resolve(import.meta.dir, '..'), 'agents-skills-plugins', 'plugins'));
    const agent = createClaudeAgent({
        contextBuilder:             contextLayer.contextBuilder,
        memoryMcpServer:            mcpServers.memoryMcpServer,
        discordMcpServer:           mcpServers.discordMcpServer,
        inboxMcpServer:             mcpServers.inboxMcpServer,
        emailMcpServer:             emailSetup?.emailMcpServer,
        plugins,
        taskPersistenceCoordinator: storage.taskPersistenceCoordinator,
        mainModel:                  config.agent.mainModel,
    });

    // Load identity
    const identityContext = await loadIdentityContext(config.agent.oauthToken, contextLayer.contextBuilder);

    // Create Discord bot
    const bot: DiscordBot = createDiscordBot({
        config:            config.discord,
        perchConfig:       config.perch,
        identityContext,
        agent,
        client:            discordInfra.discordClient,
        questionRegistry,
        inboxManager:      discordInfra.inboxManager,
        botStateManager:   discordInfra.botStateManager,
        channelRegistry:   discordInfra.channelRegistry,
        eventDeltaTracker: contextLayer.eventDeltaTracker,
        contextBuilder:    contextLayer.contextBuilder,
        memoryBackend:     createCatchUpSignalAdapter(storage.memoryBackend),
        emailSetup,
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

if(import.meta.main) {
    // Change to scratch directory for containment
    // Use absolute path based on project root to prevent nesting on hot reload
    // import.meta.dir is src/, so go up one level to project root
    const scratchDirFromEnv = env.get('SCRATCH_DIR').asString();
    const scratchDir = scratchDirFromEnv
        ? path.resolve(process.cwd(), scratchDirFromEnv)
        : path.resolve(import.meta.dir, '..', 'scratch');
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
    const aspSourceRoot = path.resolve(import.meta.dir, '..', 'agents-skills-plugins');
    const targetClaudeDir = path.join(process.cwd(), '.claude');
    await syncAgentsAndSkills(aspSourceRoot, targetClaudeDir);

    const app = await createApp();

    // Start the application
    await app.start();

    // Store handler references so we can remove them on hot reload
    const sigintHandler = safeAsyncHandler(async () => {
        logger.info('Received SIGINT, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    }, logger, 'SIGINT handler');

    const sigtermHandler = safeAsyncHandler(async () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    }, logger, 'SIGTERM handler');

    // Handle graceful shutdown
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    // Hot reload cleanup for bun --hot
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: import.meta.hot is only available when running with bun --hot
    if(import.meta.hot) {
        import.meta.hot.dispose(async () => {
            logger.info('Hot reload detected, cleaning up...');
            // Remove signal handlers before cleanup to prevent duplicate calls
            process.off('SIGINT', sigintHandler);
            process.off('SIGTERM', sigtermHandler);
            await app.stop();
        });
    }
}
// Stryker restore all
