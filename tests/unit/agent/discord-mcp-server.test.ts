import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Client, MessageCreateOptions } from 'discord.js';
import { createDiscordMCPServer, setConversationContext, clearConversationContext } from '../../../src/agent/discord-mcp-server';
import type { QuestionRegistry } from '../../../src/agent/question-registry';
import type { MCPChannelRegistry, MCPDMTracker, MCPMessageSplitter, MCPQuestionButtonBuilder, MCPRetryHelper, MCPMessageSearchService } from '../../../src/agent/types';
import type { SearchResponse, DiscordSearchResult } from '../../../src/integrations/discord/message-history/types';
import type { ChannelId, GuildId, UserId } from '../../../src/integrations/discord/types';
import { mockFsPromises, resetMockFsPrefix, textContent } from '../../setup';

interface ZodShapeEntry {
    safeParse: (v: unknown) => { success: boolean }
    unwrap:    () => { safeParse: (v: unknown) => { success: boolean } }
}
interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, ZodShapeEntry> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

interface MockChannelFetch {
    fetch: ReturnType<typeof mock>
}
interface MockDiscordClient {
    user:     { id: string }
    channels: MockChannelFetch
    guilds?:  { cache: { values: ReturnType<typeof mock> } }
    users?:   { fetch: ReturnType<typeof mock> }
}
interface MockQuestionRegistry {
    register: ReturnType<typeof mock>
}
interface MockChannelRegistry {
    resolveChannelId:   ReturnType<typeof mock>
    muteChannel:        ReturnType<typeof mock>
    unmuteChannel:      ReturnType<typeof mock>
    getAllChannels:     ReturnType<typeof mock>
    getUnmutedChannels: ReturnType<typeof mock>
}
interface MockDMTracker {
    getOrCreateDMByUsername: ReturnType<typeof mock>
}
interface MockMessageSplitter {
    splitMessage: ReturnType<typeof mock>
}
interface MockButtonBuilder {
    buildQuestionButtons: ReturnType<typeof mock>
}
interface MockRetryHelper {
    withRetry: ReturnType<typeof mock>
}

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

describe('createDiscordMCPServer', () => {
    let mockSearchService: MCPMessageSearchService;
    let mockClient: MockDiscordClient;
    let mockQuestionRegistry: MockQuestionRegistry;
    let mockChannelRegistry: MockChannelRegistry;
    let mockDMTracker: MockDMTracker;
    let mockMessageSplitter: MockMessageSplitter;
    let mockButtonBuilder: MockButtonBuilder;
    let mockRetryHelper: MockRetryHelper;

    beforeEach(() => {
        // Clear conversation context before each test
        clearConversationContext();
        mockSearchService = {
            searchMessages:    mock(() => Promise.resolve(createMockSearchResponse())),
            getRecentMessages: mock(() => Promise.resolve(createMockSearchResponse())),
            getMessageById:    mock(() => Promise.resolve(null)),
            getMessagesById:   mock(() => Promise.resolve([])),
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
                    isTextBased: () => true,
                    isThread:    () => false,
                    isDMBased:   () => false,
                })),
            },
        };

        // Mock question registry
        mockQuestionRegistry = {
            register: mock(() => Promise.resolve({
                questionId: 'test-question-id',
                answer:     null,
                timedOut:   false,
                channelId:  '123456789012345678',
            })),
        };

        // Mock channel registry
        mockChannelRegistry = {
            resolveChannelId:   mock((nameOrId: string) => nameOrId as ChannelId),
            muteChannel:        mock(() => Promise.resolve()),
            unmuteChannel:      mock(() => Promise.resolve()),
            getAllChannels:     mock(() => []),
            getUnmutedChannels: mock(() => Promise.resolve([])),
        };

        // Mock DM tracker
        mockDMTracker = {
            getOrCreateDMByUsername: mock(() => Promise.resolve('dm-channel-id' as ChannelId)),
        };

        // Mock message splitter (default: return content in single chunk)
        mockMessageSplitter = {
            splitMessage: mock((content: string) => [content]),
        };

        // Mock button builder (default: return empty array)
        mockButtonBuilder = {
            buildQuestionButtons: mock(() => []),
        };

        // Mock retry helper (default: call fn directly without retry)
        mockRetryHelper = {
            withRetry: mock((fn: () => Promise<unknown>) => fn()),
        };
    });

    // Helper to create server with current mocks and optional timezone override
    const createServer = (timezone?: string): ReturnType<typeof createDiscordMCPServer> => createDiscordMCPServer({
        searchService:    mockSearchService,
        client:           mockClient as unknown as Client,
        questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
        channelRegistry:  mockChannelRegistry as unknown as MCPChannelRegistry,
        dmTracker:        mockDMTracker as unknown as MCPDMTracker,
        messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
        buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
        retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
        timezone,
    });

    // Helper function to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createDiscordMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    describe('createDiscordMCPServer function', () => {
        test.each([
            ['name', (server: ReturnType<typeof createDiscordMCPServer>) => server.name, 'discord'],
            ['instance', (server: ReturnType<typeof createDiscordMCPServer>) => server.instance, expect.anything()],
            ['type', (server: ReturnType<typeof createDiscordMCPServer>) => server.type, 'sdk'],
            ['version', (server: ReturnType<typeof createDiscordMCPServer>) => (server.instance as unknown as RegisteredToolInstance).server._serverInfo.version, '1.0.0'],
        ])('should create MCP server with correct %s', (_name, accessor, expected) => {
            const server = createServer();
            expect(accessor(server)).toEqual(expected);
        });

        test.each([
            ['searchMessages', 'Search Discord message history by text, time range, or both. Returns messages with overflow summaries if results exceed limit. Accepts channel ID or #channel-name format.'],
            ['getRecentMessages', 'Get the most recent messages from a Discord channel. Returns the N most recent messages plus an overflow count. Use searchMessages with time range for AI summaries of older messages. Accepts channel ID or #channel-name format.'],
            ['getMessageById', 'Fetch a specific Discord message by its ID, or multiple messages by an array of IDs. Accepts channel ID or #channel-name format.'],
            ['sendDiscordMessage', `Send a message to a Discord channel or DM to a user. Use this to communicate with users.

CRITICAL: Only use channel IDs from:
1. The channelId in a message you're responding to (preferred)
2. Your memory (/state/discord-channels)
3. Channel name: #general, #off-topic, etc.
4. @username format for DMs (e.g., "@alice" to send a DM)
5. Default: 1451694737026449581 (#general)

NEVER invent or guess channel IDs. If unsure, use #general.`],
            ['addReaction', 'Add one or more emoji reactions to a Discord message. Accepts channel ID or #channel-name format.'],
            ['askUserQuestion', 'Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. Options are limited to 25 maximum (Discord limit). Accepts channel ID or #channel-name format.'],
        ])('should have %s tool with description', (toolName, expectedDescription) => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(tool.description).toBe(expectedDescription);
        });

        test.each([
            ['searchMessages', ['channelId', 'query', 'startTime', 'endTime', 'limit']],
            ['getRecentMessages', ['channelId', 'limit']],
            ['getMessageById', ['channelId', 'messageId']],
        ])('should have %s tool with correct input schema fields', (toolName, expectedFields) => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(tool.inputSchema).toBeDefined();

            expect(tool.inputSchema.shape).toBeDefined();
            for(const field of expectedFields) {
                expect(tool.inputSchema.shape[field]).toBeDefined();
            }
        });

        test.each([
            ['searchMessages',    { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true }],
            ['getRecentMessages', { readOnlyHint: true,  destructiveHint: false, idempotentHint: false, openWorldHint: true }],
            ['getMessageById',    { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true }],
            ['sendDiscordMessage', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
            ['askUserQuestion',   { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
            ['addReaction',       { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true }],
            ['muteChannel',       { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true }],
            ['unmuteChannel',     { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true }],
            ['listChannels',      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true }],
        ])('should have %s tool with correct annotations', (toolName, expectedAnnotations) => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(tool.annotations).toEqual(expectedAnnotations);
        });

        test('should accept timezone parameter for localTimestamp enrichment', () => {
            const server = createServer('America/New_York');
            // Server should be created successfully with timezone parameter
            expect(server).toBeDefined();
            expect(server.name).toBe('discord');
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

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content).toBeDefined();

            expect(result.content.length).toBe(1);

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0].content).toBe('First message');

            expect(result.isError).toBeUndefined();
        });

        test('should parse startTime from ISO string', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

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

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

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

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            expect(textContent(result.content[0])).toBe('Error: Discord API error');
            expect(textContent(result.content[0])).not.toBe('');

            expect(result.isError).toBe(true);
            // Verify error object structure (kills ObjectLiteral and StringLiteral mutants on line 463)
            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toEqual({
                type: 'text',
                text: 'Error: Discord API error',
            });
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.searchMessages = mock(async () => {
                throw 'Network failure';
            });

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

            const result = await handler({ channelId: '123456789012345678' });

            expect(textContent(result.content[0])).toBe('Error: Network failure');

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

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

            const result = await handler({ channelId: '123456789012345678' });

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.overflow).toBeDefined();
            expect(parsed.overflow?.count).toBe(5);
            expect(parsed.overflow?.summaries).toHaveLength(1);
        });

        test('should add localTimestamp when timezone is provided', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111', timestamp: '2025-01-15T14:30:00.000Z' }),
                createMockSearchResult({ id: '222', timestamp: '2025-01-15T16:45:00.000Z' }),
            ];
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse({
                messages: mockMessages,
            }));

            const server = createServer('America/Los_Angeles');
            const handler = getToolHandler(server, 'searchMessages');

            const result = await handler({ channelId: '123456789012345678' });

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.messages[0].localTimestamp).toBeDefined();
            expect(parsed.messages[0].localTimestamp).toBe('2025-01-15T06:30:00');
            expect(parsed.messages[1].localTimestamp).toBe('2025-01-15T08:45:00');
        });

        test('should not add localTimestamp when timezone is not provided', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111', timestamp: '2025-01-15T14:30:00.000Z' }),
            ];
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse({
                messages: mockMessages,
            }));

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

            const result = await handler({ channelId: '123456789012345678' });

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.messages[0].localTimestamp).toBeUndefined();
        });

        test('should use default limit of 10 when limit not provided', async () => {
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse());

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

            await handler({ channelId: '123456789012345678' });

            expect(mockSearchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 10 })
            );
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

            const server = createServer();
            const handler = getToolHandler(server, 'getRecentMessages');

            const result = await handler({ channelId: '123456789012345678' });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0].content).toBe('Recent message 1');

            expect(result.isError).toBeUndefined();
        });

        test('should return error when searchService throws Error', async () => {
            mockSearchService.getRecentMessages = mock(async () => {
                throw new Error('Channel not found');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'getRecentMessages');

            const result = await handler({ channelId: '123456789012345678' });

            expect(textContent(result.content[0])).toBe('Error: Channel not found');
            expect(textContent(result.content[0])).not.toBe('');

            expect(result.isError).toBe(true);
            // Verify error object structure (kills ObjectLiteral and StringLiteral mutants on line 493)
            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toEqual({
                type: 'text',
                text: 'Error: Channel not found',
            });
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.getRecentMessages = mock(async () => {
                throw { code: 'TIMEOUT' };
            });

            const server = createServer();
            const handler = getToolHandler(server, 'getRecentMessages');

            const result = await handler({ channelId: '123456789012345678' });

            expect(textContent(result.content[0])).toContain('Error:');

            expect(result.isError).toBe(true);
        });

        test('should add localTimestamp when timezone is provided', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111', timestamp: '2025-01-15T14:30:00.000Z' }),
                createMockSearchResult({ id: '222', timestamp: '2025-01-15T16:45:00.000Z' }),
            ];
            mockSearchService.getRecentMessages = mock(async () => createMockSearchResponse({
                messages: mockMessages,
            }));

            const server = createServer('America/Los_Angeles');
            const handler = getToolHandler(server, 'getRecentMessages');

            const result = await handler({ channelId: '123456789012345678' });

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.messages[0].localTimestamp).toBeDefined();
            expect(parsed.messages[0].localTimestamp).toBe('2025-01-15T06:30:00');
            expect(parsed.messages[1].localTimestamp).toBe('2025-01-15T08:45:00');
        });

        test('should not add localTimestamp when timezone is not provided', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111', timestamp: '2025-01-15T14:30:00.000Z' }),
            ];
            mockSearchService.getRecentMessages = mock(async () => createMockSearchResponse({
                messages: mockMessages,
            }));

            const server = createServer();
            const handler = getToolHandler(server, 'getRecentMessages');

            const result = await handler({ channelId: '123456789012345678' });

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.messages[0].localTimestamp).toBeUndefined();
        });

        test('should use default limit of 10 when limit not provided', async () => {
            mockSearchService.getRecentMessages = mock(async () => createMockSearchResponse());

            const server = createServer();
            const handler = getToolHandler(server, 'getRecentMessages');

            await handler({ channelId: '123456789012345678' });

            expect(mockSearchService.getRecentMessages).toHaveBeenCalledWith('123456789012345678', 10);
        });
    });

    describe('getMessageById tool', () => {
        test('should return message as JSON when found', async () => {
            const mockMessage = createMockSearchResult({
                id:      '999888777666555444',
                content: 'Specific message content',
            });
            mockSearchService.getMessageById = mock(async () => mockMessage);

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult;
            expect(parsed.id).toBe('999888777666555444');
            expect(parsed.content).toBe('Specific message content');

            expect(result.isError).toBeUndefined();
        });

        test('should return "Message not found" when message does not exist', async () => {
            mockSearchService.getMessageById = mock(() => Promise.resolve(null));

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: '000000000000000000',
            });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            expect(textContent(result.content[0])).toBe('Message not found');

            expect(result.isError).toBeUndefined();
        });

        test('should add localTimestamp when timezone is provided', async () => {
            const mockMessage = createMockSearchResult({
                id:        '999888777666555444',
                content:   'Specific message content',
                timestamp: '2025-01-15T14:30:00.000Z',
            });
            mockSearchService.getMessageById = mock(async () => mockMessage);

            const server = createServer('America/Los_Angeles');
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult;
            expect(parsed.localTimestamp).toBeDefined();
            expect(parsed.localTimestamp).toBe('2025-01-15T06:30:00');
        });

        test('should not add localTimestamp when timezone is not provided', async () => {
            const mockMessage = createMockSearchResult({
                id:        '999888777666555444',
                content:   'Specific message content',
                timestamp: '2025-01-15T14:30:00.000Z',
            });
            mockSearchService.getMessageById = mock(async () => mockMessage);

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult;
            expect(parsed.localTimestamp).toBeUndefined();
        });

        test('should return error when searchService throws Error', async () => {
            mockSearchService.getMessageById = mock(async () => {
                throw new Error('Access denied');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            expect(textContent(result.content[0])).toBe('Error: Access denied');
            expect(textContent(result.content[0])).not.toBe('');

            expect(result.isError).toBe(true);
            // Verify error object structure (kills ObjectLiteral and StringLiteral mutants on line 539)
            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toEqual({
                type: 'text',
                text: 'Error: Access denied',
            });
        });

        test('should return error when searchService throws non-Error', async () => {
            mockSearchService.getMessageById = mock(async () => {
                throw 'Unknown error';
            });

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: '999888777666555444',
            });

            expect(textContent(result.content[0])).toBe('Error: Unknown error');

            expect(result.isError).toBe(true);
        });

        test('should fetch multiple messages when given array', async () => {
            const mockMessages = [
                createMockSearchResult({ id: '111111111111111111', content: 'First message' }),
                createMockSearchResult({ id: '222222222222222222', content: 'Second message' }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222'],
            });

            expect(result.content).toBeDefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult[];
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

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111'],
            });

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult[];
            expect(Array.isArray(parsed)).toBe(true);
            expect(parsed).toHaveLength(1);
        });

        test('should add localTimestamp to all messages when timezone is provided with array input', async () => {
            const mockMessages = [
                createMockSearchResult({
                    id:        '111111111111111111',
                    content:   'First message',
                    timestamp: '2025-01-15T14:30:00.000Z',
                }),
                createMockSearchResult({
                    id:        '222222222222222222',
                    content:   'Second message',
                    timestamp: '2025-01-15T16:45:00.000Z',
                }),
            ];
            mockSearchService.getMessagesById = mock(async () => mockMessages);

            const server = createServer('America/Los_Angeles');
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222'],
            });

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult[];
            expect(parsed).toHaveLength(2);
            expect(parsed[0].localTimestamp).toBeDefined();
            expect(parsed[0].localTimestamp).toBe('2025-01-15T06:30:00');
            expect(parsed[1].localTimestamp).toBeDefined();
            expect(parsed[1].localTimestamp).toBe('2025-01-15T08:45:00');
        });

        test('should handle empty array', async () => {
            mockSearchService.getMessagesById = mock(async () => []);

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: [],
            });

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult[];
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

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111', '222222222222222222', '333333333333333333'],
            });

            const parsed = JSON.parse(textContent(result.content[0])) as DiscordSearchResult[];
            expect(parsed).toHaveLength(2);

            expect(result.isError).toBeUndefined();
        });

        test('should return error when getMessagesById throws Error', async () => {
            mockSearchService.getMessagesById = mock(async () => {
                throw new Error('Batch fetch failed');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'getMessageById');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: ['111111111111111111'],
            });

            expect(textContent(result.content[0])).toBe('Error: Batch fetch failed');

            expect(result.isError).toBe(true);
        });

        test('should accept union schema for messageId (string or array)', () => {
            const server = createServer();
            const byIdTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.getMessageById;

            const schema = byIdTool.inputSchema.shape.messageId;

            // Should accept string
            expect(schema.safeParse('123456789012345678').success).toBe(true);
            // Should accept array of strings
            expect(schema.safeParse(['123456789012345678', '987654321098765432']).success).toBe(true);
            // Should accept empty array
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
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
            const result = tool.inputSchema.shape.limit.unwrap().safeParse(value);

            expect(result.success).toBe(expectedSuccess);
        });
    });

    describe('sendDiscordMessage tool', () => {
        test('should have sendDiscordMessage tool with correct description', () => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.sendDiscordMessage;

            expect(tool.description).toBe(`Send a message to a Discord channel or DM to a user. Use this to communicate with users.

CRITICAL: Only use channel IDs from:
1. The channelId in a message you're responding to (preferred)
2. Your memory (/state/discord-channels)
3. Channel name: #general, #off-topic, etc.
4. @username format for DMs (e.g., "@alice" to send a DM)
5. Default: 1451694737026449581 (#general)

NEVER invent or guess channel IDs. If unsure, use #general.`);
        });

        test('should have correct input schema fields', () => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.sendDiscordMessage;

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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBeUndefined();

            expect(result.content[0].type).toBe('text');

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(mockChannel.send).toHaveBeenCalledWith({ content: 'Test message' });
        });

        test('should resolve #channel-name to channel ID via registry', async () => {
            // Set up channel registry to resolve #test-channel to its ID
            mockChannelRegistry.resolveChannelId = mock((_nameOrId: string) => '999888777666555444' as ChannelId);

            const mockChannel = {
                id:          '999888777666555444',
                send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            mockClient.channels.fetch = mock(async (channelId: string) => {
                // Verify we're fetching the RESOLVED channel ID, not the literal #test-channel
                expect(channelId).toBe('999888777666555444');
                return mockChannel;
            });

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '#test-channel',
                content:   'Test message',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(mockChannel.send).toHaveBeenCalledWith({ content: 'Test message' });
            expect(mockChannelRegistry.resolveChannelId).toHaveBeenCalledWith('#test-channel');
        });

        test('should split and send long messages in multiple chunks', async () => {
            const sentMessages: { content: string, reference?: string }[] = [];
            const mockChannel = {
                isTextBased: () => true,
                send:        mock(async (options: MessageCreateOptions | string) => {
                    const msg = {
                        id:      `msg-${sentMessages.length + 1}`,
                        content: typeof options === 'string' ? options : options.content,
                    };
                    sentMessages.push({
                        content:   msg.content!,
                        reference: typeof options !== 'string' && options.reply ? String((options.reply as { messageReference: string }).messageReference) : undefined,
                    });
                    return msg;
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Set up splitter to return 2 chunks for long content
            mockMessageSplitter.splitMessage = mock((content: string) => [
                content.slice(0, 1000),
                content.slice(1000),
            ]);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            // Create content just over 2000 chars (will be split into 2 chunks)
            const longContent = 'a'.repeat(2001);

            const result = await handler({
                channelId: '123456789012345678',
                content:   longContent,
            });

            // Should succeed, not error
            expect(result.isError).toBeUndefined();

            // Parse response
            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number };
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
                isTextBased: () => true,
                messages:    {
                    fetch: mock(async () => mockMessage),
                },
                send: mock(async (options: MessageCreateOptions | string) => {
                    const msg = {
                        id:      `msg-${sentMessages.length + 1}`,
                        content: typeof options === 'string' ? options : options.content,
                    };
                    sentMessages.push({
                        content:  msg.content!,
                        hasReply: false,
                    });
                    return msg;
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Set up splitter to return 2 chunks for long content
            mockMessageSplitter.splitMessage = mock((content: string) => [
                content.slice(0, 1000),
                content.slice(1000),
            ]);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const longContent = 'a'.repeat(2001);

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
                isTextBased: () => true,
                send:        mock(async () => ({ id: 'msg-1' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '123456789012345678',
                content:   'Short message',
            });

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['msg-1']);
            expect(parsed.chunksCount).toBe(1);
        });

        test('should return error when channel not found', async () => {
            mockClient.channels.fetch = mock(async () => null);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBe(true);

            expect(textContent(result.content[0])).toContain('Channel not found');
            expect(textContent(result.content[0])).not.toBe('');
            // Verify error object structure (kills ObjectLiteral and StringLiteral mutants on lines 86)
            expect(result.content).toHaveLength(1);
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error: Channel not found');
        });

        test('should return error when missing threadName with createThread', async () => {
            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: true,
            });

            expect(result.isError).toBe(true);

            expect(textContent(result.content[0])).toContain('threadName is required');
        });

        test('should return error when createThread is true with empty threadName', async () => {
            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: true,
                threadName:   '',
            });

            expect(result.isError).toBe(true);

            expect(textContent(result.content[0])).toContain('threadName is required');
            expect(textContent(result.content[0])).not.toBe('');
            // Verify error object structure (kills ObjectLiteral and StringLiteral mutants on lines 61-62)
            expect(result.content).toHaveLength(1);
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error: threadName is required when createThread is true');
        });

        test('should not create thread when createThread is false with valid threadName', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                threads:     {}, // Channel supports threads
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: false,
                threadName:   'Ignored Thread Name',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number, threadId?: string };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(parsed.threadId).toBeUndefined();
            expect(mockChannel.send).toHaveBeenCalledWith({ content: 'Test message' });
        });

        test('should not create thread when createThread is undefined even with threadName', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                threads:     {}, // Channel supports threads
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: undefined,
                threadName:   'Ignored Thread Name',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number, threadId?: string };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(parsed.threadId).toBeUndefined();
            expect(mockChannel.send).toHaveBeenCalledWith({ content: 'Test message' });
        });

        test('should not create thread when threadName is undefined even with createThread true', async () => {
            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Test message',
                createThread: true,
                threadName:   undefined,
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('threadName is required');
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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };

            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:        '123456789012345678',
                content:          'Reply message',
                replyToMessageId: 'original-message-id',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['reply-message-id']);
            expect(parsed.chunksCount).toBe(1);
            expect(mockMessage.reply).toHaveBeenCalledWith({ content: 'Reply message' });
        });

        test('should create thread when createThread is true', async () => {
            const mockSentMessage = {
                id:          'sent-message-id',
                startThread: mock(async (options: { name: string }) => ({ id: 'thread-id', name: options.name })),
            };
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => mockSentMessage),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                threads:     {}, // Channel supports threads
            };

            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:    '123456789012345678',
                content:      'Thread starter message',
                createThread: true,
                threadName:   'Test Thread',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], chunksCount: number, threadId: string };
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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };

            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBe(true);

            expect(textContent(result.content[0])).toBe('Error: Discord API error');
            expect(textContent(result.content[0])).not.toBe('');
            // Verify error object structure (kills ObjectLiteral and StringLiteral mutants on line 623)
            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toEqual({
                type: 'text',
                text: 'Error: Discord API error',
            });
        });

        test('should resolve @username to DM channel and send message', async () => {
            // Mock DM channel
            const mockDMChannel = {
                id:          'dm-channel-id-123',
                send:        mock(async (_content: string) => ({ id: 'sent-dm-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => true,
            };

            // dmTracker resolves username to DM channel ID
            mockDMTracker.getOrCreateDMByUsername = mock(async () => 'dm-channel-id-123' as ChannelId);

            // Channel fetch returns the DM channel
            mockClient.channels.fetch = mock(async () => mockDMChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '@alice',
                content:   'Test DM message',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[] };
            expect(parsed.success).toBe(true);
            expect(parsed.messageIds).toEqual(['sent-dm-message-id']);

            // Verify DM tracker was called
            expect(mockDMTracker.getOrCreateDMByUsername).toHaveBeenCalledWith('alice');
        });

        test('should return error when @username not found', async () => {
            // dmTracker returns null when user not found
            mockDMTracker.getOrCreateDMByUsername = mock(async () => null);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '@nonexistent',
                content:   'Test DM message',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Could not find user @nonexistent in any server');
        });

        describe('file attachments', () => {
            afterEach(() => {
                // Clean up mock filesystem after each test
                resetMockFsPrefix(process.cwd());
            });

            test('should attach files when valid paths provided', async () => {
                // Create test files in mock filesystem within CWD
                const testFile1 = path.join(process.cwd(), 'test-file-1.txt');
                const testFile2 = path.join(process.cwd(), 'test-file-2.txt');

                // Use mock filesystem
                await mockFsPromises.writeFile(testFile1, 'test content 1');
                await mockFsPromises.writeFile(testFile2, 'test content 2');

                const mockChannel = {
                    id:   '123456789012345678',
                    send: mock(async (options: MessageCreateOptions) => {
                        // Verify files are included in options and are absolute paths
                        expect(options.files).toBeDefined();
                        expect(Array.isArray(options.files)).toBe(true);
                        expect((options.files as string[]).length).toBe(2);
                        // Files should be absolute paths after validation
                        for(const file of options.files as string[]) {
                            expect(file.startsWith('/')).toBe(true);
                        }
                        return { id: 'sent-message-id' };
                    }),
                    isTextBased: () => true,
                    isThread:    () => false,
                    isDMBased:   () => false,
                };
                mockClient.channels.fetch = mock(async () => mockChannel);

                const server = createServer();
                const handler = getToolHandler(server, 'sendDiscordMessage');

                const result = await handler({
                    channelId: '123456789012345678',
                    content:   'Test message with files',
                    files:     [testFile1, testFile2],
                });

                expect(result.isError).toBeUndefined();

                const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[], filesAttached?: number };
                expect(parsed.success).toBe(true);
                expect(parsed.filesAttached).toBe(2);
                expect(mockChannel.send).toHaveBeenCalled();
            });

            test('should not include files in options when files parameter is omitted', async () => {
                const mockChannel = {
                    id:   '123456789012345678',
                    send: mock(async (options: MessageCreateOptions) => {
                        // Verify files property is not included
                        expect(options.files).toBeUndefined();
                        return { id: 'sent-message-id' };
                    }),
                    isTextBased: () => true,
                    isThread:    () => false,
                    isDMBased:   () => false,
                };
                mockClient.channels.fetch = mock(async () => mockChannel);

                const server = createServer();
                const handler = getToolHandler(server, 'sendDiscordMessage');

                const result = await handler({
                    channelId: '123456789012345678',
                    content:   'Test message without files',
                });

                expect(result.isError).toBeUndefined();

                const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[] };
                expect(parsed.success).toBe(true);
                expect(mockChannel.send).toHaveBeenCalled();
            });

            test('should not include files in options when files array is empty', async () => {
                const mockChannel = {
                    id:   '123456789012345678',
                    send: mock(async (options: MessageCreateOptions) => {
                        // Verify files property is not included when empty array is provided
                        expect(options.files).toBeUndefined();
                        return { id: 'sent-message-id' };
                    }),
                    isTextBased: () => true,
                    isThread:    () => false,
                    isDMBased:   () => false,
                };
                mockClient.channels.fetch = mock(async () => mockChannel);

                const server = createServer();
                const handler = getToolHandler(server, 'sendDiscordMessage');

                const result = await handler({
                    channelId: '123456789012345678',
                    content:   'Test message with empty files array',
                    files:     [],
                });

                expect(result.isError).toBeUndefined();

                const parsed = JSON.parse(textContent(result.content[0])) as { success: boolean, messageIds: string[] };
                expect(parsed.success).toBe(true);
                expect(mockChannel.send).toHaveBeenCalled();
            });

            test('should return security error when file validation fails with outside_cwd', async () => {
                const mockChannel = {
                    id:          '123456789012345678',
                    send:        mock(async (_options: MessageCreateOptions) => ({ id: 'should-not-be-called' })),
                    isTextBased: () => true,
                    isThread:    () => false,
                    isDMBased:   () => false,
                };
                mockClient.channels.fetch = mock(async () => mockChannel);

                const server = createServer();
                const handler = getToolHandler(server, 'sendDiscordMessage');

                // Use a path outside CWD (parent directory) to trigger security error
                const result = await handler({
                    channelId: '123456789012345678',
                    content:   'Test message with bad file',
                    files:     ['../outside-cwd-file.txt'],
                });

                expect(result.isError).toBe(true);
                expect(textContent(result.content[0])).toContain('Security Error:');
                expect(textContent(result.content[0])).toContain('SECURITY:');
                expect(textContent(result.content[0])).toContain('outside the working directory');
                // Send should NOT be called due to security error
                expect(mockChannel.send).not.toHaveBeenCalled();
            });
        });

        test('should throw when splitMessage returns empty array (guard against invariant violation)', async () => {
            // Simulate a buggy splitMessage that violates the "always returns ≥1 chunk" invariant
            mockMessageSplitter.splitMessage = mock(() => []);

            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async () => ({ id: 'sent-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            // withToolErrorHandling catches the thrown Error and returns it as an error result
            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('splitMessage returned empty chunks array');
        });
    });

    describe('askUserQuestion tool', () => {
        test('should have askUserQuestion tool with correct description', () => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.askUserQuestion;

            expect(tool.description).toBe('Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. Options are limited to 25 maximum (Discord limit). Accepts channel ID or #channel-name format.');
        });

        test('should have correct input schema fields', () => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.askUserQuestion;

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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(mockChannel.send).toHaveBeenCalledWith(expect.objectContaining({
                content: 'What is your favorite color?'
            }));
        });

        test('should create buttons when options provided', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Set up button builder to return a non-empty components array
            const mockActionRow = { type: 1, components: [{ type: 2, label: 'Yes' }, { type: 2, label: 'No' }] };
            mockButtonBuilder.buildQuestionButtons = mock(() => [mockActionRow]);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Choose an option:',
                options:   [
                    { label: 'Yes', value: 'yes' },
                    { label: 'No', value: 'no' },
                ],
            });

            const sendCall = mockChannel.send.mock.calls[0][0] as { content?: string, components?: unknown[] };
            expect(sendCall.components).toBeDefined();
            expect(sendCall.components!.length).toBeGreaterThan(0);
        });

        test('should not create buttons when options is undefined', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'What do you think?',
                options:   undefined,
            });

            const sendCall = mockChannel.send.mock.calls[0][0] as { content?: string, components?: unknown[] };
            expect(sendCall.components).toBeUndefined();
        });

        test('should not create buttons when options is empty array', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'What do you think?',
                options:   [],
            });

            const sendCall = mockChannel.send.mock.calls[0][0] as { content?: string, components?: unknown[] };
            expect(sendCall.components).toBeUndefined();
        });

        test('should create thread when requested', async () => {
            const mockThread = {
                id:          'thread-id',
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                threads:     {
                    create: mock(async (_options: unknown) => mockThread),
                },
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId:    '123456789012345678',
                question:     'Thread question?',
                createThread: true,
                threadName:   'Q&A Thread',
            });

            expect(mockChannel.threads.create).toHaveBeenCalledWith({ name: 'Q&A Thread' });
            expect(mockThread.send).toHaveBeenCalledWith(expect.objectContaining({
                content: 'Thread question?'
            }));
        });

        test('should register question in registry', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.channelId).toBe('123456789012345678');
            expect(registerCall.questionText).toBe('Test question?');
        });

        test('should use default timeout of 300 seconds when timeoutSeconds not provided', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const beforeMs = Date.now();
            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });
            const afterMs = Date.now();

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            // Default timeout is 300 seconds = 300000 ms
            expect(registerCall.expiresAt).toBeGreaterThanOrEqual(beforeMs + 300 * 1000);
            expect(registerCall.expiresAt).toBeLessThanOrEqual(afterMs + 300 * 1000);
        });

        test('should use provided timeoutSeconds for expiration calculation', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const beforeMs = Date.now();
            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId:      '123456789012345678',
                question:       'Test question?',
                timeoutSeconds: 60,
            });
            const afterMs = Date.now();

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            // 60 seconds = 60000 ms
            expect(registerCall.expiresAt).toBeGreaterThanOrEqual(beforeMs + 60 * 1000);
            expect(registerCall.expiresAt).toBeLessThanOrEqual(afterMs + 60 * 1000);
        });

        test('should return answer when resolved', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
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

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.questionId).toBe('q1');
            expect(parsed.answer).toBe('Blue');
            expect(parsed.responderId).toBe('user-123');
            expect(parsed.channelId).toBe('123456789012345678');
            expect(parsed.timedOut).toBe(false);
        });

        test('should return timeout when no answer', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            mockQuestionRegistry.register = mock(async () => ({
                questionId: 'q1',
                answer:     null,
                timedOut:   true,
                channelId:  '123456789012345678',
            }));

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(textContent(result.content[0])).toContain('timedOut');

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.questionId).toBe('q1');
            expect(parsed.timedOut).toBe(true);
            expect(parsed.message).toBe('Question timed out without response');
            expect(parsed.channelId).toBe('123456789012345678');
        });

        test('should return error when channel not text-based', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => false,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('not a text-based channel');
            expect(textContent(result.content[0])).not.toBe('');
            // Verify error object structure (kills ObjectLiteral mutant on line 174)
            expect(result.content).toHaveLength(1);
            expect(result.content[0].type).toBe('text');
        });

        test('should return error when channel not found', async () => {
            mockClient.channels.fetch = mock(async () => null);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Channel not found');
            expect(textContent(result.content[0])).not.toBe('');
            // Verify error object structure
            expect(result.content).toHaveLength(1);
            expect(result.content[0].type).toBe('text');
        });

        test('should return error when more than 25 options provided', async () => {
            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            // Create 26 options
            const tooManyOptions = Array.from({ length: 26 }, (_, i) => ({
                label: `Option ${i + 1}`,
                value: `option${i + 1}`,
            }));

            const result = await handler({
                channelId: '123456789012345678',
                question:  'Pick one',
                options:   tooManyOptions,
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('maximum of 25 buttons');
        });

        test('should allow exactly 25 options without error', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            // Create exactly 25 options (the maximum allowed)
            const maxOptions = Array.from({ length: 25 }, (_, i) => ({
                label: `Option ${i + 1}`,
                value: `option${i + 1}`,
            }));

            const result = await handler({
                channelId: '123456789012345678',
                question:  'Pick one',
                options:   maxOptions,
            });

            // 25 options should NOT trigger the error
            expect(result.isError).toBeUndefined();
        });

        test('should include @mention when targetUserId provided', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId:    '123456789012345678',
                question:     'What is your favorite color?',
                targetUserId: 'user-123',
            });

            expect(mockChannel.send).toHaveBeenCalled();
            const sendCall = mockChannel.send.mock.calls[0][0] as { content?: string, components?: unknown[] };
            expect(sendCall.content).toContain('<@user-123>');
            expect(sendCall.content).toContain('What is your favorite color?');
        });

        test('should store targetUserId in question registry', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(mockChannel.send).toHaveBeenCalled();
            const sendCall = mockChannel.send.mock.calls[0][0] as { content?: string, components?: unknown[] };
            expect(sendCall.content).toBe('What is your favorite color?');
            expect(sendCall.content).not.toContain('<@');
        });

        test('should return error when askUserQuestion encounters Error exception', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => {
                    throw new Error('Discord rate limit exceeded');
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Discord rate limit exceeded');
        });

        test('should return error when askUserQuestion encounters non-Error exception', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => {
                    throw { code: 50_013, message: 'Missing Permissions' };
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Error:');
        });
    });

    describe('normalizeChannelId helper', () => {
        test('should normalize thread channel to parent channel ID', async () => {
            const mockThread: Record<string, unknown> = {
                id:          'thread-id',
                parentId:    'parent-channel-id',
                isThread:    () => true,
                isTextBased: () => true,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            const mockParentChannel = {
                id:          'parent-channel-id',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            mockClient.channels.fetch = mock(async (channelId: string) => {
                if(channelId === 'thread-id') {
                    return mockThread;
                }

                return mockParentChannel;
            });

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: 'thread-id',
                question:  'Test question in thread?',
            });

            // Verify that the message was sent to the thread
            expect(mockThread.send).toHaveBeenCalled();
            // Verify registration uses parent channel ID
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.channelId).toBe('parent-channel-id');
        });

        test('should return non-thread channel as-is', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(mockChannel.send).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.channelId).toBe('123456789012345678');
        });

        test('should return error when parent channel fetch fails', async () => {
            const mockThread = {
                id:          'thread-id',
                parentId:    'parent-channel-id',
                isThread:    () => true,
                isTextBased: () => true,
            };
            mockClient.channels.fetch = mock(async (channelId: string) => {
                if(channelId === 'thread-id') {
                    return mockThread;
                }
                // Parent channel fetch returns null
                return null;
            });

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: 'thread-id',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Parent channel not found');
        });

        test('should return error when parent channel is not text-based', async () => {
            const mockNonTextChannel = {
                id:          'parent-channel-id',
                isTextBased: () => false,
                isThread:    () => false,
            };
            const mockThread = {
                id:          'thread-id',
                parentId:    'parent-channel-id',
                isThread:    () => true,
                isTextBased: () => true,
            };
            mockClient.channels.fetch = mock(async (channelId: string) => {
                if(channelId === 'thread-id') {
                    return mockThread;
                }
                return mockNonTextChannel;
            });

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: 'thread-id',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Channel is not a text-based channel');
        });
    });

    describe('prepareQuestionChannel helper', () => {
        test('should use existing thread when available', async () => {
            const mockThread = {
                id:          'existing-thread-id',
                isThread:    () => true,
                isTextBased: () => true,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            const mockParentChannel = {
                id:          'parent-channel-id',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            mockClient.channels.fetch = mock(async (channelId: string) => {
                if(channelId === 'existing-thread-id') {
                    return mockThread;
                }
                return mockParentChannel;
            });

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: 'existing-thread-id',
                question:  'Test question in existing thread?',
            });

            // Verify message sent to existing thread
            expect(mockThread.send).toHaveBeenCalled();
        });

        test('should create new thread when requested', async () => {
            const mockThread = {
                id:          'new-thread-id',
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
            };
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                threads:     {
                    create: mock(async (_options: unknown) => mockThread),
                },
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId:    '123456789012345678',
                question:     'Test question?',
                createThread: true,
                threadName:   'New Thread',
            });

            expect(mockChannel.threads.create).toHaveBeenCalledWith({ name: 'New Thread' });
            expect(mockThread.send).toHaveBeenCalled();
        });

        test('should fallback to original channel when thread creation fails gracefully', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
                threads:     {
                    create: mock(async (_options: unknown) => {
                        throw new Error('Thread creation failed');
                    }),
                },
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId:    '123456789012345678',
                question:     'Test question?',
                createThread: true,
                threadName:   'New Thread',
            });

            // Should return error since thread creation threw
            expect(result.isError).toBe(true);
        });
    });

    describe('fetchAndValidateChannel helper', () => {
        test('should reject non-text-based channel', async () => {
            const mockVoiceChannel = {
                id:          '123456789012345678',
                isTextBased: () => false,
            };
            mockClient.channels.fetch = mock(async () => mockVoiceChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Channel is not a text-based channel');
        });
    });

    describe('createThreadIfRequested helper', () => {
        test('should return undefined for thread-incapable channels', async () => {
            const mockDMChannel = {
                id:          'dm-channel-id',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => true,  // DM channels can't have threads
                send:        mock(async (_content: unknown) => ({ id: 'sent-message-id', startThread: undefined })),
            };
            mockClient.channels.fetch = mock(async () => mockDMChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:    'dm-channel-id',
                content:      'Test message',
                createThread: true,
                threadName:   'Test Thread',
            });

            // Should succeed but not create thread
            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.threadId).toBeUndefined();
        });
    });

    describe('triggerUserId fallback chain', () => {
        test('should use currentUserId when available', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            setConversationContext({
                currentUserId:    'user-123' as UserId,
                currentChannelId: '123456789012345678' as ChannelId,
            });

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('user-123');
        });

        test('should fallback to clientUser.id when currentUserId not available', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            clearConversationContext();

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('bot-user-id-12345');
        });

        test('should fallback to system when neither currentUserId nor clientUser available', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            const mockClientWithoutUser = {
                user:     null,
                channels: {
                    fetch: mock(async () => mockChannel),
                },
            };

            clearConversationContext();

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           mockClientWithoutUser as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockChannelRegistry as unknown as MCPChannelRegistry,
                dmTracker:        mockDMTracker as unknown as MCPDMTracker,
                messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
                buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
                retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
            });
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('system');
        });
    });

    describe('askUserQuestion error handling', () => {
        test('should return error result when tool call throws', async () => {
            mockClient.channels.fetch = mock(async () => {
                throw new Error('Network error');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Network error');
        });
    });

    describe('conversation context', () => {
        test('should use conversation context userId for triggerUserId when set', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Set conversation context
            setConversationContext({
                currentUserId:    'user-789' as UserId,
                currentChannelId: '123456789012345678' as ChannelId,
            });

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Ensure context is cleared
            clearConversationContext();

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
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

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           clientWithoutUser as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockChannelRegistry as unknown as MCPChannelRegistry,
                dmTracker:        mockDMTracker as unknown as MCPDMTracker,
                messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
                buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
                retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
            });
            const handler = getToolHandler(server, 'askUserQuestion');

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
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            // Set context
            setConversationContext({
                currentUserId:    'user-123' as UserId,
                currentChannelId: '456' as ChannelId,
            });

            // Call handler - should use the set context
            await handler({
                channelId: '123456789012345678',
                question:  'Test question with context?',
            });

            // Verify context was used
            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            let registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('user-123');

            // Reset mock for next call
            mockQuestionRegistry.register.mockClear();

            // Clear context
            clearConversationContext();

            // Call handler again - should fallback to bot ID
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

    describe('normalizeChannelId error handling', () => {
        test('should return proper error structure when channel not found in normalizeChannelId', async () => {
            mockClient.channels.fetch = mock(async () => null);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: 'invalid-channel-id',
                question:  'Test question?',
            });

            // Verify error structure (kills mutants on line 202-207)
            expect(result.isError).toBe(true);
            expect(result.content).toHaveLength(1);
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error: Channel not found');
            expect(textContent(result.content[0])).not.toBe('');
            // Verify the full error object structure
            expect(result).toEqual({
                content: [{ type: 'text', text: 'Error: Channel not found' }],
                isError: true,
            });
        });
    });

    describe('listChannels tool', () => {
        test('should return only unmuted channels by default', async () => {
            const mockUnmutedChannelRegistry = {
                getAllChannels: mock(() => [
                    {
                        channelId:    '111111111111111111' as ChannelId,
                        channelName:  'general',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      false,
                        isWellKnown:  'general',
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                    {
                        channelId:    '222222222222222222' as ChannelId,
                        channelName:  'muted-channel',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      true,
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                ]),
                getUnmutedChannels: mock(async () => [
                    {
                        channelId:    '111111111111111111' as ChannelId,
                        channelName:  'general',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      false,
                        isWellKnown:  'general',
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                ]),
            };

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           mockClient as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockUnmutedChannelRegistry as unknown as MCPChannelRegistry,
                dmTracker:        mockDMTracker as unknown as MCPDMTracker,
                messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
                buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
                retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
            });
            const handler = getToolHandler(server, 'listChannels');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.count).toBe(1);
            expect(parsed.channels).toHaveLength(1);
            expect(parsed.channels[0].channelId).toBe('111111111111111111');
            expect(parsed.channels[0].isMuted).toBe(false);
            expect(mockUnmutedChannelRegistry.getUnmutedChannels).toHaveBeenCalled();
            expect(mockUnmutedChannelRegistry.getAllChannels).not.toHaveBeenCalled();
        });

        test('should return all channels when includesMuted is true', async () => {
            const mockAllChannelsRegistry = {
                getAllChannels: mock(() => [
                    {
                        channelId:    '111111111111111111' as ChannelId,
                        channelName:  'general',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      false,
                        isWellKnown:  'general',
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                    {
                        channelId:    '222222222222222222' as ChannelId,
                        channelName:  'muted-channel',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      true,
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                ]),
                getUnmutedChannels: mock(async () => [
                    {
                        channelId:    '111111111111111111' as ChannelId,
                        channelName:  'general',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      false,
                        isWellKnown:  'general',
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                ]),
            };

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           mockClient as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockAllChannelsRegistry as unknown as MCPChannelRegistry,
                dmTracker:        mockDMTracker as unknown as MCPDMTracker,
                messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
                buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
                retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
            });
            const handler = getToolHandler(server, 'listChannels');

            const result = await handler({ includesMuted: true });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.count).toBe(2);
            expect(parsed.channels).toHaveLength(2);
            expect(parsed.channels[0].channelId).toBe('111111111111111111');
            expect(parsed.channels[0].isMuted).toBe(false);
            expect(parsed.channels[1].channelId).toBe('222222222222222222');
            expect(parsed.channels[1].isMuted).toBe(true);
            expect(mockAllChannelsRegistry.getAllChannels).toHaveBeenCalled();
            expect(mockAllChannelsRegistry.getUnmutedChannels).not.toHaveBeenCalled();
        });

        test('should return only unmuted channels when includesMuted is false', async () => {
            const mockExcludeMutedRegistry = {
                getAllChannels: mock(() => [
                    {
                        channelId:    '111111111111111111' as ChannelId,
                        channelName:  'general',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      false,
                        isWellKnown:  'general',
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                    {
                        channelId:    '222222222222222222' as ChannelId,
                        channelName:  'muted-channel',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      true,
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                ]),
                getUnmutedChannels: mock(async () => [
                    {
                        channelId:    '111111111111111111' as ChannelId,
                        channelName:  'general',
                        guildId:      '999999999999999999' as GuildId,
                        isMuted:      false,
                        isWellKnown:  'general',
                        discoveredAt: '2025-01-01T00:00:00.000Z',
                        lastSeenAt:   '2025-01-01T12:00:00.000Z',
                        updatedAt:    '2025-01-01T12:00:00.000Z',
                    },
                ]),
            };

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           mockClient as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockExcludeMutedRegistry as unknown as MCPChannelRegistry,
                dmTracker:        mockDMTracker as unknown as MCPDMTracker,
                messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
                buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
                retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
            });
            const handler = getToolHandler(server, 'listChannels');

            const result = await handler({ includesMuted: false });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.count).toBe(1);
            expect(parsed.channels).toHaveLength(1);
            expect(parsed.channels[0].channelId).toBe('111111111111111111');
            expect(parsed.channels[0].isMuted).toBe(false);
            expect(mockExcludeMutedRegistry.getUnmutedChannels).toHaveBeenCalled();
            expect(mockExcludeMutedRegistry.getAllChannels).not.toHaveBeenCalled();
        });

        test('should handle errors from getUnmutedChannels', async () => {
            const mockErrorChannelRegistry = {
                getAllChannels:     mock(() => []),
                getUnmutedChannels: mock(async () => {
                    throw new Error('Database error');
                }),
            };

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           mockClient as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockErrorChannelRegistry as unknown as MCPChannelRegistry,
                dmTracker:        mockDMTracker as unknown as MCPDMTracker,
                messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
                buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
                retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
            });
            const handler = getToolHandler(server, 'listChannels');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Database error');
        });
    });

    describe('addReaction tool', () => {
        test('should add single emoji reaction', async () => {
            const mockMessage = {
                id:    'message-123',
                react: mock(async (_emoji: string) => undefined),
            };
            const mockChannel = {
                id:       '123456789012345678',
                messages: {
                    fetch: mock(async () => mockMessage),
                },
                isTextBased: () => true,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'addReaction');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: 'message-123',
                emoji:     '👍',
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.success).toBe(true);
            expect(parsed.addedEmojis).toEqual(['👍']);
            expect(mockMessage.react).toHaveBeenCalledWith('👍');
        });

        test('should add multiple emoji reactions', async () => {
            const mockMessage = {
                id:    'message-123',
                react: mock(async (_emoji: string) => undefined),
            };
            const mockChannel = {
                id:       '123456789012345678',
                messages: {
                    fetch: mock(async () => mockMessage),
                },
                isTextBased: () => true,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'addReaction');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: 'message-123',
                emoji:     ['👍', '❤️', '🎉'],
            });

            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.success).toBe(true);
            expect(parsed.addedEmojis).toEqual(['👍', '❤️', '🎉']);
            expect(mockMessage.react).toHaveBeenCalledTimes(3);
        });

        test('should handle partial failures', async () => {
            const mockMessage = {
                id:    'message-123',
                react: mock(async (emoji: string) => {
                    if(emoji === '❤️') {
                        throw new Error('Invalid emoji');
                    }
                }),
            };
            const mockChannel = {
                id:       '123456789012345678',
                messages: {
                    fetch: mock(async () => mockMessage),
                },
                isTextBased: () => true,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'addReaction');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: 'message-123',
                emoji:     ['👍', '❤️', '🎉'],
            });

            expect(result.isError).toBe(true);

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.success).toBe(false);
            expect(parsed.addedEmojis).toEqual(['👍', '🎉']);
            expect(parsed.failedEmojis[0].emoji).toBe('❤️');
        });

        test('should return error when message not found', async () => {
            const mockChannel = {
                id:       '123456789012345678',
                messages: {
                    fetch: mock(async () => null),
                },
                isTextBased: () => true,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'addReaction');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: 'nonexistent-message',
                emoji:     '👍',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Message not found');
        });

        test('should return error when channel fetch throws exception', async () => {
            mockClient.channels.fetch = mock(async () => {
                throw new Error('Discord API unavailable');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'addReaction');

            const result = await handler({
                channelId: '123456789012345678',
                messageId: 'message-123',
                emoji:     '👍',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Discord API unavailable');
            // Verify error object structure (kills StringLiteral and ObjectLiteral mutants in catch block)
            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toEqual({
                type: 'text',
                text: 'Error: Discord API unavailable',
            });
        });
    });

    describe('muteChannel tool', () => {
        test('should mute channel by numeric ID', async () => {
            const server = createServer();
            const handler = getToolHandler(server, 'muteChannel');

            const result = await handler({ channelId: '1451694737026449581' });

            expect(result.isError).toBeUndefined();
            expect(mockChannelRegistry.muteChannel).toHaveBeenCalledWith('1451694737026449581');

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.success).toBe(true);
            expect(parsed.muted).toBe(true);
            expect(parsed.channelId).toBe('1451694737026449581');
        });

        test('should mute channel by name with # prefix', async () => {
            mockChannelRegistry.resolveChannelId = mock((_nameOrId: string) => '1451694737026449581' as ChannelId);

            const server = createServer();
            const handler = getToolHandler(server, 'muteChannel');

            const result = await handler({ channelId: '#general' });

            expect(result.isError).toBeUndefined();
            expect(mockChannelRegistry.muteChannel).toHaveBeenCalledWith('1451694737026449581');
        });

        test('should return error when channel name not found', async () => {
            mockChannelRegistry.resolveChannelId = mock((_nameOrId: string) => {
                throw new Error('Channel not found: nonexistent');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'muteChannel');

            const result = await handler({ channelId: '#nonexistent' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Channel not found: nonexistent');
        });

        test('should return error when muteChannel registry call throws', async () => {
            mockChannelRegistry.muteChannel = mock(async () => {
                throw new Error('DynamoDB unavailable');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'muteChannel');

            const result = await handler({ channelId: '1451694737026449581' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: DynamoDB unavailable');
        });
    });

    describe('unmuteChannel tool', () => {
        test('should unmute channel by numeric ID', async () => {
            const server = createServer();
            const handler = getToolHandler(server, 'unmuteChannel');

            const result = await handler({ channelId: '1451694737026449581' });

            expect(result.isError).toBeUndefined();
            expect(mockChannelRegistry.unmuteChannel).toHaveBeenCalledWith('1451694737026449581');

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.success).toBe(true);
            expect(parsed.muted).toBe(false);
            expect(parsed.channelId).toBe('1451694737026449581');
        });

        test('should unmute channel by name with # prefix', async () => {
            mockChannelRegistry.resolveChannelId = mock((_nameOrId: string) => '1451694737026449581' as ChannelId);

            const server = createServer();
            const handler = getToolHandler(server, 'unmuteChannel');

            const result = await handler({ channelId: '#general' });

            expect(result.isError).toBeUndefined();
            expect(mockChannelRegistry.unmuteChannel).toHaveBeenCalledWith('1451694737026449581');
        });

        test('should return error when channel name not found', async () => {
            mockChannelRegistry.resolveChannelId = mock((_nameOrId: string) => {
                throw new Error('Channel not found: nonexistent');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'unmuteChannel');

            const result = await handler({ channelId: '#nonexistent' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Channel not found: nonexistent');
        });

        test('should return error when unmuteChannel registry call throws', async () => {
            mockChannelRegistry.unmuteChannel = mock(async () => {
                throw new Error('DynamoDB unavailable');
            });

            const server = createServer();
            const handler = getToolHandler(server, 'unmuteChannel');

            const result = await handler({ channelId: '1451694737026449581' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: DynamoDB unavailable');
        });
    });

    describe('listChannels getAllChannels error handling', () => {
        test('should return error when getAllChannels throws (includesMuted: true)', async () => {
            const mockThrowingRegistry = {
                getAllChannels:     mock(() => { throw new Error('Registry unavailable'); }),
                getUnmutedChannels: mock(() => Promise.resolve([])),
            };

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           mockClient as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockThrowingRegistry as unknown as MCPChannelRegistry,
                dmTracker:        mockDMTracker as unknown as MCPDMTracker,
                messageSplitter:  mockMessageSplitter as unknown as MCPMessageSplitter,
                buttonBuilder:    mockButtonBuilder as unknown as MCPQuestionButtonBuilder,
                retryHelper:      mockRetryHelper as unknown as MCPRetryHelper,
            });
            const handler = getToolHandler(server, 'listChannels');

            const result = await handler({ includesMuted: true });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Registry unavailable');
        });
    });
});
