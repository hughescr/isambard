import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import '../setup'; // SST mock is applied via side effects
import type { CompactionTelemetry, Conductor, ContextPolicy, LedgerStore } from '@/agent';
import * as agentIndexModule from '@/agent';
import * as contextBuilder from '@/agent/context-builder';
import type { ContextBuilder } from '@/agent/context-builder';
import * as memoryMcpServer from '@/agent/memory-mcp-server';
import type { createMemoryMCPServer } from '@/agent/memory-mcp-server';
import * as mcpServersModule from '@/app/mcp-servers';
import * as sessionsModule from '@/app/sessions';
import * as configLoader from '@/config/loader';
import { sessionConfigSchema, type DiscordConfig, type DynamoDBConfig, type AgentConfig, type Config, type SessionConfig } from '@/config/schemas';
import { createApp, type App } from '@/index';
import * as discordBot from '@/integrations/discord/bot';
import type { DiscordBot } from '@/integrations/discord/bot';
import * as channelRegistryBackendModule from '@/integrations/discord/channel-registry/backend';
import * as channelRegistryManagerModule from '@/integrations/discord/channel-registry/manager';
import * as registerCommandsModule from '@/integrations/discord/register-commands';
import { createGuildId } from '@/integrations/discord/types';
import * as storageModule from '@/storage';
import * as dynamoClient from '@/storage/client';

/**
 * Integration tests for bot lifecycle and component wiring with Agent SDK.
 *
 * These tests verify that:
 * 1. All components are correctly wired together via createApp()
 * 2. Configuration flows through the system properly
 * 3. Start/stop lifecycle works correctly
 * 4. Optional components (memory system) are handled gracefully
 * 5. Error conditions are handled appropriately
 */
describe('Bot Lifecycle Integration', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    let mockDiscordConfig: DiscordConfig;
    let mockAgentConfig: AgentConfig;
    let mockSessionConfig: SessionConfig;
    let mockDynamoDBConfig: DynamoDBConfig;
    let mockDiscordBot: DiscordBot;
    let originalEnv: string | undefined;

    beforeEach(() => {
        // Save original OAuth token env var
        originalEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-1234567890';

        // Mock Discord configuration
        mockDiscordConfig = {
            botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId: '123456789012345678',
            homeGuildId:   createGuildId('home-guild-123'),
        };

        // Mock Agent configuration
        mockAgentConfig = {
            oauthToken:    'test-oauth-token-1234567890',
            mainModel:     'sonnet',
            fallbackModel: 'sonnet',
            // Session-peers block 5: the quotaConfigSchema defaults, verbatim.
            quota:         { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] },
        };

        // Mock Session configuration. P13b: the `mode` flag is gone — the conductor is the only
        // path, built unconditionally in createApp() for every test in this file.
        mockSessionConfig = { ...sessionConfigSchema.parse({}) };

        // Mock DynamoDB configuration
        mockDynamoDBConfig = {
            tableName: 'IsambardMemory',
        };

        // Mock Discord Bot
        mockDiscordBot = {
            start:          mock(async () => undefined),
            stop:           mock(async () => undefined),
            triggerCatchUp: mock(async () => undefined),
        };

        // Mock DynamoDB client creation
        // Must include destroy() — app.stop() calls storage.holder.destroy()
        const mockClient = { destroy: mock(() => {}) } as unknown as DynamoDBClient;
        // mockDocClient.send must return empty Items so outbox drain (triggered on Discord CONNECT_SUCCESS)
        // does not throw when the health subscription fires during app.start()
        const mockDocClient = {
            send: mock(async () => ({ Items: [], Count: 0 })),
        } as unknown as DynamoDBDocumentClient;

        // Mock ChannelRegistryBackend and ChannelRegistryManager
        const mockChannelRegistryBackend = {
            warmCache:     mock(async () => undefined),
            getChannel:    mock(async () => null),
            upsertChannel: mock(async () => undefined),
            listChannels:  mock(async () => []),
            deleteChannel: mock(async () => undefined),
        };
        const mockChannelRegistryManager = {
            shouldProcess:      mock(() => true),
            getChannel:         mock(() => null),
            warmCache:          mock(async () => undefined),
            getUnmutedChannels: mock(async () => []),
            getAllChannels:     mock(() => []),
        };

        spies.push(
            // Mock DynamoDB client
            spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                client:    mockClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            }),
            // Mock slash command registration (avoids real HTTP requests to Discord API on app.start())
            spyOn(registerCommandsModule, 'registerAllCommands').mockResolvedValue(undefined),
            // @ts-expect-error - Mocking class constructor
            spyOn(channelRegistryBackendModule, 'ChannelRegistryBackend').mockReturnValue(mockChannelRegistryBackend as unknown as InstanceType<typeof channelRegistryBackendModule.ChannelRegistryBackend>),
            // @ts-expect-error - Mocking class constructor
            spyOn(channelRegistryManagerModule, 'ChannelRegistryManager').mockReturnValue(mockChannelRegistryManager as unknown as InstanceType<typeof channelRegistryManagerModule.ChannelRegistryManager>)
        );
    });

    afterEach(() => {
        // Restore all spies
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;

        // Restore environment
        if(originalEnv === undefined) {
            delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        } else {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnv;
        }
    });

    describe('Component Wiring', () => {
        it('should create App with start and stop methods', async () => {
            // Mock all dependencies
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            const app: App = await createApp();

            expect(app).toBeDefined();
            expect(typeof app.start).toBe('function');
            expect(typeof app.stop).toBe('function');
        });

        it('should load config from Resource provider', async () => {
            const loadConfigSpy = spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                session: mockSessionConfig,
            } as unknown as Config);
            spies.push(
                loadConfigSpy,
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            await createApp();

            expect(loadConfigSpy).toHaveBeenCalled();
            expect(loadConfigSpy).toHaveBeenCalledTimes(1);
        });

        it('should set OAuth token environment variable', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            await createApp();

            expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth-token-1234567890');
        });

        it('should call createMcpSharedDeps exactly once during app creation', async () => {
            const createMcpSharedDepsSpy = spyOn(mcpServersModule, 'createMcpSharedDeps');
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot),
                createMcpSharedDepsSpy
            );

            await createApp();

            expect(createMcpSharedDepsSpy).toHaveBeenCalledTimes(1);
        });

        it('should build the conversation conductor with DynamoDB configured (P13b: no more one-shot createClaudeAgent)', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig)
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor');
            spies.push(createConversationConductorSpy, spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            await createApp();

            expect(createConversationConductorSpy).toHaveBeenCalled();
        });

        it('should create Discord bot with config (no more agent field on DiscordBotOptions)', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig)
            );
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            await createApp();

            expect(createDiscordBotSpy).toHaveBeenCalled();
            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
            expect(botOptions).not.toHaveProperty('agent');
            expect(createDiscordBotSpy).toHaveBeenCalledWith(expect.objectContaining({
                config:           mockDiscordConfig,
                identityContext:  expect.any(String),
                questionRegistry: expect.objectContaining({
                    register:            expect.any(Function),
                    resolveWithAnswer:   expect.any(Function),
                    findPendingQuestion: expect.any(Function),
                    getQuestion:         expect.any(Function),
                    cancel:              expect.any(Function),
                    stop:                expect.any(Function),
                }),
                channelRegistry: expect.any(Object),
            }));
        });
    });

    describe('Memory System Integration', () => {
        // Integration test with real Discord client creation - needs longer timeout
        it('should create memory system when DynamoDB is configured', async () => {
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = {} as DynamoDBDocumentClient;
            const mockContextBuilder = {} as ContextBuilder;
            const mockMemoryMcp = {};

            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig)
            );
            const createDynamoDBClientSpy = spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                client:    mockClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            const createContextBuilderSpy = spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder);
            const createMemoryMCPServerSpy = spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>);
            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            }));
            spies.push(
                createDynamoDBClientSpy,
                createContextBuilderSpy,
                createMemoryMCPServerSpy,
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot),
                PersonAllowlistSpy
            );

            await createApp();

            expect(createDynamoDBClientSpy).toHaveBeenCalledWith(mockDynamoDBConfig);
            expect(createContextBuilderSpy).toHaveBeenCalled();
            expect(createMemoryMCPServerSpy).toHaveBeenCalled();
        }, { timeout: process.env.CI ? 1000 : 100 });

        it('should fail to create app when DynamoDB client creation fails', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockImplementation(() => {
                    throw new Error('Failed to connect to DynamoDB');
                }),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            // channelRegistry is REQUIRED and needs DynamoDB, so app creation should fail
            expect(createApp()).rejects.toThrow('Failed to connect to DynamoDB');
        });
    });

    describe('Conductor mode component wiring (P9, P13b: the only path)', () => {
        it('builds (but never opens) the conversation conductor and hands it to createDiscordBot, unopened', async () => {
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = {} as DynamoDBDocumentClient;
            const mockContextBuilder = {} as ContextBuilder;
            const mockMemoryMcp = {};
            const fakeOpen = mock(async () => ({ sessionId: 'sess-1', resumed: false }));
            const fakeConductor = { open: fakeOpen, submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;

            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createConversationConductorSpy, createDiscordBotSpy);

            await createApp();

            expect(createConversationConductorSpy).toHaveBeenCalledTimes(1);
            expect(fakeOpen).not.toHaveBeenCalled();
            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as { conversationConductor?: unknown };
            expect(botOptions.conversationConductor).toBe(fakeConductor);
        });
    });

    describe('Perch conductor component wiring (P12, P13b: the only path)', () => {
        const mockPerchConfig = {
            enabled: true, timezone: 'UTC', intervalMinutes: 60, jitterMinutes: 15, maxSessionMinutes: 45, wrapUpTimeoutMinutes: 5, interruptGraceMinutes: 2,
        };

        function fakeConductor(sessionId: string): Conductor {
            return { open: mock(async () => ({ sessionId, resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
        }

        it('perch enabled: builds both conductors (after identity loading) and hands both to createDiscordBot, both unopened', async () => {
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = {} as DynamoDBDocumentClient;
            const mockContextBuilder = {} as ContextBuilder;
            const mockMemoryMcp = {};
            const conversationOpen = mock(async () => ({ sessionId: 'conv-sess', resumed: false }));
            const perchOpen = mock(async () => ({ sessionId: 'perch-sess', resumed: false }));
            const fakeConversationConductor = { open: conversationOpen, submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
            const fakePerchConductor = { open: perchOpen, submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;

            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                    perch:   mockPerchConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConversationConductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakePerchConductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined),
            });
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createDiscordBotSpy);

            await createApp();

            expect(createConversationConductorSpy).toHaveBeenCalledTimes(1);
            expect(createPerchConductorSpy).toHaveBeenCalledTimes(1);
            expect(conversationOpen).not.toHaveBeenCalled();
            expect(perchOpen).not.toHaveBeenCalled();

            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as { conversationConductor?: unknown, perchConductor?: unknown };
            expect(botOptions.conversationConductor).toBe(fakeConversationConductor);
            expect(botOptions.perchConductor).toBe(fakePerchConductor);

            // The perch conductor is built strictly after the conversation conductor.
            const conversationOrder = createConversationConductorSpy.mock.invocationCallOrder[0];
            const perchOrder = createPerchConductorSpy.mock.invocationCallOrder[0];
            expect(conversationOrder).toBeLessThan(perchOrder);
        });

        it('two distinct role-keyed journals and two distinct resume-store roles are passed to the two conductor factories', async () => {
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = {
                send: mock(async () => ({ Item: undefined, Items: [], Count: 0 })),
            } as unknown as DynamoDBDocumentClient;
            const mockContextBuilder = {} as ContextBuilder;
            const mockMemoryMcp = {};

            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                    perch:   mockPerchConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined),
            });
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createDiscordBotSpy);

            await createApp();

            const conversationJournal = createConversationConductorSpy.mock.calls[0]?.[0].journal;
            const perchJournal = createPerchConductorSpy.mock.calls[0]?.[0].journal;
            const conversationResumeStore = createConversationConductorSpy.mock.calls[0]?.[0].resumeStore;
            const perchResumeStore = createPerchConductorSpy.mock.calls[0]?.[0].resumeStore;

            expect(conversationJournal).toBeDefined();
            expect(perchJournal).toBeDefined();
            expect(perchJournal).not.toBe(conversationJournal);
            expect(conversationResumeStore).toBeDefined();
            expect(perchResumeStore).toBeDefined();
            expect(perchResumeStore).not.toBe(conversationResumeStore);

            // The two resume stores are role-bound to different underlying rows: each save()
            // writes under a DIFFERENT DynamoDB key naming its own role.
            const sendMock = mockDocClient.send as unknown as ReturnType<typeof mock>;
            sendMock.mockClear();
            const conversationSessionId = '11111111-1111-4111-8111-111111111111';
            const perchSessionId = '22222222-2222-4222-8222-222222222222';
            await conversationResumeStore.save('conversation', conversationSessionId);
            await perchResumeStore.save('perch', perchSessionId);

            expect(sendMock).toHaveBeenCalledTimes(2);
            const putItems = sendMock.mock.calls.map((call: unknown[]) => (call[0] as { input: { Item: Record<string, unknown> } }).input.Item);
            const conversationItem = putItems.find(item => JSON.stringify(item).includes('conversation'));
            const perchItem = putItems.find(item => JSON.stringify(item).includes('perch'));
            expect(conversationItem).toBeDefined();
            expect(perchItem).toBeDefined();
            expect(conversationItem).not.toEqual(perchItem);

            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as { journal?: unknown, perchJournal?: unknown };
            expect(botOptions.journal).toBe(conversationJournal);
            expect(botOptions.perchJournal).toBe(perchJournal);
        });

        it('passes a working isCostPaused function into createDiscordBot (Q3 / B4)', async () => {
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient;
            const mockContextBuilder = {} as ContextBuilder;
            const mockMemoryMcp = {};

            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: { ...mockSessionConfig, dailyCostCeilingUsd: 1 },
                    perch:   mockPerchConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined),
            });
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createDiscordBotSpy);

            await createApp();

            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as { isCostPaused?: () => boolean };
            expect(typeof botOptions.isCostPaused).toBe('function');
            expect(botOptions.isCostPaused!()).toBe(false);
        });

        it('passes a working notify function into createDiscordBot, reaching the real conductor once attached (Q5 / B1)', async () => {
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = { send: mock(async () => ({ Items: [] })) } as unknown as DynamoDBDocumentClient;
            const mockContextBuilder = {} as ContextBuilder;
            const mockMemoryMcp = {};
            const conductor = { open: mock(async () => ({ sessionId: 'conv-sess', resumed: false })), submit: mock(async () => ({})), appendWithoutTurn: mock(() => undefined), status: mock(() => ({ sessionId: undefined, opened: true })) } as unknown as Conductor & { submit: ReturnType<typeof mock>, appendWithoutTurn: ReturnType<typeof mock> };

            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                    perch:   mockPerchConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor, ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, compactionTelemetry: {} as CompactionTelemetry, setWakeTurnDelivery: mock(() => undefined),
            });
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createDiscordBotSpy);

            await createApp();

            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as { notify?: (params: { source: string, text: string, wake: boolean, dedupeKey: string }) => void };
            expect(typeof botOptions.notify).toBe('function');

            botOptions.notify!({ source: 'test', text: 'hello', wake: true, dedupeKey: 'bot-lifecycle-key' });
            expect(conductor.submit).toHaveBeenCalledTimes(1);
            expect(conductor.submit.mock.calls[0]?.[1]).toEqual({ priority: 'other' });
        });

        it('config.perch.enabled: false — opens no perch conductor', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                    perch:   { ...mockPerchConfig, enabled: false },
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: { subscribe: mock(() => () => undefined) } as unknown as LedgerStore, contextPolicy: {} as ContextPolicy, compactionTelemetry: {} as CompactionTelemetry, bootLostTasks: [], setWakeTurnDelivery: mock(() => undefined),
            });
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor');
            spies.push(createConversationConductorSpy, createPerchConductorSpy);

            await createApp();

            expect(createPerchConductorSpy).not.toHaveBeenCalled();
        });
    });

    describe('Startup Sequence', () => {
        it('should call bot.start when app.start is called', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            const app = await createApp();
            await app.start();

            expect(mockDiscordBot.start).toHaveBeenCalled();
            expect(mockDiscordBot.start).toHaveBeenCalledTimes(1);
        });

        it('should start reconnection loop instead of throwing when bot.start fails', async () => {
            const mockErrorBot: DiscordBot = {
                start: mock(async () => {
                    throw new Error('Login failed');
                }),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined),
            };

            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockErrorBot)
            );

            const app = await createApp();

            // Discord startup failure is now non-fatal: app.start() resolves and starts
            // a reconnection loop in the background instead of throwing.
            await expect(app.start()).resolves.toBeUndefined();

            // Clean up
            await app.stop();
        });
    });

    describe('Shutdown Sequence', () => {
        it('should call bot.stop when app.stop is called', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            const app = await createApp();
            await app.stop();

            expect(mockDiscordBot.stop).toHaveBeenCalled();
            expect(mockDiscordBot.stop).toHaveBeenCalledTimes(1);
        });

        it('should allow multiple start/stop cycles', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            const app = await createApp();

            await app.start();
            await app.stop();
            await app.start();
            await app.stop();

            expect(mockDiscordBot.start).toHaveBeenCalledTimes(2);
            expect(mockDiscordBot.stop).toHaveBeenCalledTimes(2);
        });
    });

    describe('Health-outage notification wiring (Q6)', () => {
        it('subscribes the health-outage notification listener once during createApp() and survives a full start/stop cycle', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );
            // Deliberately no mockImplementation: this calls through to the real factory, so the
            // assertion below proves the composition root actually reaches it (not just that the
            // call was skipped) while still counting invocations.
            const createListenerSpy = spyOn(agentIndexModule, 'createHealthNotificationListener');
            spies.push(createListenerSpy);

            const app = await createApp();

            expect(createListenerSpy).toHaveBeenCalledTimes(1);

            await app.start();
            await app.stop();

            // A full start/stop cycle with the real ServiceHealthRegistryImpl and the real
            // health-outage listener/coalescer/bridge chain wired in (only the Discord bot and
            // DynamoDB client are mocked in this file's heavier integration harness) completes
            // without throwing.
            expect(mockDiscordBot.stop).toHaveBeenCalledTimes(1);
        });
    });
});
