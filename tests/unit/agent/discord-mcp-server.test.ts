/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Handler return values are typed as any in tests */
import { constant as _constant, isArray as _isArray } from 'lodash';
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { createDiscordMCPServer } from '../../../src/agent/discord-mcp-server';
import type { MessageSearchService } from '../../../src/integrations/discord/message-history/search';
import type { SearchResponse, DiscordSearchResult } from '../../../src/integrations/discord/message-history/types';
import type { ChannelId, GuildId } from '../../../src/integrations/discord/types';

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

    beforeEach(() => {
        mockSearchService = {
            searchMessages:    mock(_constant(Promise.resolve(createMockSearchResponse()))),
            getRecentMessages: mock(_constant(Promise.resolve(createMockSearchResponse()))),
            getMessageById:    mock(_constant(Promise.resolve(null))),
            getMessagesById:   mock(_constant(Promise.resolve([]))),
        };
    });

    // Helper function to get tool handler from server instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Need to access private _registeredTools
    const getToolHandler = (server: any, toolName: string): any => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing private property
        return server.instance._registeredTools[toolName].handler;
    };

    describe('createDiscordMCPServer function', () => {
        test.each([
            ['name', (server: ReturnType<typeof createDiscordMCPServer>) => server.name, 'discord'],
            ['instance', (server: ReturnType<typeof createDiscordMCPServer>) => server.instance, expect.anything()],
            ['type', (server: ReturnType<typeof createDiscordMCPServer>) => server.type, 'sdk'],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing server version
            ['version', (server: ReturnType<typeof createDiscordMCPServer>) => (server.instance as any).server._serverInfo.version, '1.0.0'],
        ])('should create MCP server with correct %s', (_name, accessor, expected) => {
            const server = createDiscordMCPServer(mockSearchService);
            expect(accessor(server)).toEqual(expected);
        });

        test.each([
            ['searchMessages', 'Search Discord message history by text, time range, or both. Returns messages with overflow summaries if results exceed limit.'],
            ['getRecentMessages', 'Get the most recent messages from a Discord channel'],
            ['getMessageById', 'Fetch a specific Discord message by its ID, or multiple messages by an array of IDs'],
        ])('should have %s tool with description', (toolName, expectedDescription) => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(tool.description).toBe(expectedDescription);
        });

        test.each([
            ['searchMessages', ['channelId', 'query', 'startTime', 'endTime', 'limit']],
            ['getRecentMessages', ['channelId', 'limit']],
            ['getMessageById', ['channelId', 'messageId']],
        ])('should have %s tool with correct input schema fields', (toolName, expectedFields) => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(tool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(tool.inputSchema.shape).toBeDefined();
            expectedFields.forEach((field) => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema field
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

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content.length).toBe(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const parsed = JSON.parse(result.content[0].text as string) as SearchResponse;
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0].content).toBe('First message');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should parse startTime from ISO string', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService);
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

            const server = createDiscordMCPServer(mockSearchService);
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

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error: Discord API error');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.searchMessages = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Network failure';
            });

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error: Network failure');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
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

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
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

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const parsed = JSON.parse(result.content[0].text as string) as SearchResponse;
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0].content).toBe('Recent message 1');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return error when searchService throws Error', async () => {
            mockSearchService.getRecentMessages = mock(async () => {
                throw new Error('Channel not found');
            });

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error: Channel not found');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.getRecentMessages = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw { code: 'TIMEOUT' };
            });

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('Error:');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
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

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult;
            expect(parsed.id).toBe('999888777666555444');
            expect(parsed.content).toBe('Specific message content');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return "Message not found" when message does not exist', async () => {
            mockSearchService.getMessageById = mock(_constant(Promise.resolve(null)));

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '000000000000000000',
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Message not found');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return error when searchService throws Error', async () => {
            mockSearchService.getMessageById = mock(async () => {
                throw new Error('Access denied');
            });

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error: Access denied');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.getMessageById = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Unknown error';
            });

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error: Unknown error');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should fetch multiple messages when given array', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111111111111111111', content: 'First message' }),
                createMockSearchResult({ id: '222222222222222222', content: 'Second message' }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222'],
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(parsed).toHaveLength(2);
            expect(parsed[0].content).toBe('First message');
            expect(parsed[1].content).toBe('Second message');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return array for array input even with single element', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111111111111111111', content: 'Single message' }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111'],
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(_isArray(parsed)).toBe(true);
            expect(parsed).toHaveLength(1);
        });

        test('should handle empty array', async () => {
            mockSearchService.getMessagesById = mock(async () => []);

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: [],
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(parsed).toHaveLength(0);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should handle some messages not found in batch', async () => {
            // Only 2 of 3 messages found
            const mockMessages = [
                createMockSearchResult({ id: '111111111111111111', content: 'First message' }),
                createMockSearchResult({ id: '333333333333333333', content: 'Third message' }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222', '333333333333333333'],
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const parsed = JSON.parse(result.content[0].text as string) as DiscordSearchResult[];
            expect(parsed).toHaveLength(2);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return error when getMessagesById throws Error', async () => {
            mockSearchService.getMessagesById = mock(async () => {
                throw new Error('Batch fetch failed');
            });

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111'],
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error: Batch fetch failed');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should accept union schema for messageId (string or array)', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const byIdTool = (server.instance as any)._registeredTools.getMessageById;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing schema
            const schema = byIdTool.inputSchema.shape.messageId;

            // Should accept string
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            expect(schema.safeParse('123456789012345678').success).toBe(true);
            // Should accept array of strings
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            expect(schema.safeParse(['123456789012345678', '987654321098765432']).success).toBe(true);
            // Should accept empty array
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
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
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = tool.inputSchema.shape.limit.unwrap().safeParse(value);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(expectedSuccess);
        });
    });
});
