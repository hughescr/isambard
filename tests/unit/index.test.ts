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
import * as staticAgentModule from '@/agent/agent';
import * as staticContextBuilderModule from '@/agent/context-builder';
import * as staticDiscordMcpModule from '@/agent/discord-mcp-server';
import * as staticInboxMcpModule from '@/agent/inbox-mcp-server';
import * as staticMemoryMcpModule from '@/agent/memory-mcp-server';
import * as staticPluginLoaderModule from '@/agent/plugin-loader';
import * as staticQuestionRegistryModule from '@/agent/question-registry';
import type { StreamTracker } from '@/agent/stream-tracker';
import * as staticTaskCleanupModule from '@/agent/task-cleanup-processor';
import * as staticTaskCopierModule from '@/agent/task-directory-copier';
import * as staticTaskCoordinatorModule from '@/agent/task-persistence-coordinator';
import * as staticConfigModule from '@/config/loader';
import * as staticIndexModule from '@/index';
import * as staticDiscordModule from '@/integrations/discord/bot';
import * as staticChannelRegistryModule from '@/integrations/discord/channel-registry';
import * as staticDiscordClientModule from '@/integrations/discord/client';
import * as staticCheckpointModule from '@/integrations/discord/inbox';
import * as staticMessageFetcherModule from '@/integrations/discord/message-history/fetcher';
import * as staticMessageSearchModule from '@/integrations/discord/message-history/search';
import * as staticMessageSummarizerModule from '@/integrations/discord/message-history/summarizer';
import * as staticEmailSetupModule from '@/integrations/discord/setup/email-setup';
import * as staticStateModule from '@/integrations/discord/state';
import { createGuildId } from '@/integrations/discord/types';
import * as staticWildDuckClientModule from '@/integrations/email';
import * as staticPersonAllowlistModule from '@/storage';
import * as staticStorageClientModule from '@/storage/client';
import * as staticMemoryToolModule from '@/storage/memory-tool';
import * as staticTaskSessionModule from '@/storage/task-session';

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
                email: {
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
                email: {
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
                listener:                { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:           {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:          {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler: {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:          { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                adminChannelId:          '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
                sendApprovalRequest:     mock(async () => {}),
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
                email: {
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
                listener:                { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:           {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:          {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler: {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:          { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                adminChannelId:          '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
                sendApprovalRequest:     mock(async () => {}),
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
                email: {
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
                listener:                { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:           {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:          {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler: {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:          { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                adminChannelId:          '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
                sendApprovalRequest:     mock(async () => {}),
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
                email: {
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
                listener:                { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:           {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:          {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler: {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:          { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                adminChannelId:          '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
                sendApprovalRequest:     mock(async () => {}),
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
                email: {
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
                listener:                { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:           {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:          {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler: {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:          { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                adminChannelId:          '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
                sendApprovalRequest:     mock(async () => {}),
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
                email: {
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
                email: {
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
                email: {
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
                email: {
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
                email: {
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
                listener:                { start: mock(async () => {}), stop: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['listener'],
                reviewHandler:           {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['reviewHandler'],
                emailMcpServer:          {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['emailMcpServer'],
                outboundApprovalHandler: {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['outboundApprovalHandler'],
                wildDuckClient:          { init: mock(async () => {}) } as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['wildDuckClient'],
                allowlist:               {} as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['allowlist'],
                adminChannelId:          '987654321098765432' as unknown as Awaited<ReturnType<typeof staticEmailSetupModule.setupEmail>>['adminChannelId'],
                sendApprovalRequest:     mock(async () => {}),
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
                email: {
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
