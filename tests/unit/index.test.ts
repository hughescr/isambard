/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, lodash/prefer-constant -- Test mocks */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { find as _find } from 'lodash';
import { mockLogger } from '../setup';

describe('createApp', () => {
    let spies: ReturnType<typeof spyOn>[];

    beforeEach(() => {
        spies = [];
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
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
    });

    describe('Memory initialization failure handling', () => {
        test('should log warning when memory initialization fails', async () => {
            // Mock storage client to throw error during initialization
            const storageClientModule = await import('@/storage/client');
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockImplementation(() => {
                throw new Error('DynamoDB connection failed');
            });
            spies.push(createClientSpy);

            // Mock other dependencies
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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            const app = await createApp();

            // Kills mutant on line 106: Verify logger.warn was called with error message
            expect(mockLogger.warn).toHaveBeenCalled();
            const warnCalls = mockLogger.warn.mock.calls as any[][];
            const memoryWarning = _find(warnCalls, (call: any) => call[0].includes('Memory not configured'));
            expect(memoryWarning).toBeDefined();
            expect((memoryWarning as any)[0]).toContain('DynamoDB connection failed');

            // Verify app was still created successfully
            expect(app).toBeDefined();
            expect(typeof app.start).toBe('function');
            expect(typeof app.stop).toBe('function');
        });

        test('should handle non-Error exceptions in memory initialization', async () => {
            // Mock storage client to throw a string (non-Error)
            const storageClientModule = await import('@/storage/client');
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockImplementation(() => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error exception handling
                throw 'String error thrown';
            });
            spies.push(createClientSpy);

            // Mock other dependencies
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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            await createApp();

            // Verify logger.warn was called with string error converted
            expect(mockLogger.warn).toHaveBeenCalled();
            const warnCalls = mockLogger.warn.mock.calls as any[][];
            const memoryWarning = _find(warnCalls, (call: any) => call[0].includes('Memory not configured'));
            expect(memoryWarning).toBeDefined();
            expect((memoryWarning as any)[0]).toContain('String error thrown');
        });
    });

    describe('Plugin loading path', () => {
        test('should call loadPlugins with exact string "plugins"', async () => {
            // Mock all dependencies
            const storageClientModule = await import('@/storage/client');
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            await createApp();

            // Kills mutant on line 113: Verify loadPlugins was called with exact string 'plugins'
            expect(loadPluginsSpy).toHaveBeenCalledWith('plugins');
            expect(loadPluginsSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('Identity context loading branches', () => {
        test('should use fallback when oauthToken is falsy (empty string)', async () => {
            // Mock all dependencies
            const storageClientModule = await import('@/storage/client');
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            await createApp();

            // Kills mutant on line 126: When oauthToken is falsy, identityContext should stay undefined
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

            const messageCacheModule = await import('@/storage/message-cache/cache');
            // @ts-expect-error - Mocking constructor
            const MessageCacheSpy = spyOn(messageCacheModule, 'MessageCache').mockImplementation(() => ({} as any));
            spies.push(MessageCacheSpy);

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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
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

            const messageCacheModule = await import('@/storage/message-cache/cache');
            // @ts-expect-error - Mocking constructor
            const MessageCacheSpy = spyOn(messageCacheModule, 'MessageCache').mockImplementation(() => ({} as any));
            spies.push(MessageCacheSpy);

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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
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

            const messageCacheModule = await import('@/storage/message-cache/cache');
            // @ts-expect-error - Mocking constructor
            const MessageCacheSpy = spyOn(messageCacheModule, 'MessageCache').mockImplementation(() => ({} as any));
            spies.push(MessageCacheSpy);

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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
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
            // Mock storage client to throw error (so contextBuilder stays undefined)
            const storageClientModule = await import('@/storage/client');
            const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
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
                    botToken:            'bot-token-123',
                    applicationId:       'app-id-456',
                    monitoredChannelIds: ['123', '456'],
                    presence:            {
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
                region:    'us-west-2',
                endpoint:  undefined,
            });
            spies.push(loadDynamoDBConfigSpy);

            // Import and call createApp
            const { createApp } = await import('@/index');
            await createApp();

            // Kills mutant on line 146-148: When contextBuilder is undefined, should use fallback directly
            // Verify createDiscordBot was called with the fallback identity
            expect(createBotSpy).toHaveBeenCalled();
            const botCallArgs = createBotSpy.mock.calls[0][0];
            expect(botCallArgs.identityContext).toBe('Isambard - AI Assistant');
        });
    });
});
