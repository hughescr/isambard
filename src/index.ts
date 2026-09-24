import { readFileSync } from 'node:fs';
import { stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger, setTimezone } from '@hughescr/logger';
import env from 'env-var';
import { Resource } from 'sst';
import { loadPlugins, QuestionRegistry, syncAgentsAndSkills, createActivityLogger, PersonHistoryCoordinator, createWebViewAdapter, createTaskListReader, createCostCeiling, createCostCeilingStore, createNotificationBridge, createQuotaNotes, createHealthOutageCoalescer, shouldNotifyHealthChange, createHealthNotificationListener, systemClock, IdentityCache, type BrowserHostPolicy, type PlatformHistoryProvider, type Conductor, type LedgerStore, type ContextPolicy, type ResumeStore, type SessionJournal, type CostCeilingPersistence } from '@/agent';
import { createStorageLayer, createContextLayer, createDiscordInfrastructure, createMcpSharedDeps, createConversationConductor, createPerchConductor, createSessionAmbience, createSessionSupervisor, startSessions, loadIdentityContext, registerSignalHandlers, createDiscordRecoveryHandler, registerHotReloadInstance, stopPreviousHotReloadInstance, createStartupChain, type ConversationConductorResult, type PerchConductorResult } from '@/app';
import { loadConfig, loadDynamoDBConfig, type Config } from '@/config';
import { InvariantViolationError } from '@/errors';
import {
    BlueskyClient,
    BskyHistoryProvider,
    bskyDmContentKey,
    bskyDmParamsSchema,
    bskyReplyContentKey,
    bskyReplyParamsSchema,
    checkBskyDmDelivery,
    checkBskyReplyDelivery,
    type BskyReplyInput
} from '@/integrations/bsky';
import { CalDAVClient, CalendarRegistryBackend } from '@/integrations/caldav';
import { createDiscordBot, setupEmail, setupBsky, CalendarCommandHandler, buildCalendarCommand, ContactCommandHandler, ContactApprovalHandler, buildContactApprovalEmbed, buildContactCommand, AllowlistCommandHandler, buildAllowlistCommand, registerAllCommands, DiscordHistoryProvider, DiscordCapabilityImpl, createOutboxReplayDeliverFn, createApprovedActionOutcomeDelivery, resolveChannelId, AllowlistInteractionHandler, channelListProvider as discordChannelListProvider, type DiscordBot, type EmailSetupResult, type BskySetupResult } from '@/integrations/discord';
import { EmailHistoryProvider, EmailFolder, WildDuckClient, checkEmailSendDelivery, emailSendParamsSchema } from '@/integrations/email';
import { ServiceHealthRegistryImpl, createReconnectionLoop, OutboxBackend, createOutboxDrainer, createOutboxDrainListener, ApprovedOutboundActionBackend, createApprovedOutboundActionExecutor, createApprovedActionOutcomeReporter, createApprovedActionRetryListener, createWakingActionWriter, AllowlistSagaBackend, AllowlistSagaExecutor, registerErrorBoundaries, type ReconnectionLoop, type OutboxDrainer, type ApprovedActionOutcomeReporter, type ApprovedOutboundActionExecutor } from '@/services';
import { PersonAllowlist, probeDynamoDB, createDynamoDBClient, setDynamoHealthNotifier, runDynamoDBProbe, loadEmbedder, type ContactChangeRequest, type EmbedderLike } from '@/storage';
import { resolveTimezone } from '@/utils';

export interface App {
    /**
     * Start the application (Discord bot and Claude agent).
     */
    start: () => Promise<void>

    /**
     * Stop the application gracefully.
     */
    stop: () => Promise<void>

    /**
     * The resolved config `createApp()` was built from — exposed so the entry point's own
     * top-level wiring (`registerSignalHandlers`'s `deadlineMs`) can read
     * `config.session.shutdownDeadlineMs` without loading config a second time (P10).
     */
    config: Config
}

// Route every Agent SDK invocation through utraque while retaining an explicit direct-Claude
// fallback. Header filtering avoids carrying a stale local token across configuration changes.
function configureAgentGateway(config: Config): NonNullable<Config['agent']['gateway']> {
    const gateway = config.agent.gateway ?? {
        enabled: true, baseUrl: 'http://127.0.0.1:8317', reportRequestTimeoutMs: 100_000,
    };
    const otherCustomHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS?.split('\n')
        .filter(header => !/^\s*X-Utraque-Token\s*:/i.test(header)).join('\n');
    if(gateway.enabled) {
        process.env.ANTHROPIC_BASE_URL = gateway.baseUrl;
        process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1';
        if(gateway.localToken !== undefined) {
            process.env.ANTHROPIC_CUSTOM_HEADERS = [otherCustomHeaders, `X-Utraque-Token: ${gateway.localToken}`]
                .filter(header => header !== undefined && header.length > 0).join('\n');
        }
    } else {
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL;
        if(otherCustomHeaders === undefined || otherCustomHeaders.length === 0) {
            delete process.env.ANTHROPIC_CUSTOM_HEADERS;
        } else {
            process.env.ANTHROPIC_CUSTOM_HEADERS = otherCustomHeaders;
        }
    }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = config.agent.oauthToken;
    return gateway;
}

async function loadConfiguredEmbedder(config: Config): Promise<EmbedderLike | undefined> {
    if(!config.vectorIndex?.enabled) {
        return undefined;
    }
    try {
        const embedder = await loadEmbedder({ slug: config.vectorIndex.modelSlug, quant: config.vectorIndex.modelQuant });
        logger.info(`Embedder loaded: ${config.vectorIndex.modelSlug}/${config.vectorIndex.modelQuant}`);
        return embedder;
    } catch (err) {
        logger.warn({
            error: err instanceof Error ? err.message : String(err),
            msg:   'Embedder load failed — vector indexing disabled for this session',
        });
        return undefined;
    }
}

async function wireDynamoDBHealth(
    storage: Awaited<ReturnType<typeof createStorageLayer>>,
    dynamoDBConfig: ReturnType<typeof loadDynamoDBConfig>,
    healthRegistry: ServiceHealthRegistryImpl,
    registerCleanup: (step: Omit<ShutdownStep, 'onFailure'>) => void
) {
    // Wire DynamoDB health monitoring.
    // DynamoDB is a required dependency — we probe it with DescribeTable to detect
    // persistent failures (e.g. FailedToOpenSocket after a transient outage).
    //
    // Reconnect strategy: probe the LIVE client (via holder.getClient()) first.
    // On persistent failure, build a fresh DynamoDBClient pair and call holder.swap()
    // so all backends immediately start using the new connection pool without restart.
    healthRegistry.sendEvent('dynamodb', { type: 'CONFIGURE' });

    const dynamoDBReconnectionLoop = createReconnectionLoop({
        service:   'dynamodb',
        registry:  healthRegistry,
        connectFn: async () => {
            // First, try probing the LIVE client — if it succeeds, no swap needed.
            // If it fails, build a fresh client pair and swap into the holder so all
            // backends pick up the new connection pool on their next operation.
            let probeClient = storage.holder.getClient();
            let freshPair: ReturnType<typeof createDynamoDBClient> | undefined;
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
        },
    });
    registerCleanup({ name: 'DynamoDB reconnection loop', run: () => dynamoDBReconnectionLoop.stop() });

    // Subscribe to health changes: auto-start reconnection loop when DynamoDB goes offline
    const unsubscribeDynamoDBReconnect = healthRegistry.subscribe((change) => {
        if(change.service === 'dynamodb' && change.newState === 'offline' && !dynamoDBReconnectionLoop.isRunning()) {
            dynamoDBReconnectionLoop.start();
        }
    });
    registerCleanup({ name: 'DynamoDB reconnect subscription', run: unsubscribeDynamoDBReconnect });

    // Wire the DynamoDB health notifier so any network-classified errors thrown by
    // withDynamoTimeout (in DynamoTableAccess) also signal CONNECTION_LOST to the
    // health registry — triggering the reconnection loop without waiting for the
    // next periodic probe.
    setDynamoHealthNotifier((err) => {
        healthRegistry.sendEvent('dynamodb', {
            type:  'CONNECTION_LOST',
            error: err instanceof Error ? err.message : String(err),
        });
    });
    registerCleanup({ name: 'DynamoDB health notifier', run: () => setDynamoHealthNotifier(undefined) });

    // Perform initial DynamoDB health probe against the live client.
    // On success: mark online. On failure: start reconnection loop.
    try {
        logger.info('Probing DynamoDB connectivity...');
        await probeDynamoDB(storage.holder.getClient(), dynamoDBConfig.tableName);
        healthRegistry.sendEvent('dynamodb', { type: 'CONNECT_SUCCESS' });
        logger.info('DynamoDB connectivity verified');
    } catch (err) {
        healthRegistry.sendEvent('dynamodb', { type: 'CONNECT_FAIL', error: err instanceof Error ? err.message : String(err) });
        logger.error({
            error: err instanceof Error ? err.message : String(err),
            msg:   'DynamoDB probe failed at startup, starting reconnection loop',
        });
        dynamoDBReconnectionLoop.start();
    }

    // Periodic DynamoDB background probe — detects post-startup connection failures
    // that would otherwise go unnoticed until the next operation fails.
    // Interval: 60s. Sends CONNECTION_LOST on failure, which the lifecycle state machine
    // handles by transitioning online → offline, triggering the reconnection loop.
    const dynamoDBProbeIntervalMs = 60_000;
    const dynamoDBProbeInterval = setInterval(() => {
        void runDynamoDBProbe(storage.holder.getClient(), dynamoDBConfig.tableName, healthRegistry, logger);
    }, dynamoDBProbeIntervalMs);
    registerCleanup({ name: 'DynamoDB probe', run: () => clearInterval(dynamoDBProbeInterval) });

    return { dynamoDBReconnectionLoop, unsubscribeDynamoDBReconnect, dynamoDBProbeInterval };
}

type ShutdownStep = {
    name: string
    run:  () => void | Promise<void>
} & ({ onFailure: 'propagate' } | { onFailure: 'log-and-continue' });

/** Preserve shutdown order while allowing later owners to release resources after a failure. */
async function runShutdownSteps(steps: readonly ShutdownStep[]): Promise<void> {
    const failures: { step: ShutdownStep, error: unknown }[] = [];
    for(const step of steps) {
        try {
            // eslint-disable-next-line no-await-in-loop -- shutdown owners must settle in dependency order
            await step.run();
        } catch (error) {
            failures.push({ step, error });
        }
    }
    reportShutdownFailures(failures);
}

function reportShutdownFailures(failures: readonly { step: ShutdownStep, error: unknown }[]): void {
    const fatalFailures: { name: string, error: Error }[] = [];
    for(const { step, error } of failures) {
        switch(step.onFailure) {
            case 'propagate': {
                fatalFailures.push({ name: step.name, error: error instanceof Error ? error : new Error(String(error)) });
                break;
            }
            case 'log-and-continue': {
                logger.error({
                    error: error instanceof Error ? error.message : String(error),
                    msg:   `Best-effort shutdown failed: ${step.name}`,
                });
                break;
            }
        }
    }

    const [first] = fatalFailures;
    if(first === undefined) {
        return;
    }
    if(fatalFailures.length === 1) {
        throw first.error;
    }
    throw new AggregateError(
        fatalFailures.map(({ name, error }) => new Error(`${name} shutdown failed`, { cause: error })),
        'Application shutdown failed'
    );
}

/**
 * Creates the Isambard application with all components wired together.
 *
 * Initialization flow:
 * 1. Load configuration (Discord, Agent OAuth token)
 * 2. Set CLAUDE_CODE_OAUTH_TOKEN for Agent SDK
 * 3. Create memory system (context builder + MCP server) if DynamoDB is available
 * 4. Create Claude agent with hybrid memory support
 * 5. Create Discord bot with agent as message handler
 *
 * Error handling:
 * - Missing required config (Discord, OAuth token) throws immediately
 * - Factory functions throw with descriptive errors if initialization fails
 *
 * @returns Application instance with start/stop methods
 * @throws {Error} If required configuration is missing or invalid
 */
async function createAppLifecycle(): Promise<App> {
    const cleanupSteps: ShutdownStep[] = [];
    const registerCleanup = (step: Omit<ShutdownStep, 'onFailure'>): void => {
        cleanupSteps.unshift({ ...step, onFailure: 'propagate' });
    };
    try {
        return await buildAppLifecycle(registerCleanup);
    } catch (error) {
        try {
            await runShutdownSteps(cleanupSteps);
        } catch (cleanupError) {
            try {
                logger.error({ cleanupError, msg: 'Lifecycle construction cleanup failed' });
            } catch{
                // A logger failure must not replace the construction error.
            }
        }
        throw error;
    }
}

async function buildAppLifecycle(registerCleanup: (step: Omit<ShutdownStep, 'onFailure'>) => void): Promise<App> {
    // Load configuration (required)

    const config = loadConfig(Resource);
    const gateway = configureAgentGateway(config);
    // Create health registry for service lifecycle tracking
    const healthRegistry = new ServiceHealthRegistryImpl({ logger });
    registerCleanup({ name: 'health registry', run: () => healthRegistry.stop() });

    // Create question registry for interactive questions (shared between MCP and bot)
    const questionRegistry = new QuestionRegistry();

    // Create DynamoDB client (REQUIRED)

    const dynamoDBConfig = loadDynamoDBConfig(Resource);

    // Load embedder for vector indexing (if enabled)
    const embedder = await loadConfiguredEmbedder(config);
    let embedderCloseAttemptedByIndexer = false;
    registerCleanup({ name: 'embedder', run: () => (embedderCloseAttemptedByIndexer ? undefined : embedder?.close()) });

    // Create a stable callback slot for identity-write invalidation.
    // The identityCache is created below after identityContext is loaded, but
    // MemoryToolBackend needs the callback at construction time.
    // Indirection: a mutable slot object whose reference is captured by the closure.
    const identityCacheSlot: { cache: IdentityCache | undefined } = { cache: undefined };
    const onIdentityWrite = (): void => {
        identityCacheSlot.cache?.invalidate();
    };

    // Create infrastructure layers
    const storage = await createStorageLayer(
        dynamoDBConfig,
        config.reconciliation,
        config.contactReconciliation,
        config.vectorIndex,
        embedder,
        onIdentityWrite,
        () => { embedderCloseAttemptedByIndexer = true; }
    );
    registerCleanup({ name: 'DynamoDB client holder', run: () => storage.holder.destroy() });
    registerCleanup({ name: 'vector index', run: () => storage.vectorIndex?.close() });
    registerCleanup({ name: 'async indexer', run: () => storage.asyncIndexer?.close() });
    registerCleanup({ name: 'tag reconciliation scheduler', run: () => storage.tagIndexReconciliationScheduler?.stop() });
    registerCleanup({ name: 'contact reconciliation scheduler', run: () => storage.contactReconciliationScheduler?.stop() });

    const { dynamoDBReconnectionLoop, unsubscribeDynamoDBReconnect, dynamoDBProbeInterval } = await wireDynamoDBHealth(storage, dynamoDBConfig, healthRegistry, registerCleanup);

    const botForConstructionCleanup: { bot: DiscordBot | undefined } = { bot: undefined };
    const discordInfra = createDiscordInfrastructure({
        discordConfig:         config.discord,
        docClient:             storage.holder,
        tableName:             storage.tableName,
        operationalStateStore: storage.operationalStateStore,
        onClientCreated:       client => registerCleanup({
            name: 'Discord bot/client',
            run:  () => botForConstructionCleanup.bot?.stop() ?? client.destroy(),
        }),
    });

    // Outbox and approved-outbound-action backends (always available — DynamoDB is required)
    const outboxBackend                 = new OutboxBackend(storage.holder, storage.tableName);
    const approvedOutboundActionBackend = new ApprovedOutboundActionBackend(storage.holder, storage.tableName);

    // Approval rows wake the executor as soon as they are durably written, so an approved send
    // goes out within seconds rather than on the next (up to 5-minute) poll. The executor is
    // built further down — its send functions close over emailSetup and bskyClient — so the wake
    // is late-bound, like discordReconnectFn below. Until it is bound, and while the executor is
    // not started, a wake is a no-op and the executor's first poll picks the row up; approval
    // clicks only arrive after the bot has started, so neither case arises in practice.
    let wakeApprovedActionExecutor: () => void = () => undefined;
    const approvedActionWriter = createWakingActionWriter(approvedOutboundActionBackend, () => {
        wakeApprovedActionExecutor();
    });

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
    logger.info('Loading person allowlist...');
    await personAllowlist.load();
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

    // Notification core (Q5 / plan amendment B1): constructed here, BEFORE setupEmail and the
    // conductor-mode block below, because the real conductor does not exist yet at this point —
    // createConversationConductor itself consumes email's MCP server instance, so the dependency
    // runs the other way. notify() is a safe no-op (debug log, drop) until
    // notificationBridge.attachConductor() late-binds the real conductor once
    // createConversationConductor resolves (Q7 threads notificationBridge.notify into
    // setupEmail's options).
    // Session-peers block 4: the process-wide ambient surface — ONE quota poller (block 3) both
    // session ledgers register with, and one time-header provider per role. Every producer of a
    // per-turn time header below takes its provider from here, so each turn also carries the
    // other session's one-line summary and the shared-subscription quota line.
    //
    // Two refresh paths feed that poller, and BOTH are needed:
    //  - the per-`result`-frame refresh the ambience wires into each registered ledger (debounced
    //    to at most one request per 30s), which only fires while Izzy is taking turns; and
    //  - the recurring `config.agent.quota.pollIntervalMs` timer, armed in start() and cancelled
    //    in stop() below, which refreshes Codex and DeepSeek capacity while Izzy is idle.
    // Anthropic quota comes only from Agent SDK rate-limit events. Those events cannot observe
    // Craig's external Claude spend while Izzy is idle; the pause guard deliberately retains its
    // prior peak until another SDK event arrives rather than weakening that safety policy here.
    const providerHeaders = (): Record<string, string> => ({
        ...(gateway.localToken === undefined ? {} : { 'X-Utraque-Token': gateway.localToken }),
    });
    const ambience = createSessionAmbience({
        timezone: config.session.timezone,
        clock:    systemClock,
        logger,
        quota:    {
            fetch:                globalThis.fetch,
            url:                  `${gateway.baseUrl.replace(/\/$/, '')}/utraque/providers/v2`,
            headers:              providerHeaders,
            preferVendorReport:   gateway.enabled,
            anthropicQuotaSource: 'sdk',
            pollIntervalMs:       config.agent.quota.pollIntervalMs,
            requestTimeoutMs:     gateway.reportRequestTimeoutMs,
        },
    });
    registerCleanup({ name: 'quota poller', run: () => ambience.quotaPoller.stop() });
    const conversationTimeHeader = ambience.timeHeaderFor('conversation');
    const perchTimeHeader = ambience.timeHeaderFor('perch');

    const notificationBridge = createNotificationBridge({
        clock:      systemClock,
        timezone:   config.session.timezone,
        timeHeader: () => conversationTimeHeader(config.session.timezone),
        logger,
    });
    registerCleanup({ name: 'notification bridge', run: () => notificationBridge.detach() });

    // Set up email integration if email config is present (conditional — non-fatal)
    // Must happen before contextLayer so the email service can be wired into the perch prompt
    //
    // Design: create WildDuckClient eagerly and wire all downstream objects immediately so
    // that consumer references (historyProviders, emailService, emailMcpServer, etc.) are
    // stable.  Only init() (authenticate + load mailboxes) is retried on failure — the client
    // object itself never changes, so no stale-reference problem exists after reconnection.
    let emailSetup: EmailSetupResult | undefined;
    let eagerWildDuckClient: WildDuckClient | undefined;
    let emailInitInFlight: Promise<void> | undefined;
    let emailStopping = false;
    let emailReconnectionLoop: ReconnectionLoop | undefined;
    let unsubscribeEmailReconnect: (() => void) | undefined;
    function trackEmailInit(client: WildDuckClient): Promise<void> {
        if(emailStopping) {
            return Promise.reject(new Error('Email integration is stopping'));
        }
        const attempt = client.init();
        emailInitInFlight = attempt;
        const clear = (): void => {
            if(emailInitInFlight === attempt) {
                emailInitInFlight = undefined;
            }
        };
        void attempt.finally(clear).catch(() => { /* The original attempt handles this rejection. */ });
        return attempt;
    }
    async function shutdownEmailClient(): Promise<void> {
        emailStopping = true;
        try {
            await emailInitInFlight;
        } catch{ /* A failed init still must settle before shutdown. */ }
        await eagerWildDuckClient?.shutdown();
    }
    async function initializeEmailIntegration(): Promise<void> {
        if(config.email) {
            healthRegistry.sendEvent('email', { type: 'CONFIGURE' });

            // Create client eagerly so all downstream objects can capture a stable reference.
            eagerWildDuckClient = new WildDuckClient({
                url:              config.email.wildDuckApiUrl,
                user:             config.email.user,
                password:         config.email.password,
                maxBodySizeBytes: config.email.maxBodySizeBytes,
            });
            const stableWildDuckClient = eagerWildDuckClient;
            // Construction rollback remains fatal; only graceful shutdown is best-effort.
            registerCleanup({ name: 'WildDuck client', run: shutdownEmailClient });

            // Create reconnection loop eagerly so post-connect drops are also handled.
            emailReconnectionLoop = createReconnectionLoop({
                service:   'email',
                registry:  healthRegistry,
                connectFn: async () => {
                    await trackEmailInit(stableWildDuckClient);
                },
            });
            registerCleanup({ name: 'email reconnection loop', run:  () => {
                emailStopping = true;
                emailReconnectionLoop?.stop();
            } });

            // Subscribe to health changes: auto-start reconnection loop when email goes offline
            unsubscribeEmailReconnect = healthRegistry.subscribe((change) => {
                if(!emailStopping && change.service === 'email' && change.newState === 'offline' && emailReconnectionLoop && !emailReconnectionLoop.isRunning()) {
                    emailReconnectionLoop.start();
                }
            });
            registerCleanup({ name: 'email reconnect subscription', run: () => unsubscribeEmailReconnect?.() });

            // Wire all downstream objects now (before init succeeds).
            // Health guards on MCP tools prevent usage until init() succeeds.
            // setupEmail with a pre-created wildDuckClient skips client creation and init().
            logger.info('Setting up email integration...');
            try {
                emailSetup = await setupEmail({
                    emailConfig:           config.email,
                    docClient:             storage.holder,
                    tableName:             storage.tableName,
                    client:                discordInfra.discordClient,
                    adminDiscordUserId:    config.adminDiscordUserId,
                    adminDiscordChannelId: config.adminDiscordChannelId,
                    activityLogger,
                    wildDuckClient:        stableWildDuckClient,
                    healthRegistry,
                    reconnectionLoop:      emailReconnectionLoop,
                    discordCapability,
                    approvedActions:       approvedActionWriter,
                    personAllowlist,
                    allowlistInteractionHandler,
                    notify:                notificationBridge.notify,
                });
                // Construction rollback remains fatal; only graceful shutdown is best-effort.
                registerCleanup({ name: 'email listener', run: () => emailSetup?.listener.stop() });
            } catch (err) {
                // Non-WildDuck setup failure (e.g. allowlist DynamoDB load) — log and skip email.
                logger.error({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'Email integration setup failed (non-WildDuck), email unavailable for this session',
                });
            }

            // Attempt to authenticate the WildDuck client (init = authenticate + load mailboxes).
            // Even if emailSetup failed above, we try init so health state is correct.
            try {
                logger.info('Starting WildDuck client...');
                await trackEmailInit(stableWildDuckClient);
                healthRegistry.sendEvent('email', { type: 'CONNECT_SUCCESS' });
                logger.info('WildDuck client initialized');
            } catch (err) {
                healthRegistry.sendEvent('email', { type: 'CONNECT_FAIL', error: err instanceof Error ? err.message : String(err) });
                logger.error({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'WildDuck init failed, starting reconnection loop',
                });
                // Retry only init() — downstream objects already hold stable refs to the same client.
                emailReconnectionLoop.start();
            }
        }
    }
    await initializeEmailIntegration();

    // Set up Bluesky integration if bsky config is present (conditional — non-fatal)
    let bskyClient: BlueskyClient | undefined;
    let bskyReconnectionLoop: ReconnectionLoop | undefined;
    let unsubscribeBskyReconnect: (() => void) | undefined;
    async function initializeBlueskyIntegration(): Promise<void> {
        if(config.bsky) {
            healthRegistry.sendEvent('bsky', { type: 'CONFIGURE' });

            // Create client eagerly so reconnection loop can capture a stable reference.
            bskyClient = new BlueskyClient({
                handle:      config.bsky.handle,
                appPassword: config.bsky.appPassword,
                serviceUrl:  config.bsky.serviceUrl,
                healthRegistry,
            });

            // Capture a stable reference for the reconnection closure — TS cannot narrow
            // the outer mutable variable inside an async callback.
            const stableBskyClient = bskyClient;

            // Create reconnection loop eagerly so post-connect drops are also handled.
            bskyReconnectionLoop = createReconnectionLoop({
                service:   'bsky',
                registry:  healthRegistry,
                connectFn: async () => {
                    await stableBskyClient.login();
                },
            });
            registerCleanup({ name: 'Bluesky reconnection loop', run: () => bskyReconnectionLoop?.stop() });

            // Subscribe to health changes: auto-start reconnection loop when bluesky goes offline
            unsubscribeBskyReconnect = healthRegistry.subscribe((change) => {
                if(change.service === 'bsky' && change.newState === 'offline' && bskyReconnectionLoop && !bskyReconnectionLoop.isRunning()) {
                    bskyReconnectionLoop.start();
                }
            });
            registerCleanup({ name: 'Bluesky reconnect subscription', run: () => unsubscribeBskyReconnect?.() });

            try {
                logger.info('Logging into Bluesky...');
                await bskyClient.login();
                healthRegistry.sendEvent('bsky', { type: 'CONNECT_SUCCESS' });
                logger.info('Bluesky login successful');
            } catch (err) {
                healthRegistry.sendEvent('bsky', { type: 'CONNECT_FAIL', error: err instanceof Error ? err.message : String(err) });
                logger.error({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'Bluesky login failed, starting reconnection loop',
                });
                // Keep bskyClient alive so reconnection can retry login on the same client.
                // Health guards on MCP tools will prevent usage until login succeeds.
                bskyReconnectionLoop.start();
            }
        }
    }
    await initializeBlueskyIntegration();

    // Set up Bluesky safety rails whenever a bsky client exists; approvals go to the admin review channel
    let bskySetup: BskySetupResult | undefined;
    async function initializeBlueskySafetyRails(): Promise<void> {
        if(bskyClient) {
            try {
                logger.info('Setting up Bluesky safety rails...');
                bskySetup = await setupBsky({
                    bskyClient,
                    docClient:             storage.holder,
                    tableName:             storage.tableName,
                    client:                discordInfra.discordClient,
                    adminDiscordChannelId: config.adminDiscordChannelId,
                    activityLogger,
                    discordCapability,
                    approvedActions:       approvedActionWriter,
                    personAllowlist,
                    allowlistInteractionHandler,
                    operationalStateStore: storage.operationalStateStore,
                    healthRegistry,
                    notify:                notificationBridge.notify,
                });
                registerCleanup({ name: 'Bluesky DM poller', run: () => bskySetup?.dmPoller.stop() });
            } catch (err) {
                logger.error({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'Bluesky safety rails setup failed, disabling Bluesky integration',
                });
            }
        }

        // If bsky client exists and login succeeded (health=online) but safety rails were not set up,
        // disable Bluesky for the current session to prevent unguarded posting.
        // If login failed (health!=online), bskyClient is kept alive for reconnection; safety rails
        // will remain unavailable until a restart, so write tools stay disabled via approval-flow checks.
        if(bskyClient && !bskySetup && healthRegistry.isAvailable('bsky')) {
            logger.warn({ msg: 'Bluesky client available but safety rails not configured — disabling Bluesky writes for this session' });
            bskyClient = undefined;
        }
    }
    await initializeBlueskySafetyRails();

    // Create Discord reconnection loop eagerly — must be created before createMCPServers() so it
    // can be threaded into Discord MCP health guards.  The connectFn is deferred through a
    // mutable reference so the loop can be created before `bot` is constructed.
    // eslint-disable-next-line prefer-const -- assigned below after bot is constructed; `let` is required for the deferred-wiring pattern
    let discordReconnectFn: (() => Promise<void>) | undefined;
    const discordReconnectionLoop = createReconnectionLoop({
        service:   'discord',
        registry:  healthRegistry,
        connectFn: async () => {
            if(discordReconnectFn === undefined) {
                throw new InvariantViolationError('discordReconnectionLoop.connectFn', 'discordReconnectFn not yet wired — reconnection loop fired before bot was constructed');
            }
            await discordReconnectFn();
        },
    });
    registerCleanup({ name: 'Discord reconnection loop', run: () => discordReconnectionLoop.stop() });

    // Subscribe to health changes: auto-start reconnection loop when Discord goes offline
    const unsubscribeDiscordReconnect = healthRegistry.subscribe((change) => {
        if(change.service === 'discord' && change.newState === 'offline' && !discordReconnectionLoop.isRunning()) {
            discordReconnectionLoop.start();
        }
    });
    registerCleanup({ name: 'Discord reconnect subscription', run: unsubscribeDiscordReconnect });

    // Outbox drainer — delivers queued Discord messages when Discord comes back online
    const outboxDrainer: OutboxDrainer = createOutboxDrainer({
        outboxBackend,
        registry:  healthRegistry,
        deliverFn: createOutboxReplayDeliverFn({ fetchChannel: channelId => discordCapability.fetchChannel(channelId) }),
        logger,
    });
    registerCleanup({ name: 'outbox drainer', run: () => outboxDrainer.stop() });

    // Approved-action outcome reporter — tells the admin (on the approval card) and Izzy what
    // really happened to each executed or failed action, from the row's durable outbox marker,
    // so a restart or an unavailable Discord/conductor retries the report, never the send.
    const approvedActionOutcomeReporter: ApprovedActionOutcomeReporter = createApprovedActionOutcomeReporter({
        backend: approvedOutboundActionBackend,
        deliver: createApprovedActionOutcomeDelivery({
            // The raw client lookup, not discordCapability.fetchChannel: that one resolves null on
            // ANY failure, which would make a transient REST error look like a deleted channel
            // and give up on the card for good.
            fetchChannel:   channelId => discordInfra.discordClient.channels.fetch(channelId),
            isDiscordReady: () => discordCapability.isReady(),
            notify:         notificationBridge.notify,
            backend:        approvedOutboundActionBackend,
        }),
        logger,
    });
    registerCleanup({ name: 'approved action outcome reporter', run: () => approvedActionOutcomeReporter.stop() });

    // Approved-outbound-action executor — executes approved bsky/email actions, including after service recovery
    const approvedActionExecutor: ApprovedOutboundActionExecutor = createApprovedOutboundActionExecutor({
        backend:           approvedOutboundActionBackend,
        registry:          healthRegistry,
        onOutcomeRecorded: () => {
            approvedActionOutcomeReporter.wake();
        },
        executors: {
            bsky_reply: async (params, signal) => {
                if(!bskyClient) {
                    throw new InvariantViolationError('approvedActionExecutor.bsky_reply', 'Bluesky client not available');
                }
                // The flat stored shape is parsed (and AT-URI/CID branded) here; the domain
                // BskyReplyInput is built from its fields.
                const parsed = bskyReplyParamsSchema.parse(params);
                const reply: BskyReplyInput = {
                    parent: { uri: parsed.parentUri, cid: parsed.parentCid },
                    root:   (parsed.rootUri !== undefined && parsed.rootCid !== undefined) ? { uri: parsed.rootUri, cid: parsed.rootCid } : undefined,
                };
                await bskyClient.replyToPost(parsed.text, reply, signal);
            },
            bsky_dm: async (params, signal) => {
                if(!bskyClient) {
                    throw new InvariantViolationError('approvedActionExecutor.bsky_dm', 'Bluesky client not available');
                }
                const parsed = bskyDmParamsSchema.parse(params);
                await bskyClient.sendDirectMessage(parsed.convoId, parsed.text, signal);
            },
            email_send: async (params, signal) => {
                if(!emailSetup) {
                    throw new InvariantViolationError('approvedActionExecutor.email_send', 'Email not available');
                }
                const uid = emailSendParamsSchema.parse(params).uid;
                await emailSetup.wildDuckClient.submitMessage(EmailFolder.Drafts, uid, signal);
            },
        },
        // #108: when a send's outcome is unknown, look for it at its destination before any resend.
        verifiers: {
            bsky_reply: {
                contentKey: bskyReplyContentKey,
                check:      async (input) => {
                    if(!bskyClient) {
                        throw new InvariantViolationError('approvedActionExecutor.verifiers.bsky_reply', 'Bluesky client not available');
                    }
                    return checkBskyReplyDelivery(bskyClient, input);
                },
            },
            bsky_dm: {
                contentKey: bskyDmContentKey,
                check:      async (input) => {
                    if(!bskyClient) {
                        throw new InvariantViolationError('approvedActionExecutor.verifiers.bsky_dm', 'Bluesky client not available');
                    }
                    return checkBskyDmDelivery(bskyClient, input);
                },
            },
            email_send: {
                contentKey: () => undefined,
                check:      async (input) => {
                    if(!emailSetup) {
                        throw new InvariantViolationError('approvedActionExecutor.verifiers.email_send', 'Email not available');
                    }
                    return checkEmailSendDelivery(emailSetup.wildDuckClient, input);
                },
            },
        },
        logger,
        activityLogger,
    });
    registerCleanup({ name: 'approved outbound action executor', run: () => approvedActionExecutor.stop() });
    wakeApprovedActionExecutor = () => {
        approvedActionExecutor.wake();
    };

    function createHistoryCoordinator(): PersonHistoryCoordinator {
        // History providers
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

        return new PersonHistoryCoordinator({
            contactBackend: storage.contactBackend,
            providers:      historyProviders,
        });
    }
    const historyCoordinator = createHistoryCoordinator();

    // Build email service from emailSetup components (if available)
    const emailService = emailSetup
        ? { wildDuckClient: emailSetup.wildDuckClient }
        : undefined;

    // Build bsky DM service from bskyClient (if available and safety rails active)
    const bskyDMService = bskyClient ? { client: bskyClient } : undefined;

    // Create CalDAV components (always available — DynamoDB is required)
    const caldavClient = new CalDAVClient({ healthRegistry });
    healthRegistry.sendEvent('caldav', { type: 'CONFIGURE' });
    healthRegistry.sendEvent('caldav', { type: 'CONNECT_SUCCESS' });
    const caldavRegistry = new CalendarRegistryBackend(storage.holder, storage.tableName);
    const calendarService = { client: caldavClient, registry: caldavRegistry };
    const calendarHandler = new CalendarCommandHandler(
        caldavClient,
        caldavRegistry,
        config.adminDiscordUserId
    );

    // Set up Contacts approval handler (always available — DynamoDB is required)
    const contactApprovalHandler = new ContactApprovalHandler(storage.contactBackend, personAllowlist);

    // Build sendContactApprovalRequest callback — posts approval embed to the admin review channel.
    // Always wired: the admin review channel is required top-level config, independent of email.
    const sendContactApprovalRequest = async (details: ContactChangeRequest): Promise<void> => {
        const uuid = crypto.randomUUID();
        contactApprovalHandler.storePendingRequest(uuid, details);
        const { embed, actionRow } = buildContactApprovalEmbed(details, uuid);
        await discordCapability.sendToChannel(
            config.adminDiscordChannelId,
            { embeds: [embed], components: [actionRow] },
            { priority: 'high', type: 'contact_approval' }
        );
    };

    const contextLayer = createContextLayer(storage.memoryBackend, emailService, bskyDMService, calendarService, bskySetup?.rejectionBackend, healthRegistry);

    function createBrowserIntegration(): { browserAdapter: ReturnType<typeof createWebViewAdapter> | undefined, browserPolicy: BrowserHostPolicy | undefined } {
        // Construct browser adapter — macOS only (Bun.WebView requires darwin), and only when browser config is present
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

        return { browserAdapter, browserPolicy };
    }
    const { browserAdapter, browserPolicy } = createBrowserIntegration();
    registerCleanup({ name: 'browser adapter', run: () => browserAdapter?.close() });

    // Shared once (P9 verifier correction): built here so both the legacy agent's own
    // 'conversation'-role MCP instance set (below, unchanged from the old createMCPServers()
    // wrapper's behaviour) and createConversationConductor's own, separate instance set (built
    // further below, in conductor mode only) reuse the same singleton state (DMTracker,
    // BskyCheckpointManager) rather than constructing it twice.
    function buildMcpSharedDeps(): ReturnType<typeof createMcpSharedDeps> {
        return createMcpSharedDeps({
            memoryBackend:             storage.memoryBackend,
            operationalStateStore:     storage.operationalStateStore,
            messageSearchService:      discordInfra.messageSearchService,
            discordClient:             discordInfra.discordClient,
            questionRegistry,
            channelRegistry:           discordInfra.channelRegistry,
            inboxManager:              discordInfra.inboxManager,
            timezone:                  resolveTimezone(),
            recordAccess:              paths => storage.memoryBackend.recordMemoryAccess(paths, new Date()),
            bskyClient,
            bskyAllowlist:             bskySetup?.allowlist,
            bskyRateLimiter:           bskySetup?.rateLimiter,
            bskySendApprovalRequest:   bskySetup?.sendApprovalRequest,
            bskySendDMApprovalRequest: bskySetup?.sendDMApprovalRequest,
            bskyRejectionBackend:      bskySetup?.rejectionBackend,
            caldavClient,
            caldavRegistry,
            contacts:                  { backend: storage.contactBackend, sendApprovalRequest: sendContactApprovalRequest },
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
            personAllowlist,
        });
    }
    const mcpSharedDeps = buildMcpSharedDeps();

    // Load plugins for the conductor build below (P13b: the one-shot agent that used to consume
    // this — and the createMCPServers()/createMcpServerInstances() per-session set it built — is
    // gone; the conductor builds its own MCP instance set from mcpSharedDeps).
    logger.info('Loading plugins...');
    const plugins = await loadPlugins(path.join(path.resolve(import.meta.dir, '..'), 'agents-skills-plugins', 'plugins'));
    logger.info('Plugins loaded');

    // Load identity
    logger.info('Loading identity context...');
    const identityContext = await loadIdentityContext(config.agent.oauthToken, contextLayer.contextBuilder);
    logger.info('Identity context loaded');

    // Create identity cache with the loaded identity context as warm seed.
    // Wire contextBuilder as the loader for future invalidate/reload cycles.
    // `identityCacheSlot.cache` is assigned here; the onIdentityWrite callback
    // captures the slot by reference so backend hooks land on this instance.
    identityCacheSlot.cache = new IdentityCache(() => contextLayer.contextBuilder.loadCoreIdentity());
    if(identityContext !== undefined) {
        identityCacheSlot.cache.set(identityContext);
    }

    // P9: build (never open) the long-lived conversation conductor — after the OAuth env write
    // (top of this function) and mcpSharedDeps (above), and before createDiscordBot and the
    // session supervisor, which opens it once the bot signals readiness (#41). P13b: the
    // conductor is the only path now — the one-shot legacy agent it used to sit beside is gone.
    //
    // #39: the last thinking content either session's turn synopsis producer saw (last writer
    // wins), for the idle Discord status generator's context. Both conductor factories feed it;
    // the bot only reads it.
    let lastThinkingContent: string | undefined;
    const setLastThinkingContent = (content: string): void => {
        lastThinkingContent = content;
    };
    let conversationConductor: Conductor | undefined;
    let conversationLedgerStore: LedgerStore | undefined;
    let conversationContextPolicy: ContextPolicy | undefined;
    let conversationJournal: SessionJournal | undefined;
    let conversationBootLostTasks: string[] | undefined;
    // R2: threaded into createDiscordBot below so clientReady can late-bind the Discord-backed
    // wake-turn delivery function it builds once responseRouter/rateLimiter exist — see
    // ConversationConductorResult.setWakeTurnDelivery's own doc.
    let conversationSetWakeTurnDelivery: ConversationConductorResult['setWakeTurnDelivery'] | undefined;
    {
        const conversationTaskListReader = createTaskListReader({
            getCurrentSessionId: getConversationSessionId,
            logger,
        });
        conversationJournal = storage.createJournal('conversation', systemClock);
        const conversationResumeStoreRole = storage.createResumeStore('conversation');
        // A RoleResumeStore (role bound at construction) must never be assigned directly to a
        // ResumeStore-typed value — see resume-store.ts's own warning: the two ports' `save`
        // signatures differ only in parameter count, which TS's assignability rules would
        // otherwise accept and silently mis-bind. Adapt explicitly instead.
        const conversationResumeStore: ResumeStore = {
            load: () => conversationResumeStoreRole.load(),
            save: (_role, sessionId) => conversationResumeStoreRole.save(sessionId),
        };
        // discord-envelope-provider.ts's own channelListProvider (unmuted only, '(guild)' suffix,
        // '[well-known: type]' annotations, a 'registry hydrating' marker before the channel
        // registry warms), bound to this process's channel registry/client and adapted from its
        // native `Promise<string[]>` to the boot-bundle's `Promise<string | undefined>` shape
        // (joined into one already-formatted section, matching boot-bundle.ts's own rendering).
        const rawChannelListProvider = discordChannelListProvider(discordInfra.channelRegistry, discordInfra.discordClient);
        const conversationChannelListProvider = async (): Promise<string | undefined> => {
            const channels = await rawChannelListProvider();
            return channels.length > 0 ? channels.join('\n') : undefined;
        };

        const builtConductor = await createConversationConductor({
            config:                  config.session,
            queryFn:                 query,
            mcpShared:               mcpSharedDeps,
            emailServerFactory:      emailSetup?.createEmailMcpServerInstance,
            plugins,
            contextBuilder:          contextLayer.contextBuilder,
            healthRegistry,
            identityCache:           identityCacheSlot.cache,
            taskListReader:          conversationTaskListReader,
            journal:                 conversationJournal,
            resumeStore:             conversationResumeStore,
            channelListProvider:     conversationChannelListProvider,
            clock:                   systemClock,
            logger,
            ambience,
            crossVendorRoutes:       gateway.enabled,
            onThinkingContentUpdate: setLastThinkingContent,
        });
        function getConversationSessionId(): string | undefined {
            return builtConductor.conductor.status().sessionId;
        }
        conversationConductor = builtConductor.conductor;
        notificationBridge.attachConductor(builtConductor.conductor);
        conversationLedgerStore = builtConductor.ledgerStore;
        conversationContextPolicy = builtConductor.contextPolicy;
        conversationBootLostTasks = builtConductor.bootLostTasks;
        conversationSetWakeTurnDelivery = builtConductor.setWakeTurnDelivery;
    }

    // P12: build (never open) the perch conductor, AFTER the conversation conductor above and
    // only when perch is actually configured/enabled — an unused conductor would still spend a
    // whole CLI child session for nothing. The session supervisor opens it (after the
    // conversation conductor); a failed open just leaves perch disabled, without a restart.
    let perchConductor: Conductor | undefined;
    let perchLedgerStore: LedgerStore | undefined;
    let perchJournal: SessionJournal | undefined;
    // R2: the perch conductor's own equivalent of conversationSetWakeTurnDelivery above.
    let perchSetWakeTurnDelivery: PerchConductorResult['setWakeTurnDelivery'] | undefined;
    // Pure pass-through to bot.ts's perch setup: the perch conductor owns the deferral policy
    // (see createPerchConductor), this only hands the driver its boundary callbacks.
    let perchSlotHooks: PerchConductorResult['slotHooks'] | undefined;
    if(config.perch?.enabled) {
        const perchTaskListReader = createTaskListReader({
            getCurrentSessionId: getPerchSessionId,
            logger,
        });
        perchJournal = storage.createJournal('perch', systemClock);
        const perchResumeStoreRole = storage.createResumeStore('perch');
        const perchResumeStore: ResumeStore = {
            load: () => perchResumeStoreRole.load(),
            save: (_role, sessionId) => perchResumeStoreRole.save(sessionId),
        };

        const builtPerchConductor = await createPerchConductor({
            config:                  config.session,
            queryFn:                 query,
            mcpShared:               mcpSharedDeps,
            emailServerFactory:      emailSetup?.createEmailMcpServerInstance,
            plugins,
            contextBuilder:          contextLayer.contextBuilder,
            identityCache:           identityCacheSlot.cache,
            taskListReader:          perchTaskListReader,
            journal:                 perchJournal,
            resumeStore:             perchResumeStore,
            clock:                   systemClock,
            logger,
            ambience,
            crossVendorRoutes:       gateway.enabled,
            onThinkingContentUpdate: setLastThinkingContent,
        });
        function getPerchSessionId(): string | undefined {
            return builtPerchConductor.conductor.status().sessionId;
        }
        perchConductor = builtPerchConductor.conductor;
        perchLedgerStore = builtPerchConductor.ledgerStore;
        perchSetWakeTurnDelivery = builtPerchConductor.setWakeTurnDelivery;
        perchSlotHooks = builtPerchConductor.slotHooks;
    }

    // Q3 / plan amendment B4: a day-bucketed spend ceiling that pauses perch (never Discord) once
    // config.session.dailyCostCeilingUsd is crossed, fed by both session ledgers' cumulativeUsd
    // deltas and surviving a process restart via the conversation journal (cost-ceiling-store.ts's
    // own doc). P13b: the conductor (and its journal) is unconditional now, so the persistence
    // store is always constructed.
    const costCeilingPersistence: CostCeilingPersistence = createCostCeilingStore({ journal: conversationJournal, clock: systemClock });
    const costCeiling = createCostCeiling({
        clock:       systemClock,
        timezone:    config.session.timezone,
        ceilingUsd:  config.session.dailyCostCeilingUsd,
        persistence: costCeilingPersistence,
        logger,
    });
    // A boot-time journal read failure must not block startup — the ceiling simply starts fresh,
    // as if today's spend had not yet been recorded (mirrors the P8 role-id lookup failure below).
    const costCeilingSnapshot = await costCeilingPersistence.load().catch((error: unknown) => {
        logger.warn({ error }, 'Failed to restore daily cost ceiling snapshot at boot');
        return undefined;
    });
    costCeilingSnapshot && costCeiling.restore(costCeilingSnapshot);
    conversationLedgerStore.subscribe((ledger, event) => costCeiling.record(conversationLedgerStore, ledger, event));
    perchLedgerStore?.subscribe((ledger, event) => costCeiling.record(perchLedgerStore, ledger, event));

    // Session-peers block 5: the same shared-subscription quota block 4 renders on every time
    // header, read actively — accumulate-only notes at config.agent.quota.notifyAtPercents and on
    // a window reset (quota-notes.ts), plus the perch ceiling ORed into isPerchPaused below. Both
    // ledgers feed the one instance: they carry the same reading a turn apart, and quota-notes
    // tracks each window's peak precisely so the staler of the two can never undo the fresher.
    const quotaNotes = createQuotaNotes({
        notify:              notificationBridge.notify,
        notifyAtPercents:    config.agent.quota.notifyAtPercents,
        perchPauseAtPercent: config.agent.quota.perchPauseAtPercent,
    });
    conversationLedgerStore.subscribe(ledger => quotaNotes.record(ledger));
    perchLedgerStore?.subscribe(ledger => quotaNotes.record(ledger));

    // Construct allowlist command handler using the unified PersonAllowlist
    const allowlistHandler = new AllowlistCommandHandler(
        personAllowlist,
        storage.contactBackend,
        config.adminDiscordUserId
    );

    // Create contacts command handler
    const contactCommandHandler = new ContactCommandHandler(storage.contactBackend, config.adminDiscordUserId, contactApprovalHandler, personAllowlist);

    // Create Discord bot
    logger.info('Creating Discord bot...');
    const bot: DiscordBot = createDiscordBot({
        config:                   config.discord,
        perchConfig:              config.perch,
        identityContext,
        identityCache:            identityCacheSlot.cache,
        client:                   discordInfra.discordClient,
        questionRegistry,
        inboxManager:             discordInfra.inboxManager,
        channelRegistry:          discordInfra.channelRegistry,
        contextBuilder:           contextLayer.contextBuilder,
        emailSetup,
        adminReviewChannelId:     config.adminDiscordChannelId,
        bskySetup,
        allowlistHandler,
        allowlistInteractionHandler,
        calendarHandler,
        contactHandler:           contactCommandHandler,
        contactApprovalHandler,
        activityLogger,
        healthRegistry,
        discordCapability,
        // Q3 / B4: composed perch-pause predicate — reaches only the conductor-mode perch
        // scheduler and presence composer (bot.ts); Discord's own turns are never gated by this.
        // Session-peers block 5 ORs the quota ceiling into the same predicate, so a nearly-spent
        // five-hour window pauses perch through the machinery that already exists (scheduler.ts's
        // skip and presence's `⏸ perch` marker), and self-clears when that window resets.
        isPerchPaused:            () => costCeiling.isPaused() || quotaNotes.isPaused(),
        getLastThinkingContent:   () => lastThinkingContent,
        // Q5 / B1: the shared notification bridge's notify function — a safe no-op until
        // notificationBridge.attachConductor() has run (above). Q6-Q8 wire the actual
        // notification sources; this package only threads the seam through.
        notify:                   notificationBridge.notify,
        // P9/P13b: conductor-mode dependencies. The session supervisor (below) opens the
        // conductors once the bot signals readiness and hands the bot the outcome; the bot only
        // wires Discord around whichever sessions opened.
        conversationConductor,
        ledgerStore:              conversationLedgerStore,
        contextPolicy:            conversationContextPolicy,
        // P12: the perch conductor and its ledger, undefined unless perch is enabled.
        perchConductor,
        perchLedgerStore,
        // R1: without this, catchup-setup.ts always falls back to its own hard-coded 24h
        // default regardless of an operator-configured config.session.bootEventsWindowMs.
        bootEventsWindowMs:       config.session.bootEventsWindowMs,
        // R1: the pre-open recovery snapshot for the merged Discord boot envelope — see
        // ConversationConductorResult.bootLostTasks's own doc for why this must come from
        // createConversationConductor rather than a read done inside bot.ts/catchup-setup.ts.
        bootLostTasks:            conversationBootLostTasks,
        // R2: threaded so clientReady can attach a host-notification reply's delivery to the
        // Discord-backed wake-turn delivery function it builds, and late-bind that same function
        // (or a separate perch one) onto whichever conductor(s) actually exist.
        notificationBridge,
        setWakeTurnDelivery:      conversationSetWakeTurnDelivery,
        setPerchWakeTurnDelivery: perchSetWakeTurnDelivery,
        // Session-peers block 4: each role's ambient time-header provider, threaded to every
        // Discord-side producer (the conductor processor, the boot/catch-up envelopes, the
        // perch-channel envelope and the perch slot envelope).
        timeHeader:               conversationTimeHeader,
        perchTimeHeader,
        perchSlotHooks,
    });
    botForConstructionCleanup.bot = bot;
    logger.info('Discord bot created');

    // #41: the session supervisor owns session open, failure, shutdown and boot-recovery policy
    // (src/app/runtime.ts). It opens nothing until app.start() launches startSessions, which waits
    // for the bot's first clientReady. The conversation conductor is always built (P13b), so it
    // is always supervised; perch only when enabled.
    const sessionSupervisor = createSessionSupervisor({
        conversation: { conductor: conversationConductor, journal: conversationJournal },
        perch:        perchConductor && perchJournal ? { conductor: perchConductor, journal: perchJournal } : undefined,
        turnWaitMs:   config.session.shutdownTurnWaitMs,
        deadlineMs:   config.session.shutdownDeadlineMs,
        stopIngress:  () => {
            bot.stopIngress();
        },
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- the one place this process terminates on a failed conversation open; the supervisor's injected exit
        exit:  code => process.exit(code),
        clock: systemClock,
        logger,
    });

    // Collect slash command builders for bulk registration at startup
    const commandBuilders = [buildCalendarCommand, buildContactCommand, buildAllowlistCommand];

    // Wire Discord client into the capability facade now (client may not be logged in yet,
    // but the facade checks isReady() before sending, so this is safe to set eagerly).
    discordCapability.setClient(discordInfra.discordClient);

    // Only Discord posts are persisted in this outbox; each lifecycle releases its subscription.
    const unsubscribeOutboxDrain = healthRegistry.subscribe(createOutboxDrainListener(outboxDrainer));
    registerCleanup({ name: 'outbox subscription', run: unsubscribeOutboxDrain });

    // Subscribe to health changes: retry transiently failed approved outbound actions when
    // their service comes back online (the logic lives in services, under the mutation gate).
    const unsubscribeApprovedActionRetry = healthRegistry.subscribe(createApprovedActionRetryListener({
        backend: approvedOutboundActionBackend,
        logger,
        wake:    () => {
            approvedActionExecutor.wake();
        },
    }));
    registerCleanup({ name: 'approved action retry subscription', run: unsubscribeApprovedActionRetry });

    // Subscribe to health changes: report outcomes left pending while Discord was down as soon
    // as it is back, rather than on the reporter's next (possibly backed-off) poll.
    const unsubscribeOutcomeReportWake = healthRegistry.subscribe((change) => {
        if(change.service === 'discord' && change.newState === 'online') {
            approvedActionOutcomeReporter.wake();
        }
    });
    registerCleanup({ name: 'approved action outcome report subscription', run: unsubscribeOutcomeReportWake });

    // Q6 / plan amendments B1-B2: health-outage notification source. Same unconditional
    // composition-root scope as unsubscribeOutboxDrain/unsubscribeApprovedActionRetry above — this wiring
    // never branches on session mode, and notificationBridge.notify is a safe no-op until the
    // real conductor has attached (see notification-bridge.ts's doc comment).
    const healthOutageCoalescer = createHealthOutageCoalescer({ clock: systemClock, notify: notificationBridge.notify });
    registerCleanup({ name: 'health outage coalescer', run: () => healthOutageCoalescer.stop() });
    const unsubscribeHealthNotifications = healthRegistry.subscribe(createHealthNotificationListener({
        shouldNotifyHealthChange,
        coalescer: healthOutageCoalescer,
        notify:    notificationBridge.notify,
    }));
    registerCleanup({ name: 'health notification subscription', run: unsubscribeHealthNotifications });

    // Subscribe to health changes: run recovery phase when Discord reconnects.
    // Registered inside app.start() AFTER bot.start() so it only fires on reconnects.
    // Catch-up on first connection is handled by startSessions -> the bot's recovery adapter.
    let unsubscribeDiscordRecovery: (() => void) | undefined;

    // Wire discordReconnectFn now that bot is available.
    discordReconnectFn = async () => {
        await bot.start();
    };

    // #41: the whole session-startup chain (open, attachSessions, boot recovery) runs at most once
    // per lifecycle. createApp lets app.start() re-enter this lifecycle's start() without a stop;
    // the supervisor's own single-flight covers only the open, and a second chain would attach a
    // second set of Discord wiring and rerun boot recovery. A stop-then-start builds a new
    // lifecycle, and with it a fresh chain. #113: the guard itself is createStartupChain
    // (src/app/startup-chain.ts), tested there directly since src/index.ts stays out of the
    // mutate glob.
    const sessionStartup = createStartupChain(() => startSessions({ host: bot, supervisor: sessionSupervisor, logger }));

    let isStopped = false;
    let stopPromise: Promise<void> | null = null;

    return {
        // eslint-disable-next-line sonarjs/cognitive-complexity -- composition root start(); complexity from optional service conditionals
        start: async () => {
            logger.info('Starting Isambard application...');

            // Mark Discord as starting
            healthRegistry.sendEvent('discord', { type: 'CONFIGURE' });

            // #41: the startup chain waits on bot.ready, which resolves on the first clientReady —
            // from this login or, if Discord is down now, from the reconnection loop's later one.
            // It never rejects (failures are logged inside startSessions), and a repeated start()
            // reuses it (see the createStartupChain guard above).
            void sessionStartup();

            logger.info('Connecting to Discord...');
            try {
                await bot.start();
                healthRegistry.sendEvent('discord', { type: 'CONNECT_SUCCESS' });
                logger.info('Discord connected');
            } catch (err) {
                healthRegistry.sendEvent('discord', {
                    type:  'CONNECT_FAIL',
                    error: err instanceof Error ? err.message : String(err),
                });
                logger.warn({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'Discord unavailable at startup, starting reconnection loop',
                });
                discordReconnectionLoop.start();
            }

            // Register recovery subscriber now — after initial bot.start() — so it only fires on reconnects.
            // Catch-up on first connection is handled by startSessions -> the bot's recovery
            // adapter (runConductorInboxInit). P10: extracted to src/app/lifecycle.ts's createDiscordRecoveryHandler,
            // tested in isolation there — this is thin wiring only. P13b: the one-shot branch
            // (botStateManager/bot) is gone from CreateDiscordRecoveryHandlerParams — the
            // conductor's submitCatchUp is the only recovery path now.
            unsubscribeDiscordRecovery = healthRegistry.subscribe(createDiscordRecoveryHandler({
                warmCache:     () => discordInfra.channelRegistry.warmCache(),
                submitCatchUp: () => bot.triggerCatchUp(),
                logger,
            }));

            // Start email listener (independent of Discord — email works even if Discord is offline)
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

            // Register slash commands (non-fatal — Discord may be connected but commands fail)
            try {
                await registerAllCommands(discordInfra.discordClient, commandBuilders);
            } catch (err) {
                logger.warn({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'Slash command registration failed, will retry on next startup',
                });
            }

            // These start regardless of Discord availability
            if(storage.tagIndexReconciliationScheduler) {
                storage.tagIndexReconciliationScheduler.start();
                logger.info('Tag index reconciliation scheduler started');
            }

            if(storage.contactReconciliationScheduler) {
                storage.contactReconciliationScheduler.start();
                logger.info('Contact reconciliation scheduler started');
            }

            // Start the approved-outbound-action executor and outcome reporter polling loops
            approvedActionExecutor.start();
            approvedActionOutcomeReporter.start();

            // Session-peers block 3/5: arm the shared subscription-usage poll. Independent of
            // Discord — quota is spent by Craig's own sessions whether or not Izzy is connected.
            ambience.quotaPoller.start();

            // Q8: start the Bluesky DM poller once safety rails are in place
            if(bskySetup) {
                bskySetup.dmPoller.start();
                logger.info('Bluesky DM poller started');
            }
        },

        stop: () => {
            if(stopPromise !== null) {
                if(isStopped) {
                    logger.debug('Application already stopped, skipping duplicate call');
                }
                return stopPromise;
            }

            logger.info('Stopping Isambard application...');
            emailStopping = true;
            const steps: ShutdownStep[] = [
                { name: 'DynamoDB reconnection loop', run: () => dynamoDBReconnectionLoop.stop(), onFailure: 'propagate' },
                { name: 'Discord reconnection loop', run: () => discordReconnectionLoop.stop(), onFailure: 'propagate' },
                { name: 'email reconnection loop', run: () => emailReconnectionLoop?.stop(), onFailure: 'propagate' },
                { name: 'Bluesky reconnection loop', run: () => bskyReconnectionLoop?.stop(), onFailure: 'propagate' },
                { name: 'Bluesky DM poller', run: () => bskySetup?.dmPoller.stop(), onFailure: 'propagate' },
                { name: 'outbox drainer', run: () => outboxDrainer.stop(), onFailure: 'propagate' },
                { name: 'approved outbound action executor', run: () => approvedActionExecutor.stop(), onFailure: 'propagate' },
                { name: 'approved action outcome reporter', run: () => approvedActionOutcomeReporter.stop(), onFailure: 'propagate' },
                // Stop usage polling and health notifications before detaching the bridge.
                { name: 'quota poller', run: () => ambience.quotaPoller.stop(), onFailure: 'propagate' },
                { name: 'outbox subscription', run: unsubscribeOutboxDrain, onFailure: 'propagate' },
                { name: 'approved action retry subscription', run: unsubscribeApprovedActionRetry, onFailure: 'propagate' },
                { name: 'approved action outcome report subscription', run: unsubscribeOutcomeReportWake, onFailure: 'propagate' },
                { name: 'health notification subscription', run: unsubscribeHealthNotifications, onFailure: 'propagate' },
                { name: 'health outage coalescer', run: () => healthOutageCoalescer.stop(), onFailure: 'propagate' },
                { name: 'notification bridge', run: () => notificationBridge.detach(), onFailure: 'propagate' },
                { name: 'Discord recovery subscription', run: () => unsubscribeDiscordRecovery?.(), onFailure: 'propagate' },
                { name: 'DynamoDB reconnect subscription', run: unsubscribeDynamoDBReconnect, onFailure: 'propagate' },
                { name: 'Discord reconnect subscription', run: unsubscribeDiscordReconnect, onFailure: 'propagate' },
                { name: 'email reconnect subscription', run: () => unsubscribeEmailReconnect?.(), onFailure: 'propagate' },
                { name: 'Bluesky reconnect subscription', run: () => unsubscribeBskyReconnect?.(), onFailure: 'propagate' },
                { name: 'tag reconciliation scheduler',     run:  () => {
                    if(storage.tagIndexReconciliationScheduler) {
                        storage.tagIndexReconciliationScheduler.stop();
                        logger.info('Tag index reconciliation scheduler stopped');
                    }
                }, onFailure: 'propagate' },
                { name: 'contact reconciliation scheduler', run:  () => {
                    if(storage.contactReconciliationScheduler) {
                        storage.contactReconciliationScheduler.stop();
                        logger.info('Contact reconciliation scheduler stopped');
                    }
                }, onFailure: 'propagate' },
                { name: 'browser adapter', run: () => browserAdapter?.close(), onFailure: 'propagate' },
                { name: 'email listener', run: () => emailSetup?.listener.stop(), onFailure: 'log-and-continue' },
                { name: 'WildDuck client', run: shutdownEmailClient, onFailure: 'log-and-continue' },
                { name: 'Discord bot', run: () => bot.stop(), onFailure: 'propagate' },
                // Each step settles before the next starts, including after a rejection.
                // This keeps indexer writes ahead of vector-index closure.
                { name: 'async indexer', run: () => storage.asyncIndexer?.close(), onFailure: 'propagate' },
                { name: 'vector index', run: () => storage.vectorIndex?.close(), onFailure: 'propagate' },
                { name: 'DynamoDB probe', run: () => clearInterval(dynamoDBProbeInterval), onFailure: 'propagate' },
                { name: 'DynamoDB health notifier', run: () => setDynamoHealthNotifier(undefined), onFailure: 'propagate' },
                { name: 'DynamoDB client holder', run: () => storage.holder.destroy(), onFailure: 'propagate' },
                { name: 'health registry', run: () => healthRegistry.stop(), onFailure: 'propagate' },
            ];
            stopPromise = runShutdownSteps(steps).then(() => {
                isStopped = true;
                logger.info('Isambard application stopped');
                return undefined;
            });
            return stopPromise;
        },
        config,
    };
}

/** Rebuild closed owners on a new start while keeping each lifecycle's stop one-shot. */
export async function createApp(): Promise<App> {
    let current = await createAppLifecycle();
    let tail: Promise<void> = Promise.resolve();
    let lastStop: Promise<void> | null = null;
    let pendingStart: Promise<void> | null = null;
    let pendingStop: Promise<void> | null = null;
    let latestOperation: 'start' | 'stop' | null = null;
    let stopped = false;

    const enqueue = (action: () => Promise<void>): Promise<void> => {
        const outcome = tail.then(action);
        // Keep the queue usable after a failed transition; callers still receive outcome.
        tail = Promise.allSettled([outcome]).then(() => undefined);
        return outcome;
    };

    return {
        get config() { return current.config; },
        start: () => {
            if(latestOperation === 'start' && pendingStart !== null) {
                return pendingStart;
            }
            const previousStop = lastStop;
            const outcome = enqueue(async () => {
                if(previousStop !== null) {
                    await previousStop;
                    current = await createAppLifecycle();
                    stopped = false;
                    if(lastStop === previousStop) {
                        lastStop = null;
                    }
                    if(pendingStop === previousStop) {
                        pendingStop = null;
                    }
                }
                await current.start();
            });
            pendingStart = outcome;
            latestOperation = 'start';
            const releaseStart = (): undefined => {
                if(pendingStart === outcome) {
                    pendingStart = null;
                }
                return undefined;
            };
            void outcome.then(releaseStart).catch(releaseStart);
            return outcome;
        },
        stop: () => {
            if(latestOperation === 'stop' && pendingStop !== null) {
                if(stopped) {
                    logger.debug('Application already stopped, skipping duplicate call');
                }
                return pendingStop;
            }
            if(pendingStart === null && lastStop !== null) {
                if(stopped) {
                    logger.debug('Application already stopped, skipping duplicate call');
                }
                return lastStop;
            }
            const previousStop = lastStop;
            const previousStart = pendingStart;
            const previousLifecycle = current;
            const outcome = enqueue(async () => {
                if(previousStop !== null) {
                    await previousStop;
                }
                if(previousStart !== null) {
                    try {
                        await previousStart;
                    } catch (error) {
                        // A failed start can still leave a new lifecycle to tear down.
                        // A failed rebuild has no new owner and must keep its error.
                        if(previousStop !== null && current === previousLifecycle) {
                            throw error;
                        }
                    }
                }
                await current.stop();
                stopped = true;
            });
            lastStop = outcome;
            pendingStop = outcome;
            latestOperation = 'stop';
            return outcome;
        },
    };
}

// Application entry point - only run if this is the main module

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

    // bun --hot re-runs this whole module on a file change WITHOUT firing import.meta.hot.dispose
    // (import.meta.hot is undefined under Bun 1.4.2's --hot; see src/app/hot-reload-guard.ts), so
    // the previous evaluation's bot would otherwise keep running beside this one. globalThis
    // survives the reload: stop whatever the last evaluation parked there before building anything.
    // boundary cast: globalThis is the runtime-persistent host; the guard reads and writes one validated string-keyed slot
    const hotReloadHost = globalThis as unknown as Record<string, unknown>;
    await stopPreviousHotReloadInstance(hotReloadHost, logger);

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

    // P10: SIGINT/SIGTERM handling extracted to src/app/lifecycle.ts's registerSignalHandlers,
    // tested in isolation there — this is thin wiring only. Registered before start() so the
    // hot-reload teardown below can hold `unregisterSignalHandlers` from the moment it is parked;
    // app.stop() is idempotent, so a signal during startup is safe.
    const unregisterSignalHandlers = registerSignalHandlers({
        proc:       process,
        stop:       () => app.stop(),
        deadlineMs: app.config.session.shutdownDeadlineMs,
        clock:      systemClock,
        logger,
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- registerSignalHandlers's own injected `exit`, the one place this process actually terminates on a signal
        exit:       code => process.exit(code),
    });

    // Park this instance's teardown for the NEXT hot reload BEFORE starting, so a reload that
    // lands mid-startup (two file changes in one deploy did exactly that on 2026-09-09) still
    // finds a handle: its stop waits for our start to settle, then tears everything down.
    const started = app.start();
    registerHotReloadInstance(hotReloadHost, {
        stop: async () => {
            await started.catch((err: unknown) => {
                logger.warn({ err, msg: 'Hot reload: previous start had failed; tearing down anyway' });
            });
            errorBoundaryRegistration.unregister();
            unregisterSignalHandlers();
            await app.stop();
        },
    });
    await started;

    // Kept for a Bun that does define import.meta.hot under --hot: then dispose fires first and
    // the globalThis handle above becomes a harmless second stop (app.stop() is idempotent).
    // Bun's ambient ImportMeta types require hot, but the runtime omits it without --hot.
    const runtimeMeta = import.meta as Omit<ImportMeta, 'hot'> & { hot?: ImportMeta['hot'] };
    if(runtimeMeta.hot) {
        runtimeMeta.hot.dispose(async () => {
            logger.info('Hot reload detected, cleaning up...');
            // Remove error boundary handlers to prevent duplicate handlers on next hot reload
            errorBoundaryRegistration.unregister();
            // Remove signal handlers before cleanup to prevent duplicate calls
            unregisterSignalHandlers();
            await app.stop();
        });
    }
}
