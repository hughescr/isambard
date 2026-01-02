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
        test('should create MCP server with correct name', () => {
            const server = createDiscordMCPServer(mockSearchService);

            expect(server).toBeDefined();
            expect(server.name).toBe('discord');
        });

        test('should create MCP server with instance', () => {
            const server = createDiscordMCPServer(mockSearchService);

            expect(server.instance).toBeDefined();
        });

        test('should create MCP server with type', () => {
            const server = createDiscordMCPServer(mockSearchService);

            expect(server.type).toBe('sdk');
        });

        test('should create MCP server with version 1.0.0', () => {
            const server = createDiscordMCPServer(mockSearchService);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing server version
            expect((server.instance as any).server._serverInfo.version).toBe('1.0.0');
        });

        test('should have searchMessages tool with description', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.searchMessages;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(searchTool.description).toBe('Search Discord message history by text, time range, or both. Returns messages with overflow summaries if results exceed limit.');
        });

        test('should have getRecentMessages tool with description', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const recentTool = (server.instance as any)._registeredTools.getRecentMessages;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(recentTool.description).toBe('Get the most recent messages from a Discord channel');
        });

        test('should have getMessageById tool with description', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const byIdTool = (server.instance as any)._registeredTools.getMessageById;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(byIdTool.description).toBe('Fetch a specific Discord message by its ID, or multiple messages by an array of IDs');
        });

        test('should have searchMessages tool with correct input schema', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.searchMessages;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(searchTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(searchTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema channelId
            expect(searchTool.inputSchema.shape.channelId).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema query
            expect(searchTool.inputSchema.shape.query).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema startTime
            expect(searchTool.inputSchema.shape.startTime).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema endTime
            expect(searchTool.inputSchema.shape.endTime).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema limit
            expect(searchTool.inputSchema.shape.limit).toBeDefined();
        });

        test('should have getRecentMessages tool with correct input schema', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const recentTool = (server.instance as any)._registeredTools.getRecentMessages;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(recentTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(recentTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema channelId
            expect(recentTool.inputSchema.shape.channelId).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema limit
            expect(recentTool.inputSchema.shape.limit).toBeDefined();
        });

        test('should have getMessageById tool with correct input schema', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const byIdTool = (server.instance as any)._registeredTools.getMessageById;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(byIdTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(byIdTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema channelId
            expect(byIdTool.inputSchema.shape.channelId).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema messageId
            expect(byIdTool.inputSchema.shape.messageId).toBeDefined();
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

        test('should call searchService.searchMessages with channelId only', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ channelId: '123456789012345678' });

            expect(mockSearchService.searchMessages).toHaveBeenCalledWith({
                channelId: '123456789012345678',
                query:     undefined,
                startTime: undefined,
                endTime:   undefined,
                limit:     10,
            });
        });

        test('should call searchService.searchMessages with query', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ channelId: '123456789012345678', query: 'deployment' });

            expect(mockSearchService.searchMessages).toHaveBeenCalledWith({
                channelId: '123456789012345678',
                query:     'deployment',
                startTime: undefined,
                endTime:   undefined,
                limit:     10,
            });
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

        test('should pass limit when provided', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ channelId: '123456789012345678', limit: 50 });

            expect(mockSearchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({
                    limit: 50,
                })
            );
        });

        test('should use default limit of 10 when not provided', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ channelId: '123456789012345678' });

            expect(mockSearchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({
                    limit: 10,
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

        test('should format result as pretty-printed JSON', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse({
                messages: [createMockSearchResult()],
            }));

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'searchMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const text = result.content[0].text as string;
            expect(text).toContain('\n');
            expect(text).toContain('  ');
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

        test('should call searchService.getRecentMessages with channelId and default limit', async () => {
            mockSearchService.getRecentMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ channelId: '123456789012345678' });

            expect(mockSearchService.getRecentMessages).toHaveBeenCalledWith('123456789012345678', 10);
        });

        test('should call searchService.getRecentMessages with custom limit', async () => {
            mockSearchService.getRecentMessages = mock(async () => createMockSearchResponse());

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ channelId: '123456789012345678', limit: 25 });

            expect(mockSearchService.getRecentMessages).toHaveBeenCalledWith('123456789012345678', 25);
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

        test('should format result as pretty-printed JSON', async () => {
            mockSearchService.getRecentMessages = mock(async () => createMockSearchResponse({
                messages: [createMockSearchResult()],
            }));

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getRecentMessages');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ channelId: '123456789012345678' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const text = result.content[0].text as string;
            expect(text).toContain('\n');
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

        test('should call searchService.getMessageById with correct parameters', async () => {
            mockSearchService.getMessageById = mock(_constant(Promise.resolve(null)));

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            expect(mockSearchService.getMessageById).toHaveBeenCalledWith(
                '123456789012345678',
                '999888777666555444'
            );
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

        test('should format result as pretty-printed JSON', async () => {
            mockSearchService.getMessageById = mock(async () => createMockSearchResult());

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            const text = result.content[0].text as string;
            expect(text).toContain('\n');
            expect(text).toContain('  ');
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

        test('should call getMessagesById with correct parameters for array input', async () => {
            mockSearchService.getMessagesById = mock(async () => []);

            const server = createDiscordMCPServer(mockSearchService);
            const handler = getToolHandler(server, 'getMessageById');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222'],
            });

            expect(mockSearchService.getMessagesById).toHaveBeenCalledWith(
                '123456789012345678',
                ['111111111111111111', '222222222222222222']
            );
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
        test('should have searchMessages limit schema that accepts valid values', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.searchMessages;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = searchTool.inputSchema.shape.limit.unwrap().safeParse(50);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(true);
        });

        test('should have searchMessages limit schema that accepts max 100', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.searchMessages;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = searchTool.inputSchema.shape.limit.unwrap().safeParse(100);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(true);
        });

        test('should have searchMessages limit schema that rejects values over 100', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.searchMessages;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = searchTool.inputSchema.shape.limit.unwrap().safeParse(101);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(false);
        });

        test('should have searchMessages limit schema that rejects zero', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.searchMessages;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = searchTool.inputSchema.shape.limit.unwrap().safeParse(0);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(false);
        });

        test('should have searchMessages limit schema that rejects negative values', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.searchMessages;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = searchTool.inputSchema.shape.limit.unwrap().safeParse(-1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(false);
        });

        test('should have getRecentMessages limit schema that accepts valid values', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const recentTool = (server.instance as any)._registeredTools.getRecentMessages;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = recentTool.inputSchema.shape.limit.unwrap().safeParse(25);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(true);
        });

        test('should have getRecentMessages limit schema that rejects values over 100', () => {
            const server = createDiscordMCPServer(mockSearchService);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const recentTool = (server.instance as any)._registeredTools.getRecentMessages;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
            const result = recentTool.inputSchema.shape.limit.unwrap().safeParse(101);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.success).toBe(false);
        });
    });
});
