/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- Test mocks */
/* eslint-disable @typescript-eslint/await-thenable -- Test async functions */
/* eslint-disable lodash/prefer-constant -- Test callbacks */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createApp, type App } from '@/index';
import * as configLoader from '@/config/loader';
import * as discordBot from '@/integrations/discord/bot';
import * as agentAgent from '@/agent/agent';
import * as contextBuilder from '@/agent/context-builder';
import * as memoryMcpServer from '@/agent/memory-mcp-server';
import * as dynamoClient from '@/storage/client';
import type { DiscordConfig, DynamoDBConfig, AgentConfig } from '@/config/schemas';
import type { DiscordBot } from '@/integrations/discord/bot';
import type { ClaudeAgent } from '@/agent/agent';
import type { ContextBuilder } from '@/agent/context-builder';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createGuildId, createChannelId, createUserId } from '@/integrations/discord/types';

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
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['987654321098765432'],
        };

        // Mock Agent configuration
        mockAgentConfig = {
            oauthToken: 'test-oauth-token-1234567890',
        };

        // Mock DynamoDB configuration
        mockDynamoDBConfig = {
            tableName: 'IsambardMemory',
            region:    'us-west-2',
            endpoint:  undefined,
        };

        // Mock Discord Bot
        mockDiscordBot = {
            start: mock(async () => undefined),
            stop:  mock(async () => undefined),
        };

        // Mock Claude Agent
        mockClaudeAgent = {
            chat: mock(async () => 'Test response'),
        };
    });

    afterEach(() => {
        // Restore all spies
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;

        // Restore environment
        if(originalEnv !== undefined) {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnv;
        } else {
            delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
    });

    describe('Component Wiring', () => {
        it('should create App with start and stop methods', async () => {
            // Mock all dependencies
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app: App = await createApp();

            expect(app).toBeDefined();
            expect(typeof app.start).toBe('function');
            expect(typeof app.stop).toBe('function');
        });

        it('should load config from Resource provider', async () => {
            const loadConfigSpy = spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any);
            spies.push(loadConfigSpy);
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            await createApp();

            expect(loadConfigSpy).toHaveBeenCalled();
            expect(loadConfigSpy).toHaveBeenCalledTimes(1);
        });

        it('should set OAuth token environment variable', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            await createApp();

            expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth-token-1234567890');
        });

        it('should create Claude agent without memory when DynamoDB not configured', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy);
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            await createApp();

            expect(createClaudeAgentSpy).toHaveBeenCalled();
            // Should be called with empty options (no contextBuilder or memoryMcpServer)
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                contextBuilder:  undefined,
                memoryMcpServer: undefined,
            });
        });

        it('should create Discord bot with config and agent', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            await createApp();

            expect(createDiscordBotSpy).toHaveBeenCalled();
            expect(createDiscordBotSpy).toHaveBeenCalledWith({
                config:          mockDiscordConfig,
                onMessage:       expect.any(Function),
                anthropicClient: expect.any(Object),
                identityContext: expect.any(String),
                agent:           mockClaudeAgent,
            });
        });
    });

    describe('Memory System Integration', () => {
        // Integration test with real Discord client creation - needs longer timeout
        it('should create memory system when DynamoDB is configured', async () => {
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = {} as DynamoDBDocumentClient;
            const mockContextBuilder = {} as ContextBuilder;
            const mockMemoryMcp = {};

            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig));
            const createDynamoDBClientSpy = spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                client:    mockClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createDynamoDBClientSpy);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock context builder
            const createContextBuilderSpy = spyOn(contextBuilder, 'createContextBuilder').mockReturnValue(mockContextBuilder as any);
            spies.push(createContextBuilderSpy);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock MCP server
            const createMemoryMCPServerSpy = spyOn(memoryMcpServer, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcp as any);
            spies.push(createMemoryMCPServerSpy);
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy);
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            await createApp();

            expect(createDynamoDBClientSpy).toHaveBeenCalledWith(mockDynamoDBConfig);
            expect(createContextBuilderSpy).toHaveBeenCalled();
            expect(createMemoryMCPServerSpy).toHaveBeenCalled();
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                contextBuilder:   mockContextBuilder,
                memoryMcpServer:  mockMemoryMcp,
                discordMcpServer: expect.any(Object),
            });
        }, { timeout: 15 });

        it('should continue without memory when DynamoDB client creation fails', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig));
            spies.push(spyOn(dynamoClient, 'createDynamoDBClient').mockImplementation(() => {
                throw new Error('Failed to connect to DynamoDB');
            }));
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy);
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            await createApp();

            // Should create agent without memory or discord MCP (both require DynamoDB)
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                contextBuilder:   undefined,
                memoryMcpServer:  undefined,
                discordMcpServer: undefined,
            });
        });
    });

    describe('Startup Sequence', () => {
        it('should call bot.start when app.start is called', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app = await createApp();
            await app.start();

            expect(mockDiscordBot.start).toHaveBeenCalled();
            expect(mockDiscordBot.start).toHaveBeenCalledTimes(1);
        });

        it('should propagate errors from bot.start', async () => {
            const mockErrorBot: DiscordBot = {
                start: mock(async () => {
                    throw new Error('Login failed');
                }),
                stop: mock(async () => undefined),
            };

            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockErrorBot));

            const app = await createApp();

            await expect(app.start()).rejects.toThrow('Login failed');
        });
    });

    describe('Shutdown Sequence', () => {
        it('should call bot.stop when app.stop is called', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app = await createApp();
            await app.stop();

            expect(mockDiscordBot.stop).toHaveBeenCalled();
            expect(mockDiscordBot.stop).toHaveBeenCalledTimes(1);
        });

        it('should allow multiple start/stop cycles', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app = await createApp();

            await app.start();
            await app.stop();
            await app.start();
            await app.stop();

            expect(mockDiscordBot.start).toHaveBeenCalledTimes(2);
            expect(mockDiscordBot.stop).toHaveBeenCalledTimes(2);
        });
    });

    describe('Message Flow Integration', () => {
        it('should wire onMessage to call agent.chat with message context', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            await createApp();

            // Extract the onMessage callback
            const botOptions = createDiscordBotSpy.mock.calls[0][0];
            const onMessage = botOptions.onMessage;

            // Simulate a message
            const mockContext = {
                guildId:   createGuildId('123456789012345678'),
                messageId: 'msg_123',
                userId:    createUserId('user_456'),
                channelId: createChannelId('987654321098765432'),
                content:   'Hello bot!',
                timestamp: new Date().toISOString(),
                botUserId: createUserId('bot_789'),
            };

            const response = await onMessage(mockContext);

            expect(mockClaudeAgent.chat).toHaveBeenCalledWith(mockContext);
            expect(response).toBe('Test response');
        });

        it('should handle null response from agent.chat', async () => {
            const mockAgentWithNull: ClaudeAgent = {
                chat: mock(async () => null),
            };

            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                agent:   mockAgentConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockAgentWithNull));
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            await createApp();

            // Extract the onMessage callback
            const botOptions = createDiscordBotSpy.mock.calls[0][0];
            const onMessage = botOptions.onMessage;

            // Simulate a message
            const mockContext = {
                guildId:   createGuildId('123456789012345678'),
                messageId: 'msg_123',
                userId:    createUserId('user_456'),
                channelId: createChannelId('987654321098765432'),
                content:   'Hello bot!',
                timestamp: new Date().toISOString(),
                botUserId: createUserId('bot_789'),
            };

            const response = await onMessage(mockContext);

            expect(response).toBeNull();
        });
    });
});
