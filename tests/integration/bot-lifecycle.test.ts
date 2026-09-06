import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import '../setup'; // SST mock is applied via side effects
import type { Conductor, ContextPolicy, LedgerStore } from '@/agent';
import * as agentAgent from '@/agent/agent';
import type { ClaudeAgent } from '@/agent/agent';
import * as contextBuilder from '@/agent/context-builder';
import type { ContextBuilder } from '@/agent/context-builder';
import * as memoryMcpServer from '@/agent/memory-mcp-server';
import type { createMemoryMCPServer } from '@/agent/memory-mcp-server';
import type { StreamTracker } from '@/agent/stream-tracker';
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
    let mockClaudeAgent: ClaudeAgent;
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
        };

        // Mock Session configuration (P8: config.session.mode is read early in createApp, right
        // after storage creation, to decide the stale-session cleanup strategy)
        mockSessionConfig = sessionConfigSchema.parse({});

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

        // Mock Claude Agent
        mockClaudeAgent = {
            handleInput: mock(async () => ({
                response:       'Test response',
                sessionId:      undefined,
                wasInterrupted: false,
                streamTracker:  {} as StreamTracker,
            })),
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot),
                createMcpSharedDepsSpy
            );

            await createApp();

            expect(createMcpSharedDepsSpy).toHaveBeenCalledTimes(1);
        });

        it('should create Claude agent with DynamoDB configured', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig)
            );
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy, spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            await createApp();

            expect(createClaudeAgentSpy).toHaveBeenCalled();
        });

        it('should create Discord bot with config and agent', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent)
            );
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            await createApp();

            expect(createDiscordBotSpy).toHaveBeenCalled();
            expect(createDiscordBotSpy).toHaveBeenCalledWith(expect.objectContaining({
                config:           mockDiscordConfig,
                identityContext:  expect.any(String),
                agent:            mockClaudeAgent,
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
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            }));
            spies.push(
                createDynamoDBClientSpy,
                createContextBuilderSpy,
                createMemoryMCPServerSpy,
                createClaudeAgentSpy,
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot),
                PersonAllowlistSpy
            );

            await createApp();

            expect(createDynamoDBClientSpy).toHaveBeenCalledWith(mockDynamoDBConfig);
            expect(createContextBuilderSpy).toHaveBeenCalled();
            expect(createMemoryMCPServerSpy).toHaveBeenCalled();
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                contextBuilder:             mockContextBuilder,
                memoryMcpServer:            mockMemoryMcp,
                discordMcpServer:           expect.any(Object),
                inboxMcpServer:             expect.any(Object),
                emailMcpServer:             undefined,
                bskyMcpServer:              undefined,
                caldavMcpServer:            expect.any(Object),
                wikipediaMcpServer:         expect.any(Object),
                mediaMcpServer:             expect.any(Object),
                contactsMcpServer:          expect.any(Object),
                userContextMcpServer:       expect.any(Object),
                browserMcpServer:           undefined,
                plugins:                    expect.any(Array),
                taskPersistenceCoordinator: expect.any(Object),
                compactionSink:             expect.any(Object),
                mainModel:                  'sonnet',
                fallbackModel:              'sonnet',
            });
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            // channelRegistry is REQUIRED and needs DynamoDB, so app creation should fail
            expect(createApp()).rejects.toThrow('Failed to connect to DynamoDB');
        });
    });

    describe('Conductor mode component wiring (P9)', () => {
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
                    session: { ...mockSessionConfig, mode: 'conductor' },
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor, ledgerStore: {} as LedgerStore, contextPolicy: {} as ContextPolicy,
            });
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createConversationConductorSpy, createDiscordBotSpy);

            await createApp();

            expect(createConversationConductorSpy).toHaveBeenCalledTimes(1);
            expect(fakeOpen).not.toHaveBeenCalled();
            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as { conversationConductor?: unknown };
            expect(botOptions.conversationConductor).toBe(fakeConductor);
        });

        it('oneshot mode (default): never calls createConversationConductor', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor');
            spies.push(createConversationConductorSpy);

            await createApp();

            expect(createConversationConductorSpy).not.toHaveBeenCalled();
        });
    });

    describe('Perch conductor component wiring (P12)', () => {
        const mockPerchConfig = {
            enabled: true, timezone: 'UTC', intervalMinutes: 60, jitterMinutes: 15, maxSessionMinutes: 45, wrapUpTimeoutMinutes: 5, interruptGraceMinutes: 2,
        };

        function fakeConductor(sessionId: string): Conductor {
            return { open: mock(async () => ({ sessionId, resumed: false })), submit: mock(), status: mock(() => ({ sessionId: undefined })) } as unknown as Conductor;
        }

        it('conductor mode + perch enabled: builds both conductors (after MCP servers and identity) and hands both to createDiscordBot, both unopened', async () => {
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
                    session: { ...mockSessionConfig, mode: 'conductor' },
                    perch:   mockPerchConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConversationConductor, ledgerStore: {} as LedgerStore, contextPolicy: {} as ContextPolicy,
            });
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakePerchConductor, ledgerStore: {} as LedgerStore,
            });
            const createMcpServerInstancesSpy = spyOn(mcpServersModule, 'createMcpServerInstances');
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createConversationConductorSpy, createPerchConductorSpy, createMcpServerInstancesSpy, createDiscordBotSpy);

            await createApp();

            expect(createConversationConductorSpy).toHaveBeenCalledTimes(1);
            expect(createPerchConductorSpy).toHaveBeenCalledTimes(1);
            expect(conversationOpen).not.toHaveBeenCalled();
            expect(perchOpen).not.toHaveBeenCalled();

            const botOptions = createDiscordBotSpy.mock.calls[0]?.[0] as unknown as { conversationConductor?: unknown, perchConductor?: unknown };
            expect(botOptions.conversationConductor).toBe(fakeConversationConductor);
            expect(botOptions.perchConductor).toBe(fakePerchConductor);

            // Both conductors are built after MCP server instances and identity loading —
            // createMcpServerInstances is called (at least once, for the legacy agent's own
            // 'conversation' set) strictly before either conductor factory runs.
            const mcpOrder = createMcpServerInstancesSpy.mock.invocationCallOrder[0];
            const conversationOrder = createConversationConductorSpy.mock.invocationCallOrder[0];
            const perchOrder = createPerchConductorSpy.mock.invocationCallOrder[0];
            expect(mcpOrder).toBeLessThan(conversationOrder);
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
                    session: { ...mockSessionConfig, mode: 'conductor' },
                    perch:   mockPerchConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                    client: mockClient, docClient: mockDocClient, tableName: 'IsambardMemory',
                }),
                spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder),
                spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                // @ts-expect-error - Mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({ load: mock(async () => {}) }))
            );
            const createConversationConductorSpy = spyOn(sessionsModule, 'createConversationConductor').mockResolvedValue({
                conductor: fakeConductor('conv-sess'), ledgerStore: {} as LedgerStore, contextPolicy: {} as ContextPolicy,
            });
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor').mockResolvedValue({
                conductor: fakeConductor('perch-sess'), ledgerStore: {} as LedgerStore,
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

        it('oneshot mode: opens no perch conductor', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                    perch:   mockPerchConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );
            const createPerchConductorSpy = spyOn(sessionsModule, 'createPerchConductor');
            spies.push(createPerchConductorSpy);

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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
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
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
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

    describe('Catch-Up Mode Integration', () => {
        it('should not start catch-up when memoryBackend is not provided', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
                    session: mockSessionConfig,
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            await createApp();

            // Agent should not be called with specialMode: 'catchup' when no memoryBackend
            expect(mockClaudeAgent.handleInput).not.toHaveBeenCalled();
        });

        it('should pass memoryBackend to bot when DynamoDB is configured', async () => {
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
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            // @ts-expect-error - Mocking constructor
            const PersonAllowlistSpy = spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({
                load: mock(async () => {}),
            }));
            spies.push(
                createDynamoDBClientSpy,
                createContextBuilderSpy,
                createMemoryMCPServerSpy,
                createClaudeAgentSpy,
                createDiscordBotSpy,
                PersonAllowlistSpy
            );

            // Create app (which will trigger memoryBackend creation)
            await createApp();

            // Verify memoryBackend was passed to bot
            const botOptions = createDiscordBotSpy.mock.calls[0][0];
            expect(botOptions.memoryBackend).toBeDefined();
            expect(botOptions.memoryBackend).toHaveProperty('storeCompletionSignal');
            expect(botOptions.memoryBackend).toHaveProperty('loadCompletionSignal');
            expect(botOptions.memoryBackend).toHaveProperty('storeInProgressSignal');
            expect(botOptions.memoryBackend).toHaveProperty('loadInProgressSignal');
            expect(botOptions.memoryBackend).toHaveProperty('deleteInProgressSignal');
        }, { timeout: process.env.CI ? 1000 : 100 });
    });
});
