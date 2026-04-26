import { readFileSync } from 'node:fs';
import { stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger, setTimezone } from '@hughescr/logger';
import type { SlashCommandBuilder } from 'discord.js';
import env from 'env-var';
import { Resource } from 'sst';
import { z } from 'zod';
import { createClaudeAgent, loadPlugins, QuestionRegistry, cleanupAllStaleSessions, syncAgentsAndSkills, createActivityLogger, PersonHistoryCoordinator, createWebViewAdapter, type BrowserHostPolicy, type PlatformHistoryProvider, type ContactChangeRequest } from '@/agent';
import { createStorageLayer, createContextLayer, createDiscordInfrastructure, createMCPServers, loadIdentityContext } from '@/app';
import { loadConfig, loadDynamoDBConfig } from '@/config';
import { BlueskyClient, BskyHistoryProvider } from '@/integrations/bsky';
import { CalDAVClient, CalendarCommandHandler, CalendarRegistryBackend, buildCalendarCommand } from '@/integrations/caldav';
import { createDiscordBot, setupEmail, setupBsky, ContactCommandHandler, ContactApprovalHandler, buildContactApprovalEmbed, buildContactCommand, AllowlistCommandHandler, buildAllowlistCommand, registerAllCommands, DiscordHistoryProvider, DiscordCapabilityImpl, resolveChannelId, splitMessage, withDiscordRetry, AllowlistInteractionHandler, createCatchUpSignalAdapter, type DiscordBot, type EmailSetupResult, type BskySetupResult } from '@/integrations/discord';
import { EmailHistoryProvider, EmailFolder, WildDuckClient } from '@/integrations/email';
import { ServiceHealthRegistryImpl, createReconnectionLoop, OutboxBackend, createOutboxDrainer, ApprovalSagaBackend, createSagaExecutor, AllowlistSagaBackend, AllowlistSagaExecutor, type ApprovalSagaType, type ReconnectionLoop, type OutboxDrainer, type SagaExecutor } from '@/services';
import { PersonAllowlist } from '@/storage';
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
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Cleaning up stale sessions...');
    await cleanupAllStaleSessions();
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Stale sessions cleaned up');

    // Load configuration (required)

    const config = loadConfig(Resource);

    // Set OAuth token for Agent SDK
    process.env.CLAUDE_CODE_OAUTH_TOKEN = config.agent.oauthToken;

    // Create health registry for service lifecycle tracking
    const healthRegistry = new ServiceHealthRegistryImpl({ logger });

    // Create question registry for interactive questions (shared between MCP and bot)
    const questionRegistry = new QuestionRegistry();

    // Create DynamoDB client (REQUIRED)

    const dynamoDBConfig = loadDynamoDBConfig(Resource);

    // Create infrastructure layers
    const storage = createStorageLayer(dynamoDBConfig, config.reconciliation);
    const discordInfra = createDiscordInfrastructure({
        discordConfig: config.discord,
        docClient:     storage.docClient,
        tableName:     storage.tableName,
        memoryBackend: storage.memoryBackend,
    });

    // Outbox and approval saga backends (always available — DynamoDB is required)
    const outboxBackend      = new OutboxBackend(storage.docClient, storage.tableName);
    const approvalSagaBackend = new ApprovalSagaBackend(storage.docClient, storage.tableName);

    // Discord capability facade (wraps Discord sends with outbox fallback)
    const discordCapability = new DiscordCapabilityImpl({
        registry: healthRegistry,
        outboxBackend,
        logger,
    });

    // Activity logger (always available — uses memoryBackend)
    const activityLogger = createActivityLogger(storage.memoryBackend);

    // Create unified PersonAllowlist singleton (always available — shared by email + bsky)
    const personAllowlist = new PersonAllowlist(storage.docClient, storage.tableName, storage.contactBackend);
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Loading person allowlist...');
    await personAllowlist.load();
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Person allowlist loaded');

    // Create AllowlistSagaBackend, AllowlistSagaExecutor, and AllowlistInteractionHandler.
    // These are shared between email and bsky approval flows to start the allowlist saga.
    const allowlistSagaBackend = new AllowlistSagaBackend(storage.docClient, storage.tableName);
    const allowlistSagaExecutor = new AllowlistSagaExecutor({
        contactBackend: storage.contactBackend,
        personAllowlist,
        allowlistSagaBackend,
    });
    const allowlistInteractionHandler = new AllowlistInteractionHandler({
        executor:       allowlistSagaExecutor,
        contactBackend: storage.contactBackend,
    });

    // Set up email integration if email config is present (conditional — non-fatal)
    // Must happen before contextLayer so the email service can be wired into the perch prompt
    //
    // Design: create WildDuckClient eagerly and wire all downstream objects immediately so
    // that consumer references (historyProviders, emailService, emailMcpServer, etc.) are
    // stable.  Only init() (authenticate + load mailboxes) is retried on failure — the client
    // object itself never changes, so no stale-reference problem exists after reconnection.
    let emailSetup: EmailSetupResult | undefined;
    let emailReconnectionLoop: ReconnectionLoop | undefined;
    let unsubscribeEmailReconnect: (() => void) | undefined;
    // Stryker disable BlockStatement: outer if-block body — composition root, not unit-testable
    if(config.email) {
        healthRegistry.sendEvent('email', 'CONFIGURE');
        // Stryker disable BlockStatement: try-catch wraps email setup - error handling

        // Create client eagerly so all downstream objects can capture a stable reference.
        // Stryker disable ObjectLiteral,StringLiteral: WildDuck client creation is integration-only
        const eagerWildDuckClient = new WildDuckClient({
            url:              config.email.wildDuckApiUrl,
            user:             config.email.user,
            password:         config.email.password,
            maxBodySizeBytes: config.email.maxBodySizeBytes,
        });
        // Stryker restore ObjectLiteral,StringLiteral

        // Create reconnection loop eagerly so post-connect drops are also handled.
        emailReconnectionLoop = createReconnectionLoop({
            service:   'email',
            registry:  healthRegistry,
            connectFn: async () => {
                await eagerWildDuckClient.init();
            },
        });

        // Subscribe to health changes: auto-start reconnection loop when email goes offline
        unsubscribeEmailReconnect = healthRegistry.subscribe((change) => {
            if(change.service === 'email' && change.newState === 'offline' && emailReconnectionLoop && !emailReconnectionLoop.isRunning()) {
                emailReconnectionLoop.start();
            }
        });

        // Wire all downstream objects now (before init succeeds).
        // Health guards on MCP tools prevent usage until init() succeeds.
        // setupEmail with a pre-created wildDuckClient skips client creation and init().
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Setting up email integration...');
        try {
            emailSetup = await setupEmail({
                emailConfig:        config.email,
                docClient:          storage.docClient,
                tableName:          storage.tableName,
                client:             discordInfra.discordClient,
                adminDiscordUserId: config.adminDiscordUserId,
                activityLogger,
                wildDuckClient:     eagerWildDuckClient,
                healthRegistry,
                reconnectionLoop:   emailReconnectionLoop,
                discordCapability,
                approvalSagaBackend,
                personAllowlist,
                allowlistInteractionHandler,
            });
        } catch (err) {
            // Non-WildDuck setup failure (e.g. allowlist DynamoDB load) — log and skip email.
            // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Email integration setup failed (non-WildDuck), email unavailable for this session',
            });
            // Stryker restore ObjectLiteral,StringLiteral
        }

        // Attempt to authenticate the WildDuck client (init = authenticate + load mailboxes).
        // Even if emailSetup failed above, we try init so health state is correct.
        try {
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Starting WildDuck client...');
            await eagerWildDuckClient.init();
            healthRegistry.sendEvent('email', 'CONNECT_SUCCESS');
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('WildDuck client initialized');
        } catch (err) {
            healthRegistry.sendEvent('email', 'CONNECT_FAIL', { error: err instanceof Error ? err.message : String(err) });
            // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'WildDuck init failed, starting reconnection loop',
            });
            // Stryker restore ObjectLiteral,StringLiteral
            // Retry only init() — downstream objects already hold stable refs to the same client.
            emailReconnectionLoop.start();
        }
        // Stryker restore BlockStatement
    }
    // Stryker restore BlockStatement

    // Set up Bluesky integration if bsky config is present (conditional — non-fatal)
    let bskyClient: BlueskyClient | undefined;
    let bskyReconnectionLoop: ReconnectionLoop | undefined;
    let unsubscribeBskyReconnect: (() => void) | undefined;
    // Stryker disable BlockStatement: Composition root — optional bsky integration guard not unit-testable
    if(config.bsky) {
        healthRegistry.sendEvent('bluesky', 'CONFIGURE');

        // Create client eagerly so reconnection loop can capture a stable reference.
        // Stryker disable ObjectLiteral,StringLiteral: BlueskyClient creation is integration-only
        bskyClient = new BlueskyClient({
            handle:      config.bsky.handle,
            appPassword: config.bsky.appPassword,
            serviceUrl:  config.bsky.serviceUrl,
            healthRegistry,
        });
        // Stryker restore ObjectLiteral,StringLiteral

        // Create reconnection loop eagerly so post-connect drops are also handled.
        bskyReconnectionLoop = createReconnectionLoop({
            service:   'bluesky',
            registry:  healthRegistry,
            connectFn: async () => {
                await bskyClient!.login();
            },
        });

        // Subscribe to health changes: auto-start reconnection loop when bluesky goes offline
        unsubscribeBskyReconnect = healthRegistry.subscribe((change) => {
            if(change.service === 'bluesky' && change.newState === 'offline' && bskyReconnectionLoop && !bskyReconnectionLoop.isRunning()) {
                bskyReconnectionLoop.start();
            }
        });

        // Stryker disable BlockStatement: try-catch wraps bsky login - error handling
        try {
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Logging into Bluesky...');
            await bskyClient.login();
            healthRegistry.sendEvent('bluesky', 'CONNECT_SUCCESS');
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Bluesky login successful');
        } catch (err) {
            healthRegistry.sendEvent('bluesky', 'CONNECT_FAIL', { error: err instanceof Error ? err.message : String(err) });
            // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Bluesky login failed, starting reconnection loop',
            });
            // Stryker restore ObjectLiteral,StringLiteral
            // Keep bskyClient alive so reconnection can retry login on the same client.
            // Health guards on MCP tools will prevent usage until login succeeds.
            bskyReconnectionLoop.start();
        }
        // Stryker restore BlockStatement
    }
    // Stryker restore BlockStatement

    // Set up Bluesky safety rails if bsky client was created and email config provides admin channel
    let bskySetup: BskySetupResult | undefined;
    // Stryker disable BlockStatement: Composition root — optional bsky safety rails guard not unit-testable
    if(bskyClient && config.email) {
        // Stryker disable BlockStatement: try-catch wraps bsky safety rails setup - error handling
        try {
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Setting up Bluesky safety rails...');
            bskySetup = await setupBsky({
                bskyClient,
                docClient:             storage.docClient,
                tableName:             storage.tableName,
                client:                discordInfra.discordClient,
                adminDiscordChannelId: config.email.adminDiscordChannelId,
                activityLogger,
                discordCapability,
                approvalSagaBackend,
                personAllowlist,
                allowlistInteractionHandler,
            });
        } catch (err) {
            // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Bluesky safety rails setup failed, disabling Bluesky integration',
            });
            // Stryker restore ObjectLiteral,StringLiteral
        }
        // Stryker restore BlockStatement
    }
    // Stryker restore BlockStatement

    // If bsky client exists and login succeeded (health=online) but safety rails were not set up,
    // disable Bluesky for the current session to prevent unguarded posting.
    // If login failed (health!=online), bskyClient is kept alive for reconnection; safety rails
    // will remain unavailable until a restart, so write tools stay disabled via approval-flow checks.
    // Stryker disable ConditionalExpression,BooleanLiteral,BlockStatement: Composition root safety guard — not unit-testable
    if(bskyClient && !bskySetup && healthRegistry.isAvailable('bluesky')) {
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.warn({ msg: 'Bluesky client available but safety rails not configured — disabling Bluesky writes for this session' });
        bskyClient = undefined;
    }
    // Stryker restore ConditionalExpression,BooleanLiteral,BlockStatement

    // Create Discord reconnection loop eagerly — must be created before createMCPServers() so it
    // can be threaded into Discord MCP health guards.  The connectFn is deferred through a
    // mutable reference so the loop can be created before `bot` is constructed.
    // Stryker disable BlockStatement: Composition root — reconnection loop wiring is not unit-testable
    // eslint-disable-next-line prefer-const -- assigned below after bot is constructed; `let` is required for the deferred-wiring pattern
    let discordReconnectFn: (() => Promise<void>) | undefined;
    const discordReconnectionLoop = createReconnectionLoop({
        service:   'discord',
        registry:  healthRegistry,
        connectFn: async () => {
            await discordReconnectFn!();
        },
    });

    // Subscribe to health changes: auto-start reconnection loop when Discord goes offline
    const unsubscribeDiscordReconnect = healthRegistry.subscribe((change) => {
        if(change.service === 'discord' && change.newState === 'offline' && !discordReconnectionLoop.isRunning()) {
            discordReconnectionLoop.start();
        }
    });
    // Stryker restore BlockStatement

    // Outbox drainer — delivers queued Discord messages when Discord comes back online
    // Stryker disable BlockStatement: Composition root — deliverFn wiring is not unit-testable
    const outboxDrainer: OutboxDrainer = createOutboxDrainer({
        outboxBackend,
        registry:  healthRegistry,
        deliverFn: async (item) => {
            const channel = await discordCapability.fetchChannel(item.destination);
            if(channel === null) {
                throw new Error(`Channel ${item.destination} unavailable`);
            }
            if(item.payload.text) {
                const chunks = splitMessage(item.payload.text);
                for(const chunk of chunks) {
                    // eslint-disable-next-line no-await-in-loop -- chunks must be sent sequentially to preserve message order
                    await withDiscordRetry(() => channel.send(chunk));
                }
            }
            if(item.payload.embeds && item.payload.embeds.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- embed type varies by integration
                await withDiscordRetry(() => channel.send({ embeds: item.payload.embeds as any[] }));
            }
        },
        logger,
    });
    // Stryker restore BlockStatement

    // Zod schemas for saga executor param validation
    // Stryker disable ObjectLiteral,StringLiteral: Composition root — schema definitions are configuration constants
    const bskyReplyParamsSchema = z.object({
        text:      z.string(),
        parentUri: z.string(),
        parentCid: z.string(),
        rootUri:   z.string().optional(),
        rootCid:   z.string().optional(),
    });

    const bskyDMParamsSchema = z.object({ text: z.string(), convoId: z.string() });
    // Stryker restore ObjectLiteral,StringLiteral

    // Saga executor — re-executes approved bsky/email actions after service recovery
    // Stryker disable BlockStatement: Composition root — executor closures capture optional clients — not unit-testable
    const sagaExecutor: SagaExecutor = createSagaExecutor({
        backend:   approvalSagaBackend,
        registry:  healthRegistry,
        executors: {
            bsky_reply: async (params) => {
                if(!bskyClient) {
                    throw new Error('Bluesky client not available');
                }
                const parsed = bskyReplyParamsSchema.parse(params);
                await bskyClient.replyToPost(parsed.text, parsed.parentUri, parsed.parentCid, parsed.rootUri, parsed.rootCid);
            },
            bsky_dm: async (params) => {
                if(!bskyClient) {
                    throw new Error('Bluesky client not available');
                }
                const parsed = bskyDMParamsSchema.parse(params);
                await bskyClient.sendDirectMessage(parsed.convoId, parsed.text);
            },
            email_send: async (params) => {
                if(!emailSetup) {
                    throw new Error('Email not available');
                }
                const uid = z.object({ uid: z.number().int() }).parse(params).uid;
                await emailSetup.wildDuckClient.submitMessage(EmailFolder.Drafts, uid);
            },
            email_reply: async (params) => {
                if(!emailSetup) {
                    throw new Error('Email not available');
                }
                const uid = z.object({ uid: z.number().int() }).parse(params).uid;
                await emailSetup.wildDuckClient.submitMessage(EmailFolder.Drafts, uid);
            },
        },
        logger,
    });
    // Stryker restore BlockStatement

    // History providers
    // Stryker disable ObjectLiteral,ConditionalExpression,StringLiteral,BlockStatement,ArrayDeclaration: Composition root — history provider wiring is not unit-testable
    const historyProviders = [
        new DiscordHistoryProvider(
            discordInfra.messageSearchService,
            {
                resolveChannelId:   nameOrId => resolveChannelId(nameOrId, discordInfra.channelRegistry),
                muteChannel:        channelId => discordInfra.channelRegistry.muteChannel(channelId),
                unmuteChannel:      channelId => discordInfra.channelRegistry.unmuteChannel(channelId),
                getAllChannels:     () => discordInfra.channelRegistry.getAllChannels(),
                getUnmutedChannels: () => discordInfra.channelRegistry.getUnmutedChannels(),
            },
            // botUserId may be empty if constructed before Discord login; direction defaults to 'mutual' for unknown authors
            discordInfra.discordClient.user?.id ?? ''
            // Note: dmTracker is created inside bot.ts at clientReady — not available here.
            // DM-specific history search will be wired when DMTracker is elevated to composition root.
        ),
    ] as PlatformHistoryProvider[];

    // Add email history provider if wildDuckClient available
    if(emailSetup && config.email) {
        historyProviders.push(new EmailHistoryProvider(
            config.email.user,
            emailSetup.wildDuckClient
        ));
    }

    // Add bsky history provider if bskyClient available
    if(bskyClient) {
        historyProviders.push(new BskyHistoryProvider(bskyClient));
    }

    // History coordinator
    const historyCoordinator = new PersonHistoryCoordinator({
        contactBackend:       storage.contactBackend,
        providers:            historyProviders,
        messageSearchService: discordInfra.messageSearchService,
    });
    // Stryker restore ObjectLiteral,ConditionalExpression,StringLiteral,BlockStatement

    // Build email service from emailSetup components (if available)
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: Composition root — optional service wiring
    const emailService = emailSetup
        ? { wildDuckClient: emailSetup.wildDuckClient }
        : undefined;

    // Build bsky DM service from bskyClient (if available and safety rails active)
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: Composition root — optional service wiring
    const bskyDMService = bskyClient ? { client: bskyClient } : undefined;

    // Create CalDAV components (always available — DynamoDB is required)
    // Stryker disable next-line ObjectLiteral: Composition root — CalDAV client options object is wiring
    const caldavClient = new CalDAVClient({ healthRegistry });
    // Stryker disable next-line StringLiteral,ObjectLiteral: Composition root — CalDAV has no auth step, always available
    healthRegistry.sendEvent('caldav', 'CONFIGURE');
    // Stryker disable next-line StringLiteral,ObjectLiteral: Composition root — CalDAV has no auth step, always available
    healthRegistry.sendEvent('caldav', 'CONNECT_SUCCESS');
    const caldavRegistry = new CalendarRegistryBackend(storage.docClient, storage.tableName);
    // Stryker disable next-line ObjectLiteral: Composition root — CalDAV service wiring object is configuration
    const calendarService = { client: caldavClient, registry: caldavRegistry };
    const calendarHandler = new CalendarCommandHandler(
        caldavClient,
        caldavRegistry,
        config.adminDiscordUserId
    );

    // Set up Contacts approval handler (always available — DynamoDB is required)
    const contactApprovalHandler = new ContactApprovalHandler(storage.contactBackend, personAllowlist);

    // Build sendContactApprovalRequest callback — posts approval embed to admin channel
    // Only wired when email config provides the admin channel ID
    // Stryker disable BlockStatement: Composition root — optional contact approval callback, not unit-testable
    const sendContactApprovalRequest = config.email
        ? async (action: 'create' | 'update', details: ContactChangeRequest): Promise<void> => {
            const uuid = crypto.randomUUID();
            contactApprovalHandler.storePendingRequest(uuid, details);
            const { embed, actionRow } = buildContactApprovalEmbed(details, uuid);
            // Stryker disable BlockStatement,StringLiteral: integration-only callback body
            await discordCapability.sendToChannel(
                config.email!.adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                { priority: 'high', type: 'contact_approval' }
            );
            // Stryker restore BlockStatement,StringLiteral
        }
        : undefined;
    // Stryker restore BlockStatement

    // Stryker disable ObjectLiteral,OptionalChaining: Composition root — service wiring objects and optional deps are not unit-testable
    const contextLayer = createContextLayer(storage.memoryBackend, emailService, bskyDMService, calendarService, bskySetup?.rejectionBackend, healthRegistry);

    // Construct browser adapter — macOS only (Bun.WebView requires darwin), and only when browser config is present
    // Stryker disable all: Composition root — browser adapter wiring is not unit-testable
    let browserAdapter: ReturnType<typeof createWebViewAdapter> | undefined;
    let browserPolicy: BrowserHostPolicy | undefined;
    if(process.platform === 'darwin' && config.browser) {
        browserAdapter = createWebViewAdapter({
            backend:             config.browser.backend,
            viewportWidth:       config.browser.viewportWidth,
            viewportHeight:      config.browser.viewportHeight,
            navigationTimeoutMs: config.browser.navigationTimeoutMs,
            actionTimeoutMs:     config.browser.actionTimeoutMs,
            // maxScreenshotBytes and maxTextBytes are NOT adapter config — enforced at MCP layer
            dataStorePath:       config.browser.dataStorePath,
            chromePath:          config.browser.chromePath,
        });
        browserPolicy = { allowlist: config.browser.allowlist };
    } else if(config.browser) {
        logger.warn('Browser config present but Bun.WebView is only supported on macOS — browser tools will be unavailable');
    }
    // Stryker restore all

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
        bskyRejectionBackend:      bskySetup?.rejectionBackend,
        caldavClient,
        caldavRegistry,
        contactBackend:            storage.contactBackend,
        contactApprovalRequest:    sendContactApprovalRequest,
        historyCoordinator,
        healthRegistry,
        discordReconnectionLoop,
        bskyReconnectionLoop,
        emailReconnectionLoop,
        browserAdapter,
        browserPolicy,
        browserMaxScreenshotBytes: config.browser?.maxScreenshotBytes,
        browserMaxTextBytes:       config.browser?.maxTextBytes,
    });
    // Stryker restore ObjectLiteral,OptionalChaining

    // Load plugins and create agent
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Loading plugins...');
    // Stryker disable next-line StringLiteral: Filesystem path is configuration
    const plugins = await loadPlugins(path.join(path.resolve(import.meta.dir, '..'), 'agents-skills-plugins', 'plugins'));
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Plugins loaded');
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Creating Claude agent...');
    const agent = createClaudeAgent({
        contextBuilder:             contextLayer.contextBuilder,
        memoryMcpServer:            mcpServers.memoryMcpServer,
        discordMcpServer:           mcpServers.discordMcpServer,
        inboxMcpServer:             mcpServers.inboxMcpServer,
        emailMcpServer:             emailSetup?.emailMcpServer,
        bskyMcpServer:              mcpServers.bskyMcpServer,
        caldavMcpServer:            mcpServers.caldavMcpServer,
        wikipediaMcpServer:         mcpServers.wikipediaMcpServer,
        mediaMcpServer:             mcpServers.mediaMcpServer,
        contactsMcpServer:          mcpServers.contactsMcpServer,
        userContextMcpServer:       mcpServers.userContextMcpServer,
        browserMcpServer:           mcpServers.browserMcpServer,
        plugins,
        taskPersistenceCoordinator: storage.taskPersistenceCoordinator,
        mainModel:                  config.agent.mainModel,
        fallbackModel:              config.agent.fallbackModel,
        // Stryker disable ObjectLiteral: Composition root — wiring BotStateManager to compaction hooks
        // getCompactionStateManager() returns a properly-typed narrow view of BotStateManagerImpl
        // (no unsafe cast needed — the method returns CompactionStateManager directly).
        compactionStateManager:     discordInfra.botStateManager.getCompactionStateManager(),
        // Stryker restore ObjectLiteral
    });
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Claude agent created');

    // Load identity
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Loading identity context...');
    const identityContext = await loadIdentityContext(config.agent.oauthToken, contextLayer.contextBuilder);
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Identity context loaded');

    // Construct allowlist command handler using the unified PersonAllowlist
    // Stryker disable next-line ObjectLiteral: Composition root — AllowlistCommandHandler is integration wiring
    const allowlistHandler = new AllowlistCommandHandler(
        personAllowlist,
        storage.contactBackend,
        config.adminDiscordUserId
    );

    // Create contacts command handler
    const contactCommandHandler = new ContactCommandHandler(storage.contactBackend, config.adminDiscordUserId, contactApprovalHandler, personAllowlist);

    // Create Discord bot
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Creating Discord bot...');
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
        allowlistInteractionHandler,
        calendarHandler,
        contactHandler:    contactCommandHandler,
        contactApprovalHandler,
        activityLogger,
        historyCoordinator,
        healthRegistry,
        discordCapability,
    });
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Discord bot created');

    // Collect slash command builders for bulk registration at startup
    // Stryker disable BlockStatement,ArrayDeclaration: Composition root — command builder list construction is not unit-testable
    const commandBuilders: (() => SlashCommandBuilder)[] = [buildCalendarCommand, buildContactCommand, buildAllowlistCommand];

    // Wire Discord client into the capability facade now (client may not be logged in yet,
    // but the facade checks isReady() before sending, so this is safe to set eagerly).
    discordCapability.setClient(discordInfra.discordClient);

    // Subscribe to health changes: drain outbox when any service comes online
    // Registered once at createApp() time so it survives across start()/stop() cycles
    // Stryker disable BlockStatement: Composition root — health subscription callback is not unit-testable
    const unsubscribeOutboxDrain = healthRegistry.subscribe((change) => {
        if(change.newState === 'online') {
            void outboxDrainer.drain(change.service);
        }
    });
    // Stryker restore BlockStatement

    // Subscribe to health changes: reset failed sagas when a service comes back online
    // Stryker disable BlockStatement: Composition root — health subscription callback is not unit-testable
    const unsubscribeSagaRetry = healthRegistry.subscribe((change) => {
        if(change.newState !== 'online') {
            return;
        }

        const sagaTypes: ApprovalSagaType[] = [];
        if(change.service === 'bluesky') {
            sagaTypes.push('bsky_reply', 'bsky_dm');
        }
        if(change.service === 'email') {
            sagaTypes.push('email_send', 'email_reply');
        }
        if(sagaTypes.length === 0) {
            return;
        }

        void (async () => {
            try {
                const failed = await approvalSagaBackend.listByState('failed');
                for(const saga of failed) {
                    if(new Set(sagaTypes).has(saga.type)) {
                        // eslint-disable-next-line no-await-in-loop -- sequential: saga state updates must be ordered
                        await approvalSagaBackend.updateState(saga.id, 'approved');
                    }
                }
            } catch (err) {
                logger.warn({ error: err instanceof Error ? err.message : String(err), msg: 'Failed to reset sagas on reconnect' });
            }
        })();
    });
    // Stryker restore BlockStatement

    // Subscribe to health changes: run recovery phase when Discord reconnects.
    // Registered inside app.start() AFTER bot.start() so it only fires on reconnects.
    // Catch-up on first connection is handled by setupInboxAndCatchUp in bot.ts clientReady.
    let unsubscribeDiscordRecovery: (() => void) | undefined;

    // Wire discordReconnectFn now that bot is available.
    discordReconnectFn = async () => {
        await bot.start();
    };

    let isStopping = false;

    return {
        // Stryker disable BlockStatement: Composition root — startup/shutdown branching is not unit-testable
        start: async () => {
            isStopping = false;
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Starting Isambard application...');

            // Mark Discord as starting
            healthRegistry.sendEvent('discord', 'CONFIGURE');

            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Connecting to Discord...');
            // Stryker disable BlockStatement: try-catch wraps Discord startup — error handling
            try {
                await bot.start();
                healthRegistry.sendEvent('discord', 'CONNECT_SUCCESS');
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Discord connected');
            } catch (err) {
                healthRegistry.sendEvent('discord', 'CONNECT_FAIL', {
                    error: err instanceof Error ? err.message : String(err),
                });
                logger.warn({
                    error: err instanceof Error ? err.message : String(err),
                    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                    msg:   'Discord unavailable at startup, starting reconnection loop',
                });
                discordReconnectionLoop.start();
            }
            // Stryker restore BlockStatement

            // Register recovery subscriber now — after initial bot.start() — so it only fires on reconnects.
            // Catch-up on first connection is handled by setupInboxAndCatchUp inside bot.ts clientReady.
            unsubscribeDiscordRecovery = healthRegistry.subscribe((change) => {
                if(change.service === 'discord' && change.newState === 'online') {
                    void (async () => {
                        try {
                            await discordInfra.channelRegistry.warmCache();
                            const currentMode = discordInfra.botStateManager.getMode();
                            if(currentMode === 'processing_message') {
                                discordInfra.botStateManager.goIdle();
                            }
                            await bot.triggerCatchUp();
                        } catch (err) {
                            logger.warn({ error: err instanceof Error ? err.message : String(err), msg: 'Discord recovery phase failed' });
                        }
                    })();
                }
            });

            // Start email listener (independent of Discord — email works even if Discord is offline)
            // Stryker disable BlockStatement: try-catch wraps email listener start - composition root error handling
            if(emailSetup) {
                try {
                    await emailSetup.listener.start();
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.info({ msg: 'Email listener started' });
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        msg:   'Failed to start email listener',
                    });
                }
            }
            // Stryker restore BlockStatement

            // Register slash commands (non-fatal — Discord may be connected but commands fail)
            // Stryker disable BlockStatement: Composition root — not unit-testable
            try {
                await registerAllCommands(discordInfra.discordClient, commandBuilders);
            } catch (err) {
                logger.warn({
                    error: err instanceof Error ? err.message : String(err),
                    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                    msg:   'Slash command registration failed, will retry on next startup',
                });
            }
            // Stryker restore BlockStatement

            // These start regardless of Discord availability
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional startup - equivalent mutant
            if(storage.reconciliationScheduler) {
                storage.reconciliationScheduler.start();
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Tag index reconciliation scheduler started');
            }

            // Start saga executor polling loop
            sagaExecutor.start();

            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Isambard application started successfully');
        },
        // Stryker restore BlockStatement

        // Stryker disable BlockStatement: Composition root — startup/shutdown branching is not unit-testable
        // eslint-disable-next-line sonarjs/cognitive-complexity -- stop() is a composition-root shutdown handler; complexity is inherent from cleaning up multiple optional services
        stop: async () => {
            if(isStopping) {
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.debug('Application already stopped, skipping duplicate call');
                return;
            }
            isStopping = true;

            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Stopping Isambard application...');

            // Stop reconnection loops if running
            discordReconnectionLoop.stop();
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(emailReconnectionLoop) {
                emailReconnectionLoop.stop();
            }
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(bskyReconnectionLoop) {
                bskyReconnectionLoop.stop();
            }

            // Stop outbox drainer and saga executor
            outboxDrainer.stop();
            sagaExecutor.stop();

            // Unsubscribe health listeners
            unsubscribeOutboxDrain();
            unsubscribeSagaRetry();
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional unsubscribe — only registered after first successful start()
            unsubscribeDiscordRecovery?.();
            unsubscribeDiscordReconnect();
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional unsubscribe - equivalent mutant
            unsubscribeEmailReconnect?.();
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional unsubscribe - equivalent mutant
            unsubscribeBskyReconnect?.();

            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(storage.reconciliationScheduler) {
                storage.reconciliationScheduler.stop();
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Tag index reconciliation scheduler stopped');
            }

            // Close browser adapter if running
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(browserAdapter) {
                browserAdapter.close();
            }

            // Stop email listener and WildDuck client before bot.stop()
            // (email lifecycle moved here since listener now starts in app.start())
            // Stryker disable BlockStatement: try-catch isolates email stop from Discord cleanup
            if(emailSetup) {
                try {
                    await emailSetup.listener.stop();
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        // Stryker disable next-line StringLiteral: log message is not behavior-affecting
                        msg:   'Email listener stop failed during shutdown',
                    });
                }
                // Stryker restore BlockStatement
                // Stryker disable BlockStatement: try-catch isolates WildDuck shutdown from Discord cleanup
                try {
                    await emailSetup.wildDuckClient.shutdown();
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        // Stryker disable next-line StringLiteral: log message is not behavior-affecting
                        msg:   'WildDuck client shutdown failed during email teardown',
                    });
                }
            }
            // Stryker restore BlockStatement

            await bot.stop();

            // Stop health registry after bot.stop() so health subscribers can still
            // react to service state changes during graceful shutdown.
            healthRegistry.stop();
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Isambard application stopped');
        },
        // Stryker restore BlockStatement
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
