import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import _ from 'lodash';
import { createInboxMCPServer } from '@/agent/inbox-mcp-server';
import type { InboxManager } from '@/integrations/discord/inbox/inbox-manager';
import type { UnreadMessage, UnreadOverview, ChannelSummaryResponse } from '@/integrations/discord/inbox/types';
import { createChannelId } from '@/integrations/discord/types';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as textGenerator from '@/agent/text-generator';
import type { BotStateManager } from '@/integrations/discord/state';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry';

describe('createInboxMCPServer', () => {
    let mockInboxManager: InboxManager;
    let mockChannelRegistry: ChannelRegistryManager;
    const spies: ReturnType<typeof spyOn>[] = [];

    beforeEach(() => {
        mockInboxManager = {
            getUnreadOverview: mock(() => ({
                totalUnread: 0,
                channels:    [],
            })),
            getChannelMessages: mock(() => []),
            getMessage:         mock(() => undefined),
            markAsRead:         mock(async () => { /* intentionally empty */ }),
            markChannelRead:    mock(async () => { /* intentionally empty */ }),
        } as unknown as InboxManager;

        mockChannelRegistry = {
            getAllChannels: mock(() => []),
        } as unknown as ChannelRegistryManager;
    });

    afterEach(() => {
        // Restore all spies to prevent test interference when running concurrently
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
    });

    // Helper function to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createInboxMCPServer>, toolName: string): ((args: Record<string, unknown>) => Promise<CallToolResult>) => {
        const instance = server.instance as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }> };
        return instance._registeredTools[toolName].handler;
    };

    // Helper function to extract text content from CallToolResult
    const getTextContent = (result: CallToolResult): string | undefined => {
        const content = result.content[0];
        if(content && 'text' in content && _.isString(content.text)) {
            return content.text;
        }
        return undefined;
    };

    // Helper function to safely parse JSON with type casting
    const parseJSON = <T>(text: string): T => {
        return JSON.parse(text) as T;
    };

    describe('createInboxMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);

            expect(server).toBeDefined();
            expect(server.name).toBe('inbox');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as { server: { _serverInfo: { version: string } } }).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['getUnreadOverview', 'Get a high-level overview of unread messages across all channels. Returns counts only, no message content.'],
            ['getChannelSummary', 'Get an AI-generated summary of unread messages in a channel, plus message metadata for selective reading. Accepts channel ID or #channel-name format.'],
            ['fetchMessages', 'Fetch full content of specific messages by ID. Use after reviewing channel summary to get details. Accepts channel ID or #channel-name format.'],
            ['markAsRead', 'Mark specific messages as read. Updates the checkpoint for the channel. Accepts channel ID or #channel-name format.'],
            ['markChannelRead', 'Mark all messages in a channel as read. Updates the checkpoint to the latest message. Accepts channel ID or #channel-name format.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const tool = (server.instance as unknown as { _registeredTools: Record<string, { description: string }> })._registeredTools[toolName];

            expect(tool.description).toBe(expectedDescription);
        });
    });

    describe('getUnreadOverview tool', () => {
        test('should return empty overview when no unread messages', async () => {
            mockInboxManager.getUnreadOverview = mock(() => ({
                totalUnread: 0,
                channels:    [],
            }));

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getUnreadOverview');

            const result: CallToolResult = await handler({});

            expect(result.content).toBeDefined();
            expect(result.content[0]?.type).toBe('text');

            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<UnreadOverview>(text!);
            expect(parsed.totalUnread).toBe(0);
            expect(parsed.channels).toEqual([]);
            expect(mockInboxManager.getUnreadOverview).toHaveBeenCalledTimes(1);
        });

        test('should return overview with unread messages', async () => {
            const overview: UnreadOverview = {
                totalUnread: 10,
                channels:    [
                    {
                        channelId:    createChannelId('123456789'),
                        channelName:  'general',
                        messageCount: 5,
                    },
                    {
                        channelId:    createChannelId('987654321'),
                        channelName:  'random',
                        messageCount: 5,
                    },
                ],
            };

            mockInboxManager.getUnreadOverview = mock(() => overview);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getUnreadOverview');

            const result: CallToolResult = await handler({});

            expect(result.content).toBeDefined();
            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<UnreadOverview>(text!);
            expect(parsed).toEqual(overview);
        });

        test('should return error on exception', async () => {
            mockInboxManager.getUnreadOverview = mock(() => {
                throw new Error('Test error');
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getUnreadOverview');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toContain('Error: Test error');
        });

        test('should handle non-Error exceptions', async () => {
            mockInboxManager.getUnreadOverview = mock(() => {
                throw new Error('string error');
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getUnreadOverview');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toContain('Error: string error');
        });
    });

    describe('getChannelSummary tool', () => {
        test('should return empty summary when no messages', async () => {
            mockInboxManager.getChannelMessages = mock(() => []);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getChannelSummary');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            expect(result.content).toBeDefined();
            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<ChannelSummaryResponse>(text!);
            expect(parsed.messageCount).toBe(0);
            expect(parsed.summary).toBe('No unread messages in this channel.');
            expect(parsed.authors).toEqual([]);
            expect(parsed.messages).toEqual([]);
            expect(parsed.timeRange).toEqual({ start: '', end: '' });
        });

        test('should generate summary for messages', async () => {
            const messages: UnreadMessage[] = [
                {
                    id:          '111',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Alice',
                    content:     'Hello everyone!',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    isRead:      false,
                },
                {
                    id:          '222',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Bob',
                    content:     'Hi Alice!',
                    timestamp:   '2025-01-24T10:05:00.000Z',
                    isRead:      false,
                },
            ];

            mockInboxManager.getChannelMessages = mock(() => messages);

            // Mock the text generator
            const spy = spyOn(textGenerator, 'generateTextWithSystemPrompt').mockResolvedValue('Alice greeted everyone and Bob responded.');
            spies.push(spy);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getChannelSummary');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            expect(result.content).toBeDefined();
            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<ChannelSummaryResponse>(text!);

            expect(parsed.channelId).toBe(createChannelId('123456789'));
            expect(parsed.channelName).toBe('general');
            expect(parsed.messageCount).toBe(2);
            expect(parsed.summary).toBe('Alice greeted everyone and Bob responded.');
            expect(parsed.authors).toEqual(['Alice', 'Bob']);
            expect(parsed.timeRange.start).toBe('2025-01-24T10:00:00.000Z');
            expect(parsed.timeRange.end).toBe('2025-01-24T10:05:00.000Z');
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0].id).toBe('111');
            expect(parsed.messages[0].sizeChars).toBe(15);
        });

        test('should handle AI summary generation failure', async () => {
            const messages: UnreadMessage[] = [
                {
                    id:          '111',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Alice',
                    content:     'Hello',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    isRead:      false,
                },
            ];

            mockInboxManager.getChannelMessages = mock(() => messages);

            // Mock the text generator to return null
            const spy = spyOn(textGenerator, 'generateTextWithSystemPrompt').mockResolvedValue(null as unknown as string);
            spies.push(spy);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getChannelSummary');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<ChannelSummaryResponse>(text!);
            expect(parsed.summary).toBe('Unable to generate summary.');
        });

        test('should deduplicate authors', async () => {
            const messages: UnreadMessage[] = [
                {
                    id:          '111',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Alice',
                    content:     'First',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    isRead:      false,
                },
                {
                    id:          '222',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Alice',
                    content:     'Second',
                    timestamp:   '2025-01-24T10:05:00.000Z',
                    isRead:      false,
                },
            ];

            mockInboxManager.getChannelMessages = mock(() => messages);

            const spy = spyOn(textGenerator, 'generateTextWithSystemPrompt').mockResolvedValue('Alice sent two messages.');
            spies.push(spy);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getChannelSummary');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<ChannelSummaryResponse>(text!);
            expect(parsed.authors).toEqual(['Alice']);
        });

        test('should sort timestamps correctly to find earliest and latest', async () => {
            // Messages with out-of-order timestamps
            const messages: UnreadMessage[] = [
                {
                    id:          '111',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Alice',
                    content:     'First',
                    timestamp:   '2025-01-01T10:00:00.000Z',
                    isRead:      false,
                },
                {
                    id:          '222',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Bob',
                    content:     'Second',
                    timestamp:   '2025-01-01T08:00:00.000Z', // Earliest
                    isRead:      false,
                },
                {
                    id:          '333',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Charlie',
                    content:     'Third',
                    timestamp:   '2025-01-01T09:00:00.000Z',
                    isRead:      false,
                },
            ];

            mockInboxManager.getChannelMessages = mock(() => messages);

            const spy = spyOn(textGenerator, 'generateTextWithSystemPrompt').mockResolvedValue('Conversation summary.');
            spies.push(spy);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getChannelSummary');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<ChannelSummaryResponse>(text!);
            // Verify that timeRange.start is the earliest timestamp
            expect(parsed.timeRange.start).toBe('2025-01-01T08:00:00.000Z');
            // Verify that timeRange.end is the latest timestamp
            expect(parsed.timeRange.end).toBe('2025-01-01T10:00:00.000Z');
        });

        test('should return error on exception', async () => {
            mockInboxManager.getChannelMessages = mock(() => {
                throw new Error('Test error');
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getChannelSummary');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toContain('Error: Test error');
        });
    });

    describe('fetchMessages tool', () => {
        test('should return empty array when no messages found', async () => {
            mockInboxManager.getMessage = mock(() => undefined);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'fetchMessages');

            const result: CallToolResult = await handler({
                channelId:  '123456789',
                messageIds: ['111', '222'],
            });

            expect(result.content).toBeDefined();
            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<{ messages: UnreadMessage[] }>(text!);
            expect(parsed.messages).toEqual([]);
        });

        test('should fetch messages by IDs', async () => {
            const message1: UnreadMessage = {
                id:          '111',
                channelId:   createChannelId('123456789'),
                channelName: 'general',
                guildId:     'DM',
                author:      'Alice',
                content:     'Hello',
                timestamp:   '2025-01-24T10:00:00.000Z',
                isRead:      false,
            };

            const message2: UnreadMessage = {
                id:          '222',
                channelId:   createChannelId('123456789'),
                channelName: 'general',
                guildId:     'DM',
                author:      'Bob',
                content:     'Hi',
                timestamp:   '2025-01-24T10:05:00.000Z',
                isRead:      false,
            };

            mockInboxManager.getMessage = mock((_channelId, messageId) => {
                if(messageId === '111') {
                    return message1;
                }
                if(messageId === '222') {
                    return message2;
                }
                return undefined;
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'fetchMessages');

            const result: CallToolResult = await handler({
                channelId:  '123456789',
                messageIds: ['111', '222'],
            });

            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<{ messages: UnreadMessage[] }>(text!);
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0]?.id).toBe('111');
            expect(parsed.messages[0]?.author).toBe('Alice');
            expect(parsed.messages[0]?.content).toBe('Hello');
            expect(parsed.messages[1]?.id).toBe('222');
            expect(parsed.messages[1]?.author).toBe('Bob');
            expect(mockInboxManager.getMessage).toHaveBeenCalledTimes(2);
        });

        test('should skip non-existent messages', async () => {
            const message1: UnreadMessage = {
                id:          '111',
                channelId:   createChannelId('123456789'),
                channelName: 'general',
                guildId:     'DM',
                author:      'Alice',
                content:     'Hello',
                timestamp:   '2025-01-24T10:00:00.000Z',
                isRead:      false,
            };

            mockInboxManager.getMessage = mock((_channelId, messageId) => {
                if(messageId === '111') {
                    return message1;
                }
                return undefined;
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'fetchMessages');

            const result: CallToolResult = await handler({
                channelId:  '123456789',
                messageIds: ['111', '999'],
            });

            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<{ messages: UnreadMessage[] }>(text!);
            expect(parsed.messages).toHaveLength(1);
            expect(parsed.messages[0]?.id).toBe('111');
        });

        test('should return error on exception', async () => {
            mockInboxManager.getMessage = mock(() => {
                throw new Error('Test error');
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'fetchMessages');

            const result: CallToolResult = await handler({
                channelId:  '123456789',
                messageIds: ['111'],
            });

            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toBeDefined();
            expect(text!).toContain('Error: Test error');
        });
    });

    describe('markAsRead tool', () => {
        test('should mark messages as read', async () => {
            mockInboxManager.markAsRead = mock(async () => { /* intentionally empty */ });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'markAsRead');

            const result: CallToolResult = await handler({
                channelId:  '123456789',
                messageIds: ['111', '222'],
            });

            expect(result.content).toBeDefined();
            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<{ success: boolean, markedCount: number }>(text!);
            expect(parsed.success).toBe(true);
            expect(parsed.markedCount).toBe(2);
            expect(mockInboxManager.markAsRead).toHaveBeenCalledTimes(1);
            expect(mockInboxManager.markAsRead).toHaveBeenCalledWith(
                createChannelId('123456789'),
                ['111', '222']
            );
        });

        test('should handle empty message list', async () => {
            mockInboxManager.markAsRead = mock(async () => { /* intentionally empty */ });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'markAsRead');

            const result: CallToolResult = await handler({
                channelId:  '123456789',
                messageIds: [],
            });

            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<{ success: boolean, markedCount: number }>(text!);
            expect(parsed.success).toBe(true);
            expect(parsed.markedCount).toBe(0);
        });

        test('should return error on exception', async () => {
            mockInboxManager.markAsRead = mock(async () => {
                throw new Error('Test error');
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'markAsRead');

            const result: CallToolResult = await handler({
                channelId:  '123456789',
                messageIds: ['111'],
            });

            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toBeDefined();
            expect(text!).toContain('Error: Test error');
        });
    });

    describe('markChannelRead tool', () => {
        test('should mark channel as read', async () => {
            mockInboxManager.markChannelRead = mock(async () => { /* intentionally empty */ });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'markChannelRead');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            expect(result.content).toBeDefined();
            const text = getTextContent(result);
            expect(text).toBeDefined();
            const parsed = parseJSON<{ success: boolean }>(text!);
            expect(parsed.success).toBe(true);
            expect(mockInboxManager.markChannelRead).toHaveBeenCalledTimes(1);
            expect(mockInboxManager.markChannelRead).toHaveBeenCalledWith(
                createChannelId('123456789')
            );
        });

        test('should return error on exception', async () => {
            mockInboxManager.markChannelRead = mock(async () => {
                throw new Error('Test error');
            });

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'markChannelRead');

            const result: CallToolResult = await handler({ channelId: '123456789' });

            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toBeDefined();
            expect(text!).toContain('Error: Test error');
        });
    });

    describe('BotStateManager integration', () => {
        test('getChannelSummary should mark channel as viewed when state manager provided', async () => {
            const messages: UnreadMessage[] = [
                {
                    id:          '111',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Alice',
                    content:     'Hello',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    isRead:      false,
                },
            ];

            mockInboxManager.getChannelMessages = mock(() => messages);
            const spy = spyOn(textGenerator, 'generateTextWithSystemPrompt').mockResolvedValue('Test summary');
            spies.push(spy);

            const mockStateManager: BotStateManager = {
                markChannelViewed: mock(_.noop),
            } as unknown as BotStateManager;

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry, mockStateManager);
            const handler = getToolHandler(server, 'getChannelSummary');

            await handler({ channelId: '123456789' });

            expect(mockStateManager.markChannelViewed).toHaveBeenCalledTimes(1);
            expect(mockStateManager.markChannelViewed).toHaveBeenCalledWith(createChannelId('123456789'));
        });

        test('getChannelSummary should not mark channel when state manager not provided', async () => {
            const messages: UnreadMessage[] = [
                {
                    id:          '111',
                    channelId:   createChannelId('123456789'),
                    channelName: 'general',
                    guildId:     'DM',
                    author:      'Alice',
                    content:     'Hello',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    isRead:      false,
                },
            ];

            mockInboxManager.getChannelMessages = mock(() => messages);
            const spy = spyOn(textGenerator, 'generateTextWithSystemPrompt').mockResolvedValue('Test summary');
            spies.push(spy);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'getChannelSummary');

            const result = await handler({ channelId: '123456789' });

            // Should succeed without state manager
            expect(result.isError).toBeUndefined();
        });

        test('fetchMessages should mark channel as viewed when state manager provided', async () => {
            const message: UnreadMessage = {
                id:          '111',
                channelId:   createChannelId('123456789'),
                channelName: 'general',
                guildId:     'DM',
                author:      'Alice',
                content:     'Hello',
                timestamp:   '2025-01-24T10:00:00.000Z',
                isRead:      false,
            };

            mockInboxManager.getMessage = mock(() => message);

            const mockStateManager: BotStateManager = {
                markChannelViewed: mock(_.noop),
            } as unknown as BotStateManager;

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry, mockStateManager);
            const handler = getToolHandler(server, 'fetchMessages');

            await handler({ channelId: '123456789', messageIds: ['111'] });

            expect(mockStateManager.markChannelViewed).toHaveBeenCalledTimes(1);
            expect(mockStateManager.markChannelViewed).toHaveBeenCalledWith(createChannelId('123456789'));
        });

        test('fetchMessages should not mark channel when state manager not provided', async () => {
            const message: UnreadMessage = {
                id:          '111',
                channelId:   createChannelId('123456789'),
                channelName: 'general',
                guildId:     'DM',
                author:      'Alice',
                content:     'Hello',
                timestamp:   '2025-01-24T10:00:00.000Z',
                isRead:      false,
            };

            mockInboxManager.getMessage = mock(() => message);

            const server = createInboxMCPServer(mockInboxManager, mockChannelRegistry);
            const handler = getToolHandler(server, 'fetchMessages');

            const result = await handler({ channelId: '123456789', messageIds: ['111'] });

            // Should succeed without state manager
            expect(result.isError).toBeUndefined();
        });
    });
});
