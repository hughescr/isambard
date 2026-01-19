/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Handler return values are typed as any in tests */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- Mock objects used throughout tests */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Mock object access in tests */
import { constant as _constant, isArray as _isArray, forEach as _forEach, repeat as _repeat, isString as _isString } from 'lodash';
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Client, MessageCreateOptions } from 'discord.js';
import { createDiscordMCPServer, setConversationContext, clearConversationContext } from '../../../src/agent/discord-mcp-server';
import type { MessageSearchService } from '../../../src/integrations/discord/message-history/search';
import type { SearchResponse, DiscordSearchResult } from '../../../src/integrations/discord/message-history/types';
import type { ChannelId, GuildId, UserId } from '../../../src/integrations/discord/types';

// Helper to create mock search result
const createMockSearchResult = (overrides: Partial<DiscordSearchResult> = {}): DiscordSearchResult => ({
    id:        '1234567890123456789',
    channelId: '9876543210987654321' as ChannelId,
    guildId:   '1111111111111111111' as GuildId,
    author:    {
        id:          '2222222222222222222',
        username:    'testuser',
        displayName: 'Test User',
    },
    content:     'Test message content',
    timestamp:   '2025-01-01T12:00:00.000Z',
    attachments: [],
    embeds:      [],
    reactions:   [],
    ...overrides,
});

// Helper to create mock search response
const createMockSearchResponse = (overrides: Partial<SearchResponse> = {}): SearchResponse => ({
    messages: [],
    metadata: {
        totalFound: 0,
        timeRange:  {
            start: '2025-01-01T00:00:00.000Z',
            end:   '2025-01-07T00:00:00.000Z',
        },
    },
    ...overrides,
});

describe.concurrent('createDiscordMCPServer', () => {
    let mockSearchService: MessageSearchService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock Discord client for testing
    let mockClient: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock question registry for testing
    let mockQuestionRegistry: any;

    beforeEach(() => {
        // Clear conversation context before each test
        clearConversationContext();
        mockSearchService = {
            searchMessages:    mock(_constant(Promise.resolve(createMockSearchResponse()))),
            getRecentMessages: mock(_constant(Promise.resolve(createMockSearchResponse()))),
            getMessageById:    mock(_constant(Promise.resolve(null))),
            getMessagesById:   mock(_constant(Promise.resolve([]))),
        };

        // Mock Discord client
        mockClient = {
            user: {
                id: 'bot-user-id-12345',
            },
            channels: {
                fetch: mock(async () => ({
                    id:          '123456789012345678',
                    send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                    reply:       mock(async (_content: string) => ({ id: 'reply-message-id' })),
                    isTextBased: _constant(true),
                    isThread:    _constant(false),
                    isDMBased:   _constant(false),
                })),
            },
        };

        // Mock question registry
        mockQuestionRegistry = {
            register: mock(_constant(Promise.resolve({
                questionId: 'test-question-id',
                answer:     null,
                timedOut:   false,
                channelId:  '123456789012345678',
            }))),
        };
    });

    // Helper function to get tool handler from server instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Need to access private _registeredTools
    const getToolHandler = (server: any, toolName: string): any => {
        return server.instance._registeredTools[toolName].handler;
    };

    describe('createDiscordMCPServer function', () => {
        test.each([
            ['name', (server: ReturnType<typeof createDiscordMCPServer>) => server.name, 'discord'],
            ['instance', (server: ReturnType<typeof createDiscordMCPServer>) => server.instance, expect.anything()],
            ['type', (server: ReturnType<typeof createDiscordMCPServer>) => server.type, 'sdk'],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return -- Accessing server version and mock return value
            ['version', (server: ReturnType<typeof createDiscordMCPServer>) => (server.instance as any).server._serverInfo.version, '1.0.0'],
        ])('should create MCP server with correct %s', (_name, accessor, expected) => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            expect(accessor(server)).toEqual(expected);
        });

        test.each([
            ['searchMessages', 'Search Discord message history by text, time range, or both. Returns messages with overflow summaries if results exceed limit.'],
            ['getRecentMessages', 'Get the most recent messages from a Discord channel'],
            ['getMessageById', 'Fetch a specific Discord message by its ID, or multiple messages by an array of IDs'],
            ['sendDiscordMessage', 'Send a message to a Discord channel. Use this to communicate with users during processing.'],
            ['askUserQuestion', 'Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. Options are limited to 25 maximum (Discord limit).'],
        ])('should have %s tool with description', (toolName, expectedDescription) => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];

            expect(tool.description).toBe(expectedDescription);
        });

        test.each([
            ['searchMessages', ['channelId', 'query', 'startTime', 'endTime', 'limit']],
            ['getRecentMessages', ['channelId', 'limit']],
            ['getMessageById', ['channelId', 'messageId']],
        ])('should have %s tool with correct input schema fields', (toolName, expectedFields) => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];

            expect(tool.inputSchema).toBeDefined();

            expect(tool.inputSchema.shape).toBeDefined();
            _forEach(expectedFields, (field) => {
                expect(tool.inputSchema.shape[field]).toBeDefined();
            });
        });
    });

    describe('searchMessages tool', () => {
        test('should return search results as JSON when messages found', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111', content: 'First message' }),
                createMockSearchResult({ id: '222', content: 'Second message' }),
            ];
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse({
                messages: mockMessages,
                metadata: {
                    totalFound: 2,
                    timeRange:  {
                        start: '2025-01-01T00:00:00.000Z',
                        end:   '2025-01-07T00:00:00.000Z',
                    },
                },
            }));

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content).toBeDefined();

            expect(result.content.length).toBe(1);

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(result.content[0].text as string) as SearchResponse;
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0].content).toBe('First message');

            expect(result.isError).toBeUndefined();
        });

        test('should parse startTime from ISO string', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                startTime: '2025-01-01T00:00:00.000Z',
            });

            expect(mockSearchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({
                    startTime: new Date('2025-01-01T00:00:00.000Z'),
                })
            );
        });

        test('should parse endTime from ISO string', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                endTime:   '2025-01-15T23:59:59.000Z',
            });

            expect(mockSearchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({
                    endTime: new Date('2025-01-15T23:59:59.000Z'),
                })
            );
        });

        test('should return error when searchService throws Error', async () => {
            mockSearchService.searchMessages = mock(async () => {
                throw new Error('Discord API error');
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            expect(result.content[0].text).toBe('Error: Discord API error');

            expect(result.isError).toBe(true);
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.searchMessages = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Network failure';
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content[0].text).toBe('Error: Network failure');

            expect(result.isError).toBe(true);
        });

        test('should include overflow summaries in response when present', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse({
                messages: [createMockSearchResult()],
                overflow: {
                    count:     5,
                    summaries: [{
                        id:        '333',
                        timestamp: '2025-01-01T00:00:00.000Z',
                        author:    'someuser',
                        synopsis:  'Summary of older messages',
                    }],
                },
            }));

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            const parsed = JSON.parse(result.content[0].text as string) as SearchResponse;
            expect(parsed.overflow).toBeDefined();
            expect(parsed.overflow?.count).toBe(5);
            expect(parsed.overflow?.summaries).toHaveLength(1);
        });
    });

    describe('getRecentMessages tool', () => {
        test('should return recent messages as JSON', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111', content: 'Recent message 1' }),
                createMockSearchResult({ id: '222', content: 'Recent message 2' }),
            ];
            mockSearchService.getRecentMessages = mock(async () => createMockSearchResponse({
                messages: mockMessages,
                metadata: {
                    totalFound: 2,
                    timeRange:  {
                        start: '2025-01-01T00:00:00.000Z',
                        end:   '2025-01-07T00:00:00.000Z',
                    },
                },
            }));

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(result.content[0].text as string) as SearchResponse;
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0].content).toBe('Recent message 1');

            expect(result.isError).toBeUndefined();
        });

        test('should return error when searchService throws Error', async () => {
            mockSearchService.getRecentMessages = mock(async () => {
                throw new Error('Channel not found');
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content[0].text).toBe('Error: Channel not found');

            expect(result.isError).toBe(true);
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.getRecentMessages = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw { code: 'TIMEOUT' };
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content[0].text).toContain('Error:');

            expect(result.isError).toBe(true);
        });
    });

    describe('getMessageById tool', () => {
        test('should return message as JSON when found', async () => {
            const mockMessage = createMockSearchResult({
                id:      '999888777666555444',
                content: 'Specific message content',
            });
            mockSearchService.getMessageById = mock(async () => mockMessage);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult;
            expect(parsed.id).toBe('999888777666555444');
            expect(parsed.content).toBe('Specific message content');

            expect(result.isError).toBeUndefined();
        });

        test('should return "Message not found" when message does not exist', async () => {
            mockSearchService.getMessageById = mock(_constant(Promise.resolve(null)));

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '000000000000000000',
            });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            expect(result.content[0].text).toBe('Message not found');

            expect(result.isError).toBeUndefined();
        });

        test('should return error when searchService throws Error', async () => {
            mockSearchService.getMessageById = mock(async () => {
                throw new Error('Access denied');
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            expect(result.content[0].text).toBe('Error: Access denied');

            expect(result.isError).toBe(true);
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.getMessageById = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Unknown error';
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            expect(result.content[0].text).toBe('Error: Unknown error');

            expect(result.isError).toBe(true);
        });

        test('should fetch multiple messages when given array', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111111111111111111', content: 'First message' }),
                createMockSearchResult({ id: '222222222222222222', content: 'Second message' }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222'],
            });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(parsed).toHaveLength(2);
            expect(parsed[0].content).toBe('First message');
            expect(parsed[1].content).toBe('Second message');

            expect(result.isError).toBeUndefined();
        });

        test('should return array for array input even with single element', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111111111111111111', content: 'Single message' }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111'],
            });

            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(_isArray(parsed)).toBe(true);
            expect(parsed).toHaveLength(1);
        });

        test('should handle empty array', async () => {
            mockSearchService.getMessagesById = mock(async () => []);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: [],
            });

            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(parsed).toHaveLength(0);

            expect(result.isError).toBeUndefined();
        });

        test('should handle some messages not found in batch', async () => {
            // Only 2 of 3 messages found
            const mockMessages = [
                createMockSearchResult({ id: '111111111111111111', content: 'First message' }),
                createMockSearchResult({ id: '333333333333333333', content: 'Third message' }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222', '333333333333333333'],
            });

            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(parsed).toHaveLength(2);

            expect(result.isError).toBeUndefined();
        });

        test('should return error when getMessagesById throws Error', async () => {
            mockSearchService.getMessagesById = mock(async () => {
                throw new Error('Batch fetch failed');
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111'],
            });

            expect(result.content[0].text).toBe('Error: Batch fetch failed');

            expect(result.isError).toBe(true);
        });

        test('should accept union schema for messageId (string or array)', () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const byIdTool = (server.instance as any)._registeredTools.getMessageById;

            const schema = byIdTool.inputSchema.shape.messageId;

            // Should accept string
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Accessing schema
            expect(schema.safeParse('123456789012345678').success).toBe(true);
            // Should accept array of strings
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Accessing schema
            expect(schema.safeParse(['123456789012345678', '987654321098765432']).success).toBe(true);
            // Should accept empty array
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Accessing schema
            expect(schema.safeParse([]).success).toBe(true);
        });
    });

    describe('limit validation', () => {
        test.each([
            ['searchMessages', 50, true],
            ['searchMessages', 100, true],
            ['searchMessages', 101, false],
            ['searchMessages', 0, false],
            ['searchMessages', -1, false],
            ['getRecentMessages', 25, true],
            ['getRecentMessages', 100, true],
            ['getRecentMessages', 101, false],
        ])('should validate %s limit schema for value %d (expect success: %s)', (toolName, value, expectedSuccess) => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = tool.inputSchema.shape.limit.unwrap().safeParse(value);

            expect(result.success).toBe(expectedSuccess);
        });
    });

    describe('sendDiscordMessage tool', () => {
        test('should have sendDiscordMessage tool with correct description', () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools.sendDiscordMessage;

            expect(tool.description).toBe('Send a message to a Discord channel. Use this to communicate with users during processing.');
        });

        test('should have correct input schema fields', () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools.sendDiscordMessage;

            expect(tool.inputSchema).toBeDefined();

            const shape = tool.inputSchema.shape;
            expect(shape.channelId).toBeDefined();
            expect(shape.content).toBeDefined();
            expect(shape.replyToMessageId).toBeDefined();
            expect(shape.createThread).toBeDefined();
            expect(shape.threadName).toBeDefined();
        });

        test('should send message successfully', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBeUndefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(result.content[0].text as string) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(mockChannel.send).toHaveBeenCalledWith('Test message');
        });

        test('should split and send long messages in multiple chunks', async () => {
            const sentMessages: { content: string, reference?: string }[] = [];
            const mockChannel = {
                isTextBased: _constant(true),
                send:        mock(async (options: MessageCreateOptions | string) => {
                    const msg = {
                        id:      `msg-${sentMessages.length + 1}`,
                        content: _isString(options) ? options : options.content,
                    };
                    sentMessages.push({
                        content:   msg.content!,
                        reference: !_isString(options) && options.reply ? String((options.reply as { messageReference: string }).messageReference) : undefined,
                    });
                    return msg;
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // Create content just over 2000 chars (will be split into 2 chunks)
            const longContent = _repeat('a', 2001);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                content:   longContent,
            });

            // Should succeed, not error
            expect(result.isError).toBeUndefined();

            // Parse response
            const parsed = JSON.parse(result.content[0].text as string) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toBeInstanceOf(Array);
            expect(parsed.messageIds.length).toBe(2);
            expect(parsed.chunksCount).toBe(2);

            // Verify multiple sends occurred
            expect(sentMessages.length).toBe(2);
        });

        test('should only apply reply to first chunk when splitting', async () => {
            const sentMessages: { content: string, hasReply: boolean }[] = [];
            const mockMessage = {
                id:    'original-msg-id',
                reply: mock(async (content: string) => {
                    const msg = {
                        id: `msg-${sentMessages.length + 1}`,
                        content,
                    };
                    sentMessages.push({
                        content:  msg.content,
                        hasReply: true,
                    });
                    return msg;
                }),
            };
            const mockChannel = {
                isTextBased: _constant(true),
                messages:    {
                    fetch: mock(async () => mockMessage),
                },
                send: mock(async (options: MessageCreateOptions | string) => {
                    const msg = {
                        id:      `msg-${sentMessages.length + 1}`,
                        content: _isString(options) ? options : options.content,
                    };
                    sentMessages.push({
                        content:  msg.content!,
                        hasReply: false,
                    });
                    return msg;
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const longContent = _repeat('a', 2001);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId:        '123456789012345678',
                content:          longContent,
                replyToMessageId: 'original-msg-id',
            });

            // First message should have reply
            expect(sentMessages[0].hasReply).toBe(true);
            // Second message should NOT have reply
            expect(sentMessages[1].hasReply).toBe(false);
        });

        test('should return messageIds array even for single chunk', async () => {
            const mockChannel = {
                isTextBased: _constant(true),
                send:        mock(async () => ({ id: 'msg-1' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                content:   'Short message',
            });

            const parsed = JSON.parse(result.content[0].text as string) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['msg-1']);
            expect(parsed.chunksCount).toBe(1);
        });

        test('should return error when channel not found', async () => {
            // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
            mockClient.channels.fetch = mock(async () => null);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBe(true);

            expect(result.content[0].text).toContain('Channel not found');
        });

        test('should return error when missing threadName with createThread', async () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: true,
            });

            expect(result.isError).toBe(true);

            expect(result.content[0].text).toContain('threadName is required');
        });

        test('should return error when createThread is true with empty threadName', async () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: true,
                threadName:   '',
            });

            expect(result.isError).toBe(true);

            expect(result.content[0].text).toContain('threadName is required');
        });

        test('should not create thread when createThread is false with valid threadName', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                threads:     {}, // Channel supports threads
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: false,
                threadName:   'Ignored Thread Name',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(result.content[0].text as string) as { success: boolean, messageIds: string[], chunksCount: number, threadId?: string };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(parsed.threadId).toBeUndefined();
            expect(mockChannel.send).toHaveBeenCalledWith('Test message');
        });

        test('should not create thread when createThread is undefined even with threadName', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                threads:     {}, // Channel supports threads
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: undefined,
                threadName:   'Ignored Thread Name',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(result.content[0].text as string) as { success: boolean, messageIds: string[], chunksCount: number, threadId?: string };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(parsed.threadId).toBeUndefined();
            expect(mockChannel.send).toHaveBeenCalledWith('Test message');
        });

        test('should not create thread when threadName is undefined even with createThread true', async () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: true,
                threadName:   undefined,
            });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('threadName is required');
        });

        test('should send as reply when replyToMessageId provided', async () => {
            const mockMessage = {
                id:    'original-message-id',
                reply: mock(async (_content: string) => ({ id: 'reply-message-id' })),
            };
            const mockChannel = {
                id:       '123456789012345678',
                messages: {
                    fetch: mock(async () => mockMessage),
                },
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
            };

            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId:        '123456789012345678',
                content:          'Reply message',
                replyToMessageId: 'original-message-id',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(result.content[0].text as string) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['reply-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(mockMessage.reply).toHaveBeenCalledWith('Reply message');
        });

        test('should create thread when createThread is true', async () => {
            const mockSentMessage = {
                id:          'sent-message-id',
                startThread: mock(async (options: { name: string }) => ({ id: 'thread-id', name: options.name })),
            };
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => mockSentMessage),
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                threads:     {}, // Channel supports threads
            };

            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Thread starter message',
                createThread: true,
                threadName:   'Test Thread',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(result.content[0].text as string) as { success: boolean, messageIds: string[], chunksCount: number, threadId: string };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(parsed.threadId).toBe('thread-id');
            expect(mockSentMessage.startThread).toHaveBeenCalledWith({ name: 'Test Thread' });
        });

        test('should return error when Discord API throws', async () => {
            const mockChannel = {
                id:   '123456789012345678',
                send: mock(async () => {
                    throw new Error('Discord API error');
                }),
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
            };

            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBe(true);

            expect(result.content[0].text).toBe('Error: Discord API error');
        });
    });

    describe('askUserQuestion tool', () => {
        test('should have askUserQuestion tool with correct description', () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools.askUserQuestion;

            expect(tool.description).toBe('Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. Options are limited to 25 maximum (Discord limit).');
        });

        test('should have correct input schema fields', () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools.askUserQuestion;

            expect(tool.inputSchema).toBeDefined();

            const shape = tool.inputSchema.shape;
            expect(shape.channelId).toBeDefined();
            expect(shape.question).toBeDefined();
            expect(shape.options).toBeDefined();
            expect(shape.timeoutSeconds).toBeDefined();
            expect(shape.createThread).toBeDefined();
            expect(shape.threadName).toBeDefined();
            expect(shape.targetUserId).toBeDefined();
        });

        test('should send question to channel', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(mockChannel.send).toHaveBeenCalled();
        });

        test('should create buttons when options provided', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'Choose an option:',
                options:   [
                    { label: 'Yes', value: 'yes' },
                    { label: 'No', value: 'no' },
                ],
            });

            const sendCall = mockChannel.send.mock.calls[0][0];
            expect(sendCall.components).toBeDefined();
            expect(sendCall.components.length).toBeGreaterThan(0);
        });

        test('should not create buttons when options is undefined', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'What do you think?',
                options:   undefined,
            });

            const sendCall = mockChannel.send.mock.calls[0][0];
            expect(sendCall.components).toBeUndefined();
        });

        test('should not create buttons when options is empty array', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'What do you think?',
                options:   [],
            });

            const sendCall = mockChannel.send.mock.calls[0][0];
            expect(sendCall.components).toBeUndefined();
        });

        test('should create thread when requested', async () => {
            const mockThread = {
                id:          'thread-id',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
            };
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                threads:     {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock thread options for testing
                    create: mock(async (_options: any) => mockThread),
                },
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId:    '123456789012345678',
                question:     'Thread question?',
                createThread: true,
                threadName:   'Q&A Thread',
            });

            expect(mockChannel.threads.create).toHaveBeenCalledWith({ name: 'Q&A Thread' });
            expect(mockThread.send).toHaveBeenCalled();
        });

        test('should register question in registry', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.channelId).toBe('123456789012345678');
            expect(registerCall.questionText).toBe('Test question?');
        });

        test('should return answer when resolved', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            mockQuestionRegistry.register = mock(async () => ({
                questionId: 'q1',
                answer:     {
                    content:     'Blue',
                    responderId: 'user-123',
                    messageId:   'answer-message-id',
                    channelId:   '123456789012345678',
                },
                timedOut:  false,
                channelId: '123456789012345678',
            }));

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(result.content[0].text as string);
            expect(parsed.questionId).toBe('q1');
            expect(parsed.answer).toBe('Blue');
            expect(parsed.responderId).toBe('user-123');
            expect(parsed.channelId).toBe('123456789012345678');
            expect(parsed.timedOut).toBe(false);
        });

        test('should return timeout when no answer', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            mockQuestionRegistry.register = mock(async () => ({
                questionId: 'q1',
                answer:     null,
                timedOut:   true,
                channelId:  '123456789012345678',
            }));

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(result.content[0].text).toContain('timedOut');

            const parsed = JSON.parse(result.content[0].text as string);
            expect(parsed.questionId).toBe('q1');
            expect(parsed.timedOut).toBe(true);
            expect(parsed.channelId).toBe('123456789012345678');
        });

        test('should return error when channel not text-based', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(false),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('not a text-based channel');
        });

        test('should return error when channel not found', async () => {
            // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
            mockClient.channels.fetch = mock(async () => null);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Channel not found');
        });

        test('should return error when more than 25 options provided', async () => {
            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // Create 26 options
            const tooManyOptions = Array.from({ length: 26 }, (_, i) => ({
                label: `Option ${i + 1}`,
                value: `option${i + 1}`,
            }));

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                question:  'Pick one',
                options:   tooManyOptions,
            });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('maximum of 25 buttons');
        });

        test('should include @mention when targetUserId provided', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId:    '123456789012345678',
                question:     'What is your favorite color?',
                targetUserId: 'user-123',
            });

            expect(mockChannel.send).toHaveBeenCalled();
            const sendCall = mockChannel.send.mock.calls[0][0];
            expect(sendCall.content).toContain('<@user-123>');
            expect(sendCall.content).toContain('What is your favorite color?');
        });

        test('should store targetUserId in question registry', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId:    '123456789012345678',
                question:     'Test question?',
                targetUserId: 'user-456',
            });

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.targetUserId).toBe('user-456');
        });

        test('should not include @mention when targetUserId not provided', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(mockChannel.send).toHaveBeenCalled();
            const sendCall = mockChannel.send.mock.calls[0][0];
            expect(sendCall.content).toBe('What is your favorite color?');
            expect(sendCall.content).not.toContain('<@');
        });

        test('should return error when askUserQuestion encounters Error exception', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => {
                    throw new Error('Discord rate limit exceeded');
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toBe('Error: Discord rate limit exceeded');
        });

        test('should return error when askUserQuestion encounters non-Error exception', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => {
                    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                    throw { code: 50013, message: 'Missing Permissions' };
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Error:');
        });
    });

    describe('conversation context', () => {
        test('should use conversation context userId for triggerUserId when set', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Set conversation context
            setConversationContext({
                currentUserId:    'user-789' as UserId,
                currentChannelId: '123456789012345678' as ChannelId,
            });

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('user-789');
        });

        test('should fallback to bot ID for triggerUserId when context not set', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Ensure context is cleared
            clearConversationContext();

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('bot-user-id-12345');
        });

        test('should fallback to "system" for triggerUserId when both context and clientUser are null', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };

            // Create client without user
            const clientWithoutUser = {
                user:     null,
                channels: {
                    fetch: mock(async () => mockChannel),
                },
            };

            // Ensure context is cleared
            clearConversationContext();

            const server = createDiscordMCPServer(mockSearchService, clientWithoutUser as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('system');
        });

        test('clearConversationContext should reset context', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: _constant(true),
                isThread:    _constant(false),
                isDMBased:   _constant(false),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock message options for testing
                send:        mock(async (_content: any) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createDiscordMCPServer(mockSearchService, mockClient as unknown as Client, mockQuestionRegistry);
            const handler = getToolHandler(server, 'askUserQuestion');

            // Set context
            setConversationContext({
                currentUserId:    'user-123' as UserId,
                currentChannelId: '456' as ChannelId,
            });

            // Call handler - should use the set context
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'Test question with context?',
            });

            // Verify context was used
            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            let registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('user-123');

            // Reset mock for next call
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Mock method
            mockQuestionRegistry.register.mockClear();

            // Clear context
            clearConversationContext();

            // Call handler again - should fallback to bot ID
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                question:  'Test question after clear?',
            });

            // Verify context was cleared (falls back to bot ID)
            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('bot-user-id-12345');
        });
    });
});
