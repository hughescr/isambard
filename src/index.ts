import { readFileSync } from 'node:fs';
import { stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger, setTimezone } from '@hughescr/logger';
import type { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import env from 'env-var';
import { Resource } from 'sst';
import { z } from 'zod';
import { createClaudeAgent, loadPlugins, QuestionRegistry, cleanupAllStaleSessions, syncAgentsAndSkills, createActivityLogger, PersonHistoryCoordinator, createWebViewAdapter, IdentityCache, type BrowserHostPolicy, type PlatformHistoryProvider, type ContactChangeRequest } from '@/agent';
import { createStorageLayer, createContextLayer, createDiscordInfrastructure, createMCPServers, loadIdentityContext } from '@/app';
import { loadConfig, loadDynamoDBConfig } from '@/config';
import { ChannelNotFoundByIdError, InvariantViolationError } from '@/errors';
import { BlueskyClient, BskyHistoryProvider } from '@/integrations/bsky';
import { CalDAVClient, CalendarCommandHandler, CalendarRegistryBackend, buildCalendarCommand } from '@/integrations/caldav';
import { createDiscordBot, setupEmail, setupBsky, ContactCommandHandler, ContactApprovalHandler, buildContactApprovalEmbed, buildContactCommand, AllowlistCommandHandler, buildAllowlistCommand, registerAllCommands, DiscordHistoryProvider, DiscordCapabilityImpl, resolveChannelId, splitMessage, withDiscordRetry, AllowlistInteractionHandler, createCatchUpSignalAdapter, type DiscordBot, type EmailSetupResult, type BskySetupResult } from '@/integrations/discord';
import { EmailHistoryProvider, EmailFolder, WildDuckClient } from '@/integrations/email';
import { ServiceHealthRegistryImpl, createReconnectionLoop, OutboxBackend, createOutboxDrainer, ApprovalSagaBackend, createSagaExecutor, AllowlistSagaBackend, AllowlistSagaExecutor, registerErrorBoundaries, type ApprovalSagaType, type ReconnectionLoop, type OutboxDrainer, type SagaExecutor } from '@/services';
import { PersonAllowlist, probeDynamoDB, createDynamoDBClient, setDynamoHealthNotifier, runDynamoDBProbe, loadEmbedder, type EmbedderLike } from '@/storage';
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

    // Load embedder for vector indexing (if enabled)
    // Stryker disable BlockStatement: Composition root — embedder loading is not unit-testable (requires GGUF model file on disk)
    let embedder: EmbedderLike | undefined;
    if(config.vectorIndex?.enabled) {
        try {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Composition root — embedder options are configuration
            embedder = await loadEmbedder({ slug: config.vectorIndex.modelSlug, quant: config.vectorIndex.modelQuant });
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info(`Embedder loaded: ${config.vectorIndex.modelSlug}/${config.vectorIndex.modelQuant}`);
        } catch (err) {
            // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Embedder load failed — vector indexing disabled for this session',
            });
            // Stryker restore ObjectLiteral,StringLiteral
            embedder = undefined;
        }
    }
    // Stryker restore BlockStatement

    // Create a stable callback slot for identity-write invalidation.
    // The identityCache is created below after identityContext is loaded, but
    // MemoryToolBackend needs the callback at construction time.
    // Indirection: a mutable slot object whose reference is captured by the closure.
    // Stryker disable all: Composition root — identity cache wiring is not unit-testable
    const identityCacheSlot: { cache: IdentityCache | undefined } = { cache: undefined };
    const onIdentityWrite = (): void => {
        identityCacheSlot.cache?.invalidate();
    };
    // Stryker restore all

    // Create infrastructure layers
    const storage = await createStorageLayer(
        dynamoDBConfig,
        config.reconciliation,
        config.contactReconciliation,
        config.vectorIndex,
        embedder,
        onIdentityWrite
    );

    // Wire DynamoDB health monitoring.
    // DynamoDB is a required dependency — we probe it with DescribeTable to detect
    // persistent failures (e.g. FailedToOpenSocket after a transient outage).
    //
    // Reconnect strategy: probe the LIVE client (via holder.getClient()) first.
    // On persistent failure, build a fresh DynamoDBClient pair and call holder.swap()
    // so all backends immediately start using the new connection pool without restart.
    // Stryker disable BlockStatement: Composition root — dynamodb reconnection wiring is not unit-testable
    // Stryker disable next-line StringLiteral: composition root — CONFIGURE event code is not unit-testable
    healthRegistry.sendEvent('dynamodb', 'CONFIGURE');

    const dynamoDBReconnectionLoop = createReconnectionLoop({
        service:   'dynamodb',
        registry:  healthRegistry,
        connectFn: async () => {
            // First, try probing the LIVE client — if it succeeds, no swap needed.
            // If it fails, build a fresh client pair and swap into the holder so all
            // backends pick up the new connection pool on their next operation.
            let probeClient = storage.holder.getClient();
            let freshPair: ReturnType<typeof createDynamoDBClient> | undefined;
            // Stryker disable BlockStatement,BooleanLiteral,ConditionalExpression: try-finally ensures fresh client is destroyed on probe failure — composition root, not unit-testable
            try {
                await probeDynamoDB(probeClient, dynamoDBConfig.tableName);
            } catch{
                // Live client failed — build fresh pair and probe it
                freshPair = createDynamoDBClient(dynamoDBConfig);
                probeClient = freshPair.client;
                let swapped = false;
                try {
                    await probeDynamoDB(probeClient, dynamoDBConfig.tableName);
                    // Fresh probe succeeded — atomically swap so all backends use new client
                    storage.holder.swap(freshPair.client, freshPair.docClient);
                    swapped = true;
                } finally {
                    // Destroy fresh client if swap did not happen (probe failed or threw)
                    if(!swapped) {
                        freshPair.client.destroy();
                    }
                }
            }
            // Stryker restore BlockStatement,BooleanLiteral,ConditionalExpression
        },
    });

    // Subscribe to health changes: auto-start reconnection loop when DynamoDB goes offline
    // Stryker disable ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral: Composition root — subscriber callback is not unit-testable
    const unsubscribeDynamoDBReconnect = healthRegistry.subscribe((change) => {
        if(change.service === 'dynamodb' && change.newState === 'offline' && !dynamoDBReconnectionLoop.isRunning()) {
            dynamoDBReconnectionLoop.start();
        }
    });
    // Stryker restore ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral

    // Wire the DynamoDB health notifier so any network-classified errors thrown by
    // withDynamoTimeout (in BaseRepository) also signal CONNECTION_LOST to the
    // health registry — triggering the reconnection loop without waiting for the
    // next periodic probe.
    // Stryker disable BlockStatement,StringLiteral,ObjectLiteral: Composition root — health notifier wiring is not unit-testable
    setDynamoHealthNotifier((err) => {
        healthRegistry.sendEvent('dynamodb', 'CONNECTION_LOST', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
    // Stryker restore BlockStatement,StringLiteral,ObjectLiteral

    // Perform initial DynamoDB health probe against the live client.
    // On success: mark online. On failure: start reconnection loop.
    // Stryker disable BlockStatement: try-catch wraps DynamoDB probe - error handling
    try {
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Probing DynamoDB connectivity...');
        await probeDynamoDB(storage.holder.getClient(), dynamoDBConfig.tableName);
        // Stryker disable next-line StringLiteral: health event string is composition root configuration
        healthRegistry.sendEvent('dynamodb', 'CONNECT_SUCCESS');
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('DynamoDB connectivity verified');
    } catch (err) {
        // Stryker disable next-line StringLiteral,ObjectLiteral: health event string and context are composition root configuration
        healthRegistry.sendEvent('dynamodb', 'CONNECT_FAIL', { error: err instanceof Error ? err.message : String(err) });
        // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.error({
            error: err instanceof Error ? err.message : String(err),
            msg:   'DynamoDB probe failed at startup, starting reconnection loop',
        });
        // Stryker restore ObjectLiteral,StringLiteral
        dynamoDBReconnectionLoop.start();
    }
    // Stryker restore BlockStatement

    // Periodic DynamoDB background probe — detects post-startup connection failures
    // that would otherwise go unnoticed until the next operation fails.
    // Interval: 60s. Sends CONNECTION_LOST on failure, which the lifecycle state machine
    // handles by transitioning online/degraded → offline, triggering the reconnection loop.
    const dynamoDBProbeIntervalMs = 60_000;
    // Stryker disable BlockStatement: Composition root — interval wiring is not unit-testable
    const dynamoDBProbeInterval = setInterval(() => {
        void runDynamoDBProbe(storage.holder.getClient(), dynamoDBConfig.tableName, healthRegistry, logger);
    }, dynamoDBProbeIntervalMs);
    // Stryker restore BlockStatement

    const discordInfra = createDiscordInfrastructure({
        discordConfig: config.discord,
        docClient:     storage.holder,
        tableName:     storage.tableName,
        memoryBackend: storage.memoryBackend,
    });

    // Outbox and approval saga backends (always available — DynamoDB is required)
    const outboxBackend      = new OutboxBackend(storage.holder, storage.tableName);
    const approvalSagaBackend = new ApprovalSagaBackend(storage.holder, storage.tableName);

    // Discord capability facade (wraps Discord sends with outbox fallback)
    const discordCapability = new DiscordCapabilityImpl({
        registry: healthRegistry,
        outboxBackend,
        logger,
    });

    // Activity logger (always available — uses memoryBackend)
    const activityLogger = createActivityLogger(storage.memoryBackend);

    // Create unified PersonAllowlist singleton (always available — shared by email + bsky)
    const personAllowlist = new PersonAllowlist(storage.holder, storage.tableName, storage.contactBackend);
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Loading person allowlist...');
    await personAllowlist.load();
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Person allowlist loaded');

    // Create AllowlistSagaBackend, AllowlistSagaExecutor, and AllowlistInteractionHandler.
    // These are shared between email and bsky approval flows to start the allowlist saga.
    const allowlistSagaBackend = new AllowlistSagaBackend(storage.holder, storage.tableName);
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
        // Stryker disable next-line StringLiteral: health event string is composition root configuration
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
        // Stryker disable ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral: Composition root — subscriber callback is not unit-testable
        unsubscribeEmailReconnect = healthRegistry.subscribe((change) => {
            if(change.service === 'email' && change.newState === 'offline' && emailReconnectionLoop && !emailReconnectionLoop.isRunning()) {
                emailReconnectionLoop.start();
            }
        });
        // Stryker restore ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral

        // Wire all downstream objects now (before init succeeds).
        // Health guards on MCP tools prevent usage until init() succeeds.
        // setupEmail with a pre-created wildDuckClient skips client creation and init().
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Setting up email integration...');
        try {
            emailSetup = await setupEmail({
                emailConfig:        config.email,
                docClient:          storage.holder,
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
        // Stryker disable next-line StringLiteral: health event string is composition root configuration
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

        // Capture a stable reference for the reconnection closure — TS cannot narrow
        // the outer mutable variable inside an async callback.
        const stableBskyClient = bskyClient;

        // Create reconnection loop eagerly so post-connect drops are also handled.
        bskyReconnectionLoop = createReconnectionLoop({
            service:   'bluesky',
            registry:  healthRegistry,
            connectFn: async () => {
                await stableBskyClient.login();
            },
        });

        // Subscribe to health changes: auto-start reconnection loop when bluesky goes offline
        // Stryker disable ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral: Composition root — subscriber callback is not unit-testable
        unsubscribeBskyReconnect = healthRegistry.subscribe((change) => {
            if(change.service === 'bluesky' && change.newState === 'offline' && bskyReconnectionLoop && !bskyReconnectionLoop.isRunning()) {
                bskyReconnectionLoop.start();
            }
        });
        // Stryker restore ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral

        // Stryker disable BlockStatement: try-catch wraps bsky login - error handling
        try {
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Logging into Bluesky...');
            await bskyClient.login();
            // Stryker disable next-line StringLiteral: health event string is composition root configuration
            healthRegistry.sendEvent('bluesky', 'CONNECT_SUCCESS');
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Bluesky login successful');
        } catch (err) {
            // Stryker disable next-line StringLiteral,ObjectLiteral: health event strings and context are composition root configuration
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
                docClient:             storage.holder,
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
    // Stryker disable ConditionalExpression,BooleanLiteral,BlockStatement,LogicalOperator: Composition root safety guard — not unit-testable
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
            if(discordReconnectFn === undefined) {
                // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
                throw new InvariantViolationError('discordReconnectionLoop.connectFn', 'discordReconnectFn not yet wired — reconnection loop fired before bot was constructed');
            }
            await discordReconnectFn();
        },
    });

    // Subscribe to health changes: auto-start reconnection loop when Discord goes offline
    // Stryker disable ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral: Composition root — subscriber callback is not unit-testable
    const unsubscribeDiscordReconnect = healthRegistry.subscribe((change) => {
        if(change.service === 'discord' && change.newState === 'offline' && !discordReconnectionLoop.isRunning()) {
            discordReconnectionLoop.start();
        }
    });
    // Stryker restore ConditionalExpression,EqualityOperator,LogicalOperator,BooleanLiteral
    // Stryker restore BlockStatement

    // Outbox drainer — delivers queued Discord messages when Discord comes back online
    // Stryker disable BlockStatement,ConditionalExpression,EqualityOperator: Composition root — deliverFn wiring is not unit-testable
    const outboxDrainer: OutboxDrainer = createOutboxDrainer({
        outboxBackend,
        registry:  healthRegistry,
        deliverFn: async (item) => {
            const channel = await discordCapability.fetchChannel(item.destination);
            if(channel === null) {
                throw new ChannelNotFoundByIdError(item.destination);
            }
            if(item.payload.text) {
                const chunks = splitMessage(item.payload.text);
                for(const chunk of chunks) {
                    // eslint-disable-next-line no-await-in-loop -- chunks must be sent sequentially to preserve message order
                    await withDiscordRetry(() => channel.send(chunk));
                }
            }
            if(item.payload.embeds && item.payload.embeds.length > 0) {
                // Outbox schema stores embeds as unknown[]; callers always put EmbedBuilder instances in.
                await withDiscordRetry(() => channel.send({ embeds: item.payload.embeds as EmbedBuilder[] }));
            }
        },
        logger,
    });
    // Stryker restore BlockStatement,ConditionalExpression,EqualityOperator

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
    // Stryker disable BlockStatement,ObjectLiteral: Composition root — executor closures capture optional clients — not unit-testable
    const sagaExecutor: SagaExecutor = createSagaExecutor({
        backend:   approvalSagaBackend,
        registry:  healthRegistry,
        executors: {
            bsky_reply: async (params) => {
                if(!bskyClient) {
                    // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
                    throw new InvariantViolationError('sagaExecutor.bsky_reply', 'Bluesky client not available');
                }
                const parsed = bskyReplyParamsSchema.parse(params);
                await bskyClient.replyToPost(parsed.text, parsed.parentUri, parsed.parentCid, parsed.rootUri, parsed.rootCid);
            },
            bsky_dm: async (params) => {
                if(!bskyClient) {
                    // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
                    throw new InvariantViolationError('sagaExecutor.bsky_dm', 'Bluesky client not available');
                }
                const parsed = bskyDMParamsSchema.parse(params);
                await bskyClient.sendDirectMessage(parsed.convoId, parsed.text);
            },
            email_send: async (params) => {
                if(!emailSetup) {
                    // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
                    throw new InvariantViolationError('sagaExecutor.email_send', 'Email not available');
                }
                const uid = z.object({ uid: z.number().int() }).parse(params).uid;
                await emailSetup.wildDuckClient.submitMessage(EmailFolder.Drafts, uid);
            },
            email_reply: async (params) => {
                if(!emailSetup) {
                    // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
                    throw new InvariantViolationError('sagaExecutor.email_reply', 'Email not available');
                }
                const uid = z.object({ uid: z.number().int() }).parse(params).uid;
                await emailSetup.wildDuckClient.submitMessage(EmailFolder.Drafts, uid);
            },
        },
        logger,
    });
    // Stryker restore BlockStatement,ObjectLiteral

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
    const caldavRegistry = new CalendarRegistryBackend(storage.holder, storage.tableName);
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
    const emailConfig = config.email;
    const sendContactApprovalRequest = emailConfig
        ? async (action: 'create' | 'update', details: ContactChangeRequest): Promise<void> => {
            const uuid = crypto.randomUUID();
            contactApprovalHandler.storePendingRequest(uuid, details);
            const { embed, actionRow } = buildContactApprovalEmbed(details, uuid);
            // Stryker disable BlockStatement,StringLiteral,ObjectLiteral: integration-only callback body
            await discordCapability.sendToChannel(
                emailConfig.adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                { priority: 'high', type: 'contact_approval' }
            );
            // Stryker restore BlockStatement,StringLiteral,ObjectLiteral
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
        vectorIndex:               storage.vectorIndex,
        embedder,
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

    // Create identity cache with the loaded identity context as warm seed.
    // Wire contextBuilder as the loader for future invalidate/reload cycles.
    // `identityCacheSlot.cache` is assigned here; the onIdentityWrite callback
    // captures the slot by reference so backend hooks land on this instance.
    // Stryker disable all: Composition root — identity cache wiring is not unit-testable
    identityCacheSlot.cache = new IdentityCache(() => contextLayer.contextBuilder.loadCoreIdentity());
    if(identityContext !== undefined) {
        identityCacheSlot.cache.set(identityContext);
    }
    // Stryker restore all

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
        identityCache:     identityCacheSlot.cache,
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
    // Stryker disable BlockStatement,ConditionalExpression,EqualityOperator: Composition root — health subscription callback is not unit-testable
    const unsubscribeOutboxDrain = healthRegistry.subscribe((change) => {
        if(change.newState === 'online') {
            void outboxDrainer.drain(change.service);
        }
    });
    // Stryker restore BlockStatement,ConditionalExpression,EqualityOperator

    // Subscribe to health changes: reset failed sagas when a service comes back online
    // Stryker disable BlockStatement,ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,ObjectLiteral: Composition root — health subscription callback is not unit-testable
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
    // Stryker restore BlockStatement,ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,ObjectLiteral

    // Subscribe to health changes: run recovery phase when Discord reconnects.
    // Registered inside app.start() AFTER bot.start() so it only fires on reconnects.
    // Catch-up on first connection is handled by setupInboxAndCatchUp in bot.ts clientReady.
    let unsubscribeDiscordRecovery: (() => void) | undefined;

    // Wire discordReconnectFn now that bot is available.
    // Stryker disable next-line BlockStatement: Composition root wiring — async function body is not unit-testable
    discordReconnectFn = async () => {
        await bot.start();
    };

    let isStopping = false;

    return {
        // Stryker disable BlockStatement: Composition root — startup/shutdown branching is not unit-testable
        // eslint-disable-next-line sonarjs/cognitive-complexity -- composition root start(); complexity from optional service conditionals
        start: async () => {
            isStopping = false;
            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Starting Isambard application...');

            // Mark Discord as starting
            // Stryker disable next-line StringLiteral: health event string is composition root configuration
            healthRegistry.sendEvent('discord', 'CONFIGURE');

            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Connecting to Discord...');
            // Stryker disable BlockStatement,ObjectLiteral: try-catch wraps Discord startup — error handling; logger context objects not unit-testable
            try {
                await bot.start();
                // Stryker disable next-line StringLiteral: health event string is composition root configuration
                healthRegistry.sendEvent('discord', 'CONNECT_SUCCESS');
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Discord connected');
            } catch (err) {
                // Stryker disable next-line StringLiteral,ObjectLiteral: health event strings and context are composition root configuration
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
            // Stryker restore BlockStatement,ObjectLiteral

            // Register recovery subscriber now — after initial bot.start() — so it only fires on reconnects.
            // Catch-up on first connection is handled by setupInboxAndCatchUp inside bot.ts clientReady.
            // Stryker disable BlockStatement,ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,ObjectLiteral: Composition root — recovery subscriber callback is not unit-testable
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
            // Stryker restore BlockStatement,ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,ObjectLiteral

            // Start email listener (independent of Discord — email works even if Discord is offline)
            // Stryker disable BlockStatement,ObjectLiteral,StringLiteral: try-catch wraps email listener start - composition root error handling; logger context objects not unit-testable
            if(emailSetup) {
                try {
                    await emailSetup.listener.start();
                    logger.info({ msg: 'Email listener started' });
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        msg:   'Failed to start email listener',
                    });
                }
            }
            // Stryker restore BlockStatement,ObjectLiteral,StringLiteral

            // Register slash commands (non-fatal — Discord may be connected but commands fail)
            // Stryker disable BlockStatement,ObjectLiteral,StringLiteral: Composition root — not unit-testable; logger context objects not unit-testable
            try {
                await registerAllCommands(discordInfra.discordClient, commandBuilders);
            } catch (err) {
                logger.warn({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'Slash command registration failed, will retry on next startup',
                });
            }
            // Stryker restore BlockStatement,ObjectLiteral,StringLiteral

            // These start regardless of Discord availability
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional startup - equivalent mutant
            if(storage.reconciliationScheduler) {
                storage.reconciliationScheduler.start();
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Tag index reconciliation scheduler started');
            }

            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional startup - equivalent mutant
            if(storage.contactReconciliationScheduler) {
                storage.contactReconciliationScheduler.start();
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Contact reconciliation scheduler started');
            }

            // Start saga executor polling loop
            sagaExecutor.start();

            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Isambard application started successfully');
        },
        // Stryker restore BlockStatement

        // Stryker disable BlockStatement: Composition root — startup/shutdown branching is not unit-testable
        // eslint-disable-next-line sonarjs/cognitive-complexity, complexity -- stop() is a composition-root shutdown handler; complexity is inherent from cleaning up multiple optional services including vector index lifecycle
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
            dynamoDBReconnectionLoop.stop();
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
            unsubscribeDynamoDBReconnect();
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

            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(storage.contactReconciliationScheduler) {
                storage.contactReconciliationScheduler.stop();
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Contact reconciliation scheduler stopped');
            }

            // Close browser adapter if running
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(browserAdapter) {
                browserAdapter.close();
            }

            // Stop email listener and WildDuck client before bot.stop()
            // (email lifecycle moved here since listener now starts in app.start())
            // Stryker disable BlockStatement,ObjectLiteral,StringLiteral: try-catch isolates email stop from Discord cleanup; logger context objects not unit-testable
            if(emailSetup) {
                try {
                    await emailSetup.listener.stop();
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        msg:   'Email listener stop failed during shutdown',
                    });
                }
                // Stryker restore BlockStatement,ObjectLiteral,StringLiteral
                // Stryker disable BlockStatement,ObjectLiteral,StringLiteral: try-catch isolates WildDuck shutdown from Discord cleanup; logger context objects not unit-testable
                try {
                    await emailSetup.wildDuckClient.shutdown();
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        msg:   'WildDuck client shutdown failed during email teardown',
                    });
                }
            }
            // Stryker restore BlockStatement,ObjectLiteral,StringLiteral

            await bot.stop();

            // Drain and close the async indexer before closing the vector index.
            // asyncIndexer.close() waits for all pending embedding jobs to complete,
            // then closes the embedder — the indexer must be drained before the index
            // is closed so in-flight upserts can still write to SQLite.
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(storage.asyncIndexer) {
                await storage.asyncIndexer.close();
            }
            // Close the vector index (SQLite database) after the indexer is fully drained.
            // Stryker disable next-line ConditionalExpression,BlockStatement: Optional shutdown - equivalent mutant
            if(storage.vectorIndex) {
                storage.vectorIndex.close();
            }

            // Clear periodic DynamoDB probe interval.
            clearInterval(dynamoDBProbeInterval);

            // Clear health notifier so withDynamoTimeout no longer fires after shutdown.
            setDynamoHealthNotifier(undefined);

            // Destroy the DynamoDB client holder — cancels any pending grace timer and
            // synchronously destroys both the current and any in-grace previous client.
            storage.holder.destroy();

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
        // Silent: readFileSync throws when .git is a directory rather than a file,
        // which is the standard (non-worktree) case. The expected EISDIR/ENOENT is
        // not an error — it just means we are not in a worktree, so apparentRoot is
        // already correct. Logging this would fire on every normal startup.
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

    // Register process-level error boundaries to capture unhandled errors.
    // Capture registration so we can remove handlers on hot reload (prevents duplicate handlers).
    const errorBoundaryRegistration = registerErrorBoundaries(logger);

    // Copy agents and skills to scratch/.claude/ for SDK filesystem discovery
    const aspSourceRoot = path.resolve(import.meta.dir, '..', 'agents-skills-plugins');
    const targetClaudeDir = path.join(process.cwd(), '.claude');
    await syncAgentsAndSkills(aspSourceRoot, targetClaudeDir);

    // Wrap createApp() in try-catch for a clear startup failure log + clean exit.
    let app: App;
    try {
        app = await createApp();
    } catch (err) {
        logger.error({
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            msg:   'Fatal: application failed to start',
        });
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- Fatal startup error requires exit
        process.exit(1);
    }

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
            // Remove error boundary handlers to prevent duplicate handlers on next hot reload
            errorBoundaryRegistration.unregister();
            // Remove signal handlers before cleanup to prevent duplicate calls
            process.off('SIGINT', sigintHandler);
            process.off('SIGTERM', sigtermHandler);
            await app.stop();
        });
    }
}
// Stryker restore all
