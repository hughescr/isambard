import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import '../setup'; // SST mock is applied via side effects
import * as agentAgent from '@/agent/agent';
import type { ClaudeAgent } from '@/agent/agent';
import * as contextBuilder from '@/agent/context-builder';
import type { ContextBuilder } from '@/agent/context-builder';
import * as memoryMcpServer from '@/agent/memory-mcp-server';
import type { createMemoryMCPServer } from '@/agent/memory-mcp-server';
import type { StreamTracker } from '@/agent/stream-tracker';
import * as configLoader from '@/config/loader';
import type { DiscordConfig, DynamoDBConfig, AgentConfig, Config } from '@/config/schemas';
import { createApp, type App } from '@/index';
import * as discordBot from '@/integrations/discord/bot';
import type { DiscordBot } from '@/integrations/discord/bot';
import * as channelRegistryBackendModule from '@/integrations/discord/channel-registry/backend';
import * as channelRegistryManagerModule from '@/integrations/discord/channel-registry/manager';
import * as registerCommandsModule from '@/integrations/discord/register-commands';
import { createGuildId } from '@/integrations/discord/types';
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
            oauthToken: 'test-oauth-token-1234567890',
            mainModel:  'sonnet',
        };

        // Mock DynamoDB configuration
        mockDynamoDBConfig = {
            tableName: 'IsambardMemory',
        };

        // Mock Discord Bot
        mockDiscordBot = {
            start:          mock(async () => undefined),
            stop:           mock(async () => undefined),
            triggerCatchUp: mock(async () => undefined),
        } as DiscordBot;

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
        const mockClient = {} as DynamoDBClient;
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
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
            );

            await createApp();

            expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth-token-1234567890');
        });

        it('should create Claude agent with DynamoDB configured', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
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
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig)
            );
            const createDynamoDBClientSpy = spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                client:    mockClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            const createContextBuilderSpy = spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder as unknown as ContextBuilder);
            const createMemoryMCPServerSpy = spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>);
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(
                createDynamoDBClientSpy,
                createContextBuilderSpy,
                createMemoryMCPServerSpy,
                createClaudeAgentSpy,
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot)
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
                contactsMcpServer:          expect.any(Object),
                userContextMcpServer:       expect.any(Object),
                plugins:                    expect.any(Array),
                taskPersistenceCoordinator: expect.any(Object),
                mainModel:                  'sonnet',
            });
        }, { timeout: process.env.CI ? 1000 : 100 });

        it('should fail to create app when DynamoDB client creation fails', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
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

    describe('Startup Sequence', () => {
        it('should call bot.start when app.start is called', async () => {
            spies.push(
                spyOn(configLoader, 'loadConfig').mockReturnValue({
                    discord: mockDiscordConfig,
                    agent:   mockAgentConfig,
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
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig),
                spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent),
                spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockErrorBot)
            );

            const app = await createApp();

            // Discord startup failure is now non-fatal: app.start() resolves and starts
            // a reconnection loop in the background instead of throwing.
            // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- awaiting .resolves assertion is intentional; ensures the promise is settled before proceeding
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
                } as unknown as Config),
                spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig)
            );
            const createDynamoDBClientSpy = spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                client:    mockClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            const createContextBuilderSpy = spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder as unknown as ContextBuilder);
            const createMemoryMCPServerSpy = spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as unknown as ReturnType<typeof createMemoryMCPServer>);
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(
                createDynamoDBClientSpy,
                createContextBuilderSpy,
                createMemoryMCPServerSpy,
                createClaudeAgentSpy,
                createDiscordBotSpy
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
