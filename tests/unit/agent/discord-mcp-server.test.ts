import { describe, test, expect, beforeEach, mock, afterEach, jest } from 'bun:test';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Client, MessageCreateOptions } from 'discord.js';
import { createDiscordMCPServer } from '../../../src/agent/discord-mcp-server';
import type { QuestionRegistry } from '../../../src/agent/question-registry';
import type { MCPChannelRegistry, MCPMessageSearchService } from '../../../src/agent/types';
import type { SearchResponse, DiscordSearchResult } from '../../../src/integrations/discord/message-history/types';
import type { ChannelId, GuildId } from '../../../src/integrations/discord/types';
import { mockFsPromises, mockLogger, resetMockFsPrefix, textContent } from '../../setup';

interface ZodShapeEntry {
    description?: string
    safeParse:    (v: unknown) => { success: boolean }
    unwrap:       () => { safeParse: (v: unknown) => { success: boolean } }
}
interface RegisteredTool {
    _meta?:      Record<string, unknown>
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
interface MockPersonAllowlist {
    isAllowed: ReturnType<typeof mock>
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
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
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
                state:      'cancelled',
                reason:     'interrupted',
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

    // Helper to create server with current mocks and optional timezone/allowlist override
    const createServer = (timezone?: string, personAllowlist?: MockPersonAllowlist): ReturnType<typeof createDiscordMCPServer> => createDiscordMCPServer({
        searchService:    mockSearchService,
        client:           mockClient as unknown as Client,
        questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
        channelRegistry:  mockChannelRegistry,
        dmTracker:        mockDMTracker,
        messageSplitter:  mockMessageSplitter,
        buttonBuilder:    mockButtonBuilder,
        retryHelper:      mockRetryHelper,
        timezone,
        personAllowlist:  personAllowlist as unknown as Parameters<typeof createDiscordMCPServer>[0]['personAllowlist'],
    });

    // Helper function to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createDiscordMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    test.each([
        ['searchMessages', { channelId: '123' }],
        ['getRecentMessages', { channelId: '123' }],
        ['getMessageById', { channelId: '123', messageId: '456' }],
        ['sendDiscordMessage', { channelId: '123', content: 'hello' }],
        ['askUserQuestion', { channelId: '123', question: 'Proceed?' }],
        ['muteChannel', { channelId: '123' }],
        ['unmuteChannel', { channelId: '123' }],
    ])('%s identifies its tool when channel resolution fails', async (toolName, args) => {
        mockChannelRegistry.resolveChannelId = mock(() => {
            throw new Error('route unavailable');
        });

        const result = await getToolHandler(createServer(), toolName)(args);

        expect(result.isError).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: toolName, error: 'route unavailable' }, 'MCP tool error');
    });

    test('listChannels identifies its tool when channel enumeration fails', async () => {
        mockChannelRegistry.getUnmutedChannels = mock(() => Promise.reject(new Error('registry unavailable')));

        const result = await getToolHandler(createServer(), 'listChannels')({});

        expect(result.isError).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: 'listChannels', error: 'registry unavailable' }, 'MCP tool error');
    });

    test.each(['searchMessages', 'getRecentMessages'])('%s enriches a result batch and safely leaves malformed records alone', async (toolName) => {
        const response = createMockSearchResponse({
            messages: [
                createMockSearchResult({ id: 'valid', timestamp: '2025-01-15T14:30:00.000Z' }),
                { id: 'bad', timestamp: undefined } as unknown as DiscordSearchResult,
            ],
        });
        const search = mock(async () => response);
        mockSearchService.searchMessages = search;
        mockSearchService.getRecentMessages = search;

        const result = await getToolHandler(createServer('America/Los_Angeles'), toolName)({ channelId: '123456789012345678' });
        const parsed = JSON.parse(textContent(result.content[0])) as { messages: { id: string, localTimestamp?: string }[] };
        expect(result.isError).toBeUndefined();
        expect(parsed.messages).toHaveLength(2);
        expect(parsed.messages[0].localTimestamp).toBe('2025-01-15T06:30:00');
        expect(parsed.messages[1].localTimestamp).toBeUndefined();
        expect(search).toHaveBeenCalledTimes(1);
    });

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

NEVER invent or guess channel IDs. If unsure, use #general.

The channel must always be given explicitly — there is no ambient conversation context.`],
            ['addReaction', 'Add one or more emoji reactions to a Discord message. Accepts channel ID or #channel-name format.'],
            ['askUserQuestion', 'Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. The returned state identifies whether the question was answered, timed out, or cancelled. Options are limited to 25 maximum (Discord limit). Accepts channel ID or #channel-name format. The channel and requesting user must always be given explicitly — there is no ambient conversation context.'],
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

        test('publishes meaningful input guidance for every registered tool', () => {
            const server = createServer();
            const registered = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
            for(const [name, entry] of Object.entries(registered)) {
                expect(entry.description.length).toBeGreaterThan(15);
                for(const [fieldName, schema] of Object.entries(entry.inputSchema.shape)) {
                    expect(schema.description?.length, `${name}.${fieldName}`).toBeGreaterThan(8);
                }
            }
            expect(registered.sendDiscordMessage.description).toContain('NEVER invent or guess channel IDs');
            expect(registered.askUserQuestion.description).toContain('25 maximum');
            expect(registered.askUserQuestion.description).toContain('state');
            expect(registered.muteChannel.description).toContain('will not respond');
        });

        test('should accept timezone parameter for localTimestamp enrichment', () => {
            const server = createServer('America/New_York');
            // Server should be created successfully with timezone parameter
            expect(server).toBeDefined();
            expect(server.name).toBe('discord');
        });

        test('should mark every Discord tool as always loaded so tool search never defers it', () => {
            const server = createServer();
            const registered = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
            const names = Object.keys(registered);
            expect(names.length).toBeGreaterThan(0);
            for(const name of names) {
                expect(registered[name]._meta).toEqual({ 'anthropic/alwaysLoad': true });
            }
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

            expect(result.content).toHaveLength(1);

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

        test('should pass producible batch overflow summaries through unchanged', async () => {
            const overflow = {
                count:          5,
                batchSummaries: [{
                    startTimestamp: '2025-01-01T00:00:00.000Z',
                    endTimestamp:   '2025-01-01T00:05:00.000Z',
                    messageCount:   5,
                    authors:        ['someuser'],
                    synopsis:       'Summary of older messages',
                }],
            };
            mockSearchService.searchMessages = mock(async () => createMockSearchResponse({
                messages: [createMockSearchResult()],
                overflow,
            }));

            const server = createServer();
            const handler = getToolHandler(server, 'searchMessages');

            const result = await handler({ channelId: '123456789012345678' });

            const parsed = JSON.parse(textContent(result.content[0])) as SearchResponse;
            expect(parsed.overflow).toEqual(overflow);
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
        afterEach(() => {
            jest.restoreAllMocks();
        });

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

NEVER invent or guess channel IDs. If unsure, use #general.

The channel must always be given explicitly — there is no ambient conversation context.`);
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
            expect(shape.requestingUserId).toBeDefined();
        });

        test.each([
            ['a single file path string', 'attachment.png'],
            ['an array of file path strings', ['attachment1.png', 'attachment2.png']],
        ])('should accept %s for the files field', (_description, value) => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.sendDiscordMessage;

            const result = tool.inputSchema.shape.files.unwrap().safeParse(value);

            expect(result.success).toBe(true);
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

        test('should pass requestingUserId through to the "Message sent via MCP tool" log', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                send:        mock(async (_content: string) => ({ id: 'sent-message-id' })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);
            const infoSpy = mockLogger.info;
            infoSpy.mockClear();

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            const result = await handler({
                channelId:        '123456789012345678',
                content:          'Test message',
                requestingUserId: 'user-456',
            });

            expect(result.isError).toBeUndefined();
            expect(infoSpy).toHaveBeenCalledWith(
                expect.objectContaining({ requestingUserId: 'user-456', msg: 'Message sent via MCP tool' })
            );
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
            expect(parsed.messageIds).toEqual(['msg-1', 'msg-2']);
            expect(parsed.chunksCount).toBe(2);

            // Verify multiple sends occurred
            expect(sentMessages).toHaveLength(2);
        });

        test('should start a thread from the first message when content is split into chunks', async () => {
            const firstMessage = {
                id:          'first-message',
                startThread: mock(async () => ({ id: 'thread-from-first' })),
            };
            const secondMessage = { id: 'second-message', startThread: mock(async () => ({ id: 'thread-from-second' })) };
            let sendCount = 0;
            const mockChannel = {
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                threads:     {},
                send:        mock(async () => {
                    sendCount++;
                    return sendCount === 1 ? firstMessage : secondMessage;
                }),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);
            mockMessageSplitter.splitMessage = mock(() => ['first chunk', 'second chunk']);

            const result = await getToolHandler(createServer(), 'sendDiscordMessage')({
                channelId:    '123456789012345678',
                content:      'split message',
                createThread: true,
                threadName:   'Split thread',
            });

            const parsed = JSON.parse(textContent(result.content[0])) as { messageIds: string[], threadId: string };
            expect(parsed.messageIds).toEqual(['first-message', 'second-message']);
            expect(parsed.threadId).toBe('thread-from-first');
            expect(firstMessage.startThread).toHaveBeenCalledWith({ name: 'Split thread' });
            expect(secondMessage.startThread).not.toHaveBeenCalled();
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
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { channelId: '123456789012345678' },
                'Discord tool returned error: Channel not found'
            );
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
            expect(mockLogger.warn).toHaveBeenCalledWith({ createThread: true, threadName: undefined }, 'Discord tool returned error: threadName required when createThread is true');
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
                        expect(options.files as string[]).toHaveLength(2);
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

            test('should attach one validated file when a single path is provided', async () => {
                const testFile = path.join(process.cwd(), 'single-file.txt');
                await mockFsPromises.writeFile(testFile, 'single file');
                let sentOptions: MessageCreateOptions | undefined;
                const mockChannel = {
                    id:   '123456789012345678',
                    send: mock(async (options: MessageCreateOptions) => {
                        sentOptions = options;
                        return { id: 'sent-message-id' };
                    }),
                    isTextBased: () => true,
                    isThread:    () => false,
                    isDMBased:   () => false,
                };
                mockClient.channels.fetch = mock(async () => mockChannel);

                const result = await getToolHandler(createServer(), 'sendDiscordMessage')({
                    channelId: '123456789012345678',
                    content:   'One attachment',
                    files:     testFile,
                });

                const parsed = JSON.parse(textContent(result.content[0])) as { filesAttached?: number };
                expect(parsed.filesAttached).toBe(1);
                expect(mockChannel.send).toHaveBeenCalledTimes(1);
                expect(sentOptions?.files).toEqual([testFile]);
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
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.objectContaining({
                        tool:  'sendDiscordMessage',
                        error: expect.stringContaining('outside the working directory'),
                        path:  expect.any(String),
                    }),
                    'Discord tool returned security error'
                );
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
            expect(textContent(result.content[0])).toContain('Invariant violated in sendAllChunks:');
        });

        test('should reject a sparse chunk array returned by splitMessage', async () => {
            const chunks = ['first chunk', undefined] as unknown as string[];
            mockMessageSplitter.splitMessage = mock(() => chunks);

            const send = mock(async () => ({ id: 'sent-message-id' }));
            mockClient.channels.fetch = mock(async () => ({
                id:          '123456789012345678',
                send,
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            }));

            const handler = getToolHandler(createServer(), 'sendDiscordMessage');
            const result = await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('chunks[i] undefined despite i < chunks.length');
            expect(textContent(result.content[0])).toContain('Invariant violated in sendAllChunks:');
            expect(send).toHaveBeenCalledTimes(1);
        });
    });

    describe('askUserQuestion tool', () => {
        test('should have askUserQuestion tool with correct description', () => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.askUserQuestion;

            expect(tool.description).toBe('Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. The returned state identifies whether the question was answered, timed out, or cancelled. Options are limited to 25 maximum (Discord limit). Accepts channel ID or #channel-name format. The channel and requesting user must always be given explicitly — there is no ambient conversation context.');
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
            expect(shape.requestingUserId).toBeDefined();
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

        test('should create a button when one option is provided', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);
            const singleOption = [{ label: 'Continue', value: 'continue' }];
            const actionRows = [{ type: 1, components: [{ type: 2, label: 'Continue' }] }];
            mockButtonBuilder.buildQuestionButtons = mock(() => actionRows);

            await getToolHandler(createServer(), 'askUserQuestion')({
                channelId: '123456789012345678',
                question:  'Continue?',
                options:   singleOption,
            });

            expect(mockButtonBuilder.buildQuestionButtons).toHaveBeenCalledWith(expect.objectContaining({ options: singleOption }));
            expect(mockChannel.send).toHaveBeenCalledWith(expect.objectContaining({ components: actionRows }));
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
            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
                channelId:   '123456789012345678',
                hasOptions:  false,
                optionCount: 0,
                msg:         'Question asked via MCP tool',
            }));
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
                state:      'answered',
                answer:     {
                    content:     'Blue',
                    responderId: 'user-123',
                    messageId:   'answer-message-id',
                    channelId:   '123456789012345678',
                },
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
            expect(parsed.state).toBe('answered');
            expect(parsed.message).toBe('Question answered');
            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
                channelId:         '123456789012345678',
                responderId:       'user-123',
                hasSelectedOption: false,
                msg:               'Question answered',
            }));
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
                state:      'timed_out',
                channelId:  '123456789012345678',
            }));

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });

            expect(textContent(result.content[0])).toContain('timed_out');

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.questionId).toBe('q1');
            expect(parsed.state).toBe('timed_out');
            expect(parsed.message).toBe('Question timed out without response');
            expect(parsed.channelId).toBe('123456789012345678');
            expect(mockLogger.info).toHaveBeenCalledWith({
                questionId: expect.any(String),
                channelId:  '123456789012345678',
                threadId:   undefined,
                msg:        'Question timed out without answer',
            });
        });

        test('should return a cancelled state with reason and no answer', async () => {
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
                state:      'cancelled' as const,
                reason:     'interrupted' as const,
                channelId:  '123456789012345678',
            }));

            const handler = getToolHandler(createServer(), 'askUserQuestion');
            const result = await handler({
                channelId: '123456789012345678',
                question:  'What is your favorite color?',
            });
            const parsed = JSON.parse(textContent(result.content[0]));

            expect(parsed).toMatchObject({
                questionId: 'q1',
                channelId:  '123456789012345678',
                state:      'cancelled',
                reason:     'interrupted',
                message:    'Question cancelled: interrupted',
            });
            expect(parsed).not.toHaveProperty('answer');
            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
                reason: 'interrupted',
                msg:    'Question cancelled',
            }));
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
            expect(mockLogger.warn).toHaveBeenCalledWith({ normalizedChannelId: '123456789012345678' }, 'Discord tool returned error: Parent channel is not text-based');
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
            expect(mockLogger.warn).toHaveBeenCalledWith({ optionCount: 26 }, 'Discord tool returned error: Too many options (max 25)');
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
            expect(mockLogger.warn).toHaveBeenCalledWith({ normalizedChannelId: 'parent-channel-id' }, 'Discord tool returned error: Parent channel not found');
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
            expect(mockLogger.warn).toHaveBeenCalledWith({ normalizedChannelId: 'parent-channel-id' }, 'Discord tool returned error: Parent channel is not text-based');
        });
    });

    describe('prepareQuestionChannel helper', () => {
        test('uses the original channel unless thread creation is requested', async () => {
            const send = mock(async () => ({ id: 'question-message-id' }));
            const create = mock(async () => ({ id: 'unwanted-thread-id', send }));
            mockClient.channels.fetch = mock(async () => ({
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send,
                threads:     { create },
            }));

            const result = await getToolHandler(createServer(), 'askUserQuestion')({
                channelId: '123456789012345678',
                question:  'Question in this channel?',
            });

            expect(result.isError).toBeUndefined();
            expect(create).not.toHaveBeenCalled();
            expect(send).toHaveBeenCalledTimes(1);
        });

        test('uses the default Q&A thread name when none is supplied', async () => {
            const create = mock(async () => ({ id: 'qa-thread-id', send: mock(async () => ({ id: 'question-message-id' })) }));
            mockClient.channels.fetch = mock(async () => ({
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                threads:     { create },
            }));

            const result = await getToolHandler(createServer(), 'askUserQuestion')({
                channelId:    '123456789012345678',
                question:     'Question in a new thread?',
                createThread: true,
            });

            expect(result.isError).toBeUndefined();
            expect(create).toHaveBeenCalledWith({ name: 'Q&A' });
        });

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

        test('falls back to the original channel when createThread is true but the channel type has no threads collection', async () => {
            const send = mock(async (_content: unknown) => ({ id: 'question-message-id' }));
            const dmChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => true,
                send,
                // DM channels have no `threads` property at all - 'threads' in channel is
                // false even though createThread is true, so this must not attempt to
                // create one.
            };
            mockClient.channels.fetch = mock(async () => dmChannel);

            const result = await getToolHandler(createServer(), 'askUserQuestion')({
                channelId:    '123456789012345678',
                question:     'DM question?',
                createThread: true,
                threadName:   'Some Thread',
            });

            expect(result.isError).toBeUndefined();
            expect(send).toHaveBeenCalledTimes(1);
        });

        test('creates the thread with the exact supplied name, even an empty one (no upstream validation on this path)', async () => {
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
                threads:     { create: mock(async (_options: unknown) => mockThread) },
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            // Unlike sendDiscordMessage, askUserQuestion never runs threadName through
            // validateThreadCreation, so an empty string reaches prepareQuestionChannel
            // as-is and must not be coalesced away.
            await getToolHandler(createServer(), 'askUserQuestion')({
                channelId:    '123456789012345678',
                question:     'Thread question?',
                createThread: true,
                threadName:   '',
            });

            expect(mockChannel.threads.create).toHaveBeenCalledWith({ name: '' });
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
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { channelId: '123456789012345678' },
                'Discord tool returned error: Channel is not text-based'
            );
        });

        test('fetches the channel through the retry helper', async () => {
            const mockVoiceChannel = {
                id:          '123456789012345678',
                isTextBased: () => false,
            };
            mockClient.channels.fetch = mock(async () => mockVoiceChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'sendDiscordMessage');

            await handler({
                channelId: '123456789012345678',
                content:   'Test message',
            });

            // Nothing else in this flow calls retryHelper.withRetry before the
            // not-text-based error short-circuits, so exactly one call proves the
            // channel fetch itself was wrapped in the retry helper rather than
            // calling client.channels.fetch directly.
            expect(mockRetryHelper.withRetry).toHaveBeenCalledTimes(1);
        });
    });

    describe('createThreadIfRequested helper', () => {
        test('does not start a thread when the channel lacks thread capability', async () => {
            const startThread = mock(async () => ({ id: 'unwanted-thread-id' }));
            mockClient.channels.fetch = mock(async () => ({
                id:          'text-only-channel-id',
                send:        mock(async () => ({ id: 'sent-message-id', startThread })),
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
            }));

            const result = await getToolHandler(createServer(), 'sendDiscordMessage')({
                channelId:    'text-only-channel-id',
                content:      'Message in a text-only channel',
                createThread: true,
                threadName:   'Unsupported thread',
            });

            expect(result.isError).toBeUndefined();
            expect(startThread).not.toHaveBeenCalled();
        });

        test('does not start another thread from a message already sent in a thread', async () => {
            const startThread = mock(async () => ({ id: 'nested-thread-id' }));
            mockClient.channels.fetch = mock(async () => ({
                id:          'existing-thread-id',
                send:        mock(async () => ({ id: 'sent-message-id', startThread })),
                isTextBased: () => true,
                isThread:    () => true,
                isDMBased:   () => false,
            }));

            const result = await getToolHandler(createServer(), 'sendDiscordMessage')({
                channelId:    'existing-thread-id',
                content:      'Message in an existing thread',
                createThread: true,
                threadName:   'Nested thread',
            });

            expect(result.isError).toBeUndefined();
            expect(startThread).not.toHaveBeenCalled();
            expect(JSON.parse(textContent(result.content[0])).threadId).toBeUndefined();
        });

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

    describe('triggerUserId resolution', () => {
        const mockAnsweredChannel = {
            id:          '123456789012345678',
            isTextBased: () => true,
            isThread:    () => false,
            isDMBased:   () => false,
            send:        mock(async (_content: unknown) => ({ id: 'question-message-id' })),
        };

        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('should use requestingUserId as triggerUserId when given and allowlisted', async () => {
            mockClient.channels.fetch = mock(async () => mockAnsweredChannel);
            const mockAllowlist: MockPersonAllowlist = { isAllowed: mock(() => true) };

            const server = createServer(undefined, mockAllowlist);
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId:        '123456789012345678',
                question:         'Test question?',
                requestingUserId: 'user-123',
            });

            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('discord', 'user-123');
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('user-123');
        });

        test('should use requestingUserId as triggerUserId when no allowlist is configured', async () => {
            mockClient.channels.fetch = mock(async () => mockAnsweredChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId:        '123456789012345678',
                question:         'Test question?',
                requestingUserId: 'user-123',
            });

            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('user-123');
        });

        test('should fallback to clientUser.id when requestingUserId is omitted', async () => {
            mockClient.channels.fetch = mock(async () => mockAnsweredChannel);

            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('bot-user-id-12345');
        });

        test('should fallback to system when requestingUserId omitted and no clientUser available', async () => {
            const mockClientWithoutUser = {
                user:     null,
                channels: {
                    fetch: mock(async () => mockAnsweredChannel),
                },
            };

            const server = createDiscordMCPServer({
                searchService:    mockSearchService,
                client:           mockClientWithoutUser as unknown as Client,
                questionRegistry: mockQuestionRegistry as unknown as QuestionRegistry,
                channelRegistry:  mockChannelRegistry,
                dmTracker:        mockDMTracker,
                messageSplitter:  mockMessageSplitter,
                buttonBuilder:    mockButtonBuilder,
                retryHelper:      mockRetryHelper,
            });
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId: '123456789012345678',
                question:  'Test question?',
            });

            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('system');
        });

        test('should fallback to clientUser.id and log a warning when requestingUserId is not allowlisted', async () => {
            mockClient.channels.fetch = mock(async () => mockAnsweredChannel);
            const mockAllowlist: MockPersonAllowlist = { isAllowed: mock(() => false) };
            const warnSpy = mockLogger.warn;

            const server = createServer(undefined, mockAllowlist);
            const handler = getToolHandler(server, 'askUserQuestion');

            await handler({
                channelId:        '123456789012345678',
                question:         'Test question?',
                requestingUserId: 'hallucinated-user-id',
            });

            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('discord', 'hallucinated-user-id');
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('bot-user-id-12345');
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ requestingUserId: 'hallucinated-user-id' }),
                expect.stringContaining('not allowlisted')
            );
        });

        test('should treat an empty-string requestingUserId as absent rather than throwing', async () => {
            mockClient.channels.fetch = mock(async () => mockAnsweredChannel);
            const warnSpy = mockLogger.warn;
            // logger.warn is a shared module-level mock (see tests/setup.ts); spyOn() reuses
            // it rather than wrapping a fresh call-history array, so an adjacent test's calls
            // can still be sitting in it — clear before exercising this test's own behavior.
            warnSpy.mockClear();

            // No allowlist configured: '' would otherwise take the fail-open fast path
            // straight into createUserId(''), which throws (UserId requires non-empty).
            const server = createServer();
            const handler = getToolHandler(server, 'askUserQuestion');

            const result = await handler({
                channelId:        '123456789012345678',
                question:         'Test question?',
                requestingUserId: '',
            });

            expect(result.isError).toBeUndefined();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.triggerUserId).toBe('bot-user-id-12345');
            expect(warnSpy).not.toHaveBeenCalled();
        });

        test('should attribute interleaved askUserQuestion calls on two servers from the same options to their own requestingUserId', async () => {
            mockClient.channels.fetch = mock(async () => mockAnsweredChannel);

            const serverA = createServer();
            const serverB = createServer();
            const handlerA = getToolHandler(serverA, 'askUserQuestion');
            const handlerB = getToolHandler(serverB, 'askUserQuestion');

            await Promise.all([
                handlerA({ channelId: '123456789012345678', question: 'From A', requestingUserId: 'user-a' }),
                handlerB({ channelId: '123456789012345678', question: 'From B', requestingUserId: 'user-b' }),
            ]);

            const calls = mockQuestionRegistry.register.mock.calls;
            expect(calls).toHaveLength(2);
            const triggerIds = calls.map(call => call[0].triggerUserId).toSorted((a: string, b: string) => a.localeCompare(b));
            expect(triggerIds).toEqual(['user-a', 'user-b']);
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
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { channelId: 'invalid-channel-id' },
                'Discord tool returned error: Channel not found in normalizeChannelId'
            );
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
                dmTracker:        mockDMTracker,
                messageSplitter:  mockMessageSplitter,
                buttonBuilder:    mockButtonBuilder,
                retryHelper:      mockRetryHelper,
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
                dmTracker:        mockDMTracker,
                messageSplitter:  mockMessageSplitter,
                buttonBuilder:    mockButtonBuilder,
                retryHelper:      mockRetryHelper,
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
                dmTracker:        mockDMTracker,
                messageSplitter:  mockMessageSplitter,
                buttonBuilder:    mockButtonBuilder,
                retryHelper:      mockRetryHelper,
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
                dmTracker:        mockDMTracker,
                messageSplitter:  mockMessageSplitter,
                buttonBuilder:    mockButtonBuilder,
                retryHelper:      mockRetryHelper,
            });
            const handler = getToolHandler(server, 'listChannels');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Database error');
        });
    });

    describe('addReaction tool', () => {
        test.each([
            ['a single emoji string', '👍'],
            ['an array of emoji strings', ['👍', '❤️']],
        ])('should accept %s for the emoji field', (_description, value) => {
            const server = createServer();
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.addReaction;

            const result = tool.inputSchema.shape.emoji.safeParse(value);

            expect(result.success).toBe(true);
        });

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
            expect(parsed.failedEmojis).toBeUndefined();
            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(mockMessage.react).toHaveBeenCalledWith('👍');
        });

        test('should resolve a channel name before fetching its message', async () => {
            const mockMessage = { id: 'message-123', react: mock(async () => undefined) };
            const mockChannel = {
                id:          'resolved-channel-id',
                messages:    { fetch: mock(async () => mockMessage) },
                isTextBased: () => true,
            };
            mockChannelRegistry.resolveChannelId = mock(() => 'resolved-channel-id' as ChannelId);
            mockClient.channels.fetch = mock(async (channelId: string) => {
                expect(channelId).toBe('resolved-channel-id');
                return mockChannel;
            });

            const result = await getToolHandler(createServer(), 'addReaction')({
                channelId: '#release-notes',
                messageId: 'message-123',
                emoji:     '👍',
            });

            expect(result.isError).toBeUndefined();
            expect(mockChannelRegistry.resolveChannelId).toHaveBeenCalledWith('#release-notes');
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
                    if(emoji === '❤️' || emoji === '🚫') {
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
                emoji:     ['👍', '❤️', '🚫', '🎉'],
            });

            expect(result.isError).toBe(true);

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.success).toBe(false);
            expect(parsed.addedEmojis).toEqual(['👍', '🎉']);
            expect(parsed.failedEmojis).toEqual([
                { emoji: '❤️', error: 'Invalid emoji' },
                { emoji: '🚫', error: 'Invalid emoji' },
            ]);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                {
                    tool:         'addReaction',
                    channelId:    '123456789012345678',
                    messageId:    'message-123',
                    failedEmojis: [
                        { emoji: '❤️', error: 'Invalid emoji' },
                        { emoji: '🚫', error: 'Invalid emoji' },
                    ],
                },
                'Discord tool returned partial error: Some reactions failed'
            );
        });

        test('should return error when message not found', async () => {
            const mockChannel = {
                id:       '123456789012345678',
                messages: {
                    fetch: mock(async () => { throw new Error('Unknown Message'); }),
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
            expect(textContent(result.content[0])).toBe('Error: Unknown Message');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { tool: 'addReaction', error: 'Unknown Message' },
                'MCP tool error'
            );
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
            expect(mockLogger.info).toHaveBeenCalledWith({ tool: 'muteChannel', channelId: '1451694737026449581', msg: 'Channel muted' });
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
            expect(mockLogger.info).toHaveBeenCalledWith({ tool: 'unmuteChannel', channelId: '1451694737026449581', msg: 'Channel unmuted' });
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
                dmTracker:        mockDMTracker,
                messageSplitter:  mockMessageSplitter,
                buttonBuilder:    mockButtonBuilder,
                retryHelper:      mockRetryHelper,
            });
            const handler = getToolHandler(server, 'listChannels');

            const result = await handler({ includesMuted: true });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Registry unavailable');
        });
    });

    describe('surviving mutant regressions', () => {
        test('addReaction reports a single failed emoji and flags the result as an error', async () => {
            const mockMessage = {
                id:    'message-123',
                react: mock(async (emoji: string) => {
                    if(emoji === '❤️') {
                        throw new Error('Invalid emoji');
                    }
                }),
            };
            const mockChannel = {
                id:          '123456789012345678',
                messages:    { fetch: mock(async () => mockMessage) },
                isTextBased: () => true,
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            const result = await getToolHandler(createServer(), 'addReaction')({
                channelId: '123456789012345678',
                messageId: 'message-123',
                emoji:     ['👍', '❤️'],
            });

            expect(result.isError).toBe(true);

            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed.success).toBe(false);
            expect(parsed.addedEmojis).toEqual(['👍']);
            expect(parsed.failedEmojis).toEqual([{ emoji: '❤️', error: 'Invalid emoji' }]);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('normalizeChannelId falls back to the requested channel id when a thread has no parent', async () => {
            const mockThread = {
                id:          'thread-id',
                parentId:    null,
                isThread:    () => true,
                isTextBased: () => true,
            };
            const mockParentChannel = {
                id:          'resolved-channel-id',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async () => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async (channelId: string) => {
                if(channelId === 'resolved-channel-id') {
                    return mockThread;
                }
                return mockParentChannel;
            });

            await getToolHandler(createServer(), 'askUserQuestion')({
                channelId: 'resolved-channel-id',
                question:  'Test question?',
            });

            expect(mockQuestionRegistry.register).toHaveBeenCalled();
            const registerCall = mockQuestionRegistry.register.mock.calls[0][0];
            expect(registerCall.channelId).toBe('resolved-channel-id');
        });

        test('logs hasOptions false when an empty options array is supplied', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async () => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            await getToolHandler(createServer(), 'askUserQuestion')({
                channelId: '123456789012345678',
                question:  'Empty options?',
                options:   [],
            });

            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
                hasOptions:  false,
                optionCount: 0,
            }));
        });

        test('separates the target mention from the question with a single space', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async (_options: MessageCreateOptions | string) => ({ id: 'question-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            await getToolHandler(createServer(), 'askUserQuestion')({
                channelId:    '123456789012345678',
                question:     'What is your favorite color?',
                targetUserId: 'user-123',
            });

            const sendCall = mockChannel.send.mock.calls[0][0] as { content?: string };
            expect(sendCall.content).toBe('<@user-123> What is your favorite color?');
        });

        test('retries a transient fetch failure when replying to a message', async () => {
            let fetchAttempts = 0;
            const originalMessage = {
                id:    'original-message-id',
                reply: mock(async () => ({ id: 'reply-message-id' })),
            };
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async () => ({ id: 'sent-message-id' })),
                messages:    {
                    fetch: mock(async () => {
                        fetchAttempts++;
                        if(fetchAttempts === 1) {
                            throw new Error('transient fetch failure');
                        }
                        return originalMessage;
                    }),
                },
            };
            mockClient.channels.fetch = mock(async () => mockChannel);
            mockRetryHelper.withRetry = mock((fn: () => Promise<unknown>) => fn().catch(() => fn()));

            const result = await getToolHandler(createServer(), 'sendDiscordMessage')({
                channelId:        '123456789012345678',
                content:          'replying',
                replyToMessageId: 'original-message-id',
            });

            expect(result.isError).toBeUndefined();
            expect(originalMessage.reply).toHaveBeenCalled();
            expect(fetchAttempts).toBe(2);
        });

        test('treats an @ as a DM marker only when it is the first character', async () => {
            const mockChannel = {
                id:          '123456789012345678',
                isTextBased: () => true,
                isThread:    () => false,
                isDMBased:   () => false,
                send:        mock(async () => ({ id: 'sent-message-id' })),
            };
            mockClient.channels.fetch = mock(async () => mockChannel);

            await getToolHandler(createServer(), 'sendDiscordMessage')({
                channelId: '#games@night',
                content:   'hello',
            });

            expect(mockDMTracker.getOrCreateDMByUsername).not.toHaveBeenCalled();
            expect(mockChannelRegistry.resolveChannelId).toHaveBeenCalledWith('#games@night');
        });
    });
});
