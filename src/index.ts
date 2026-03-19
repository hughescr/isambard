import { readFileSync } from 'node:fs';
import { stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger, setTimezone } from '@hughescr/logger';
import env from 'env-var';
import { Resource } from 'sst';
import { createClaudeAgent, loadPlugins, QuestionRegistry, cleanupAllStaleSessions, syncAgentsAndSkills } from '@/agent';
import { createStorageLayer, createContextLayer, createDiscordInfrastructure, createMCPServers, loadIdentityContext, createCatchUpSignalAdapter } from '@/app';
import { loadConfig, loadDynamoDBConfig } from '@/config';
import { BlueskyClient } from '@/integrations/bsky';
import { CalDAVClient, CalendarCommandHandler, CalendarRegistryBackend, registerCalendarCommand } from '@/integrations/caldav';
import { createDiscordBot, setupEmail, setupBsky, type DiscordBot, type EmailSetupResult, type BskySetupResult } from '@/integrations/discord';
import { AllowlistCommandHandler } from '@/integrations/email';
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
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- createApp is a composition root; branching is inherent — wires email, bsky, and all optional integrations
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
                emailConfig:        config.email,
                docClient:          storage.docClient,
                tableName:          storage.tableName,
                client:             discordInfra.discordClient,
                botToken:           config.discord.botToken,
                applicationId:      config.discord.applicationId,
                adminDiscordUserId: config.adminDiscordUserId,
            });
        } catch (err) {
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Email integration setup failed, continuing without email',
            });
        }
        // Stryker enable BlockStatement
    }

    // Set up Bluesky integration if bsky config is present (conditional — non-fatal)
    let bskyClient: BlueskyClient | undefined;
    if(config.bsky) {
        // Stryker disable BlockStatement: try-catch wraps bsky setup - error handling
        try {
            bskyClient = new BlueskyClient({
                handle:      config.bsky.handle,
                appPassword: config.bsky.appPassword,
                serviceUrl:  config.bsky.serviceUrl,
            });
            await bskyClient.login();
        } catch (err) {
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Bluesky integration setup failed, continuing without Bluesky',
            });
            bskyClient = undefined;
        }
        // Stryker enable BlockStatement
    }

    // Set up Bluesky safety rails if bsky client was created and email config provides admin channel
    let bskySetup: BskySetupResult | undefined;
    if(bskyClient && config.email) {
        // Stryker disable BlockStatement: try-catch wraps bsky safety rails setup - error handling
        try {
            bskySetup = await setupBsky({
                bskyClient,
                docClient:             storage.docClient,
                tableName:             storage.tableName,
                client:                discordInfra.discordClient,
                adminDiscordChannelId: config.email.adminDiscordChannelId,
            });
        } catch (err) {
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Bluesky safety rails setup failed, disabling Bluesky integration',
            });
        }
        // Stryker enable BlockStatement
    }

    // If bsky client exists but safety rails were not set up (no email config or setup failed),
    // disable Bluesky entirely to prevent unguarded posting
    if(bskyClient && !bskySetup) {
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.warn({ msg: 'Bluesky client available but safety rails not configured — disabling Bluesky integration' });
        bskyClient = undefined;
    }

    // Build email service from emailSetup components (if available)
    const emailService = emailSetup
        ? { wildDuckClient: emailSetup.wildDuckClient }
        : undefined;

    // Build bsky DM service from bskyClient (if available and safety rails active)
    const bskyDMService = bskyClient ? { client: bskyClient } : undefined;

    // Create CalDAV components (always available — DynamoDB is required)
    const caldavClient = new CalDAVClient();
    const caldavRegistry = new CalendarRegistryBackend(storage.docClient, storage.tableName);
    const calendarService = { client: caldavClient, registry: caldavRegistry };
    const calendarHandler = new CalendarCommandHandler(
        caldavClient,
        caldavRegistry,
        config.adminDiscordUserId
    );

    const contextLayer = createContextLayer(storage.memoryBackend, emailService, bskyDMService, calendarService);
    const mcpServers = createMCPServers({
        memoryBackend:             storage.memoryBackend,
        messageSearchService:      discordInfra.messageSearchService,
        discordClient:             discordInfra.discordClient,
        questionRegistry,
        channelRegistry:           discordInfra.channelRegistry,
        inboxManager:              discordInfra.inboxManager,
        botStateManager:           discordInfra.botStateManager,
        timezone:                  resolveTimezone(),
        recordAccess:              paths => contextLayer.contextBuilder.recordAccess(paths),
        bskyClient,
        bskyAllowlist:             bskySetup?.allowlist,
        bskyRateLimiter:           bskySetup?.rateLimiter,
        bskySendApprovalRequest:   bskySetup?.sendApprovalRequest,
        bskySendDMApprovalRequest: bskySetup?.sendDMApprovalRequest,
        caldavClient,
        caldavRegistry,
    });

    // Load plugins and create agent
    const plugins = await loadPlugins(path.join(path.resolve(import.meta.dir, '..'), 'agents-skills-plugins', 'plugins'));
    const agent = createClaudeAgent({
        contextBuilder:             contextLayer.contextBuilder,
        memoryMcpServer:            mcpServers.memoryMcpServer,
        discordMcpServer:           mcpServers.discordMcpServer,
        inboxMcpServer:             mcpServers.inboxMcpServer,
        emailMcpServer:             emailSetup?.emailMcpServer,
        bskyMcpServer:              mcpServers.bskyMcpServer,
        caldavMcpServer:            mcpServers.caldavMcpServer,
        wikipediaMcpServer:         mcpServers.wikipediaMcpServer,
        plugins,
        taskPersistenceCoordinator: storage.taskPersistenceCoordinator,
        mainModel:                  config.agent.mainModel,
    });

    // Load identity
    const identityContext = await loadIdentityContext(config.agent.oauthToken, contextLayer.contextBuilder);

    // Construct allowlist command handler externally (after both email and bsky setups are done)
    // so it can manage both the email and Bluesky allowlists from a single /allowlist command.
    const activeBskyClient = bskyClient; // capture for closure — TypeScript narrowing
    const resolveHandleToDid = activeBskyClient
        ? async (handle: string): Promise<string | undefined> => {
            const profile = await activeBskyClient.getProfile(handle);
            return profile.did;
        }
        : undefined;
    const allowlistHandler = emailSetup
        ? new AllowlistCommandHandler(
            emailSetup.allowlist,
            // Stryker disable next-line ConditionalExpression,ObjectLiteral: optional bsky allowlist wiring
            bskySetup?.allowlist ?? { addEntry: async () => { /* no-op */ }, removeEntry: async () => { /* no-op */ }, list: async () => [] },
            config.adminDiscordUserId,
            resolveHandleToDid
        )
        : undefined;

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
        bskySetup,
        allowlistHandler,
        calendarHandler,
    });

    let isStopping = false;

    return {
        start: async () => {
            isStopping = false;
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Starting Isambard application...');
            await bot.start();
            await registerCalendarCommand(config.discord.botToken, config.discord.applicationId);
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

/**
 * Resolve the real repository root, following git worktree links.
 * In a worktree, `.git` is a file containing `gitdir: <path>` pointing to the
 * main repo's `.git/worktrees/<name>` directory. We follow that link to find
 * the actual repo root so shared directories like `scratch/` resolve correctly.
 */
function resolveRepoRoot(apparentRoot: string): string {
    const gitPath = path.join(apparentRoot, '.git');
    try {
        // eslint-disable-next-line n/no-sync -- sync read required; function runs before any async context
        const content = readFileSync(gitPath, 'utf8');
        // .git file in worktree contains: gitdir: /path/to/main/.git/worktrees/<name>
        // Use \S to anchor captured group and prevent super-linear backtracking
        const match = /^gitdir: *(\S[^\n]*)$/m.exec(content);
        if(match?.[1]) {
            // gitdir points to .git/worktrees/<name>, go up 3 levels to get repo root
            return path.resolve(path.dirname(gitPath), match[1].trimEnd(), '..', '..', '..');
        }
    } catch{
        // .git is a directory (normal repo), not a file (worktree)
    }
    return apparentRoot;
}

if(import.meta.main) {
    // Change to scratch directory for containment
    // Use absolute path based on project root to prevent nesting on hot reload
    // import.meta.dir is src/, so go up one level to project root, then resolve
    // the real repo root in case we are running from a git worktree (e.g. running/)
    const apparentRoot = path.resolve(import.meta.dir, '..');
    const repoRoot = resolveRepoRoot(apparentRoot);
    const scratchDirFromEnv = env.get('SCRATCH_DIR').asString();
    const scratchDir = scratchDirFromEnv
        ? path.resolve(process.cwd(), scratchDirFromEnv)
        : path.resolve(repoRoot, 'scratch');
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
