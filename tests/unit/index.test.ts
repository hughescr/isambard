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
import * as staticAgentModule from '@/agent/agent';
import * as staticContextBuilderModule from '@/agent/context-builder';
import * as staticDiscordMcpModule from '@/agent/discord-mcp-server';
import * as staticCompactionModule from '@/agent/hooks/compaction';
import * as staticInboxMcpModule from '@/agent/inbox-mcp-server';
import * as staticMemoryMcpModule from '@/agent/memory-mcp-server';
import * as staticPluginLoaderModule from '@/agent/plugin-loader';
import * as staticQuestionRegistryModule from '@/agent/question-registry';
import * as staticSessionCleanupModule from '@/agent/session-cleanup';
import type { StreamTracker } from '@/agent/stream-tracker';
import * as staticTaskCleanupModule from '@/agent/task-cleanup-processor';
import * as staticTaskCopierModule from '@/agent/task-directory-copier';
import * as staticTaskCoordinatorModule from '@/agent/task-persistence-coordinator';
import * as staticAppLifecycleModule from '@/app/lifecycle';
import * as staticSessionsModule from '@/app/sessions';
import type { SessionConfig } from '@/config';
import * as staticConfigModule from '@/config/loader';
import { sessionConfigSchema } from '@/config/schemas';
import * as staticIndexModule from '@/index';
import * as staticBskyModule from '@/integrations/bsky';
import * as staticDiscordModule from '@/integrations/discord/bot';
import * as staticChannelRegistryModule from '@/integrations/discord/channel-registry';
import * as staticDiscordClientModule from '@/integrations/discord/client';
import * as staticCheckpointModule from '@/integrations/discord/inbox';
import * as staticMessageFetcherModule from '@/integrations/discord/message-history/fetcher';
import * as staticMessageSearchModule from '@/integrations/discord/message-history/search';
import * as staticMessageSummarizerModule from '@/integrations/discord/message-history/summarizer';
import * as staticBskySetupModule from '@/integrations/discord/setup/bsky-setup';
import * as staticEmailSetupModule from '@/integrations/discord/setup/email-setup';
import * as staticStateModule from '@/integrations/discord/state';
import { createGuildId } from '@/integrations/discord/types';
import * as staticWildDuckClientModule from '@/integrations/email';
import type { HealthChangeListener } from '@/services';
import * as staticServicesModule from '@/services';
import * as staticPersonAllowlistModule from '@/storage';
import * as staticStorageClientModule from '@/storage/client';
import * as staticMemoryToolModule from '@/storage/memory-tool';
import * as staticTaskSessionModule from '@/storage/task-session';

// Captured as a plain variable (not a live ES-module binding) at file-load time, before any
// spyOn() call ever runs — mirrors tests/setup.ts's "capture functions as local variables
// BEFORE mock.module()" pattern. spyOn(staticAgentIndexModule, 'createNotificationBridge')
// mutates the module's live export binding; a `mockImplementation` that called the *imported*
// name (a live binding to that same export) would recurse into its own spy forever. This copy
// is a normal value, immune to that later mutation.
const realCreateNotificationBridge = importedCreateNotificationBridge;
const realCreateHealthOutageCoalescer = importedCreateHealthOutageCoalescer;
const realCreateHealthNotificationListener = importedCreateHealthNotificationListener;

const sessionConfig: SessionConfig = {
    mode:                    'oneshot',
    compactThresholdPercent: 60,
    humanWaitTargetMs:       10_000,
    humanWaitCeilingMs:      30_000,
    perchWrapUpLeadMs:       300_000,
    perchInterruptGraceMs:   120_000,
    userMemoryWindowMs:      6 * 60 * 60 * 1000,
    bootEventsWindowMs:      24 * 60 * 60 * 1000,
    shutdownTurnWaitMs:      60_000,
    shutdownDeadlineMs:      120_000,
    transcriptRetentionMs:   7 * 24 * 60 * 60 * 1000,
    debounceMs:              250,
    timezone:                'UTC',
};

/** Default `config.perch` for `wireHappyPathForCleanupTests` — perch enabled, matching production defaults. `perchOverrides` lets a test disable it (`{ enabled: false }`) or tweak a field. */
const defaultPerchConfig = {
    enabled:               true,
    timezone:              'UTC',
    intervalMinutes:       60,
    jitterMinutes:         15,
    maxSessionMinutes:     45,
    wrapUpTimeoutMinutes:  5,
    interruptGraceMinutes: 2,
};

/**
 * Wires the same full happy-path mock set the "Plugin loading path" test uses — storage layer
 * constructed for real against a mocked docClient, everything Discord/agent/email-side stubbed —
 * so `createApp()` can run to completion. Used by the P8 stale-session-cleanup tests, which need
 * `createApp()` to actually reach (and complete) the cleanup step it re-orders below `loadConfig`
 * and storage creation. `sessionOverrides` lets each test pick `session.mode`; `perchOverrides`
 * lets a test disable perch or tweak a field (P12); the returned `getSessionIdForRole` mock lets
 * the conductor-mode test control what the two role-keyed `TASK_SESSION#<role>` rows resolve to.
 * `bskyEnabled` (Q8) additionally configures `config.bsky`, mocks `BlueskyClient` (constructor +
 * no-op `login`) and `setupBsky` (resolving with a stubbed `dmPoller`, captured via the returned
 * `dmPollerStart`/`dmPollerStop` mocks) so the bsky composition-root block actually runs.
 */
function wireHappyPathForCleanupTests(spies: ReturnType<typeof spyOn>[], sessionOverrides: Partial<SessionConfig> = {}, perchOverrides: Partial<typeof defaultPerchConfig> = {}, bskyEnabled = false): {
    cleanupAllStaleSessionsSpy: ReturnType<typeof spyOn>
    pruneStaleSessionsSpy:      ReturnType<typeof spyOn>
    getSessionIdForRole:        ReturnType<typeof mock>
    createBotSpy:               ReturnType<typeof spyOn>
    emailSetupSpy:              ReturnType<typeof spyOn>
    bskySetupSpy?:              ReturnType<typeof spyOn>
    dmPollerStart:              ReturnType<typeof mock>
    dmPollerStop:               ReturnType<typeof mock>
} {
    const mockDocClient = {} as unknown as DynamoDBDocumentClient;
    const getSessionIdForRole = mock(async (_role: 'conversation' | 'perch') => undefined as string | undefined);
    const cleanupAllStaleSessionsSpy = spyOn(staticSessionCleanupModule, 'cleanupAllStaleSessions').mockResolvedValue(undefined);
    const pruneStaleSessionsSpy = spyOn(staticSessionCleanupModule, 'pruneStaleSessions').mockResolvedValue(undefined);
    const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
        start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
    });
    const emailSetupSpy = spyOn(staticEmailSetupModule, 'setupEmail').mockResolvedValue({
        listener:                     { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
        reviewHandler:                {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
        emailMcpServer:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
        outboundApprovalHandler:      {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
        wildDuckClient:               { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
        allowlist:                    {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
        adminChannelId:               '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
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
        spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client: {} as unknown as DynamoDBClient, docClient: mockDocClient, tableName: 'IsambardMemory',
        }),
        spyOn(staticPluginLoaderModule, 'loadPlugins').mockResolvedValue([]),
        spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
            handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
        }),
        spyOn(staticCompactionModule, 'createBotStateCompactionSink'),
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
        spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticMemoryToolModule.MemoryToolBackend>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticPersonAllowlistModule, 'PersonAllowlist').mockImplementation(() => ({
            load: mock(async () => {}),
        } as unknown as InstanceType<typeof staticPersonAllowlistModule.PersonAllowlist>)),
        spyOn(staticContextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ReturnType<typeof staticContextBuilderModule.createContextBuilder>),
        spyOn(staticInboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticInboxMcpModule.createInboxMCPServer>),
        // @ts-expect-error - Mocking constructor
        spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticStateModule, 'BotStateManagerImpl').mockImplementation(() => ({ getCompactionStateManager: () => ({}) } as unknown as InstanceType<typeof staticStateModule.BotStateManagerImpl>)),
        // @ts-expect-error - Mocking constructor
        spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({
            getSessionIdForRole, setSessionIdForRole: mock(async () => undefined), clearSessionIdForRole: mock(async () => undefined),
        } as unknown as InstanceType<typeof staticTaskSessionModule.TaskSessionBackend>)),
        spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCleanupModule.createTaskCleanupProcessor>),
        spyOn(staticTaskCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCopierModule.createTaskDirectoryCopier>),
        spyOn(staticTaskCoordinatorModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCoordinatorModule.createTaskPersistenceCoordinator>),
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
            },
            session: { ...sessionConfig, ...sessionOverrides },
            email:   {
                user:                           'user@example.com',
                password:                       'emailpass',
                pollFallbackMs:                 300_000,
                sseReconnectDelayMs:            5000,
                maxBodySizeBytes:               50_000,
                adminDiscordChannelId:          '987654321098765432',
                wildDuckApiUrl:                 'https://wildduck.example.com',
                sendReservoirCapacity:          24,
                sendReservoirRefillRatePerHour: 1,
            },
            discord: {
                botToken:      'bot-token-123',
                applicationId: 'app-id-456',
                homeGuildId:   createGuildId('home-guild-123'),
                presence:      {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            },
            perch:              { ...defaultPerchConfig, ...perchOverrides },
            adminDiscordUserId: '423276934781468692',
            ...(bskyEnabled
                ? { bsky: { handle: 'isambard.bsky.social', appPassword: 'app-password', serviceUrl: 'https://bsky.social' } }
                : {}),
        }),
        spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
            tableName: 'IsambardMemory',
        }),
        cleanupAllStaleSessionsSpy,
        pruneStaleSessionsSpy
    );

    return {
        cleanupAllStaleSessionsSpy, pruneStaleSessionsSpy, getSessionIdForRole, createBotSpy, emailSetupSpy, bskySetupSpy, dmPollerStart, dmPollerStop,
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            expect(createApp()).rejects.toThrow('Memory backend initialization failed');
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw string error
            const { createApp } = staticIndexModule;
            expect(createApp()).rejects.toThrow('String error thrown');
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

            const createAgentSpy = spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
                handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
            });
            spies.push(createAgentSpy);

            // P5: compactionSink is built (via createBotStateCompactionSink) from
            // botStateManager.getCompactionStateManager() at the composition root, not passed
            // through as the old compactionStateManager option.
            const createBotStateCompactionSinkSpy = spyOn(staticCompactionModule, 'createBotStateCompactionSink');
            spies.push(createBotStateCompactionSinkSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined),
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

            const createInboxMcpSpy = spyOn(staticInboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticInboxMcpModule.createInboxMCPServer>);
            spies.push(createInboxMcpSpy);

            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>));
            spies.push(InboxManagerSpy);

            // @ts-expect-error - Mocking constructor
            const createBotStateManagerSpy = spyOn(staticStateModule, 'BotStateManagerImpl').mockImplementation(() => ({ getCompactionStateManager: () => ({}) } as unknown as InstanceType<typeof staticStateModule.BotStateManagerImpl>));
            spies.push(createBotStateManagerSpy);

            // @ts-expect-error - Mocking constructor
            const TaskSessionBackendSpy = spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticTaskSessionModule.TaskSessionBackend>));
            spies.push(TaskSessionBackendSpy);

            const createTaskCleanupSpy = spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCleanupModule.createTaskCleanupProcessor>);
            spies.push(createTaskCleanupSpy);

            const createTaskCopierSpy = spyOn(staticTaskCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCopierModule.createTaskDirectoryCopier>);
            spies.push(createTaskCopierSpy);

            const createTaskCoordinatorSpy = spyOn(staticTaskCoordinatorModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCoordinatorModule.createTaskPersistenceCoordinator>);
            spies.push(createTaskCoordinatorSpy);

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
                adminChannelId:               '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
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

            // P5: createClaudeAgent receives compactionSink (not compactionStateManager), built
            // from botStateManager.getCompactionStateManager() via createBotStateCompactionSink.
            expect(createBotStateCompactionSinkSpy).toHaveBeenCalledTimes(1);
            const agentCallOptions: unknown = createAgentSpy.mock.calls[0]?.[0];
            expect(agentCallOptions).not.toHaveProperty('compactionStateManager');
            expect(agentCallOptions).toHaveProperty('compactionSink');
            const builtSink: unknown = createBotStateCompactionSinkSpy.mock.results[0]?.value;
            expect((agentCallOptions as { compactionSink?: unknown }).compactionSink).toBe(builtSink);
        });
    });

    describe('Stale session cleanup ordering (P8)', () => {
        test('oneshot mode: cleanupAllStaleSessions runs (after loadConfig and storage creation); pruneStaleSessions does not', async () => {
            const { cleanupAllStaleSessionsSpy, pruneStaleSessionsSpy } = wireHappyPathForCleanupTests(spies, { mode: 'oneshot' });

            const { createApp } = staticIndexModule;
            await createApp();

            expect(cleanupAllStaleSessionsSpy).toHaveBeenCalledTimes(1);
            expect(pruneStaleSessionsSpy).not.toHaveBeenCalled();
        });

        test('conductor mode: pruneStaleSessions runs with the two stored role ids and the configured retention; cleanupAllStaleSessions does not run', async () => {
            const { cleanupAllStaleSessionsSpy, pruneStaleSessionsSpy, getSessionIdForRole } = wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
            getSessionIdForRole.mockImplementation(async (role: 'conversation' | 'perch') => (role === 'conversation' ? 'conv-id' : 'perch-id'));

            const { createApp } = staticIndexModule;
            await createApp();

            expect(pruneStaleSessionsSpy).toHaveBeenCalledWith({
                keepSessionIds: new Set(['conv-id', 'perch-id']),
                maxAgeMs:       7 * 24 * 60 * 60 * 1000,
            });
            expect(cleanupAllStaleSessionsSpy).not.toHaveBeenCalled();
        });

        test('conductor mode: a role-id lookup failure is logged and pruning is skipped, not run with an empty keep set', async () => {
            const { pruneStaleSessionsSpy, getSessionIdForRole } = wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
            const lookupFailure = new Error('DynamoDB throttled');
            getSessionIdForRole.mockImplementation(() => Promise.reject(lookupFailure));

            const { createApp } = staticIndexModule;
            await expect(createApp()).resolves.toBeDefined();

            expect(pruneStaleSessionsSpy).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: lookupFailure }), expect.any(String));
        });
    });

    describe('Shutdown config wiring (P10)', () => {
        test('passes config.session.shutdownTurnWaitMs and shutdownDeadlineMs through to createDiscordBot, so an operator-configured budget actually reaches the conductor shutdown orchestrator', async () => {
            const { createBotSpy } = wireHappyPathForCleanupTests(spies, {
                shutdownTurnWaitMs: 5000,
                shutdownDeadlineMs: 30_000,
            });

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createBotSpy).toHaveBeenCalledWith(expect.objectContaining({
                shutdownTurnWaitMs: 5000,
                shutdownDeadlineMs: 30_000,
            }));
        });
    });

    describe('Conversation conductor build (P9)', () => {
        test('conductor mode: createConversationConductor is called once, after the OAuth env write, and its (unopened) conductor is handed to createDiscordBot before it is created', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });

            let oauthTokenAtCallTime: string | undefined;
            const fakeOpen = mock(async () => ({ sessionId: 'sess-1', resumed: false }));
            const fakeConductor = { open: fakeOpen, submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockImplementation(async () => {
                oauthTokenAtCallTime = process.env.CLAUDE_CODE_OAUTH_TOKEN;
                return { conductor: fakeConductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry };
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
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

        test('oneshot mode: createConversationConductor is never called', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'oneshot' });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor');
            spies.push(createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createConversationConductorSpy).not.toHaveBeenCalled();
        });
    });

    describe('Perch conductor build (P12)', () => {
        function fakeConductor(sessionId: string): Conductor {
            return { open: mock(async () => ({ sessionId, resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
        }

        test('conductor mode with perch enabled: createPerchConductor is called once, AFTER createConversationConductor, and its (unopened) conductor is handed to createDiscordBot as perchConductor', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const fakePerch = fakeConductor('perch-sess');
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakePerch, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
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

        test('conductor mode with perch DISABLED (config.perch.enabled: false): createPerchConductor is never called', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' }, { enabled: false });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor');
            spies.push(createConversationConductorSpy, createPerchConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createPerchConductorSpy).not.toHaveBeenCalled();
        });

        test('oneshot mode: createPerchConductor is never called', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'oneshot' });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor');
            spies.push(createPerchConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createPerchConductorSpy).not.toHaveBeenCalled();
        });

        test('passes a role-keyed journal/resume store distinct from the conversation conductor\'s own', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry,
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

        // P13a: 'conductor' is now the schema/env default (SESSION_MODE=oneshot is the kill
        // switch) — this exercises that default value specifically, rather than a
        // hardcoded 'conductor' literal, so it tracks the schema default if it ever moves.
        test('default config path (session.mode left at its schema default): builds both conductors (unopened)', async () => {
            wireHappyPathForCleanupTests(spies, { mode: sessionConfigSchema.parse({}).mode });

            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry,
            });
            spies.push(createConversationConductorSpy, createPerchConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createConversationConductorSpy).toHaveBeenCalledTimes(1);
            expect(createPerchConductorSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('Daily cost ceiling (Q3 / B4)', () => {
        function fakeConductor(sessionId: string): Conductor {
            return { open: mock(async () => ({ sessionId, resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
        }

        /** A controllable `LedgerStore` double: `emit` synchronously fires whatever was passed to `subscribe`. */
        function fakeLedgerStoreWithEmit(): LedgerStore & { emit: (ledger: Ledger, event: LedgerEvent) => void } {
            let listener: ((ledger: Ledger, event: LedgerEvent) => void) | undefined;
            return {
                get:       mock(() => initialLedger('conversation')),
                dispatch:  mock(() => undefined),
                subscribe: mock((cb: (ledger: Ledger, event: LedgerEvent) => void) => {
                    listener = cb;
                    return () => {
                        listener = undefined;
                    };
                }),
                emit(ledger: Ledger, event: LedgerEvent) {
                    listener?.(ledger, event);
                },
            };
        }

        function tickEvent(): LedgerEvent {
            return { type: 'tick', rssBytes: 0, at: new Date() };
        }

        test('passes a working isCostPaused function into createDiscordBot, initially false', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor', dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isCostPaused?: () => boolean };
            expect(typeof botOptions.isCostPaused).toBe('function');
            expect(botOptions.isCostPaused!()).toBe(false);
        });

        test('a conversation ledger event crossing dailyCostCeilingUsd pauses isCostPaused()', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor', dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const conversationLedgerStore = fakeLedgerStoreWithEmit();
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: conversationLedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isCostPaused?: () => boolean };
            // The very first record() for a store baselines rather than booking its prior spend
            // (cost-ceiling.ts's own doc) — emit a $0 baseline event first, matching production
            // (the ledger starts at $0 when the ceiling subscribes at boot), then the delta that
            // actually crosses the ceiling.
            conversationLedgerStore.emit({ ...initialLedger('conversation'), cost: { cumulativeUsd: 0, lastTurnUsd: 0 } }, tickEvent());
            conversationLedgerStore.emit({ ...initialLedger('conversation'), cost: { cumulativeUsd: 2, lastTurnUsd: 0 } }, tickEvent());

            expect(botOptions.isCostPaused!()).toBe(true);
        });

        test('a perch ledger event crossing dailyCostCeilingUsd also pauses isCostPaused() — the shared ceiling folds both stores', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor', dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const perchLedgerStore = fakeLedgerStoreWithEmit();
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createPerchConductorSpy = spyOn(staticSessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: perchLedgerStore, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
            });
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isCostPaused?: () => boolean };
            perchLedgerStore.emit({ ...initialLedger('perch'), cost: { cumulativeUsd: 0, lastTurnUsd: 0 } }, tickEvent());
            perchLedgerStore.emit({ ...initialLedger('perch'), cost: { cumulativeUsd: 2, lastTurnUsd: 0 } }, tickEvent());

            expect(botOptions.isCostPaused!()).toBe(true);
        });

        test('dailyCostCeilingUsd left undefined: isCostPaused() stays false regardless of ledger spend', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
            const conversationLedgerStore = fakeLedgerStoreWithEmit();
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: conversationLedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isCostPaused?: () => boolean };
            conversationLedgerStore.emit({ ...initialLedger('conversation'), cost: { cumulativeUsd: 1000, lastTurnUsd: 0 } }, tickEvent());

            expect(botOptions.isCostPaused!()).toBe(false);
        });

        test('restores a previously-persisted paused snapshot from the conversation journal at boot, before any ledger event', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor', dailyCostCeilingUsd: 1, timezone: 'UTC' });
            const snapshotRow = {
                PK: 'SESSION_JOURNAL#conversation', SK: '2026-09-05T00:00:00.000Z#000000', TTL: 0, at: '2026-09-05T00:00:00.000Z', type: 'cost_ceiling_snapshot', dateKey: '2026-09-05', totalUsd: 5, paused: true,
            };
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [snapshotRow] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
            });
            spies.push(createConversationConductorSpy, createBotSpy);

            // Fixes "now" inside the restored snapshot's own local day so the boot-time
            // rollover check does not immediately clear it as stale.
            const fixedNow = new Date('2026-09-05T12:00:00.000Z');
            const dateNowSpy = spyOn(Date, 'now').mockReturnValue(fixedNow.getTime());
            spies.push(dateNowSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            const botOptions = createBotSpy.mock.calls[0]?.[0] as unknown as { isCostPaused?: () => boolean };
            expect(botOptions.isCostPaused!()).toBe(true);
        });

        test('a boot-time journal read failure is logged and tolerated, never blocking startup', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor', dailyCostCeilingUsd: 1, timezone: 'UTC' });
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: { send: mock(async () => { throw new Error('DynamoDB throttled'); }) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: fakeLedgerStoreWithEmit(), contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            spies.push(createConversationConductorSpy);

            const { createApp } = staticIndexModule;

            await expect(createApp()).resolves.toBeDefined();
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.any(String));
        });
    });

    describe('Notification bridge composition (Q5 / plan amendment B1)', () => {
        function fakeConductor(sessionId: string): Conductor & { submit: ReturnType<typeof mock>, appendWithoutTurn: ReturnType<typeof mock> } {
            return {
                open:              mock(async () => ({ sessionId, resumed: false })),
                submit:            mock(async () => ({})),
                appendWithoutTurn: mock(() => undefined),
                // opened:true — these tests model a conductor whose open() has already resolved;
                // the "attached but not open yet" gap has its own dedicated coverage in
                // notification-bridge.test.ts.
                status:            mock(() => ({ sessionId: undefined, opened: true })),
            } as unknown as Conductor & { submit: ReturnType<typeof mock>, appendWithoutTurn: ReturnType<typeof mock> };
        }

        test('is constructed before setupEmail and before createConversationConductor', async () => {
            const { emailSetupSpy } = wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => realCreateNotificationBridge(bridgeParams)
            );
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
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
            const { emailSetupSpy } = wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            spies.push(createBridgeSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(capturedBridge).toBeDefined();
            const emailOptions = emailSetupSpy.mock.calls[0]?.[0] as { notify?: NotifyFn };
            expect(emailOptions.notify).toBe(capturedBridge!.notify);
        });

        test('threads memoryBackend, healthRegistry, and notificationBridge.notify into setupBsky\'s options (Q8)', async () => {
            let capturedBridge: NotificationBridge | undefined;
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => {
                    const bridge = realCreateNotificationBridge(bridgeParams);
                    capturedBridge = bridge;
                    return bridge;
                }
            );
            const { bskySetupSpy } = wireHappyPathForCleanupTests(spies, { mode: 'conductor' }, {}, true);
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            spies.push(createBridgeSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(capturedBridge).toBeDefined();
            expect(bskySetupSpy).toBeDefined();
            const bskyOptions = bskySetupSpy!.mock.calls[0]?.[0] as { memoryBackend?: unknown, healthRegistry?: unknown, notify?: NotifyFn };
            expect(bskyOptions.notify).toBe(capturedBridge!.notify);
            expect(bskyOptions.memoryBackend).toBeDefined();
            expect(bskyOptions.healthRegistry).toBeDefined();
        });

        test('starts the dmPoller during app.start() and stops it during app.stop() (Q8)', async () => {
            const { dmPollerStart, dmPollerStop } = wireHappyPathForCleanupTests(spies, { mode: 'conductor' }, {}, true);
            // app.start() fires real healthRegistry.sendEvent transitions, which independently wake
            // the outbox drainer's health subscription — it needs a docClient.send that resolves
            // (see the identically-named helper in the "Lifecycle seams (P10)" describe block below).
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy: mock(() => {}) } as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
            const createConversationConductorSpy = spyOn(staticSessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
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
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
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
                capturedBridge?.notify({ source: 'mid-boot', text: 'mid-boot text', wake: true, dedupeKey: 'mid-boot-key' });
                return { conductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry };
            });
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined), stop: mock(async () => undefined), triggerCatchUp: mock(async () => undefined),
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
            botOptions.notify!({ source: 'post-boot', text: 'post-boot text', wake: true, dedupeKey: 'post-boot-key' });
            expect(conductor.submit).toHaveBeenCalledTimes(1);
            expect(conductor.submit.mock.calls[0]?.[1]).toEqual({ priority: 'other' });
        });

        test('app.stop() detaches the notification bridge from the conductor', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
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
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry,
            });
            spies.push(createBridgeSpy, createConversationConductorSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();

            expect(attachSpy).toHaveBeenCalledTimes(1);
            expect(detachSpy).not.toHaveBeenCalled();

            await app.stop();

            expect(detachSpy).toHaveBeenCalledTimes(1);
        });

        test('oneshot mode: the bridge is still constructed but never attached (no conductor exists)', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'oneshot' });
            let attachSpy: ReturnType<typeof spyOn>;
            const createBridgeSpy = spyOn(staticAgentIndexModule, 'createNotificationBridge').mockImplementation(
                (bridgeParams: Parameters<typeof realCreateNotificationBridge>[0]) => {
                    const bridge = realCreateNotificationBridge(bridgeParams);
                    attachSpy = spyOn(bridge, 'attachConductor');
                    return bridge;
                }
            );
            spies.push(createBridgeSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createBridgeSpy).toHaveBeenCalledTimes(1);
            expect(attachSpy).not.toHaveBeenCalled();
        });
    });

    describe('Health-outage notification source (Q6)', () => {
        test('subscribes exactly once to healthRegistry with a listener built from the real predicate, coalescer, and bridge notify; unsubscribes on stop()', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
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

        test('wires the subscription unconditionally: still subscribed once in oneshot mode with no conductor', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'oneshot' });

            const listenerReturns: HealthChangeListener[] = [];
            const createListenerSpy = spyOn(staticAgentIndexModule, 'createHealthNotificationListener').mockImplementation(
                (listenerParams: Parameters<typeof realCreateHealthNotificationListener>[0]) => {
                    const listener = realCreateHealthNotificationListener(listenerParams);
                    listenerReturns.push(listener);
                    return listener;
                }
            );

            const subscribedListeners: HealthChangeListener[] = [];
            const subscribeSpy = spyOn(staticServicesModule.ServiceHealthRegistryImpl.prototype, 'subscribe').mockImplementation(
                (listener: HealthChangeListener) => {
                    subscribedListeners.push(listener);
                    return mock(() => undefined);
                }
            );

            spies.push(createListenerSpy, subscribeSpy);

            const { createApp } = staticIndexModule;
            await createApp();

            expect(createListenerSpy).toHaveBeenCalledTimes(1);
            expect(subscribedListeners).toContain(listenerReturns[0]);
        });
    });

    describe('Lifecycle seams (P10)', () => {
        test('app.config exposes the resolved config createApp() was built from', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });

            const { createApp } = staticIndexModule;
            const app = await createApp();

            expect(app.config.session.mode).toBe('conductor');
        });

        /**
         * app.start() fires real `healthRegistry.sendEvent` transitions, which (independently of
         * this seam) wake the outbox drainer's health subscription — it needs a `docClient.send`
         * that resolves rather than `wireHappyPathForCleanupTests`'s bare `{}` docClient.
         */
        function stubDocClientSend(): void {
            spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient,
                tableName: 'IsambardMemory',
            }));
        }

        test('app.start() wires createDiscordRecoveryHandler with the resolved session mode as the health registry\'s discord subscriber', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'conductor' });
            stubDocClientSend();
            const fakeHandler = mock(() => undefined);
            const createDiscordRecoveryHandlerSpy = spyOn(staticAppLifecycleModule, 'createDiscordRecoveryHandler').mockReturnValue(fakeHandler);
            spies.push(createDiscordRecoveryHandlerSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();
            await app.start();

            expect(createDiscordRecoveryHandlerSpy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'conductor' }));
        });

        test('app.start() wires createDiscordRecoveryHandler with mode "oneshot" in oneshot mode', async () => {
            wireHappyPathForCleanupTests(spies, { mode: 'oneshot' });
            stubDocClientSend();
            const fakeHandler = mock(() => undefined);
            const createDiscordRecoveryHandlerSpy = spyOn(staticAppLifecycleModule, 'createDiscordRecoveryHandler').mockReturnValue(fakeHandler);
            spies.push(createDiscordRecoveryHandlerSpy);

            const { createApp } = staticIndexModule;
            const app = await createApp();
            await app.start();

            expect(createDiscordRecoveryHandlerSpy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'oneshot' }));
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

            const createAgentSpy = spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
                handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
            });
            spies.push(createAgentSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined),
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

            const createInboxMcpSpy = spyOn(staticInboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticInboxMcpModule.createInboxMCPServer>);
            spies.push(createInboxMcpSpy);

            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>));
            spies.push(InboxManagerSpy);

            // @ts-expect-error - Mocking constructor
            const createBotStateManagerSpy = spyOn(staticStateModule, 'BotStateManagerImpl').mockImplementation(() => ({ getCompactionStateManager: () => ({}) } as unknown as InstanceType<typeof staticStateModule.BotStateManagerImpl>));
            spies.push(createBotStateManagerSpy);

            // @ts-expect-error - Mocking constructor
            const TaskSessionBackendSpy = spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticTaskSessionModule.TaskSessionBackend>));
            spies.push(TaskSessionBackendSpy);

            const createTaskCleanupSpy = spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCleanupModule.createTaskCleanupProcessor>);
            spies.push(createTaskCleanupSpy);

            const createTaskCopierSpy = spyOn(staticTaskCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCopierModule.createTaskDirectoryCopier>);
            spies.push(createTaskCopierSpy);

            const createTaskCoordinatorSpy = spyOn(staticTaskCoordinatorModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCoordinatorModule.createTaskPersistenceCoordinator>);
            spies.push(createTaskCoordinatorSpy);

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
                adminChannelId:               '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
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

            const createAgentSpy = spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
                handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
            });
            spies.push(createAgentSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined),
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
                adminChannelId:               '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
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

            const createAgentSpy = spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
                handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
            });
            spies.push(createAgentSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined),
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
                adminChannelId:               '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
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

            // Mock storage client to succeed
            const mockDocClient = {} as unknown as DynamoDBDocumentClient;
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

            const createAgentSpy = spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
                handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
            });
            spies.push(createAgentSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined),
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
                adminChannelId:               '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
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
            const identityWarning = warnCalls.find((call: unknown[]) => (call[0] as string).includes('Failed to load identity context'));
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

            const createAgentSpy = spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
                handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
            });
            spies.push(createAgentSpy);

            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined),
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            expect(createApp()).rejects.toThrow('Memory not available');
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            expect(createApp()).rejects.toThrow('DynamoDB connection failed');
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw error from factory
            const { createApp } = staticIndexModule;
            expect(createApp()).rejects.toThrow('Invalid configuration');
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(staticConfigModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw raw string error
            const { createApp } = staticIndexModule;
            expect(createApp()).rejects.toThrow('String error in channel registry');
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

            const createAgentSpy = spyOn(staticAgentModule, 'createClaudeAgent').mockReturnValue({
                handleInput: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as unknown as StreamTracker })),
            });
            spies.push(createAgentSpy);

            // Mock bot with trackable stop method
            const mockBotStop = mock(async () => undefined);
            const createBotSpy = spyOn(staticDiscordModule, 'createDiscordBot').mockReturnValue({
                start:          mock(async () => undefined),
                stop:           mockBotStop,
                triggerCatchUp: mock(async () => undefined),
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

            const createInboxMcpSpy = spyOn(staticInboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as ReturnType<typeof staticInboxMcpModule.createInboxMCPServer>);
            spies.push(createInboxMcpSpy);

            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(staticCheckpointModule, 'CheckpointManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.CheckpointManager>));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(staticCheckpointModule, 'InboxManager').mockImplementation(() => ({} as unknown as InstanceType<typeof staticCheckpointModule.InboxManager>));
            spies.push(InboxManagerSpy);

            // @ts-expect-error - Mocking constructor
            const createBotStateManagerSpy = spyOn(staticStateModule, 'BotStateManagerImpl').mockImplementation(() => ({ getCompactionStateManager: () => ({}) } as unknown as InstanceType<typeof staticStateModule.BotStateManagerImpl>));
            spies.push(createBotStateManagerSpy);

            // @ts-expect-error - Mocking constructor
            const TaskSessionBackendSpy = spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({} as unknown as InstanceType<typeof staticTaskSessionModule.TaskSessionBackend>));
            spies.push(TaskSessionBackendSpy);

            const createTaskCleanupSpy = spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCleanupModule.createTaskCleanupProcessor>);
            spies.push(createTaskCleanupSpy);

            const createTaskCopierSpy = spyOn(staticTaskCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCopierModule.createTaskDirectoryCopier>);
            spies.push(createTaskCopierSpy);

            const createTaskCoordinatorSpy = spyOn(staticTaskCoordinatorModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as ReturnType<typeof staticTaskCoordinatorModule.createTaskPersistenceCoordinator>);
            spies.push(createTaskCoordinatorSpy);

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
                adminChannelId:               '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
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
                },
                session: sessionConfig,
                email:   {
                    user:                           'user@example.com',
                    password:                       'emailpass',
                    pollFallbackMs:                 300_000,
                    sseReconnectDelayMs:            5000,
                    maxBodySizeBytes:               50_000,
                    adminDiscordChannelId:          '987654321098765432',
                    wildDuckApiUrl:                 'https://wildduck.example.com',
                    sendReservoirCapacity:          24,
                    sendReservoirRefillRatePerHour: 1,
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60_000,
                        idleRefreshIntervalMs: 300_000,
                    },
                },
                adminDiscordUserId: '423276934781468692',
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
