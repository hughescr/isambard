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
import * as agentClient from '@/agent/client';
import * as agentAgent from '@/agent/agent';
import * as claudeMemory from '@/agent/claude';
import * as dynamoClient from '@/storage/client';
import type { DiscordConfig, DynamoDBConfig } from '@/config/schemas';
import type { DiscordBot } from '@/integrations/discord/bot';
import type { ClaudeAgent } from '@/agent/agent';
import type Anthropic from '@anthropic-ai/sdk';
import type { Client } from 'discord.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createGuildId, createChannelId, createUserId } from '@/integrations/discord/types';

/**
 * Integration tests for bot lifecycle and component wiring.
 *
 * These tests verify that:
 * 1. All components are correctly wired together via createApp()
 * 2. Configuration flows through the system properly
 * 3. Start/stop lifecycle works correctly
 * 4. Optional components (memory tool) are handled gracefully
 * 5. Error conditions are handled appropriately
 *
 * Test strategy:
 * - Mock external dependencies (Discord.js Client, Anthropic SDK, DynamoDB)
 * - Use spies to verify component creation and method calls
 * - Test both happy path and error scenarios
 * - Verify configuration flows from Resource -> Config -> Components
 */
describe('Bot Lifecycle Integration', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    let mockDiscordConfig: DiscordConfig;
    let mockDynamoDBConfig: DynamoDBConfig;
    let mockDiscordClient: Client;
    let mockDiscordBot: DiscordBot;
    let mockAnthropicClient: Anthropic;
    let mockClaudeAgent: ClaudeAgent;
    let originalEnv: string | undefined;

    beforeEach(() => {
        // Save original ANTHROPIC_API_KEY
        originalEnv = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'test-api-key-sk-ant-1234567890';

        // Mock Discord configuration
        mockDiscordConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['987654321098765432'],
        };

        // Mock DynamoDB configuration
        mockDynamoDBConfig = {
            tableName: 'IsambardMemory',
            region:    'us-west-2',
            endpoint:  undefined,
        };

        // Mock Discord.js Client
        mockDiscordClient = {
            on:      mock(() => mockDiscordClient),
            login:   mock(async () => 'mock-login-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        // Mock Discord Bot
        mockDiscordBot = {
            start: mock(async () => undefined),
            stop:  mock(async () => undefined),
        };

        // Mock Anthropic client
        mockAnthropicClient = {
            messages: {
                create: mock(async () => ({
                    id:          'msg_123',
                    type:        'message',
                    role:        'assistant',
                    content:     [{ type: 'text', text: 'Test response' }],
                    model:       'claude-sonnet-4-20250514',
                    stop_reason: 'end_turn',
                    usage:       { input_tokens: 10, output_tokens: 20 },
                })),
            },
        } as unknown as Anthropic;

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
            process.env.ANTHROPIC_API_KEY = originalEnv;
        } else {
            delete process.env.ANTHROPIC_API_KEY;
        }
    });

    describe('Component Wiring', () => {
        it('should create App with start and stop methods', () => {
            // Mock all dependencies
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app: App = createApp();

            expect(app).toBeDefined();
            expect(typeof app.start).toBe('function');
            expect(typeof app.stop).toBe('function');
        });

        it('should load Discord config from Resource provider', () => {
            const loadConfigSpy = spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any);
            spies.push(loadConfigSpy);
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            createApp();

            expect(loadConfigSpy).toHaveBeenCalled();
            // Verify it's called with Resource object (complex proxy, so just verify it's called)
            expect(loadConfigSpy).toHaveBeenCalledTimes(1);
        });

        it('should create Claude client', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            const createClaudeClientSpy = spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient);
            spies.push(createClaudeClientSpy);
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            createApp();

            expect(createClaudeClientSpy).toHaveBeenCalled();
            expect(createClaudeClientSpy).toHaveBeenCalledTimes(1);
        });

        it('should create Claude agent with client', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy);
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            createApp();

            expect(createClaudeAgentSpy).toHaveBeenCalled();
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                client:     mockAnthropicClient,
                memoryTool: undefined,
            });
        });

        it('should create Discord bot with config and agent', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            createApp();

            expect(createDiscordBotSpy).toHaveBeenCalled();
            expect(createDiscordBotSpy).toHaveBeenCalledWith({
                config:    mockDiscordConfig,
                onMessage: expect.any(Function),
            });
        });

        it('should wire agent.chat as bot onMessage handler', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            createApp();

            // Verify onMessage callback is provided
            const botOptions = createDiscordBotSpy.mock.calls[0][0];
            expect(botOptions.onMessage).toBeDefined();
            expect(typeof botOptions.onMessage).toBe('function');
        });
    });

    describe('Memory Tool Integration', () => {
        it('should create memory tool when DynamoDB is configured', () => {
            const mockMemoryTool = { name: 'memory', description: 'Test memory tool' };
            const mockClient = {} as DynamoDBClient;
            const mockDocClient = {} as DynamoDBDocumentClient;

            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig));
            const createDynamoDBClientSpy = spyOn(dynamoClient, 'createDynamoDBClient').mockReturnValue({
                client:    mockClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });
            spies.push(createDynamoDBClientSpy);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock memory tool type compatibility
            const createMemoryToolSpy = spyOn(claudeMemory, 'createMemoryTool').mockReturnValue(mockMemoryTool as any);
            spies.push(createMemoryToolSpy);
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy);
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            createApp();

            expect(createDynamoDBClientSpy).toHaveBeenCalledWith(mockDynamoDBConfig);
            expect(createMemoryToolSpy).toHaveBeenCalledWith(mockDocClient, 'IsambardMemory');
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                client:     mockAnthropicClient,
                memoryTool: mockMemoryTool,
            });
        });

        it('should continue without memory tool when DynamoDB config is missing', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            const loadDynamoDBConfigSpy = spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB config not found');
            });
            spies.push(loadDynamoDBConfigSpy);
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy);
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            createApp();

            expect(loadDynamoDBConfigSpy).toHaveBeenCalled();
            // Should create agent without memory tool
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                client:     mockAnthropicClient,
                memoryTool: undefined,
            });
        });

        it('should continue without memory tool when DynamoDB client creation fails', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockReturnValue(mockDynamoDBConfig));
            spies.push(spyOn(dynamoClient, 'createDynamoDBClient').mockImplementation(() => {
                throw new Error('Failed to connect to DynamoDB');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            const createClaudeAgentSpy = spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent);
            spies.push(createClaudeAgentSpy);
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            createApp();

            // Should create agent without memory tool
            expect(createClaudeAgentSpy).toHaveBeenCalledWith({
                client:     mockAnthropicClient,
                memoryTool: undefined,
            });
        });
    });

    describe('Startup Sequence', () => {
        it('should call bot.start when app.start is called', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app = createApp();
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockErrorBot));

            const app = createApp();

            await expect(app.start()).rejects.toThrow('Login failed');
        });
    });

    describe('Shutdown Sequence', () => {
        it('should call bot.stop when app.stop is called', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app = createApp();
            await app.stop();

            expect(mockDiscordBot.stop).toHaveBeenCalled();
            expect(mockDiscordBot.stop).toHaveBeenCalledTimes(1);
        });

        it('should handle bot.stop errors gracefully', async () => {
            const mockErrorBot: DiscordBot = {
                start: mock(async () => undefined),
                stop:  mock(async () => {
                    throw new Error('Destroy failed');
                }),
            };

            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockErrorBot));

            const app = createApp();

            // Should propagate error
            await expect(app.stop()).rejects.toThrow('Destroy failed');
        });

        it('should allow multiple start/stop cycles', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot));

            const app = createApp();

            await app.start();
            await app.stop();
            await app.start();
            await app.stop();

            expect(mockDiscordBot.start).toHaveBeenCalledTimes(2);
            expect(mockDiscordBot.stop).toHaveBeenCalledTimes(2);
        });
    });

    describe('Error Handling', () => {
        it('should throw when Discord config is missing', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockImplementation(() => {
                throw new Error('Discord config not found');
            }));

            expect(() => createApp()).toThrow('Discord config not found');
        });

        it('should throw when ANTHROPIC_API_KEY is missing', () => {
            delete process.env.ANTHROPIC_API_KEY;

            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockImplementation(() => {
                throw new Error('ANTHROPIC_API_KEY environment variable is required');
            }));

            expect(() => createApp()).toThrow('ANTHROPIC_API_KEY environment variable is required');
        });

        it('should throw when agent creation fails', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockImplementation(() => {
                throw new Error('Agent creation failed');
            }));

            expect(() => createApp()).toThrow('Agent creation failed');
        });

        it('should throw when bot creation fails', () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            spies.push(spyOn(discordBot, 'createDiscordBot').mockImplementation(() => {
                throw new Error('Bot creation failed');
            }));

            expect(() => createApp()).toThrow('Bot creation failed');
        });
    });

    describe('Message Flow Integration', () => {
        it('should wire onMessage to call agent.chat with message context', async () => {
            spies.push(spyOn(configLoader, 'loadConfig').mockReturnValue({
                discord: mockDiscordConfig,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockClaudeAgent));
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            createApp();

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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config
            } as any));
            spies.push(spyOn(configLoader, 'loadDynamoDBConfig').mockImplementation(() => {
                throw new Error('DynamoDB not configured');
            }));
            spies.push(spyOn(agentClient, 'createClaudeClient').mockReturnValue(mockAnthropicClient));
            spies.push(spyOn(agentAgent, 'createClaudeAgent').mockReturnValue(mockAgentWithNull));
            const createDiscordBotSpy = spyOn(discordBot, 'createDiscordBot').mockReturnValue(mockDiscordBot);
            spies.push(createDiscordBotSpy);

            createApp();

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
            };

            const response = await onMessage(mockContext);

            expect(response).toBeNull();
        });
    });
});
