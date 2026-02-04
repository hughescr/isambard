/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, lodash/prefer-constant -- Test mocks */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { find as _find } from 'lodash';
import { mockLogger, resetMockSstResource } from '../setup';
import { createGuildId } from '@/integrations/discord/types';

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
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock MemoryToolBackend to throw error (now REQUIRED, not optional)
            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
                throw new Error('Memory backend initialization failed');
            });
            spies.push(MemoryToolBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123',
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw
            const { createApp } = await import('@/index');
            expect(createApp()).rejects.toThrow('Failed to initialize Discord client and channel registry: Memory backend initialization failed. The bot cannot start without these.');

            // Verify error was logged
            expect(mockLogger.error).toHaveBeenCalled();
            const errorCalls = mockLogger.error.mock.calls as any[][];
            const systemError = _find(errorCalls, (call: any) => call[0].includes('Failed to initialize required systems'));
            expect(systemError).toBeDefined();
            expect((systemError as any)[0]).toContain('Memory backend initialization failed');
        });

        test('should handle non-Error exceptions in memory initialization', async () => {
            // Mock storage client to succeed
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock MemoryToolBackend to throw a string (non-Error)
            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error exception handling
                throw 'String error thrown';
            });
            spies.push(MemoryToolBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123',
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw
            const { createApp } = await import('@/index');
            expect(createApp()).rejects.toThrow('Failed to initialize Discord client and channel registry: String error thrown. The bot cannot start without these.');

            // Verify error was logged with string error converted
            expect(mockLogger.error).toHaveBeenCalled();
            const errorCalls = mockLogger.error.mock.calls as any[][];
            const systemError = _find(errorCalls, (call: any) => call[0].includes('Failed to initialize required systems'));
            expect(systemError).toBeDefined();
            expect((systemError as any)[0]).toContain('String error thrown');
        });
    });

    describe('Plugin loading path', () => {
        test('should call loadPlugins with exact string "plugins"', async () => {
            // Mock storage client to succeed
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            const pluginLoaderModule = await import('@/agent/plugin-loader');
            const loadPluginsSpy = spyOn(pluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const agentModule = await import('@/agent/agent');
            const createAgentSpy = spyOn(agentModule, 'createClaudeAgent').mockReturnValue({
                chat:      mock(async () => 'response'),
                chatBatch: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as any })),
            });
            spies.push(createAgentSpy);

            const discordModule = await import('@/integrations/discord/bot');
            const createBotSpy = spyOn(discordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined),
                stop:  mock(async () => undefined),
            });
            spies.push(createBotSpy);

            // Mock all required systems to succeed
            const memoryMcpModule = await import('@/agent/memory-mcp-server');
            const createMemoryMcpSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
            spies.push(createMemoryMcpSpy);

            const discordMcpModule = await import('@/agent/discord-mcp-server');
            const createDiscordMcpSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
            spies.push(createDiscordMcpSpy);

            const discordClientModule = await import('@/integrations/discord/client');
            const createDiscordClientSpy = spyOn(discordClientModule, 'createDiscordClient').mockReturnValue({} as any);
            spies.push(createDiscordClientSpy);

            const messageFetcherModule = await import('@/integrations/discord/message-history/fetcher');
            const createFetcherSpy = spyOn(messageFetcherModule, 'createMessageFetcher').mockReturnValue({} as any);
            spies.push(createFetcherSpy);

            const messageSummarizerModule = await import('@/integrations/discord/message-history/summarizer');
            const createSummarizerSpy = spyOn(messageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as any);
            spies.push(createSummarizerSpy);

            const messageSearchModule = await import('@/integrations/discord/message-history/search');
            const createSearchSpy = spyOn(messageSearchModule, 'createMessageSearchService').mockReturnValue({} as any);
            spies.push(createSearchSpy);

            const questionRegistryModule = await import('@/agent/question-registry');
            const createQuestionRegistrySpy = spyOn(questionRegistryModule, 'createQuestionRegistry').mockReturnValue({} as any);
            spies.push(createQuestionRegistrySpy);

            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as any));
            spies.push(MemoryToolBackendSpy);

            const contextBuilderModule = await import('@/agent/context-builder');
            const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as any);
            spies.push(createContextBuilderSpy);

            const inboxMcpModule = await import('@/agent/inbox-mcp-server');
            const createInboxMcpSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
            spies.push(createInboxMcpSpy);

            const checkpointModule = await import('@/integrations/discord/inbox');
            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(checkpointModule, 'CheckpointManager').mockImplementation(() => ({} as any));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(checkpointModule, 'InboxManager').mockImplementation(() => ({} as any));
            spies.push(InboxManagerSpy);

            const stateModule = await import('@/integrations/discord/state');
            const createBotStateManagerSpy = spyOn(stateModule, 'createBotStateManager').mockReturnValue({} as any);
            spies.push(createBotStateManagerSpy);

            const taskSessionModule = await import('@/storage/task-session');
            // @ts-expect-error - Mocking constructor
            const TaskSessionBackendSpy = spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({} as any));
            spies.push(TaskSessionBackendSpy);

            const taskCleanupModule = await import('@/agent/task-cleanup-processor');
            const createTaskCleanupSpy = spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as any);
            spies.push(createTaskCleanupSpy);

            const taskCopierModule = await import('@/agent/task-directory-copier');
            const createTaskCopierSpy = spyOn(taskCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as any);
            spies.push(createTaskCopierSpy);

            const taskCoordinatorModule = await import('@/agent/task-persistence-coordinator');
            const createTaskCoordinatorSpy = spyOn(taskCoordinatorModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as any);
            spies.push(createTaskCoordinatorSpy);

            const channelRegistryModule = await import('@/integrations/discord/channel-registry');
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryManagerSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123',
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            await createApp();

            // Kills mutant on line 199: Verify loadPlugins was called with exact string 'plugins'
            expect(loadPluginsSpy).toHaveBeenCalledWith('plugins');
            expect(loadPluginsSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('Identity context loading branches', () => {
        test('should use fallback when oauthToken is falsy (empty string)', async () => {
            // Mock storage client to succeed
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            const pluginLoaderModule = await import('@/agent/plugin-loader');
            const loadPluginsSpy = spyOn(pluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const agentModule = await import('@/agent/agent');
            const createAgentSpy = spyOn(agentModule, 'createClaudeAgent').mockReturnValue({
                chat:      mock(async () => 'response'),
                chatBatch: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as any })),
            });
            spies.push(createAgentSpy);

            const discordModule = await import('@/integrations/discord/bot');
            const createBotSpy = spyOn(discordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined),
                stop:  mock(async () => undefined),
            });
            spies.push(createBotSpy);

            // Mock all required systems to succeed
            const memoryMcpModule = await import('@/agent/memory-mcp-server');
            const createMemoryMcpSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
            spies.push(createMemoryMcpSpy);

            const discordMcpModule = await import('@/agent/discord-mcp-server');
            const createDiscordMcpSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
            spies.push(createDiscordMcpSpy);

            const discordClientModule = await import('@/integrations/discord/client');
            const createDiscordClientSpy = spyOn(discordClientModule, 'createDiscordClient').mockReturnValue({} as any);
            spies.push(createDiscordClientSpy);

            const messageFetcherModule = await import('@/integrations/discord/message-history/fetcher');
            const createFetcherSpy = spyOn(messageFetcherModule, 'createMessageFetcher').mockReturnValue({} as any);
            spies.push(createFetcherSpy);

            const messageSummarizerModule = await import('@/integrations/discord/message-history/summarizer');
            const createSummarizerSpy = spyOn(messageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as any);
            spies.push(createSummarizerSpy);

            const messageSearchModule = await import('@/integrations/discord/message-history/search');
            const createSearchSpy = spyOn(messageSearchModule, 'createMessageSearchService').mockReturnValue({} as any);
            spies.push(createSearchSpy);

            const questionRegistryModule = await import('@/agent/question-registry');
            const createQuestionRegistrySpy = spyOn(questionRegistryModule, 'createQuestionRegistry').mockReturnValue({} as any);
            spies.push(createQuestionRegistrySpy);

            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as any));
            spies.push(MemoryToolBackendSpy);

            const contextBuilderModule = await import('@/agent/context-builder');
            const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as any);
            spies.push(createContextBuilderSpy);

            const inboxMcpModule = await import('@/agent/inbox-mcp-server');
            const createInboxMcpSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
            spies.push(createInboxMcpSpy);

            const checkpointModule = await import('@/integrations/discord/inbox');
            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(checkpointModule, 'CheckpointManager').mockImplementation(() => ({} as any));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(checkpointModule, 'InboxManager').mockImplementation(() => ({} as any));
            spies.push(InboxManagerSpy);

            const stateModule = await import('@/integrations/discord/state');
            const createBotStateManagerSpy = spyOn(stateModule, 'createBotStateManager').mockReturnValue({} as any);
            spies.push(createBotStateManagerSpy);

            const taskSessionModule = await import('@/storage/task-session');
            // @ts-expect-error - Mocking constructor
            const TaskSessionBackendSpy = spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({} as any));
            spies.push(TaskSessionBackendSpy);

            const taskCleanupModule = await import('@/agent/task-cleanup-processor');
            const createTaskCleanupSpy = spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as any);
            spies.push(createTaskCleanupSpy);

            const taskCopierModule = await import('@/agent/task-directory-copier');
            const createTaskCopierSpy = spyOn(taskCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as any);
            spies.push(createTaskCopierSpy);

            const taskCoordinatorModule = await import('@/agent/task-persistence-coordinator');
            const createTaskCoordinatorSpy = spyOn(taskCoordinatorModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as any);
            spies.push(createTaskCoordinatorSpy);

            const channelRegistryModule = await import('@/integrations/discord/channel-registry');
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryManagerSpy);

            // Mock loadConfig with empty oauthToken
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: '', // Empty string (falsy)
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            await createApp();

            // Kills mutant on line 216: When oauthToken is falsy, identityContext should stay undefined
            // Verify createDiscordBot was called with undefined identityContext
            expect(createBotSpy).toHaveBeenCalled();
            const botCallArgs = createBotSpy.mock.calls[0][0];
            expect(botCallArgs.identityContext).toBeUndefined();
        });

        test('should call loadCoreIdentity when oauthToken is truthy and contextBuilder exists', async () => {
            // Mock storage client to succeed
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock context builder with loadCoreIdentity
            const contextBuilderModule = await import('@/agent/context-builder');
            const mockLoadCoreIdentity = mock(async () => 'Test Identity from Memory');
            const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({
                loadCoreIdentity: mockLoadCoreIdentity,
            } as any);
            spies.push(createContextBuilderSpy);

            const pluginLoaderModule = await import('@/agent/plugin-loader');
            const loadPluginsSpy = spyOn(pluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const agentModule = await import('@/agent/agent');
            const createAgentSpy = spyOn(agentModule, 'createClaudeAgent').mockReturnValue({
                chat:      mock(async () => 'response'),
                chatBatch: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as any })),
            });
            spies.push(createAgentSpy);

            const discordModule = await import('@/integrations/discord/bot');
            const createBotSpy = spyOn(discordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined),
                stop:  mock(async () => undefined),
            });
            spies.push(createBotSpy);

            // Mock MCP server factories
            const memoryMcpModule = await import('@/agent/memory-mcp-server');
            const createMemoryMcpSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
            spies.push(createMemoryMcpSpy);

            const discordMcpModule = await import('@/agent/discord-mcp-server');
            const createDiscordMcpSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
            spies.push(createDiscordMcpSpy);

            const discordClientModule = await import('@/integrations/discord/client');
            const createDiscordClientSpy = spyOn(discordClientModule, 'createDiscordClient').mockReturnValue({} as any);
            spies.push(createDiscordClientSpy);

            const messageFetcherModule = await import('@/integrations/discord/message-history/fetcher');
            const createFetcherSpy = spyOn(messageFetcherModule, 'createMessageFetcher').mockReturnValue({} as any);
            spies.push(createFetcherSpy);

            const messageSummarizerModule = await import('@/integrations/discord/message-history/summarizer');
            const createSummarizerSpy = spyOn(messageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as any);
            spies.push(createSummarizerSpy);

            const messageSearchModule = await import('@/integrations/discord/message-history/search');
            const createSearchSpy = spyOn(messageSearchModule, 'createMessageSearchService').mockReturnValue({} as any);
            spies.push(createSearchSpy);

            const questionRegistryModule = await import('@/agent/question-registry');
            const createQuestionRegistrySpy = spyOn(questionRegistryModule, 'createQuestionRegistry').mockReturnValue({} as any);
            spies.push(createQuestionRegistrySpy);

            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as any));
            spies.push(MemoryToolBackendSpy);

            // Mock loadConfig with valid oauthToken
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123', // Truthy
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
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
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock context builder with loadCoreIdentity returning empty string
            const contextBuilderModule = await import('@/agent/context-builder');
            const mockLoadCoreIdentity = mock(async () => ''); // Empty string (falsy)
            const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({
                loadCoreIdentity: mockLoadCoreIdentity,
            } as any);
            spies.push(createContextBuilderSpy);

            const pluginLoaderModule = await import('@/agent/plugin-loader');
            const loadPluginsSpy = spyOn(pluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const agentModule = await import('@/agent/agent');
            const createAgentSpy = spyOn(agentModule, 'createClaudeAgent').mockReturnValue({
                chat:      mock(async () => 'response'),
                chatBatch: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as any })),
            });
            spies.push(createAgentSpy);

            const discordModule = await import('@/integrations/discord/bot');
            const createBotSpy = spyOn(discordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined),
                stop:  mock(async () => undefined),
            });
            spies.push(createBotSpy);

            // Mock MCP server factories (same as previous test)
            const memoryMcpModule = await import('@/agent/memory-mcp-server');
            const createMemoryMcpSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
            spies.push(createMemoryMcpSpy);

            const discordMcpModule = await import('@/agent/discord-mcp-server');
            const createDiscordMcpSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
            spies.push(createDiscordMcpSpy);

            const discordClientModule = await import('@/integrations/discord/client');
            const createDiscordClientSpy = spyOn(discordClientModule, 'createDiscordClient').mockReturnValue({} as any);
            spies.push(createDiscordClientSpy);

            const messageFetcherModule = await import('@/integrations/discord/message-history/fetcher');
            const createFetcherSpy = spyOn(messageFetcherModule, 'createMessageFetcher').mockReturnValue({} as any);
            spies.push(createFetcherSpy);

            const messageSummarizerModule = await import('@/integrations/discord/message-history/summarizer');
            const createSummarizerSpy = spyOn(messageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as any);
            spies.push(createSummarizerSpy);

            const messageSearchModule = await import('@/integrations/discord/message-history/search');
            const createSearchSpy = spyOn(messageSearchModule, 'createMessageSearchService').mockReturnValue({} as any);
            spies.push(createSearchSpy);

            const questionRegistryModule = await import('@/agent/question-registry');
            const createQuestionRegistrySpy = spyOn(questionRegistryModule, 'createQuestionRegistry').mockReturnValue({} as any);
            spies.push(createQuestionRegistrySpy);

            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as any));
            spies.push(MemoryToolBackendSpy);

            // Mock loadConfig with valid oauthToken
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123', // Truthy
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
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
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock context builder with loadCoreIdentity throwing error
            const contextBuilderModule = await import('@/agent/context-builder');
            const mockLoadCoreIdentity = mock(async () => {
                throw new Error('Failed to load identity from DynamoDB');
            });
            const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({
                loadCoreIdentity: mockLoadCoreIdentity,
            } as any);
            spies.push(createContextBuilderSpy);

            const pluginLoaderModule = await import('@/agent/plugin-loader');
            const loadPluginsSpy = spyOn(pluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const agentModule = await import('@/agent/agent');
            const createAgentSpy = spyOn(agentModule, 'createClaudeAgent').mockReturnValue({
                chat:      mock(async () => 'response'),
                chatBatch: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as any })),
            });
            spies.push(createAgentSpy);

            const discordModule = await import('@/integrations/discord/bot');
            const createBotSpy = spyOn(discordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined),
                stop:  mock(async () => undefined),
            });
            spies.push(createBotSpy);

            // Mock MCP server factories
            const memoryMcpModule = await import('@/agent/memory-mcp-server');
            const createMemoryMcpSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
            spies.push(createMemoryMcpSpy);

            const discordMcpModule = await import('@/agent/discord-mcp-server');
            const createDiscordMcpSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
            spies.push(createDiscordMcpSpy);

            const discordClientModule = await import('@/integrations/discord/client');
            const createDiscordClientSpy = spyOn(discordClientModule, 'createDiscordClient').mockReturnValue({} as any);
            spies.push(createDiscordClientSpy);

            const messageFetcherModule = await import('@/integrations/discord/message-history/fetcher');
            const createFetcherSpy = spyOn(messageFetcherModule, 'createMessageFetcher').mockReturnValue({} as any);
            spies.push(createFetcherSpy);

            const messageSummarizerModule = await import('@/integrations/discord/message-history/summarizer');
            const createSummarizerSpy = spyOn(messageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as any);
            spies.push(createSummarizerSpy);

            const messageSearchModule = await import('@/integrations/discord/message-history/search');
            const createSearchSpy = spyOn(messageSearchModule, 'createMessageSearchService').mockReturnValue({} as any);
            spies.push(createSearchSpy);

            const questionRegistryModule = await import('@/agent/question-registry');
            const createQuestionRegistrySpy = spyOn(questionRegistryModule, 'createQuestionRegistry').mockReturnValue({} as any);
            spies.push(createQuestionRegistrySpy);

            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as any));
            spies.push(MemoryToolBackendSpy);

            // Mock loadConfig with valid oauthToken
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123', // Truthy
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            await createApp();

            // Kills mutant on lines 136-140: Verify error was caught and logged
            expect(mockLogger.warn).toHaveBeenCalled();
            const warnCalls = mockLogger.warn.mock.calls as any[][];
            const identityWarning = _find(warnCalls, (call: any) => call[0].includes('Failed to load identity context'));
            expect(identityWarning).toBeDefined();
            expect((identityWarning as any)[0]).toContain('Failed to load identity from DynamoDB');

            // Verify createDiscordBot was called with the fallback identity
            expect(createBotSpy).toHaveBeenCalled();
            const botCallArgs = createBotSpy.mock.calls[0][0];
            expect(botCallArgs.identityContext).toBe('Isambard - AI Assistant');
        });

        test('should use fallback when contextBuilder is undefined', async () => {
            // Mock storage client to succeed (required for channelRegistry)
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock channelRegistry creation (REQUIRED)
            const channelRegistryModule = await import('@/integrations/discord/channel-registry');
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryManagerSpy);

            // Mock MemoryToolBackend to throw error (so contextBuilder stays undefined)
            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
                throw new Error('Memory not available');
            });
            spies.push(MemoryToolBackendSpy);

            const pluginLoaderModule = await import('@/agent/plugin-loader');
            const loadPluginsSpy = spyOn(pluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const agentModule = await import('@/agent/agent');
            const createAgentSpy = spyOn(agentModule, 'createClaudeAgent').mockReturnValue({
                chat:      mock(async () => 'response'),
                chatBatch: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as any })),
            });
            spies.push(createAgentSpy);

            const discordModule = await import('@/integrations/discord/bot');
            const createBotSpy = spyOn(discordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined),
                stop:  mock(async () => undefined),
            });
            spies.push(createBotSpy);

            // Mock loadConfig with valid oauthToken
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123', // Truthy
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw because memory is now required
            const { createApp } = await import('@/index');
            expect(createApp()).rejects.toThrow('Failed to initialize Discord client and channel registry: Memory not available. The bot cannot start without these.');

            // Verify error was logged
            expect(mockLogger.error).toHaveBeenCalled();
            const errorCalls = mockLogger.error.mock.calls as any[][];
            const systemError = _find(errorCalls, (call: any) => call[0].includes('Failed to initialize required systems'));
            expect(systemError).toBeDefined();
            expect((systemError as any)[0]).toContain('Memory not available');
        });
    });

    describe('ChannelRegistry initialization failure handling', () => {
        test('should throw fatal error when ChannelRegistryBackend construction fails', async () => {
            // Mock storage client to succeed
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock ChannelRegistryBackend constructor to throw error
            const channelRegistryModule = await import('@/integrations/discord/channel-registry');
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
                throw new Error('DynamoDB connection failed');
            });
            spies.push(ChannelRegistryBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123',
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw
            const { createApp } = await import('@/index');
            expect(createApp()).rejects.toThrow('Failed to initialize Discord client and channel registry: DynamoDB connection failed. The bot cannot start without these.');

            // Verify error was logged
            expect(mockLogger.error).toHaveBeenCalled();
            const errorCalls = mockLogger.error.mock.calls as any[][];
            const channelRegistryError = _find(errorCalls, (call: any) => call[0].includes('Failed to initialize required systems'));
            expect(channelRegistryError).toBeDefined();
            expect((channelRegistryError as any)[0]).toContain('DynamoDB connection failed');
        });

        test('should throw fatal error when ChannelRegistryManager construction fails', async () => {
            // Mock storage client to succeed
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock ChannelRegistryBackend to succeed
            const channelRegistryModule = await import('@/integrations/discord/channel-registry');
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryBackendSpy);

            // Mock ChannelRegistryManager constructor to throw error
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => {
                throw new Error('Invalid configuration');
            });
            spies.push(ChannelRegistryManagerSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123',
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw
            const { createApp } = await import('@/index');
            expect(createApp()).rejects.toThrow('Failed to initialize Discord client and channel registry: Invalid configuration. The bot cannot start without these.');

            // Verify error was logged
            expect(mockLogger.error).toHaveBeenCalled();
            const errorCalls = mockLogger.error.mock.calls as any[][];
            const channelRegistryError = _find(errorCalls, (call: any) => call[0].includes('Failed to initialize required systems'));
            expect(channelRegistryError).toBeDefined();
            expect((channelRegistryError as any)[0]).toContain('Invalid configuration');
        });

        test('should handle non-Error exceptions in ChannelRegistry initialization', async () => {
            // Mock storage client to succeed
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            // Mock ChannelRegistryBackend to throw non-Error exception
            const channelRegistryModule = await import('@/integrations/discord/channel-registry');
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error exception handling
                throw 'String error in channel registry';
            });
            spies.push(ChannelRegistryBackendSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123',
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp - should throw
            const { createApp } = await import('@/index');
            expect(createApp()).rejects.toThrow('Failed to initialize Discord client and channel registry: String error in channel registry. The bot cannot start without these.');

            // Verify error was logged
            expect(mockLogger.error).toHaveBeenCalled();
            const errorCalls = mockLogger.error.mock.calls as any[][];
            const channelRegistryError = _find(errorCalls, (call: any) => call[0].includes('Failed to initialize required systems'));
            expect(channelRegistryError).toBeDefined();
            expect((channelRegistryError as any)[0]).toContain('String error in channel registry');
        });
    });

    describe('App stop idempotency', () => {
        test('should only call bot.stop() once when stop() is called multiple times', async () => {
            mockLogger.debug.mockClear();

            // Mock storage client to succeed (required for channelRegistry)
            const storageClientModule = await import('@/storage/client');
            const mockDocClient = {} as any;
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as any,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createClientSpy);

            const pluginLoaderModule = await import('@/agent/plugin-loader');
            const loadPluginsSpy = spyOn(pluginLoaderModule, 'loadPlugins').mockResolvedValue([]);
            spies.push(loadPluginsSpy);

            const agentModule = await import('@/agent/agent');
            const createAgentSpy = spyOn(agentModule, 'createClaudeAgent').mockReturnValue({
                chat:      mock(async () => 'response'),
                chatBatch: mock(async () => ({ response: 'response', wasInterrupted: false, sessionId: undefined, streamTracker: {} as any })),
            });
            spies.push(createAgentSpy);

            // Mock bot with trackable stop method
            const discordModule = await import('@/integrations/discord/bot');
            const mockBotStop = mock(async () => undefined);
            const createBotSpy = spyOn(discordModule, 'createDiscordBot').mockReturnValue({
                start: mock(async () => undefined),
                stop:  mockBotStop,
            });
            spies.push(createBotSpy);

            // Mock all required systems to succeed
            const memoryMcpModule = await import('@/agent/memory-mcp-server');
            const createMemoryMcpSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
            spies.push(createMemoryMcpSpy);

            const discordMcpModule = await import('@/agent/discord-mcp-server');
            const createDiscordMcpSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
            spies.push(createDiscordMcpSpy);

            const discordClientModule = await import('@/integrations/discord/client');
            const createDiscordClientSpy = spyOn(discordClientModule, 'createDiscordClient').mockReturnValue({} as any);
            spies.push(createDiscordClientSpy);

            const messageFetcherModule = await import('@/integrations/discord/message-history/fetcher');
            const createFetcherSpy = spyOn(messageFetcherModule, 'createMessageFetcher').mockReturnValue({} as any);
            spies.push(createFetcherSpy);

            const messageSummarizerModule = await import('@/integrations/discord/message-history/summarizer');
            const createSummarizerSpy = spyOn(messageSummarizerModule, 'createMessageSummarizer').mockReturnValue({} as any);
            spies.push(createSummarizerSpy);

            const messageSearchModule = await import('@/integrations/discord/message-history/search');
            const createSearchSpy = spyOn(messageSearchModule, 'createMessageSearchService').mockReturnValue({} as any);
            spies.push(createSearchSpy);

            const questionRegistryModule = await import('@/agent/question-registry');
            const createQuestionRegistrySpy = spyOn(questionRegistryModule, 'createQuestionRegistry').mockReturnValue({} as any);
            spies.push(createQuestionRegistrySpy);

            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error - Mocking constructor
            const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({} as any));
            spies.push(MemoryToolBackendSpy);

            const contextBuilderModule = await import('@/agent/context-builder');
            const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as any);
            spies.push(createContextBuilderSpy);

            const inboxMcpModule = await import('@/agent/inbox-mcp-server');
            const createInboxMcpSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
            spies.push(createInboxMcpSpy);

            const checkpointModule = await import('@/integrations/discord/inbox');
            // @ts-expect-error - Mocking constructor
            const CheckpointManagerSpy = spyOn(checkpointModule, 'CheckpointManager').mockImplementation(() => ({} as any));
            spies.push(CheckpointManagerSpy);
            // @ts-expect-error - Mocking constructor
            const InboxManagerSpy = spyOn(checkpointModule, 'InboxManager').mockImplementation(() => ({} as any));
            spies.push(InboxManagerSpy);

            const stateModule = await import('@/integrations/discord/state');
            const createBotStateManagerSpy = spyOn(stateModule, 'createBotStateManager').mockReturnValue({} as any);
            spies.push(createBotStateManagerSpy);

            const taskSessionModule = await import('@/storage/task-session');
            // @ts-expect-error - Mocking constructor
            const TaskSessionBackendSpy = spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({} as any));
            spies.push(TaskSessionBackendSpy);

            const taskCleanupModule = await import('@/agent/task-cleanup-processor');
            const createTaskCleanupSpy = spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as any);
            spies.push(createTaskCleanupSpy);

            const taskCopierModule = await import('@/agent/task-directory-copier');
            const createTaskCopierSpy = spyOn(taskCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as any);
            spies.push(createTaskCopierSpy);

            const taskCoordinatorModule = await import('@/agent/task-persistence-coordinator');
            const createTaskCoordinatorSpy = spyOn(taskCoordinatorModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as any);
            spies.push(createTaskCoordinatorSpy);

            const channelRegistryModule = await import('@/integrations/discord/channel-registry');
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryBackendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryBackendSpy);
            // @ts-expect-error - Mocking constructor
            const ChannelRegistryManagerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({} as any));
            spies.push(ChannelRegistryManagerSpy);

            // Mock loadConfig and loadDynamoDBConfig
            const configModule = await import('@/config/loader');
            const loadConfigSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
                app: {
                    nodeEnv:  'development',
                    logLevel: 'info',
                    port:     3000,
                },
                agent: {
                    oauthToken: 'test-oauth-token-123',
                },
                caldav: {
                    url:      'https://caldav.example.com',
                    username: 'user',
                    password: 'password',
                },
                email: {
                    imapHost: 'mail.example.com',
                    imapPort: 993,
                    smtpHost: 'mail.example.com',
                    smtpPort: 587,
                    user:     'user@example.com',
                    password: 'emailpass',
                },
                discord: {
                    botToken:      'bot-token-123',
                    applicationId: 'app-id-456',
                    homeGuildId:   createGuildId('home-guild-123'),
                    presence:      {
                        updateThrottleMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                },
                box: {
                    clientId:     'box-client-id',
                    clientSecret: 'box-secret',
                },
            });
            spies.push(loadConfigSpy);

            const loadDynamoDBConfigSpy = spyOn(configModule, 'loadDynamoDBConfig').mockReturnValue({
                tableName: 'IsambardMemory',
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            const app = await createApp();

            // Call stop twice
            await app.stop();
            await app.stop();

            // Verify bot.stop() was only called once (idempotent)
            expect(mockBotStop).toHaveBeenCalledTimes(1);

            // Optionally verify logger.debug was called with skip message on second call
            const debugCalls = mockLogger.debug.mock.calls as any[][];
            const skipMessage = _find(debugCalls, (call: any) => call[0].includes('already stopped'));
            expect(skipMessage).toBeDefined();
        });
    });
});
