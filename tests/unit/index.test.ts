import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockLogger, resetMockSstResource } from '../setup';
// Static (file-scope) imports used throughout this file's tests instead of per-test
// `await import(...)`. spyOn() still intercepts these exports before createApp() calls
// them, since ESM re-exports are live bindings — a per-test dynamic import is not required
// for that to work, and Bun's dynamic import has real per-call overhead (~0.6ms even for
// an already-cached module — measured via local benchmark), which on a slow CI runner was
// pushing tests close enough to the 60ms CI timeout cap to risk a mid-test timeout (see CI
// failure: "should throw fatal error when ChannelRegistryBackend construction fails" at
// 64.40ms on macOS).
import {
    initialLedger,
    createNotificationBridge as importedCreateNotificationBridge,
    createHealthOutageCoalescer as importedCreateHealthOutageCoalescer,
    createHealthNotificationListener as importedCreateHealthNotificationListener,
    shouldNotifyHealthChange,
    systemClock,
    type CompactionTelemetry,
    type Conductor,
    type ContextPolicy,
    type Ledger,
    type LedgerEvent,
    type LedgerStore,
    type NotificationBridge,
    type NotifyFn
} from '@/agent';
import * as staticAgentIndexModule from '@/agent';
import * as staticContextBuilderModule from '@/agent/context-builder';
import * as staticDiscordInboxMcpModule from '@/agent/discord-inbox-mcp-server';
import * as staticDiscordMcpModule from '@/agent/discord-mcp-server';
import * as staticMemoryMcpModule from '@/agent/memory-mcp-server';
import * as staticPluginLoaderModule from '@/agent/plugin-loader';
import * as staticQuestionRegistryModule from '@/agent/question-registry';
import { createChannelId } from '@/agent/types';
import * as staticAppLifecycleModule from '@/app/lifecycle';
import * as staticMcpServersModule from '@/app/mcp-servers';
import * as staticRuntimeModule from '@/app/runtime';
import { createSessionAmbience as importedCreateSessionAmbience } from '@/app/sessions';
import * as staticSessionsModule from '@/app/sessions';
import type { SessionConfig } from '@/config';
import * as staticConfigModule from '@/config/loader';
import * as staticIndexModule from '@/index';
import * as staticBskyModule from '@/integrations/bsky';
import * as staticDiscordModule from '@/integrations/discord/bot';
import { DiscordCapabilityImpl } from '@/integrations/discord/capability';
import * as staticChannelRegistryModule from '@/integrations/discord/channel-registry';
import * as staticDiscordClientModule from '@/integrations/discord/client';
import * as staticCheckpointModule from '@/integrations/discord/inbox';
import * as staticMessageFetcherModule from '@/integrations/discord/message-history/fetcher';
import * as staticMessageSearchModule from '@/integrations/discord/message-history/search';
import * as staticMessageSummarizerModule from '@/integrations/discord/message-history/summarizer';
import * as staticBskySetupModule from '@/integrations/discord/setup/bsky-setup';
import * as staticEmailSetupModule from '@/integrations/discord/setup/email-setup';
import { createGuildId } from '@/integrations/discord/types';
import * as staticWildDuckClientModule from '@/integrations/email';
import * as staticJevModule from '@/integrations/typesafe/jev-outbox-failure-classifier';
import type { HealthChangeListener } from '@/services';
import * as staticServicesModule from '@/services';
import * as staticPersonAllowlistModule from '@/storage';
import * as staticStorageClientModule from '@/storage/client';
import * as staticMemoryToolModule from '@/storage/memory-tool';
import { createMemoryPath } from '@/storage/memory-tool/types';
import type { OperationalStateStore } from '@/storage/operational-state';
import * as staticOperationalStateModule from '@/storage/operational-state';
import * as staticSessionResumeModule from '@/storage/session-resume';

// Captured as a plain variable (not a live ES-module binding) at file-load time, before any
// spyOn() call ever runs — mirrors tests/setup.ts's "capture functions as local variables
// BEFORE mock.module()" pattern. spyOn(staticAgentIndexModule, 'createNotificationBridge')
// mutates the module's live export binding; a `mockImplementation` that called the *imported*
// name (a live binding to that same export) would recurse into its own spy forever. This copy
// is a normal value, immune to that later mutation.
const realCreateNotificationBridge = importedCreateNotificationBridge;
const realCreateHealthOutageCoalescer = importedCreateHealthOutageCoalescer;
const realCreateHealthNotificationListener = importedCreateHealthNotificationListener;
const realCreateSessionAmbience = importedCreateSessionAmbience;
const realCreateApprovedActionRetryListener = staticServicesModule.createApprovedActionRetryListener;

/**
 * The #41 session-host members of a mocked DiscordBot. `ready` NEVER resolves, so app.start()'s
 * `startSessions` never opens a conductor: wireHappyPath builds a REAL conversation conductor over
 * the real SDK `query`, and opening it would spawn the real Claude CLI during `bun test`.
 */
function pendingSessionHost() {
    const ready = new Promise<void>(() => {
        // Deliberately never resolves: the bot never signals readiness in these tests.
    });
    return {
        ready,
        attachSessions:  mock(async () => undefined),
        stopIngress:     mock(() => undefined),
        recoveryAdapter: { recover: mock(async () => undefined) },
    };
}

const sessionConfig: SessionConfig = {
    compactThresholdPercent: 60,
    humanWaitTargetMs:       10_000,
    humanWaitCeilingMs:      30_000,
    bootEventsWindowMs:      24 * 60 * 60 * 1000,
    shutdownTurnWaitMs:      60_000,
    shutdownDeadlineMs:      120_000,
    reopenTaskWaitMs:        120_000,
    debounceMs:              250,
    timezone:                'UTC',
};

/** Top-level `config.adminDiscordChannelId` (the admin review channel) used by `wireHappyPath`. */
const ADMIN_REVIEW_CHANNEL_ID = createChannelId('987654321098765432');

/** Default `config.perch` for `wireHappyPath` — perch enabled, matching production defaults. `perchOverrides` lets a test disable it (`{ enabled: false }`) or tweak a field. */
const defaultPerchConfig = {
    enabled:               true,
    timezone:              'UTC',
    intervalMinutes:       60,
    slotWindowMinutes:     45,
    wrapUpLeadMinutes:     5,
    interruptGraceMinutes: 2,
};

/**
 * Wires the same full happy-path mock set the "Plugin loading path" test uses — storage layer
 * constructed for real against a mocked docClient, everything Discord/agent/email-side stubbed —
 * so `createApp()` can run to completion. Used by the majority of `createApp()` tests below.
 * `sessionOverrides` lets each test tweak a `session` field; `perchOverrides` lets a test disable
 * perch or tweak a field (P12). `bskyEnabled` (Q8) additionally configures `config.bsky`, mocks
 * `BlueskyClient` (constructor + no-op `login`) and `setupBsky` (resolving with a stubbed
 * `dmPoller`, captured via the returned `dmPollerStart`/`dmPollerStop` mocks) so the bsky
 * composition-root block actually runs. `emailEnabled` (default true) set to false omits
 * `config.email`, so tests can prove the admin review channel wiring does not depend on email.
 * `typesafeEnabled` (default false) additionally configures `config.typesafe.apiKey`, so tests
 * can prove the Jev outbox classifier receives it. `jevClassifierSpy` is always returned (spying,
 * not mocking — the real factory has no side effects) so every test can assert its call args.
 */
function wireHappyPath(spies: ReturnType<typeof spyOn>[], sessionOverrides: Partial<SessionConfig> = {}, perchOverrides: Partial<typeof defaultPerchConfig> = {}, bskyEnabled = false, emailEnabled = true, typesafeEnabled = false): {
    createBotSpy:       ReturnType<typeof spyOn>
    recordMemoryAccess: ReturnType<typeof mock>
    emailSetupSpy:      ReturnType<typeof spyOn>
    emailListenerStop:  ReturnType<typeof mock>
    bskySetupSpy?:      ReturnType<typeof spyOn>
    dmPollerStart:      ReturnType<typeof mock>
    dmPollerStop:       ReturnType<typeof mock>
    jevClassifierSpy:   ReturnType<typeof spyOn>
} {
    const mockDocClient = {} as unknown as DynamoDBDocumentClient;
    const recordMemoryAccess = mock(async () => {});
    const getSessionIdForRole = mock(async (_role: 'conversation' | 'perch') => undefined as string | undefined);
    const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
        start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
    });
    // Spied, not mocked: the real factory is a pure synchronous constructor with no side effects,
    // so letting it run for real while capturing its call args is cheaper and closer to production
    // than stubbing it.
    const jevClassifierSpy = spyOn(staticJevModule, 'createJevOutboxFailureClassifier');
    const emailListenerStop = mock(async () => {});
    const emailSetupSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
        listener:                     { start: mock(async () => {}), stop: emailListenerStop } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
        reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
        emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
        outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
        wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
        allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
        sendApprovalRequest:          mock(async () => {}),
        createEmailMcpServerInstance: mock(() => ({} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'])),
    });

    const dmPollerStart = mock(() => undefined);
    const dmPollerStop  = mock(() => undefined);
    const bskySetupSpy  = bskyEnabled
        ? spyOn(staticBskySetupModule, 'setupBsky').mockResolvedValue({
            client:                  {} as unknown as Awaited<ReturnType<typeof staticBskySetupModule.setupBsky>>['client'],
            allowlist:               {} as unknown as Awaited<ReturnType<typeof staticBskySetupModule.setupBsky>>['allowlist'],
            rateLimiter:             {} as unknown as Awaited<ReturnType<typeof staticBskySetupModule.setupBsky>>['rateLimiter'],
            rejectionBackend:        {} as unknown as Awaited<ReturnType<typeof staticBskySetupModule.setupBsky>>['rejectionBackend'],
            outboundApprovalHandler: {} as unknown as Awaited<ReturnType<typeof staticBskySetupModule.setupBsky>>['outboundApprovalHandler'],
            sendApprovalRequest:     mock(async () => {}),
            sendDMApprovalRequest:   mock(async () => {}),
            dmPoller:                { start: dmPollerStart, stop: dmPollerStop },
        })
        : undefined;

    if(bskyEnabled) {
        spies.push(
            // @ts-expect-error - Mocking constructor
            spyOn(staticBskyModule, 'BlueskyClient').mockImplementation(() => ({
                login: mock(async () => {}),
            } as unknown as InstanceType<typeof staticBskyModule.BlueskyClient>)),
            bskySetupSpy!
        );
    }

    spies.push(
        jevClassifierSpy,
        spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client: { destroy: mock(() => undefined) } as unknown as DynamoDBClient, docClient: mockDocClient, tableName: 'IsambardMemory',
        }),
        spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]),
        createBotSpy,
        spyOn(staticMemoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticMemoryMcpModule.createMemoryMCPServer>),
        spyOn(staticDiscordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordMcpModule.createDiscordMCPServer>),
        spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>),
        spyOn(staticMessageFetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as ReturnType<typeof staticMessageFetcherModule.createMessageFetcher>),
        spyOn(staticMessageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSummarizerModule.createMessageSummarizer>),
        spyOn(staticMessageSearchModule, 'createMessageSearchService').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSearchModule.createMessageSearchService>),
        // @ts-expect-error - Mocking constructor
        spyOn(staticQuestionRegistryModule, 'QuestionRegistry').mockImplementation(() => ({} as unknown as InstanceType<typeof staticQuestionRegistryModule.QuestionRegistry>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({ recordMemoryAccess } as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
            load: mock(async () => {}),
        } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>)),
        spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>),
        spyOn(staticDiscordInboxMcpModule, 'createDiscordInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordInboxMcpModule.createDiscordInboxMCPServer>),
        // @ts-expect-error - Mocking constructor
        spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({
            getSessionIdForRole, setSessionIdForRole: mock(async () => undefined), clearSessionIdForRole: mock(async () => undefined),
        } as unknown as InstanceType<typeof staticSessionResumeModule.SessionResumeBackend>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryBackend>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticChannelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryManager>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
            init: mock(async () => {}),
        } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>)),
        emailSetupSpy,
        spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
            app: {
                nodeEnv:  'development',
                logLevel: 'info',
                port:     3000,
            },
            agent: {
                oauthToken:    'test-oauth-token-123',
                mainModel:     'sonnet',
                fallbackModel: 'sonnet',
                // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
            },
            session: { ...sessionConfig, ...sessionOverrides },
            ...(emailEnabled
                ? {
                    email: {
                        user:                           'user@example.com',
                        password:                       'emailpass',
                        pollFallbackMs:                 300_000,
                        sseReconnectDelayMs:            5000,
                        maxBodySizeBytes:               50_000,
                        wildDuckApiUrl:                 'https://wildduck.example.com',
                        sendReservoirCapacity:          24,
                        sendReservoirRefillRatePerHour: 1,
                    },
                }
                : {}),
            discord: {
                botToken:      'bot-token-123',
                applicationId: 'app-id-456',
                homeGuildId:   createGuildId('111222333444555666'),
                presence:      {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            },
            perch:                 { ...defaultPerchConfig, ...perchOverrides },
            adminDiscordUserId:    '423276934781468692',
            adminDiscordChannelId: ADMIN_REVIEW_CHANNEL_ID,
            ...(bskyEnabled
                ? { bsky: { handle: 'isambard.bsky.social', appPassword: 'app-password', serviceUrl: 'https://bsky.social' } }
                : {}),
            ...(typesafeEnabled
                ? { typesafe: { apiKey: 'test-typesafe-key' } }
                : {}),
        }),
        spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
            tableName: 'IsambardMemory',
        })
    );

    return {
        createBotSpy, recordMemoryAccess, emailSetupSpy, emailListenerStop, bskySetupSpy, dmPollerStart, dmPollerStop, jevClassifierSpy,
    };
}

describe('createApp', () => {
    let spies: ReturnType<typeof spyOn>[];

    beforeEach(() => {
        spies = [];
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // Ignore errors - spy may already be restored
            }
        }
        spies.length = 0;
        resetMockSstResource();
    });

    test('logs and continues after a best-effort email-listener shutdown failure', async () => {
        const { emailListenerStop } = wireHappyPath(spies);
        emailListenerStop.mockRejectedValueOnce(new Error('listener stop failed'));

        const app = await staticIndexModule.createApp();

        await expect(app.stop()).resolves.toBeUndefined();
        expect(mockLogger.error).toHaveBeenCalledWith({
            error: 'listener stop failed',
            msg:   'Best-effort shutdown failed: email listener',
        });
    });

    test('continues cleanup after a best-effort failure and propagates a later fatal failure', async () => {
        const { createBotSpy, emailListenerStop } = wireHappyPath(spies);
        const botStopError = new Error('bot stop failed');
        const botStop = mock(async () => {
            throw botStopError;
        });
        createBotSpy.mockReturnValueOnce({
            start: mock(async () => undefined), stop: botStop, triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
        });
        emailListenerStop.mockRejectedValueOnce(new Error('listener stop failed'));

        const app = await staticIndexModule.createApp();

        await expect(app.stop()).rejects.toBe(botStopError);
        expect(botStop).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith({
            error: 'listener stop failed',
            msg:   'Best-effort shutdown failed: email listener',
        });
    });

    test('closes the eager WildDuck client after setupEmail fails', async () => {
        const { emailSetupSpy } = wireHappyPath(spies);
        emailSetupSpy.mockRejectedValueOnce(new Error('email wiring failed'));
        const init = mock(async () => undefined);
        const shutdown = mock(async () => undefined);
        // @ts-expect-error - Test replaces the constructor with a client that records shutdown
        const wildDuckSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
            init, shutdown,
        } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
        const storageClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    { destroy: mock(() => undefined) } as unknown as DynamoDBClient,
            docClient: { send: mock(async () => ({ Items: [], Count: 0 })) } as unknown as DynamoDBDocumentClient,
            tableName: 'IsambardMemory',
        });
        spies.unshift(wildDuckSpy, storageClientSpy);

        const app = await staticIndexModule.createApp();
        expect(emailSetupSpy).toHaveBeenCalledTimes(1);
        expect(init).toHaveBeenCalledTimes(1);
        await app.stop();
        expect(shutdown).toHaveBeenCalledTimes(1);
    });

    test('waits for an in-flight email reconnect before closing its client', async () => {
        const { emailSetupSpy } = wireHappyPath(spies);
        emailSetupSpy.mockRejectedValueOnce(new Error('email wiring failed'));
        let resolveRetry: (() => void) | undefined;
        let signalRetry: (() => void) | undefined;
        const retryStarted = new Promise<void>((resolve) => {
            signalRetry = resolve;
        });
        let attempts = 0;
        let authenticated = false;
        const init = mock((): Promise<void> => {
            attempts += 1;
            if(attempts === 1) {
                return Promise.reject(new Error('initial auth failed'));
            }
            signalRetry?.();
            return new Promise<void>((resolve) => {
                resolveRetry = () => {
                    authenticated = true;
                    resolve();
                };
            });
        });
        const shutdown = mock(async () => {
            authenticated = false;
        });
        // @ts-expect-error - Test replaces the constructor with a client that records shutdown
        const wildDuckSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
            init, shutdown,
        } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
        const storageClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    { destroy: mock(() => undefined) } as unknown as DynamoDBClient,
            docClient: { send: mock(async () => ({ Items: [], Count: 0 })) } as unknown as DynamoDBDocumentClient,
            tableName: 'IsambardMemory',
        });
        spies.unshift(wildDuckSpy, storageClientSpy);

        const app = await staticIndexModule.createApp();
        await retryStarted;
        const stop = app.stop();
        await Promise.resolve();
        expect(shutdown).not.toHaveBeenCalled();
        resolveRetry?.();
        await stop;
        expect(init).toHaveBeenCalledTimes(2);
        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(authenticated).toBe(false);
    });

    test('construction rollback waits for an in-flight email reconnect before closing its client', async () => {
        const { emailSetupSpy } = wireHappyPath(spies);
        emailSetupSpy.mockRejectedValueOnce(new Error('email wiring failed'));
        const constructionError = new Error('context wiring failed');
        let signalRetry: (() => void) | undefined;
        const retryStarted = new Promise<void>((resolve) => {
            signalRetry = resolve;
        });
        let rejectRetry: ((error: Error) => void) | undefined;
        let attempts = 0;
        const init = mock((): Promise<void> => {
            attempts += 1;
            if(attempts === 1) {
                return Promise.reject(new Error('initial auth failed'));
            }
            signalRetry?.();
            return new Promise<void>((_resolve, reject) => {
                rejectRetry = reject;
            });
        });
        const shutdown = mock(async () => undefined);
        // @ts-expect-error - Test replaces the constructor with a client that records shutdown
        const wildDuckSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
            init, shutdown,
        } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
        const contextSpy = spyOn(staticContextBuilderModule, 'createContextBuilder').mockImplementation(() => {
            throw constructionError;
        });
        const storageClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    { destroy: mock(() => undefined) } as unknown as DynamoDBClient,
            docClient: { send: mock(async () => ({ Items: [], Count: 0 })) } as unknown as DynamoDBDocumentClient,
            tableName: 'IsambardMemory',
        });
        spies.unshift(wildDuckSpy, contextSpy, storageClientSpy);

        const building = staticIndexModule.createApp();
        await retryStarted;
        let settled = false;
        void building.finally(() => {
            settled = true;
        }).catch(() => undefined);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(shutdown).not.toHaveBeenCalled();
        rejectRetry?.(new Error('retry mailbox creation failed'));
        await expect(building).rejects.toBe(constructionError);
        expect(shutdown).toHaveBeenCalledTimes(1);
    });

    test('awaits Discord client disposal when construction fails after acquisition', async () => {
        wireHappyPath(spies);
        const constructionError = new Error('registry construction failed');
        let signalDestroy: (() => void) | undefined;
        const destroyStarted = new Promise<void>((resolve) => {
            signalDestroy = resolve;
        });
        let finishDestroy: (() => void) | undefined;
        const destroy = mock((): Promise<void> => {
            signalDestroy?.();
            return new Promise<void>((resolve) => {
                finishDestroy = resolve;
            });
        });
        const clientSpy = spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({
            destroy,
        } as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>);
        // @ts-expect-error - Deliberately failing manager constructor after client acquisition
        const managerSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => {
            throw constructionError;
        });
        const storageClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    { destroy: mock(() => undefined) } as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'IsambardMemory',
        });
        spies.unshift(clientSpy, managerSpy, storageClientSpy);

        const building = staticIndexModule.createApp();
        await destroyStarted;
        let settled = false;
        void building.finally(() => {
            settled = true;
        }).catch(() => undefined);
        await Promise.resolve();
        expect(settled).toBe(false);
        finishDestroy?.();
        await expect(building).rejects.toBe(constructionError);
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    describe('Jev outbox failure classifier wiring (TypesafeApiKey)', () => {
        test('wires the configured TypesafeApiKey into the Jev outbox failure classifier', async () => {
            const { jevClassifierSpy } = wireHappyPath(spies, {}, {}, false, true, true);

            const app = await staticIndexModule.createApp();
            await app.stop();

            expect(jevClassifierSpy).toHaveBeenCalledWith({ apiKey: 'test-typesafe-key' });
        });

        test('leaves the Jev outbox failure classifier without an API key when TypesafeApiKey is not configured', async () => {
            const { jevClassifierSpy } = wireHappyPath(spies);

            const app = await staticIndexModule.createApp();
            await app.stop();

            expect(jevClassifierSpy).toHaveBeenCalledWith({ apiKey: undefined });
        });
    });

    describe('Memory initialization failure handling', () => {
        test('should throw fatal error when memory backend initialization fails', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock MemoryToolBackend to throw error (now REQUIRED, not optional)
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
                throw new Error('Memory backend initialization failed');
            });
            spies.push(MemoryToolBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123',
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            await expect(createApp()).rejects.toThrow('Memory backend initialization failed');
        });

        test('should handle non-Error exceptions in memory initialization', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock MemoryToolBackend to throw a string (non-Error)
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
                throw 'String error thrown';
            });
            spies.push(MemoryToolBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123',
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw string error
            const { createApp } = staticIndexModule;
            await expect(createApp()).rejects.toThrow('String error thrown');
        });
    });

    describe('Plugin loading path', () => {
        test('should call loadPlugins with absolute path to agents-skills-plugins/plugins', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            const loadPluginsSpy = spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor:           { open: mock(async () => ({ sessionId: 'sess-1', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor,
                ledgerStore:         { subscribe: mock(() => () => undefined) } as unknown as LedgerStore,
                contextPolicy:       {} as ContextPolicy,
                compactionTelemetry: {} as CompactionTelemetry,
                bootLostTasks:       [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBotSpy);

            // Mock all required systems to succeed
            const createMemoryMcpSpy = spyOn(staticMemoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticMemoryMcpModule.createMemoryMCPServer>);
            spies.push(createMemoryMcpSpy);

            const createDiscordMcpSpy = spyOn(staticDiscordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordMcpModule.createDiscordMCPServer>);
            spies.push(createDiscordMcpSpy);

            const createDiscordClientSpy = spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>);
            spies.push(createDiscordClientSpy);

            const createFetcherSpy = spyOn(staticMessageFetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as ReturnType<typeof staticMessageFetcherModule.createMessageFetcher>);
            spies.push(createFetcherSpy);

            const createSummarizerSpy = spyOn(staticMessageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSummarizerModule.createMessageSummarizer>);
            spies.push(createSummarizerSpy);

            const createSearchSpy = spyOn(staticMessageSearchModule, 'createMessageSearchService').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSearchModule.createMessageSearchService>);
            spies.push(createSearchSpy);

            // @ts-expect-error - Mocking constructor
            const QuestionRegistrySpy = spyOn(staticQuestionRegistryModule, 'QuestionRegistry').mockImplementation(() => ({} as unknown as InstanceType<typeof staticQuestionRegistryModule.QuestionRegistry>));
            spies.push(QuestionRegistrySpy);

            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>));
            spies.push(MemoryToolBackendSpy);

            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>));
            spies.push(PersonAllowlistSpy);

            const createContextBuilderSpy = spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>);
            spies.push(createContextBuilderSpy);

            const createInboxMcpSpy = spyOn(staticDiscordInboxMcpModule, 'createDiscordInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordInboxMcpModule.createDiscordInboxMCPServer>);
            spies.push(createInboxMcpSpy);

            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>));
            spies.push(InboxManagerSpy);

            // @ts-expect-error - Mocking constructor
            const SessionResumeBackendSpy = spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticSessionResumeModule.SessionResumeBackend>));
            spies.push(SessionResumeBackendSpy);

            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryBackend>));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryManager>));
            spies.push(ChannelRegistryManagerSpy);

            // Mock WildDuckClient to prevent real HTTP calls in email setup
            // @ts-expect-error - Mocking constructor
            const WildDuckClientSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
                init: mock(async () => {}),
            } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
            spies.push(WildDuckClientSpy);

            // Mock setupEmail to prevent real email integration setup
            const setupEmailSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
                listener:                     { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                sendApprovalRequest:          mock(async () => {}),
                createEmailMcpServerInstance: mock(() => ({} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'])),
            });
            spies.push(setupEmailSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123',
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = staticIndexModule;
            await createApp();

            // Kills mutant: Verify loadPlugins was called with absolute path to agents-skills-plugins/plugins
            expect(loadPluginsSpy).toHaveBeenCalledWith(expect.stringMatching(/\/agents-skills-plugins\/plugins$/));
            expect(loadPluginsSpy).toHaveBeenCalledTimes(1);

            // P13b: loadPlugins' result is threaded into the conductor build (the one-shot
            // agent it used to feed is gone) — plugins load happens before the conductor is built.
            expect(createConversationConductorSpy).toHaveBeenCalledTimes(1);
            const conductorCallOptions = createConversationConductorSpy.mock.calls[0]?.[0];
            expect(conductorCallOptions.plugins).toEqual([]);
        });
    });

    describe('Session supervisor wiring (#41)', () => {
        test('passes config.session.shutdownTurnWaitMs and shutdownDeadlineMs to the session supervisor, so an operator-configured budget reaches the cross-session shutdown', async () => {
            wireHappyPath(spies, {
                shutdownTurnWaitMs: 5000,
                shutdownDeadlineMs: 30_000,
            });
            const supervisorSpy = spyOn(staticRuntimeModule, 'createSessionSupervisor');
            spies.push(supervisorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(supervisorSpy).toHaveBeenCalledTimes(1);
            expect(supervisorSpy).toHaveBeenCalledWith(expect.objectContaining({
                turnWaitMs: 5000,
                deadlineMs: 30_000,
            }));
        });

        test('supervises the built conversation and perch conductors with their journals; the bot no longer receives journals or the shutdown budget', async () => {
            const { createBotSpy } = wireHappyPath(spies);
            const conversationConductor = { open: mock(async () => ({ sessionId: 'conv', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
            const perchConductor = { open: mock(async () => ({ sessionId: 'perch', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
            spies.push(
                spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                    conductor: conversationConductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
                }),
                spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                    conductor: perchConductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined), slotHooks: { onSlotStart: () => undefined, onSlotEnd: () => undefined },
                })
            );
            const supervisorSpy = spyOn(staticRuntimeModule, 'createSessionSupervisor');
            spies.push(supervisorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const supervisorParams = supervisorSpy.mock.calls[0][0];
            expect(supervisorParams.conversation?.conductor).toBe(conversationConductor);
            expect(typeof supervisorParams.conversation?.journal.flush).toBe('function');
            expect(supervisorParams.perch?.conductor).toBe(perchConductor);
            expect(typeof supervisorParams.perch?.journal.flush).toBe('function');
            const botOptions = createBotSpy.mock.calls[0]?.[0] as Record<string, unknown>;
            expect('journal' in botOptions).toBe(false);
            expect('perchJournal' in botOptions).toBe(false);
            expect('shutdownTurnWaitMs' in botOptions).toBe(false);
            expect('exit' in botOptions).toBe(false);
        });

        test('app.start() launches startSessions with the bot as host, and opens nothing while the bot is not ready', async () => {
            const { createBotSpy } = wireHappyPath(spies);
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            const open = mock(async () => ({ sessionId: 'conv', resumed: false }));
            spies.push(spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: { open, submit: mock(), status: mock(() => ({ sessionId: undefined })), shutdown: mock(async () => undefined) } as unknown as Conductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            }));
            const startSessionsSpy = spyOn(staticRuntimeModule, 'startSessions');
            spies.push(startSessionsSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();
            expect(startSessionsSpy).not.toHaveBeenCalled();

            await app.start();

            expect(startSessionsSpy).toHaveBeenCalledTimes(1);
            expect(startSessionsSpy.mock.calls[0][0].host).toBe(createBotSpy.mock.results[0]!.value);
            expect(open).not.toHaveBeenCalled();
            await app.stop();
        });

        test('a repeated app.start() without an intervening stop reuses the lifecycle startSessions chain instead of launching a second one', async () => {
            wireHappyPath(spies);
            const startSessionsSpy = spyOn(staticRuntimeModule, 'startSessions');
            spies.push(
                spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                    client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                    docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                    tableName: 'IsambardMemory',
                }),
                spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                    conductor: { open: mock(async () => ({ sessionId: 'conv', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })), shutdown: mock(async () => undefined) } as unknown as Conductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
                }),
                startSessionsSpy
            );

            const { createApp } = staticIndexModule;
            const app = await createApp();

            await app.start();
            await app.start();

            expect(startSessionsSpy).toHaveBeenCalledTimes(1);
            await app.stop();
        });

        test('#113: an app.start() after an intervening app.stop() rebuilds the lifecycle and launches a fresh startSessions chain', async () => {
            wireHappyPath(spies);
            const startSessionsSpy = spyOn(staticRuntimeModule, 'startSessions');
            spies.push(
                spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                    client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                    docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                    tableName: 'IsambardMemory',
                }),
                spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                    conductor: { open: mock(async () => ({ sessionId: 'conv', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })), shutdown: mock(async () => undefined) } as unknown as Conductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
                }),
                startSessionsSpy
            );

            const { createApp } = staticIndexModule;
            const app = await createApp();

            await app.start();
            await app.stop();
            await app.start();

            expect(startSessionsSpy).toHaveBeenCalledTimes(2);
            await app.stop();
        });
    });

    describe('Conversation conductor build (P9, P13b: the only path)', () => {
        test('createConversationConductor is called once, after the OAuth env write, and its (unopened) conductor is handed to createDiscordBot before it is created', async () => {
            wireHappyPath(spies);

            let oauthTokenAtCallTime: string | undefined;
            const fakeOpen = mock(async () => ({ sessionId: 'sess-1', resumed: false }));
            const fakeConductor = { open: fakeOpen, submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockImplementation(async () => {
                oauthTokenAtCallTime = process.env.CLAUDE_CODE_OAUTH_TOKEN;
                return { conductor: fakeConductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined) };
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createConversationConductorSpy).toHaveBeenCalledTimes(1);
            expect(oauthTokenAtCallTime).toBe('test-oauth-token-123');
            expect(fakeOpen).not.toHaveBeenCalled();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { conversationConductor?: unknown };
            expect(botOptions.conversationConductor).toBe(fakeConductor);

            const conductorOrder = createConversationConductorSpy.mock.invocationCallOrder[0];
            const botOrder = createBotSpy.mock.invocationCallOrder[0];
            expect(conductorOrder).toBeDefined();
            expect(botOrder).toBeDefined();
            expect(conductorOrder).toBeLessThan(botOrder);
        });
    });

    describe('Perch conductor build (P12, P13b: the only path)', () => {
        function fakeConductor(sessionId: string): Conductor {
            return { open: mock(async () => ({ sessionId, resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
        }

        test('perch enabled: createPerchConductor is called once, AFTER createConversationConductor, and its (unopened) conductor is handed to createDiscordBot as perchConductor', async () => {
            wireHappyPath(spies);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const fakePerch = fakeConductor('perch-sess');
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakePerch, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined), slotHooks: { onSlotStart: () => undefined, onSlotEnd: () => undefined },
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createPerchConductorSpy).toHaveBeenCalledTimes(1);
            const conversationOrder = createConversationConductorSpy.mock.invocationCallOrder[0];
            const perchOrder = createPerchConductorSpy.mock.invocationCallOrder[0];
            expect(conversationOrder).toBeDefined();
            expect(perchOrder).toBeDefined();
            expect(conversationOrder).toBeLessThan(perchOrder);

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { perchConductor?: unknown };
            expect(botOptions.perchConductor).toBe(fakePerch);
        });

        test('perch DISABLED (config.perch.enabled: false): createPerchConductor is never called', async () => {
            wireHappyPath(spies, {}, { enabled: false });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor');
            spies.push(createConversationConductorSpy, createPerchConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createPerchConductorSpy).not.toHaveBeenCalled();
        });

        test('passes a role-keyed journal/resume store distinct from the conversation conductor\'s own', async () => {
            wireHappyPath(spies);
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined), slotHooks: { onSlotStart: () => undefined, onSlotEnd: () => undefined },
            });
            spies.push(createConversationConductorSpy, createPerchConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const conversationJournalArg = createConversationConductorSpy.mock.calls[0]?.[0].journal;
            const perchJournalArg = createPerchConductorSpy.mock.calls[0]?.[0].journal;
            expect(conversationJournalArg).toBeDefined();
            expect(perchJournalArg).toBeDefined();
            expect(perchJournalArg).not.toBe(conversationJournalArg);
        });
    });

    describe('Daily cost ceiling (Q3 / B4)', () => {
        function fakeConductor(sessionId: string): Conductor {
            return { open: mock(async () => ({ sessionId, resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
        }

        /**
         * A controllable `LedgerStore` double: `emit` synchronously fires EVERY listener passed to
         * `subscribe`, matching the real store — the composition root subscribes several
         * consumers (the daily cost ceiling and, since session-peers block 5, the quota notes) to
         * the same store, and a single-listener double would silently hide all but the last.
         */
        function fakeLedgerStoreWithEmit(): LedgerStore & { emit: (ledger: Ledger, event: LedgerEvent) => void } {
            const listeners = new Set<(ledger: Ledger, event: LedgerEvent) => void>();
            return {
                get:       mock(() => initialLedger('conversation')),
                dispatch:  mock(() => undefined),
                subscribe: mock((cb: (ledger: Ledger, event: LedgerEvent) => void) => {
                    listeners.add(cb);
                    return () => {
                        listeners.delete(cb);
                    };
                }),
                emit(ledger: Ledger, event: LedgerEvent) {
                    for(const listener of listeners) {
                        listener(ledger, event);
                    }
                },
            };
        }

        function tickEvent(): LedgerEvent {
            return { type: 'tick', rssBytes: 0, at: new Date() };
        }

        test('passes a working isPerchPaused function into createDiscordBot, initially false', async () => {
            wireHappyPath(spies, { dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isPerchPaused?: () => boolean };
            expect(typeof botOptions.isPerchPaused).toBe('function');
            expect(botOptions.isPerchPaused!()).toBe(false);
        });

        test('a conversation ledger event crossing dailyCostCeilingUsd pauses isPerchPaused()', async () => {
            wireHappyPath(spies, { dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const conversationLedgerStore = fakeLedgerStoreWithEmit();
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: conversationLedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isPerchPaused?: () => boolean };
            // The very first record() for a store baselines rather than booking its prior spend
            // (cost-ceiling.ts's own doc) — emit a $0 baseline event first, matching production
            // (the ledger starts at $0 when the ceiling subscribes at boot), then the delta that
            // actually crosses the ceiling.
            conversationLedgerStore.emit({ ...initialLedger('conversation'), cost: { cumulativeUsd: 0, lastTurnUsd: 0 } }, tickEvent());
            conversationLedgerStore.emit({ ...initialLedger('conversation'), cost: { cumulativeUsd: 2, lastTurnUsd: 0 } }, tickEvent());

            expect(botOptions.isPerchPaused!()).toBe(true);
        });

        test('a perch ledger event crossing dailyCostCeilingUsd also pauses isPerchPaused() — the shared ceiling folds both stores', async () => {
            wireHappyPath(spies, { dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const perchLedgerStore = fakeLedgerStoreWithEmit();
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: perchLedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined), slotHooks: { onSlotStart: () => undefined, onSlotEnd: () => undefined },
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isPerchPaused?: () => boolean };
            perchLedgerStore.emit({ ...initialLedger('perch'), cost: { cumulativeUsd: 0, lastTurnUsd: 0 } }, tickEvent());
            perchLedgerStore.emit({ ...initialLedger('perch'), cost: { cumulativeUsd: 2, lastTurnUsd: 0 } }, tickEvent());

            expect(botOptions.isPerchPaused!()).toBe(true);
        });

        test('dailyCostCeilingUsd left undefined: isPerchPaused() stays false regardless of ledger spend', async () => {
            wireHappyPath(spies);
            const conversationLedgerStore = fakeLedgerStoreWithEmit();
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: conversationLedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isPerchPaused?: () => boolean };
            conversationLedgerStore.emit({ ...initialLedger('conversation'), cost: { cumulativeUsd: 1000, lastTurnUsd: 0 } }, tickEvent());

            expect(botOptions.isPerchPaused!()).toBe(false);
        });

        test('restores a previously-persisted paused snapshot from the conversation journal at boot, before any ledger event', async () => {
            wireHappyPath(spies, { dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const snapshotRow = {
                PK: 'SESSION_JOURNAL#conversation', SK: '2026-09-05T00:00:00.000Z#000000', TTL: 0, at: '2026-09-05T00:00:00.000Z', type: 'cost_ceiling_snapshot', dateKey: '2026-09-05', totalUsd: 5, paused: true,
            };
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [snapshotRow] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            // Fixes "now" inside the restored snapshot's own local day so the boot-time
            // rollover check does not immediately clear it as stale.
            const fixedNow = new Date('2026-09-05T12:00:00.000Z');
            const dateNowSpy = spyOn(Date, 'now').mockReturnValue(fixedNow.getTime());
            spies.push(dateNowSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isPerchPaused?: () => boolean };
            expect(botOptions.isPerchPaused!()).toBe(true);
        });

        test('a boot-time journal read failure is logged and tolerated, never blocking startup', async () => {
            wireHappyPath(spies, { dailyCostCeilingUsd: 1, timezone: 'UTC' });
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: { send: mock(async () => { throw new Error('DynamoDB throttled'); }) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const { createApp } = staticIndexModule;

            await expect(createApp()).resolves.toBeDefined();
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.any(String));
        });

        // Session-peers block 5: the quota ceiling rides the SAME isPerchPaused predicate, so the
        // perch scheduler's skip and presence's paused marker need no new plumbing.
        describe('Quota ceiling (session-peers block 5)', () => {
            const RESETS_AT = new Date('2026-09-09T22:30:00.000Z');

            /** A ledger carrying one five-hour quota reading, as a `rate_limit_event` would leave it. */
            function ledgerAtFiveHour(role: 'conversation' | 'perch', utilization: number): Ledger {
                const observedAt = new Date('2026-09-09T20:00:00.000Z');
                return {
                    ...initialLedger(role),
                    quota: { fiveHour: { utilization, resetsAt: RESETS_AT, source: 'headers', observedAt }, revisedAt: observedAt },
                };
            }

            test('a five-hour window at agent.quota.perchPauseAtPercent pauses isPerchPaused(), with no daily cost ceiling configured at all', async () => {
                wireHappyPath(spies, { dailyCostCeilingUsd: undefined, timezone: 'UTC' });
                const conversationLedgerStore = fakeLedgerStoreWithEmit();
                const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                    conductor: fakeConductor('conv-sess'), ledgerStore: conversationLedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
                });
                const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                    start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
                });
                spies.push(createConversationConductorSpy, createBotSpy);

                const { createApp } = staticIndexModule;
                await createApp();

                const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isPerchPaused?: () => boolean };
                conversationLedgerStore.emit(ledgerAtFiveHour('conversation', 89), tickEvent());
                expect(botOptions.isPerchPaused!()).toBe(false);

                conversationLedgerStore.emit(ledgerAtFiveHour('conversation', 90), tickEvent());
                expect(botOptions.isPerchPaused!()).toBe(true);
            });

            test('the perch ledger feeds the same quota ceiling', async () => {
                wireHappyPath(spies, { dailyCostCeilingUsd: undefined, timezone: 'UTC' });
                const perchLedgerStore = fakeLedgerStoreWithEmit();
                const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                    conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
                });
                const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                    conductor: fakeConductor('perch-sess'), ledgerStore: perchLedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined), slotHooks: { onSlotStart: () => undefined, onSlotEnd: () => undefined },
                });
                const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                    start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
                });
                spies.push(createConversationConductorSpy, createPerchConductorSpy, createBotSpy);

                const { createApp } = staticIndexModule;
                await createApp();

                const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isPerchPaused?: () => boolean };
                perchLedgerStore.emit(ledgerAtFiveHour('perch', 95), tickEvent());

                expect(botOptions.isPerchPaused!()).toBe(true);
            });

            test('configures Anthropic quota as SDK-only without sending OAuth to the provider report', async () => {
                wireHappyPath(spies, { timezone: 'UTC' });
                const ambienceSpy = spyOn(staticSessionsModule, 'createSessionAmbience');
                spies.push(ambienceSpy);

                const { createApp } = staticIndexModule;
                await createApp();

                const quota = ambienceSpy.mock.calls[0]?.[0].quota;
                expect(quota.anthropicQuotaSource).toBe('sdk');
                expect(quota.headers?.()).toEqual({});
                expect(quota.fallbackHeaders).toBeUndefined();
            });

            test('the shared quota poller\'s recurring timer is armed by app.start() and cancelled by app.stop()', async () => {
                // Without this the configured agent.quota.pollIntervalMs is dead config and an
                // idle process never notices quota Craig's own sessions spent.
                wireHappyPath(spies, { timezone: 'UTC' });
                const pollerStart = mock(() => undefined);
                const pollerStop = mock(() => undefined);
                spies.push(
                    spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                        client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                        docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                        tableName: 'IsambardMemory',
                    }),
                    spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                        conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
                    }),
                    spyOn(staticSessionsModule, 'createSessionAmbience').mockImplementation(ambienceParams => ({
                        ...realCreateSessionAmbience(ambienceParams),
                        quotaPoller: { start: pollerStart, stop: pollerStop, noteResult: mock(() => undefined), poll: mock(async () => undefined) },
                    }))
                );

                const { createApp } = staticIndexModule;
                const app = await createApp();
                expect(pollerStart).not.toHaveBeenCalled();

                await app.start();
                expect(pollerStart).toHaveBeenCalledTimes(1);
                expect(pollerStop).not.toHaveBeenCalled();

                await app.stop();
                expect(pollerStop).toHaveBeenCalledTimes(1);
            });

            test('createQuotaNotes is built from config.agent.quota and the shared notification bridge\'s notify', async () => {
                wireHappyPath(spies, { timezone: 'UTC' });
                const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                    conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
                });
                const createQuotaNotesSpy = spyOn(staticAgentIndexModule, 'createQuotaNotes');
                spies.push(createConversationConductorSpy, createQuotaNotesSpy);

                const { createApp } = staticIndexModule;
                await createApp();

                expect(createQuotaNotesSpy).toHaveBeenCalledTimes(1);
                const [notesParams] = createQuotaNotesSpy.mock.calls[0];
                expect(notesParams.notifyAtPercents).toEqual([75, 90]);
                expect(notesParams.perchPauseAtPercent).toBe(90);
                expect(typeof notesParams.notify).toBe('function');
            });
        });
    });

    describe('Notification bridge composition (Q5 / plan amendment B1)', () => {
        function fakeConductor(sessionId: string): Conductor & { submit: ReturnType<typeof mock>, appendWithoutTurn: ReturnType<typeof mock> } {
            return {
                open:              mock(async () => ({ sessionId, resumed: false })),
                submit:            mock(async () => ({})),
                appendWithoutTurn: mock(() => undefined),
                // lifecycle 'open' — these tests model a conductor whose open() has already
                // resolved; the "attached but cannot accept work" cases have their own dedicated
                // coverage in notification-bridge.test.ts.
                status:            mock(() => ({ sessionId: undefined, lifecycle: 'open' })),
            } as unknown as Conductor & { submit: ReturnType<typeof mock>, appendWithoutTurn: ReturnType<typeof mock> };
        }

        test('is constructed before setupEmail and before createConversationConductor', async () => {
            const { emailSetupSpy } = wireHappyPath(spies);
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => realCreateNotificationBridge(bridgeParams)
            );
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createBridgeSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const bridgeOrder = createBridgeSpy.mock.invocationCallOrder[0];
            const emailOrder = emailSetupSpy.mock.invocationCallOrder[0];
            const conductorOrder = createConversationConductorSpy.mock.invocationCallOrder[0];
            expect(bridgeOrder).toBeDefined();
            expect(emailOrder).toBeDefined();
            expect(conductorOrder).toBeDefined();
            expect(bridgeOrder).toBeLessThan(emailOrder);
            expect(bridgeOrder).toBeLessThan(conductorOrder);
        });

        test('threads notificationBridge.notify into setupEmail\'s options (Q7)', async () => {
            let capturedBridge: NotificationBridge | undefined;
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => {
                    const bridge = realCreateNotificationBridge(bridgeParams);
                    capturedBridge = bridge;
                    return bridge;
                }
            );
            const { emailSetupSpy } = wireHappyPath(spies);
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createBridgeSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(capturedBridge).toBeDefined();
            const emailOptions = emailSetupSpy.mock.calls[0]?.[0] as { notify?: NotifyFn };
            expect(emailOptions.notify).toBe(capturedBridge!.notify);
        });

        test('threads operationalStateStore, healthRegistry, and notificationBridge.notify into setupBsky\'s options (Q8)', async () => {
            let capturedBridge: NotificationBridge | undefined;
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => {
                    const bridge = realCreateNotificationBridge(bridgeParams);
                    capturedBridge = bridge;
                    return bridge;
                }
            );
            const { bskySetupSpy } = wireHappyPath(spies, {}, {}, true);
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const operationalStateStore = { read: mock(), put: mock(), listByPrefix: mock() } as unknown as OperationalStateStore;
            // @ts-expect-error - Mocking constructor
            const storeBackendSpy = spyOn(staticOperationalStateModule, 'OperationalStateBackend').mockImplementation(() => operationalStateStore);
            const createMcpSharedDepsSpy = spyOn(staticMcpServersModule, 'createMcpSharedDeps');
            spies.push(createBridgeSpy, createConversationConductorSpy, storeBackendSpy, createMcpSharedDepsSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(capturedBridge).toBeDefined();
            expect(bskySetupSpy).toBeDefined();
            const bskyOptions = bskySetupSpy!.mock.calls[0]?.[0] as { operationalStateStore?: unknown, healthRegistry?: unknown, notify?: NotifyFn };
            expect(bskyOptions.notify).toBe(capturedBridge!.notify);
            expect(bskyOptions.operationalStateStore).toBe(operationalStateStore);
            expect(bskyOptions.healthRegistry).toBeDefined();
            // The same store reaches the Discord inbox checkpoint manager and the MCP shared deps.
            const checkpointManagerSpy = staticCheckpointModule.CheckpointManager as unknown as ReturnType<typeof spyOn>;
            expect(checkpointManagerSpy.mock.calls[0]?.[0]).toEqual({ store: operationalStateStore });
            expect(createMcpSharedDepsSpy.mock.calls[0]?.[0].operationalStateStore).toBe(operationalStateStore);
        });

        test('bsky present, email absent: safety rails are built and Bluesky stays enabled', async () => {
            const { bskySetupSpy, emailSetupSpy, createBotSpy } = wireHappyPath(spies, {}, {}, true, false);
            const createMcpSharedDepsSpy = spyOn(staticMcpServersModule, 'createMcpSharedDeps');
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createMcpSharedDepsSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(emailSetupSpy).not.toHaveBeenCalled();
            expect(bskySetupSpy).toHaveBeenCalledTimes(1);
            const bskyOptions = bskySetupSpy!.mock.calls[0]?.[0] as { adminDiscordChannelId?: unknown };
            expect(bskyOptions.adminDiscordChannelId).toBe(ADMIN_REVIEW_CHANNEL_ID);
            expect(mockLogger.warn).not.toHaveBeenCalledWith({ msg: 'Bluesky client available but safety rails not configured — disabling Bluesky writes for this session' });

            expect(createMcpSharedDepsSpy).toHaveBeenCalledTimes(1);
            const mcpOptions = createMcpSharedDepsSpy.mock.calls[0][0];
            expect(mcpOptions.bskyClient).toBeDefined();
            expect(mcpOptions.discordCapability).toBeInstanceOf(DiscordCapabilityImpl);
            expect(mcpOptions.contacts?.backend).toBeDefined();
            expect(mcpOptions.contacts?.sendApprovalRequest).toEqual(expect.any(Function));

            const botOptions = createBotSpy.mock.calls[0]?.[0] as { adminReviewChannelId?: unknown };
            expect(botOptions.adminReviewChannelId).toBe(ADMIN_REVIEW_CHANNEL_ID);
        });

        test('a queued Discord send wakes the outbox drainer and logs a failed drain', async () => {
            wireHappyPath(spies);
            const createMcpSharedDepsSpy = spyOn(staticMcpServersModule, 'createMcpSharedDeps');
            const drainFailure = new Error('dequeue failed');
            const drain = mock(async () => {
                throw drainFailure;
            });
            const createOutboxDrainerSpy = spyOn(staticServicesModule, 'createOutboxDrainer').mockReturnValue({ drain, stop: mock(() => undefined) });
            spies.push(createMcpSharedDepsSpy, createOutboxDrainerSpy);
            await staticIndexModule.createApp();

            const capability = createMcpSharedDepsSpy.mock.calls[0]?.[0].discordCapability as unknown as { deps: { onQueued: () => void } };
            capability.deps.onQueued();
            await Promise.resolve();
            await Promise.resolve();

            expect(drain).toHaveBeenCalledTimes(1);
            expect(drain).toHaveBeenCalledWith('discord');
            expect(mockLogger.error).toHaveBeenCalledWith({ error: drainFailure }, 'Outbox drain after a queued Discord send failed');
        });

        test('recordAccess callback delegates state touches to storage backend', async () => {
            const { recordMemoryAccess } = wireHappyPath(spies);
            const createMcpSharedDepsSpy = spyOn(staticMcpServersModule, 'createMcpSharedDeps');
            spies.push(createMcpSharedDepsSpy);
            await staticIndexModule.createApp();
            const recordAccess = createMcpSharedDepsSpy.mock.calls[0][0].recordAccess!;
            const path = createMemoryPath('/state/access.md');
            await recordAccess([path]);
            expect(recordMemoryAccess).toHaveBeenCalledTimes(1);
            expect(recordMemoryAccess.mock.calls[0][0]).toEqual([path]);
            expect(recordMemoryAccess.mock.calls[0][1]).toBeInstanceOf(Date);
        });

        test('email absent: contact approval requests post to the top-level admin review channel', async () => {
            wireHappyPath(spies, {}, {}, false, false);
            const createMcpSharedDepsSpy = spyOn(staticMcpServersModule, 'createMcpSharedDeps');
            const sendToChannelSpy = spyOn(DiscordCapabilityImpl.prototype, 'sendToChannel').mockResolvedValue({ status: 'sent' });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createMcpSharedDepsSpy, sendToChannelSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const sendApprovalRequest = createMcpSharedDepsSpy.mock.calls[0][0].contacts!.sendApprovalRequest;
            await sendApprovalRequest({ action: 'create', displayName: 'Alice', addIdentifiers: [{ platform: 'email', value: 'alice@example.com' }] });

            expect(sendToChannelSpy).toHaveBeenCalledTimes(1);
            const [channelId, , sendOptions] = sendToChannelSpy.mock.calls[0];
            expect(channelId).toBe(ADMIN_REVIEW_CHANNEL_ID);
            expect(sendOptions).toEqual({ priority: 'high', type: 'contact_approval' });
        });

        test('threads the top-level admin review channel into setupEmail\'s options', async () => {
            const { emailSetupSpy } = wireHappyPath(spies);
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const emailOptions = emailSetupSpy.mock.calls[0]?.[0] as { adminDiscordChannelId?: unknown };
            expect(emailOptions.adminDiscordChannelId).toBe(ADMIN_REVIEW_CHANNEL_ID);
        });

        test('starts the dmPoller during app.start() and stops it during app.stop() (Q8)', async () => {
            const { dmPollerStart, dmPollerStop } = wireHappyPath(spies, {}, {}, true);
            // app.start() fires real healthRegistry.sendEvent transitions, which independently wake
            // the outbox drainer's health subscription — it needs a docClient.send that resolves
            // (see the identically-named helper in the "Lifecycle seams (P10)" describe block below).
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();
            expect(dmPollerStart).not.toHaveBeenCalled();

            await app.start();
            expect(dmPollerStart).toHaveBeenCalledTimes(1);
            expect(dmPollerStop).not.toHaveBeenCalled();

            await app.stop();
            expect(dmPollerStop).toHaveBeenCalledTimes(1);
        });

        test('notify() called while createConversationConductor is still resolving is a safe no-op; once attached (after resolution) it reaches the real conductor via the createDiscordBot options', async () => {
            wireHappyPath(spies);
            let capturedBridge: NotificationBridge | undefined;
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => {
                    const bridge = realCreateNotificationBridge(bridgeParams);
                    capturedBridge = bridge;
                    return bridge;
                }
            );
            const conductor = fakeConductor('conv-sess');
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockImplementation(async () => {
                // The bridge is constructed before this call (per B1) but attachConductor only
                // runs after this promise resolves — a notify() here must be a safe no-op.
                capturedBridge?.notify({ source: 'mid-boot', text: 'mid-boot text', wake: true, key: 'mid-boot-key' });
                return { conductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined) };
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBridgeSpy, createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            // Mid-boot notify() (before attachConductor ran) never reached the conductor.
            expect(conductor.submit).not.toHaveBeenCalled();

            // The bridge's notify is threaded through createDiscordBot's options...
            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { notify?: NotifyFn };
            expect(typeof botOptions.notify).toBe('function');

            // ...and, now that the conductor has resolved and been attached, reaches it for real.
            botOptions.notify!({ source: 'post-boot', text: 'post-boot text', wake: true, key: 'post-boot-key' });
            expect(conductor.submit).toHaveBeenCalledTimes(1);
            expect(conductor.submit.mock.calls[0]?.[1]).toEqual({ priority: 'normal' });
        });

        test('app.stop() detaches the notification bridge from the conductor', async () => {
            wireHappyPath(spies);
            // app.stop() reaches storage.holder.destroy() -> client.destroy(); the shared happy-path
            // mock's bare `{}` client has no such method (only tests that actually call stop()
            // need this override — see the equivalent stub near the double-stop test below).
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            let attachSpy: ReturnType<typeof spyOn>;
            let detachSpy: ReturnType<typeof spyOn>;
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => {
                    const bridge = realCreateNotificationBridge(bridgeParams);
                    attachSpy = spyOn(bridge, 'attachConductor');
                    detachSpy = spyOn(bridge, 'detach');
                    return bridge;
                }
            );
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createBridgeSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();

            expect(attachSpy).toHaveBeenCalledTimes(1);
            expect(detachSpy).not.toHaveBeenCalled();

            await app.stop();

            expect(detachSpy).toHaveBeenCalledTimes(1);
        });

        test('R2: threads notificationBridge, and both conductors\' own setWakeTurnDelivery, into createDiscordBot\'s options', async () => {
            wireHappyPath(spies);
            const conversationSetWakeTurnDelivery = mock(() => undefined);
            const perchSetWakeTurnDelivery = mock(() => undefined);
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => realCreateNotificationBridge(bridgeParams)
            );
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: conversationSetWakeTurnDelivery,
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: perchSetWakeTurnDelivery, slotHooks: { onSlotStart: () => undefined, onSlotEnd: () => undefined },
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBridgeSpy, createConversationConductorSpy, createPerchConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as {
                notificationBridge?:       { attachReplyDelivery: (fn: unknown) => void }
                setWakeTurnDelivery?:      typeof conversationSetWakeTurnDelivery
                setPerchWakeTurnDelivery?: typeof perchSetWakeTurnDelivery
            };
            expect(botOptions.notificationBridge).toBe(createBridgeSpy.mock.results[0]?.value as typeof botOptions.notificationBridge);
            expect(botOptions.setWakeTurnDelivery).toBe(conversationSetWakeTurnDelivery);
            expect(botOptions.setPerchWakeTurnDelivery).toBe(perchSetWakeTurnDelivery);
        });
    });

    describe('Health-outage notification source (Q6)', () => {
        test('subscribes exactly once to healthRegistry with a listener built from the real predicate, coalescer, and bridge notify; unsubscribes on stop()', async () => {
            wireHappyPath(spies);
            // app.stop() reaches storage.holder.destroy() -> client.destroy(); the shared
            // happy-path mock's bare `{}` client has no such method (see the equivalent stub on
            // the Q5 "app.stop() detaches the notification bridge" test above).
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));

            let capturedBridge: NotificationBridge | undefined;
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => {
                    const bridge = realCreateNotificationBridge(bridgeParams);
                    capturedBridge = bridge;
                    return bridge;
                }
            );

            const coalescerReturns: ReturnType<typeof realCreateHealthOutageCoalescer>[] = [];
            const createCoalescerSpy = spyOn(staticAgentIndexModule, 'createHealthOutageCoalescer').mockImplementation(
                (coalescerParams: Parameters<typeof realCreateHealthOutageCoalescer>[0]) => {
                    const coalescer = realCreateHealthOutageCoalescer(coalescerParams);
                    coalescerReturns.push(coalescer);
                    return coalescer;
                }
            );

            const listenerReturns: HealthChangeListener[] = [];
            const createListenerSpy = spyOn(staticAgentIndexModule, 'createHealthNotificationListener').mockImplementation(
                (listenerParams: Parameters<typeof realCreateHealthNotificationListener>[0]) => {
                    const listener = realCreateHealthNotificationListener(listenerParams);
                    listenerReturns.push(listener);
                    return listener;
                }
            );

            const subscribedListeners: HealthChangeListener[] = [];
            const subscriptionUnsubscribes: ReturnType<typeof mock>[] = [];
            const subscribeSpy = spyOn(staticServicesModule.ServiceHealthRegistryImpl.prototype, 'subscribe').mockImplementation(
                (listener: HealthChangeListener) => {
                    subscribedListeners.push(listener);
                    const unsubscribe = mock(() => undefined);
                    subscriptionUnsubscribes.push(unsubscribe);
                    return unsubscribe;
                }
            );

            spies.push(createBridgeSpy, createCoalescerSpy, createListenerSpy, subscribeSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();

            // The coalescer is constructed exactly once, from systemClock and the bridge's own
            // notify function (plan amendments B1-B2) — not a hand-rolled closure.
            expect(createCoalescerSpy).toHaveBeenCalledTimes(1);
            expect(createCoalescerSpy.mock.calls[0]?.[0]).toMatchObject({ clock: systemClock, notify: capturedBridge!.notify });

            // The listener is built from the real (unmocked) shouldNotifyHealthChange predicate,
            // the coalescer just constructed, and the bridge's notify — never a hand-rolled
            // closure over the conductor.
            expect(createListenerSpy).toHaveBeenCalledTimes(1);
            const listenerParams = createListenerSpy.mock.calls[0]?.[0];
            expect(listenerParams.shouldNotifyHealthChange).toBe(shouldNotifyHealthChange);
            expect(listenerParams.notify).toBe(capturedBridge!.notify);
            expect(listenerParams.coalescer).toBe(coalescerReturns[0]);

            // Subscribed exactly once, at the same unconditional composition-root scope as
            // unsubscribeOutboxDrain/unsubscribeSagaRetry.
            const ourListener = listenerReturns[0];
            const subscriptionIndex = subscribedListeners.indexOf(ourListener);
            expect(subscribedListeners.filter(listener => listener === ourListener)).toHaveLength(1);

            const unsubscribeHealthNotifications = subscriptionUnsubscribes[subscriptionIndex];
            expect(unsubscribeHealthNotifications).not.toHaveBeenCalled();

            await app.stop();

            expect(unsubscribeHealthNotifications).toHaveBeenCalledTimes(1);
        });
    });

    describe('Approved outbound action retry wiring', () => {
        test('subscribes the services retry listener, built from the shared backend and logger', async () => {
            wireHappyPath(spies);
            const listeners: HealthChangeListener[] = [];
            spies.push(spyOn(staticServicesModule.ServiceHealthRegistryImpl.prototype, 'subscribe').mockImplementation(
                (listener: HealthChangeListener) => {
                    listeners.push(listener);
                    return () => undefined;
                }
            ));
            const built: HealthChangeListener[] = [];
            const createListenerSpy = spyOn(staticServicesModule, 'createApprovedActionRetryListener').mockImplementation(
                (listenerDeps: Parameters<typeof realCreateApprovedActionRetryListener>[0]) => {
                    const listener = realCreateApprovedActionRetryListener(listenerDeps);
                    built.push(listener);
                    return listener;
                }
            );
            const listSpy = spyOn(staticServicesModule.ApprovedOutboundActionBackend.prototype, 'listByState').mockResolvedValue([]);
            spies.push(createListenerSpy, listSpy);

            await staticIndexModule.createApp();

            expect(createListenerSpy).toHaveBeenCalledTimes(1);
            const listenerDeps = createListenerSpy.mock.calls[0]?.[0];
            expect(listenerDeps.backend).toBeInstanceOf(staticServicesModule.ApprovedOutboundActionBackend);
            expect(listenerDeps.logger).toBe(mockLogger as unknown as typeof listenerDeps.logger);
            expect(listeners.filter(listener => listener === built[0])).toHaveLength(1);

            built[0]({
                service: 'bsky', previousState: 'offline', newState: 'online', epoch: 1, timestamp: new Date('2026-09-12T00:00:00.000Z'),
            });

            expect(listSpy).toHaveBeenCalledWith('failed');
        });
    });

    describe('Lifecycle seams (P10, P13b: no more mode)', () => {
        test('app.config exposes the resolved config createApp() was built from', async () => {
            wireHappyPath(spies);

            const { createApp } = staticIndexModule;
            const app = await createApp();

            expect(app.config).not.toHaveProperty('session.mode');
            expect(app.config.session).not.toHaveProperty('mode');
        });

        test('createDiscordBot is called without a botStateManager option (P14: the state/ directory is gone)', async () => {
            const { createBotSpy } = wireHappyPath(spies);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0];
            expect(botOptions).not.toHaveProperty('botStateManager');
        });

        /**
         * app.start() fires real `healthRegistry.sendEvent` transitions, which (independently of
         * this seam) wake the outbox drainer's health subscription — it needs a `docClient.send`
         * that resolves rather than `wireHappyPath`'s bare `{}` docClient.
         */
        function stubDocClientSend(): void {
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                // `destroy` is real here because these tests call app.stop() to cancel the quota
                // poller's real `pollIntervalMs` timer, and stop() destroys the client holder.
                client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
        }

        test('app.start() wires createDiscordRecoveryHandler as the health registry\'s discord subscriber, with no mode field (P13b removed it from CreateDiscordRecoveryHandlerParams)', async () => {
            wireHappyPath(spies);
            stubDocClientSend();
            const fakeHandler = mock(() => undefined);
            const createDiscordRecoveryHandlerSpy = spyOn(staticAppLifecycleModule, 'createDiscordRecoveryHandler').mockReturnValue(fakeHandler);
            spies.push(createDiscordRecoveryHandlerSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();
            await app.start();

            expect(createDiscordRecoveryHandlerSpy).toHaveBeenCalledTimes(1);
            const handlerParams = createDiscordRecoveryHandlerSpy.mock.calls[0]?.[0];
            expect(handlerParams).not.toHaveProperty('mode');
            expect(handlerParams).not.toHaveProperty('botStateManager');
            expect(handlerParams).not.toHaveProperty('bot');
            expect(typeof handlerParams.warmCache).toBe('function');
            expect(typeof handlerParams.submitCatchUp).toBe('function');

            // start() now arms the shared quota poller's real `pollIntervalMs` timer; stop()
            // cancels it, so the suite leaves no five-minute wall-clock timer behind.
            await app.stop();
        });
    });

    describe('Identity context loading branches', () => {
        test('should use fallback when oauthToken is falsy (empty string)', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            const loadPluginsSpy = spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor:           { open: mock(async () => ({ sessionId: 'sess-1', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor,
                ledgerStore:         { subscribe: mock(() => () => undefined) } as unknown as LedgerStore,
                contextPolicy:       {} as ContextPolicy,
                compactionTelemetry: {} as CompactionTelemetry,
                bootLostTasks:       [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBotSpy);

            // Mock all required systems to succeed
            const createMemoryMcpSpy = spyOn(staticMemoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticMemoryMcpModule.createMemoryMCPServer>);
            spies.push(createMemoryMcpSpy);

            const createDiscordMcpSpy = spyOn(staticDiscordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordMcpModule.createDiscordMCPServer>);
            spies.push(createDiscordMcpSpy);

            const createDiscordClientSpy = spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>);
            spies.push(createDiscordClientSpy);

            const createFetcherSpy = spyOn(staticMessageFetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as ReturnType<typeof staticMessageFetcherModule.createMessageFetcher>);
            spies.push(createFetcherSpy);

            const createSummarizerSpy = spyOn(staticMessageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSummarizerModule.createMessageSummarizer>);
            spies.push(createSummarizerSpy);

            const createSearchSpy = spyOn(staticMessageSearchModule, 'createMessageSearchService').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSearchModule.createMessageSearchService>);
            spies.push(createSearchSpy);

            // @ts-expect-error - Mocking constructor
            const QuestionRegistrySpy = spyOn(staticQuestionRegistryModule, 'QuestionRegistry').mockImplementation(() => ({} as unknown as InstanceType<typeof staticQuestionRegistryModule.QuestionRegistry>));
            spies.push(QuestionRegistrySpy);

            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>));
            spies.push(MemoryToolBackendSpy);

            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>));
            spies.push(PersonAllowlistSpy);

            const createContextBuilderSpy = spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>);
            spies.push(createContextBuilderSpy);

            const createInboxMcpSpy = spyOn(staticDiscordInboxMcpModule, 'createDiscordInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordInboxMcpModule.createDiscordInboxMCPServer>);
            spies.push(createInboxMcpSpy);

            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>));
            spies.push(InboxManagerSpy);

            // @ts-expect-error - Mocking constructor
            const SessionResumeBackendSpy = spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticSessionResumeModule.SessionResumeBackend>));
            spies.push(SessionResumeBackendSpy);

            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryBackend>));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryManager>));
            spies.push(ChannelRegistryManagerSpy);

            // Mock WildDuckClient to prevent real HTTP calls in email setup
            // @ts-expect-error - Mocking constructor
            const WildDuckClientSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
                init: mock(async () => {}),
            } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
            spies.push(WildDuckClientSpy);

            // Mock setupEmail to prevent real email integration setup
            const setupEmailSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
                listener:                     { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                sendApprovalRequest:          mock(async () => {}),
                createEmailMcpServerInstance: mock(() => ({} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'])),
            });
            spies.push(setupEmailSpy);

            // Mock loadConfig with empty oauthToken
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    '', // Empty string (falsy)
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = staticIndexModule;
            await createApp();

            // Kills mutant on line 216: When oauthToken is falsy, identityContext should stay undefined
            // Verify createDiscordBot was called with undefined identityContext
            expect(createBotSpy).toHaveBeenCalled();
            const botCallArgs = createBotSpy.mock.calls[0][0];
            expect(botCallArgs.identityContext).toBeUndefined();
        });

        test('should call loadCoreIdentity when oauthToken is truthy and contextBuilder exists', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock context builder with loadCoreIdentity
            const mockLoadCoreIdentity = mock(async () => 'Test Identity from Memory');
            const createContextBuilderSpy = spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({
                loadCoreIdentity: mockLoadCoreIdentity,
            } as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>);
            spies.push(createContextBuilderSpy);

            const loadPluginsSpy = spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor:           { open: mock(async () => ({ sessionId: 'sess-1', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor,
                ledgerStore:         { subscribe: mock(() => () => undefined) } as unknown as LedgerStore,
                contextPolicy:       {} as ContextPolicy,
                compactionTelemetry: {} as CompactionTelemetry,
                bootLostTasks:       [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBotSpy);

            // Mock MCP server factories
            const createMemoryMcpSpy = spyOn(staticMemoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticMemoryMcpModule.createMemoryMCPServer>);
            spies.push(createMemoryMcpSpy);

            const createDiscordMcpSpy = spyOn(staticDiscordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordMcpModule.createDiscordMCPServer>);
            spies.push(createDiscordMcpSpy);

            const createDiscordClientSpy = spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>);
            spies.push(createDiscordClientSpy);

            const createFetcherSpy = spyOn(staticMessageFetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as ReturnType<typeof staticMessageFetcherModule.createMessageFetcher>);
            spies.push(createFetcherSpy);

            const createSummarizerSpy = spyOn(staticMessageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSummarizerModule.createMessageSummarizer>);
            spies.push(createSummarizerSpy);

            const createSearchSpy = spyOn(staticMessageSearchModule, 'createMessageSearchService').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSearchModule.createMessageSearchService>);
            spies.push(createSearchSpy);

            // @ts-expect-error - Mocking constructor
            const QuestionRegistrySpy = spyOn(staticQuestionRegistryModule, 'QuestionRegistry').mockImplementation(() => ({} as unknown as InstanceType<typeof staticQuestionRegistryModule.QuestionRegistry>));
            spies.push(QuestionRegistrySpy);

            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>));
            spies.push(MemoryToolBackendSpy);

            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>));
            spies.push(PersonAllowlistSpy);

            // Mock WildDuckClient to prevent real HTTP calls in email setup
            // @ts-expect-error - Mocking constructor
            const WildDuckClientSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
                init: mock(async () => {}),
            } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
            spies.push(WildDuckClientSpy);

            // Mock setupEmail to prevent real email integration setup
            const setupEmailSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
                listener:                     { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                sendApprovalRequest:          mock(async () => {}),
                createEmailMcpServerInstance: mock(() => ({} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'])),
            });
            spies.push(setupEmailSpy);

            // Mock loadConfig with valid oauthToken
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123', // Truthy
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = staticIndexModule;
            await createApp();

            // Kills mutant on lines 130-134: Verify loadCoreIdentity was called
            expect(mockLoadCoreIdentity).toHaveBeenCalled();

            // Verify createDiscordBot was called with the identity from loadCoreIdentity
            expect(createBotSpy).toHaveBeenCalled();
            const botCallArgs = createBotSpy.mock.calls[0][0];
            expect(botCallArgs.identityContext).toBe('Test Identity from Memory');
        });

        test('should use fallback when loadCoreIdentity returns empty string', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock context builder with loadCoreIdentity returning empty string
            const mockLoadCoreIdentity = mock(async () => ''); // Empty string (falsy)
            const createContextBuilderSpy = spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({
                loadCoreIdentity: mockLoadCoreIdentity,
            } as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>);
            spies.push(createContextBuilderSpy);

            const loadPluginsSpy = spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor:           { open: mock(async () => ({ sessionId: 'sess-1', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor,
                ledgerStore:         { subscribe: mock(() => () => undefined) } as unknown as LedgerStore,
                contextPolicy:       {} as ContextPolicy,
                compactionTelemetry: {} as CompactionTelemetry,
                bootLostTasks:       [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBotSpy);

            // Mock MCP server factories (same as previous test)
            const createMemoryMcpSpy = spyOn(staticMemoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticMemoryMcpModule.createMemoryMCPServer>);
            spies.push(createMemoryMcpSpy);

            const createDiscordMcpSpy = spyOn(staticDiscordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordMcpModule.createDiscordMCPServer>);
            spies.push(createDiscordMcpSpy);

            const createDiscordClientSpy = spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>);
            spies.push(createDiscordClientSpy);

            const createFetcherSpy = spyOn(staticMessageFetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as ReturnType<typeof staticMessageFetcherModule.createMessageFetcher>);
            spies.push(createFetcherSpy);

            const createSummarizerSpy = spyOn(staticMessageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSummarizerModule.createMessageSummarizer>);
            spies.push(createSummarizerSpy);

            const createSearchSpy = spyOn(staticMessageSearchModule, 'createMessageSearchService').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSearchModule.createMessageSearchService>);
            spies.push(createSearchSpy);

            // @ts-expect-error - Mocking constructor
            const QuestionRegistrySpy = spyOn(staticQuestionRegistryModule, 'QuestionRegistry').mockImplementation(() => ({} as unknown as InstanceType<typeof staticQuestionRegistryModule.QuestionRegistry>));
            spies.push(QuestionRegistrySpy);

            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>));
            spies.push(MemoryToolBackendSpy);

            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>));
            spies.push(PersonAllowlistSpy);

            // Mock WildDuckClient to prevent real HTTP calls in email setup
            // @ts-expect-error - Mocking constructor
            const WildDuckClientSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
                init: mock(async () => {}),
            } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
            spies.push(WildDuckClientSpy);

            // Mock setupEmail to prevent real email integration setup
            const setupEmailSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
                listener:                     { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                sendApprovalRequest:          mock(async () => {}),
                createEmailMcpServerInstance: mock(() => ({} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'])),
            });
            spies.push(setupEmailSpy);

            // Mock loadConfig with valid oauthToken
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123', // Truthy
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = staticIndexModule;
            await createApp();

            // Kills mutant on line 134: When loadCoreIdentity returns empty string, should use fallback
            expect(mockLoadCoreIdentity).toHaveBeenCalled();

            // Verify createDiscordBot was called with the fallback identity
            expect(createBotSpy).toHaveBeenCalled();
            const botCallArgs = createBotSpy.mock.calls[0][0];
            expect(botCallArgs.identityContext).toBe('Isambard - AI Assistant');
        });

        test('should catch error from loadCoreIdentity, log it, and use fallback', async () => {
            mockLogger.warn.mockClear();

            // Mock storage client to succeed. `send` must resolve (not be absent) so the
            // conductor path's resume-store lookups (storage.createResumeStore(...).load(), used
            // when wiring each conductor) do not themselves reject and log an unrelated warning
            // that would confuse the 'Failed to load identity context' assertion below.
            const mockDocClient = { send: mock(async () => ({ Item: undefined, Items: [] })) } as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock context builder with loadCoreIdentity throwing error
            const mockLoadCoreIdentity = mock(async () => {
                throw new Error('Failed to load identity from DynamoDB');
            });
            const createContextBuilderSpy = spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({
                loadCoreIdentity: mockLoadCoreIdentity,
            } as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>);
            spies.push(createContextBuilderSpy);

            const loadPluginsSpy = spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor:           { open: mock(async () => ({ sessionId: 'sess-1', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor,
                ledgerStore:         { subscribe: mock(() => () => undefined) } as unknown as LedgerStore,
                contextPolicy:       {} as ContextPolicy,
                compactionTelemetry: {} as CompactionTelemetry,
                bootLostTasks:       [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBotSpy);

            // Mock MCP server factories
            const createMemoryMcpSpy = spyOn(staticMemoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticMemoryMcpModule.createMemoryMCPServer>);
            spies.push(createMemoryMcpSpy);

            const createDiscordMcpSpy = spyOn(staticDiscordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordMcpModule.createDiscordMCPServer>);
            spies.push(createDiscordMcpSpy);

            const createDiscordClientSpy = spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>);
            spies.push(createDiscordClientSpy);

            const createFetcherSpy = spyOn(staticMessageFetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as ReturnType<typeof staticMessageFetcherModule.createMessageFetcher>);
            spies.push(createFetcherSpy);

            const createSummarizerSpy = spyOn(staticMessageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSummarizerModule.createMessageSummarizer>);
            spies.push(createSummarizerSpy);

            const createSearchSpy = spyOn(staticMessageSearchModule, 'createMessageSearchService').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSearchModule.createMessageSearchService>);
            spies.push(createSearchSpy);

            // @ts-expect-error - Mocking constructor
            const QuestionRegistrySpy = spyOn(staticQuestionRegistryModule, 'QuestionRegistry').mockImplementation(() => ({} as unknown as InstanceType<typeof staticQuestionRegistryModule.QuestionRegistry>));
            spies.push(QuestionRegistrySpy);

            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>));
            spies.push(MemoryToolBackendSpy);

            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>));
            spies.push(PersonAllowlistSpy);

            // Mock WildDuckClient to prevent real HTTP calls in email setup
            // @ts-expect-error - Mocking constructor
            const WildDuckClientSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
                init: mock(async () => {}),
            } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
            spies.push(WildDuckClientSpy);

            // Mock setupEmail to prevent real email integration setup
            const setupEmailSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
                listener:                     { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                sendApprovalRequest:          mock(async () => {}),
                createEmailMcpServerInstance: mock(() => ({} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'])),
            });
            spies.push(setupEmailSpy);

            // Mock loadConfig with valid oauthToken
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123', // Truthy
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = staticIndexModule;
            await createApp();

            // Kills mutant on lines 136-140: Verify error was caught and logged
            expect(mockLogger.warn).toHaveBeenCalled();
            const warnCalls = mockLogger.warn.mock.calls;
            const identityWarning = warnCalls.find((call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Failed to load identity context'));
            expect(identityWarning).toBeDefined();
            expect(identityWarning![0]).toContain('Failed to load identity from DynamoDB');

            // Verify createDiscordBot was called with the fallback identity
            expect(createBotSpy).toHaveBeenCalled();
            const botCallArgs = createBotSpy.mock.calls[0][0];
            expect(botCallArgs.identityContext).toBe('Isambard - AI Assistant');
        });

        test('should use fallback when contextBuilder is undefined', async () => {
            // Mock storage client to succeed (required for channelRegistry)
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock channelRegistry creation (REQUIRED)
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryBackend>));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryManager>));
            spies.push(ChannelRegistryManagerSpy);

            // Mock MemoryToolBackend to throw error (so contextBuilder stays undefined)
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
                throw new Error('Memory not available');
            });
            spies.push(MemoryToolBackendSpy);

            const loadPluginsSpy = spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor:           { open: mock(async () => ({ sessionId: 'sess-1', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor,
                ledgerStore:         { subscribe: mock(() => () => undefined) } as unknown as LedgerStore,
                contextPolicy:       {} as ContextPolicy,
                compactionTelemetry: {} as CompactionTelemetry,
                bootLostTasks:       [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBotSpy);

            // Mock loadConfig with valid oauthToken
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123', // Truthy
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            await expect(createApp()).rejects.toThrow('Memory not available');
        });
    });

    describe('ChannelRegistry initialization failure handling', () => {
        test('should throw fatal error when ChannelRegistryBackend construction fails', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock ChannelRegistryBackend constructor to throw error
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
                throw new Error('DynamoDB connection failed');
            });
            spies.push(ChannelRegistryBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123',
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            await expect(createApp()).rejects.toThrow('DynamoDB connection failed');
        });

        test('should throw fatal error when ChannelRegistryManager construction fails', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock ChannelRegistryBackend to succeed
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryBackend>));
            spies.push(ChannelRegistryBackendSpy);

            // Mock ChannelRegistryManager constructor to throw error
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => {
                throw new Error('Invalid configuration');
            });
            spies.push(ChannelRegistryManagerSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123',
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            await expect(createApp()).rejects.toThrow('Invalid configuration');
        });

        test('should handle non-Error exceptions in ChannelRegistry initialization', async () => {
            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock ChannelRegistryBackend to throw non-Error exception
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
                throw 'String error in channel registry';
            });
            spies.push(ChannelRegistryBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123',
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw string error
            const { createApp } = staticIndexModule;
            await expect(createApp()).rejects.toThrow('String error in channel registry');
        });
    });

    describe('App stop idempotency', () => {
        test('should only call bot.stop() once when stop() is called multiple times', async () => {
            mockLogger.debug.mockClear();

            // Mock storage client to succeed (required for channelRegistry)
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                // Must include destroy() — app.stop() calls storage.holder.destroy()
                client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            const loadPluginsSpy = spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor:           { open: mock(async () => ({ sessionId: 'sess-1', resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor,
                ledgerStore:         { subscribe: mock(() => () => undefined) } as unknown as LedgerStore,
                contextPolicy:       {} as ContextPolicy,
                compactionTelemetry: {} as CompactionTelemetry,
                bootLostTasks:       [], setWakeTurnDelivery: mock(() => undefined),
            });
            spies.push(createConversationConductorSpy);

            // Mock bot with trackable stop method
            const mockBotStop = mock(async () => undefined);
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mockBotStop,
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            });
            spies.push(createBotSpy);

            // Mock all required systems to succeed
            const createMemoryMcpSpy = spyOn(staticMemoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticMemoryMcpModule.createMemoryMCPServer>);
            spies.push(createMemoryMcpSpy);

            const createDiscordMcpSpy = spyOn(staticDiscordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordMcpModule.createDiscordMCPServer>);
            spies.push(createDiscordMcpSpy);

            const createDiscordClientSpy = spyOn(staticDiscordClientModule, 'createDiscordClient').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordClientModule.createDiscordClient>);
            spies.push(createDiscordClientSpy);

            const createFetcherSpy = spyOn(staticMessageFetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as ReturnType<typeof staticMessageFetcherModule.createMessageFetcher>);
            spies.push(createFetcherSpy);

            const createSummarizerSpy = spyOn(staticMessageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSummarizerModule.createMessageSummarizer>);
            spies.push(createSummarizerSpy);

            const createSearchSpy = spyOn(staticMessageSearchModule, 'createMessageSearchService').mockReturnValue({} as unknown as ReturnType<typeof staticMessageSearchModule.createMessageSearchService>);
            spies.push(createSearchSpy);

            // @ts-expect-error - Mocking constructor
            const QuestionRegistrySpy = spyOn(staticQuestionRegistryModule, 'QuestionRegistry').mockImplementation(() => ({} as unknown as InstanceType<typeof staticQuestionRegistryModule.QuestionRegistry>));
            spies.push(QuestionRegistrySpy);

            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>));
            spies.push(MemoryToolBackendSpy);

            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>));
            spies.push(PersonAllowlistSpy);

            const createContextBuilderSpy = spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>);
            spies.push(createContextBuilderSpy);

            const createInboxMcpSpy = spyOn(staticDiscordInboxMcpModule, 'createDiscordInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticDiscordInboxMcpModule.createDiscordInboxMCPServer>);
            spies.push(createInboxMcpSpy);

            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>));
            spies.push(InboxManagerSpy);

            // @ts-expect-error - Mocking constructor
            const SessionResumeBackendSpy = spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticSessionResumeModule.SessionResumeBackend>));
            spies.push(SessionResumeBackendSpy);

            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryBackend>));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(staticChannelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticChannelRegistryModule.ChannelRegistryManager>));
            spies.push(ChannelRegistryManagerSpy);

            // Mock WildDuckClient to prevent real HTTP calls in email setup
            // @ts-expect-error - Mocking constructor
            const WildDuckClientSpy = spyOn(staticWildDuckClientModule, 'WildDuckClient').mockImplementation(() => ({
                init: mock(async () => {}),
            } as unknown as InstanceType<typeof staticWildDuckClientModule.WildDuckClient>));
            spies.push(WildDuckClientSpy);

            // Mock setupEmail to prevent real email integration setup
            const setupEmailSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
                listener:                     { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                sendApprovalRequest:          mock(async () => {}),
                createEmailMcpServerInstance: mock(() => ({} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'])),
            });
            spies.push(setupEmailSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const loadConfigSpy = spyOn(staticConfigModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken:    'test-oauth-token-123',
                    mainModel:     'sonnet',
                    fallbackModel: 'sonnet',
                    // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
                    quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('111222333444555666'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId:    '423276934781468692',
                adminDiscordChannelId: createChannelId('987654321098765432'),
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = staticIndexModule;
            const app = await createApp();

            // Call stop twice
            await app.stop();
            await app.stop();

            // Verify bot.stop() was only called once (idempotent)
            expect(mockBotStop).toHaveBeenCalledTimes(1);

            // Optionally verify logger.debug was called with skip message on second call
            const debugCalls = mockLogger.debug.mock.calls;
            const skipMessage = debugCalls.find((call: unknown[]) => (call[0] as string).includes('already stopped'));
            expect(skipMessage).toBeDefined();
        });
    });
});
