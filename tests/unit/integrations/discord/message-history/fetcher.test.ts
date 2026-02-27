import { describe, test, expect, mock } from 'bun:test';
import type { Client, TextChannel, Message, Collection, User } from 'discord.js';
import constant from 'lodash/constant';
import every from 'lodash/every';
import filter from 'lodash/filter';
import find from 'lodash/find';
import findIndex from 'lodash/findIndex';
import has from 'lodash/has';
import isString from 'lodash/isString';
import map from 'lodash/map';
import some from 'lodash/some';
import { ErrorCode } from '@/errors';
import {
    createMessageFetcher,
    ChannelNotAccessibleError,
    MessageFetchError
} from '@/integrations/discord/message-history/fetcher';
import { timestampToSnowflake } from '@/integrations/discord/message-history/snowflake';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

/**
 * Creates an attachments map from an array of attachment objects.
 */
function buildAttachmentsMap(attachments: { url: string, name: string | null, contentType?: string | null }[]): Map<string, { url: string, name: string | null, contentType: string | null }> {
    const attachmentMap = new Map<string, { url: string, name: string | null, contentType: string | null }>();
    for(const [idx, att] of attachments.entries()) {
        attachmentMap.set(idx.toString(), {
            url:         att.url,
            name:        att.name,
            contentType: att.contentType ?? null,
        });
    }
    return attachmentMap;
}

/**
 * Creates a reactions map from an array of reaction objects.
 */
function buildReactionsMap(reactions: { emoji: string, count: number }[]): Map<string, { emoji: { toString: () => string }, count: number }> {
    const reactionsMap = new Map<string, { emoji: { toString: () => string }, count: number }>();
    for(const [idx, r] of reactions.entries()) {
        reactionsMap.set(idx.toString(), {
            emoji: { toString: constant(r.emoji) },
            count: r.count,
        });
    }
    return reactionsMap;
}

/**
 * Creates a mock Discord message for testing.
 */
function createMockMessage(overrides: {
    id:                 string
    content?:           string
    channelId?:         string
    guildId?:           string | null
    authorId?:          string
    authorUsername?:    string
    authorDisplayName?: string
    createdAt?:         Date
    attachments?:       { url: string, name: string | null, contentType?: string | null }[]
    embeds?:            { title?: string | null, description?: string | null, url?: string | null }[]
    reactions?:         { emoji: string, count: number }[]
    replyToId?:         string | null
}): Message {
    const {
        id,
        content = 'Test message',
        channelId = '123456789012345678',
        guildId = '987654321098765432',
        authorId = '111111111111111111',
        authorUsername = 'testuser',
        authorDisplayName = 'Test User',
        createdAt = new Date('2025-01-15T12:00:00.000Z'),
        attachments = [],
        embeds = [],
        reactions = [],
        replyToId = null,
    } = overrides;

    // Create embeds array
    const embedsArray = map(embeds, e => ({
        title:       e.title ?? null,
        description: e.description ?? null,
        url:         e.url ?? null,
    }));

    return {
        id,
        content,
        channelId,
        guildId,
        author: {
            id:          authorId,
            username:    authorUsername,
            displayName: authorDisplayName,
        } as User,
        createdAt,
        attachments: {
            values: () => buildAttachmentsMap(attachments).values(),
        } as unknown as Collection<string, { url: string, name: string | null, contentType: string | null }>,
        embeds:    embedsArray,
        reactions: {
            cache: {
                values: () => buildReactionsMap(reactions).values(),
            },
        },
        reference: replyToId ? { messageId: replyToId } : null,
    } as unknown as Message;
}

/**
 * Creates a mock Discord client with channel access.
 */
function createMockClient(channels: Map<string, TextChannel | null>): Client {
    return {
        channels: {
            fetch: mock(async (channelId: string) => {
                if(!channels.has(channelId)) {
                    throw new Error(`Channel ${channelId} not found`);
                }
                return channels.get(channelId);
            }),
        },
    } as unknown as Client;
}

/**
 * Creates a mock text channel with message fetching.
 */
function createMockChannel(
    channelId: string,
    messages: Message[],
    fetchBehavior?: (options: { limit?: number, before?: string }) => Message[]
): TextChannel {
    const defaultFetchBehavior = (options: { limit?: number, before?: string }) => {
        const limit = options.limit ?? 100;
        let result = messages;

        if(options.before) {
            const beforeIdx = findIndex(messages, ['id', options.before]);
            if(beforeIdx > 0) {
                result = messages.slice(0, beforeIdx);
            } else if(beforeIdx === -1) {
                // before snowflake is smaller than all messages, filter by snowflake comparison
                result = filter(messages, m => BigInt(m.id) < BigInt(options.before!));
            }
        }

        // Return messages in descending order (newest first) and limit
        return result.slice(-limit).toReversed();
    };

    const fetch = fetchBehavior ?? defaultFetchBehavior;

    const mockCollection = (msgs: Message[]): Collection<string, Message> => {
        const msgMap = new Map<string, Message>();
        for(const m of msgs) {
            msgMap.set(m.id, m);
        }
        return {
            values:            () => msgMap.values(),
            size:              msgMap.size,
            first:             () => (msgs.length > 0 ? msgs[0] : undefined),
            last:              () => (msgs.length > 0 ? msgs[msgs.length - 1] : undefined),
            [Symbol.iterator]: () => msgMap.values(),
        } as unknown as Collection<string, Message>;
    };

    return {
        id:          channelId,
        isTextBased: constant(true),
        messages:    {
            fetch: mock(async (options: { limit?: number, before?: string } | string) => {
                // Handle single message fetch by ID
                if(isString(options)) {
                    const msg = find(messages, ['id', options]);
                    if(!msg) {
                        throw new Error(`Message ${options} not found`);
                    }
                    return msg;
                }
                const result = fetch(options);
                return mockCollection(result);
            }),
        },
    } as unknown as TextChannel;
}

describe.concurrent('createMessageFetcher', () => {
    describe('fetchMessages', () => {
        describe('message transformation', () => {
            test('should transform message to DiscordSearchResult format', async () => {
                const message = createMockMessage({
                    id:                '100000000000000000',
                    content:           'Test content',
                    channelId:         '123456789012345678',
                    guildId:           '987654321098765432',
                    authorId:          '111111111111111111',
                    authorUsername:    'testuser',
                    authorDisplayName: 'Test User',
                    createdAt:         new Date('2025-01-15T12:00:00.000Z'),
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                const searchResult = result.messages[0];
                expect(searchResult.id).toBe('100000000000000000');
                expect(searchResult.channelId).toBe(createChannelId('123456789012345678'));
                expect(searchResult.guildId).toBe(createGuildId('987654321098765432'));
                expect(searchResult.author.id).toBe('111111111111111111');
                expect(searchResult.author.username).toBe('testuser');
                expect(searchResult.author.displayName).toBe('Test User');
                expect(searchResult.content).toBe('Test content');
                expect(searchResult.timestamp).toBe('2025-01-15T12:00:00.000Z');
            });

            test('should handle DM messages with null guildId', async () => {
                const message = createMockMessage({
                    id:      '100000000000000000',
                    guildId: null,
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].guildId).toBeNull();
            });

            test('should NOT include contentType in attachment when attachment.contentType is null', async () => {
                // This test specifically targets the mutant that changes
                // `if(attachment.contentType)` to `if(true)` at line 92.
                const message = createMockMessage({
                    id:          '100000000000000000',
                    attachments: [
                        { url: 'https://cdn.discord.com/file.bin', name: 'file.bin', contentType: null },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].attachments).toHaveLength(1);
                expect(result.messages[0].attachments[0]).toEqual({
                    url:      'https://cdn.discord.com/file.bin',
                    filename: 'file.bin',
                });
                expect('contentType' in result.messages[0].attachments[0]).toBe(false);
                expect(has(result.messages[0].attachments[0], 'contentType')).toBe(false);
            });

            test('should NOT include title in embed when embed.title is null', async () => {
                // This test specifically targets the mutant that changes
                // `if(embed.title)` to `if(true)` at line 99.
                const message = createMockMessage({
                    id:     '100000000000000000',
                    embeds: [
                        { title: null, description: 'Description only', url: null },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].embeds).toHaveLength(1);
                expect(result.messages[0].embeds[0]).toEqual({ description: 'Description only' });
                expect('title' in result.messages[0].embeds[0]).toBe(false);
                expect('url' in result.messages[0].embeds[0]).toBe(false);
                expect(has(result.messages[0].embeds[0], 'title')).toBe(false);
            });

            test('should use "unnamed" as filename when attachment.name is null', async () => {
                // This test specifically targets the mutant that changes
                // `attachment.name ?? 'unnamed'` to `attachment.name ?? ''` at line 91.
                const message = createMockMessage({
                    id:          '100000000000000000',
                    attachments: [
                        { url: 'https://cdn.discord.com/file.bin', name: null, contentType: 'application/octet-stream' },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].attachments).toHaveLength(1);
                expect(result.messages[0].attachments[0].filename).toBe('unnamed');
                expect(result.messages[0].attachments[0].url).toBe('https://cdn.discord.com/file.bin');
                expect(result.messages[0].attachments[0].contentType).toBe('application/octet-stream');
            });
        });

        describe('embed field transformation', () => {
            test('should include title in embed when embed.title is set', async () => {
                // Kills BlockStatement mutant on if(embed.title) body — no test ever executed this code path
                const message = createMockMessage({
                    id:     '100000000000000000',
                    embeds: [
                        { title: 'My Embed Title', description: 'Description', url: null },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].embeds).toHaveLength(1);
                expect(result.messages[0].embeds[0].title).toBe('My Embed Title');
                expect(result.messages[0].embeds[0].description).toBe('Description');
            });

            test('should include url in embed when embed.url is set', async () => {
                // Kills BlockStatement mutant on if(embed.url) body — no test ever executed this code path
                const message = createMockMessage({
                    id:     '100000000000000001',
                    embeds: [
                        { title: null, description: 'Description', url: 'https://example.com/page' },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].embeds).toHaveLength(1);
                expect(result.messages[0].embeds[0].url).toBe('https://example.com/page');
                expect(result.messages[0].embeds[0].description).toBe('Description');
            });

            test('should include both title and url when both are set', async () => {
                const message = createMockMessage({
                    id:     '100000000000000002',
                    embeds: [
                        { title: 'Full Embed', description: 'Desc', url: 'https://example.com' },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].embeds[0].title).toBe('Full Embed');
                expect(result.messages[0].embeds[0].url).toBe('https://example.com');
                expect(result.messages[0].embeds[0].description).toBe('Desc');
            });
        });

        describe('reaction transformation', () => {
            test('should include reactions when message has reactions', async () => {
                // Kills BlockStatement mutant on the reactions loop body — no test ever executed this code path
                const message = createMockMessage({
                    id:        '100000000000000003',
                    reactions: [
                        { emoji: '👍', count: 3 },
                        { emoji: '❤️', count: 1 },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].reactions).toHaveLength(2);
                expect(result.messages[0].reactions[0].emoji).toBe('👍');
                expect(result.messages[0].reactions[0].count).toBe(3);
                expect(result.messages[0].reactions[1].emoji).toBe('❤️');
                expect(result.messages[0].reactions[1].count).toBe(1);
            });

            test('should have empty reactions array when no reactions', async () => {
                const message = createMockMessage({
                    id:        '100000000000000004',
                    reactions: [],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].reactions).toHaveLength(0);
                expect(result.messages[0].reactions).toEqual([]);
            });
        });

        describe('reply reference transformation', () => {
            test('should include replyTo when message is a reply', async () => {
                // Kills BlockStatement mutant on if(message.reference?.messageId) body
                const message = createMockMessage({
                    id:        '100000000000000005',
                    replyToId: '999999999999999999',
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].replyTo).toBe('999999999999999999');
            });

            test('should not have replyTo when message is not a reply', async () => {
                const message = createMockMessage({
                    id:        '100000000000000006',
                    replyToId: null,
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].replyTo).toBeUndefined();
            });
        });

        describe('pagination', () => {
            test('should paginate when fetching more than 100 messages', async () => {
                const messages: Message[] = [];
                for(let i = 0; i < 150; i++) {
                    messages.push(createMockMessage({
                        id:      (100_000_000_000_000_000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCallCount++;
                    const limit = options.limit ?? 100;
                    let result = [...messages];

                    if(options.before) {
                        result = filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }

                    return result.slice(-limit).toReversed();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    limit:     150,
                });

                expect(result.messages).toHaveLength(150);
                expect(fetchCallCount).toBeGreaterThanOrEqual(2);
            });

            test('should use before parameter correctly for pagination', async () => {
                const messages = [
                    createMockMessage({ id: '100000000000000000', content: 'First' }),
                    createMockMessage({ id: '100000000000000001', content: 'Second' }),
                    createMockMessage({ id: '100000000000000002', content: 'Third' }),
                ];

                const fetchCalls: { before?: string }[] = [];
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCalls.push({ before: options.before });
                    // Return all messages on first call, empty on subsequent
                    if(!options.before) {
                        return messages.toReversed();
                    }
                    return [];
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(fetchCalls[0].before).toBeUndefined();
            });

            test('should update cursor to last message ID for subsequent fetch when paginating', async () => {
                // This tests the cursor assignment block at line 272-273
                const messages: Message[] = [];
                for(let i = 0; i < 150; i++) {
                    messages.push(createMockMessage({
                        id:      (100_000_000_000_000_000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                const fetchCalls: { before?: string, limit?: number }[] = [];
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCalls.push({ before: options.before, limit: options.limit });
                    const limit = options.limit ?? 100;
                    let result = [...messages];

                    if(options.before) {
                        result = filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }

                    return result.slice(-limit).toReversed();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    limit:     150,
                });

                expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
                expect(fetchCalls[0].before).toBeUndefined();
                expect(fetchCalls[1].before).toBeDefined();
                expect(BigInt(fetchCalls[1].before!)).toBeLessThan(BigInt(fetchCalls[0].before ?? '100000000000000150'));
            });

            test('should stop fetching when batch returns empty', async () => {
                // This tests the empty batch break block at line 252-254
                const messages: Message[] = [];
                for(let i = 0; i < 100; i++) {
                    messages.push(createMockMessage({
                        id:      (100_000_000_000_000_000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', messages, (_options) => {
                    fetchCallCount++;
                    if(fetchCallCount === 1) {
                        return [...messages].toReversed();
                    }
                    return [];
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678', limit: 1000 });

                expect(result.messages).toHaveLength(100);
                expect(fetchCallCount).toBe(2);
            });

            test('should respect limit parameter', async () => {
                const messages: Message[] = [];
                for(let i = 0; i < 50; i++) {
                    messages.push(createMockMessage({
                        id:      (100_000_000_000_000_000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                const channel = createMockChannel('123456789012345678', messages);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    limit:     10,
                });

                expect(result.messages).toHaveLength(10);
            });

            test('should set hasMore to true when more messages exist', async () => {
                const messages: Message[] = [];
                for(let i = 0; i < 50; i++) {
                    messages.push(createMockMessage({
                        id: (100_000_000_000_000_000n + BigInt(i)).toString(),
                    }));
                }

                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    const limit = options.limit ?? 100;
                    return messages.slice(0, limit).toReversed();
                });
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    limit:     10,
                });

                expect(result.hasMore).toBe(true);
            });

            test('should set hasMore to false when all messages fetched', async () => {
                const messages = [
                    createMockMessage({ id: '100000000000000000' }),
                    createMockMessage({ id: '100000000000000001' }),
                ];

                const channel = createMockChannel('123456789012345678', messages, () => {
                    return messages.toReversed();
                });
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    limit:     100,
                });

                expect(result.hasMore).toBe(false);
            });

            test('should calculate remaining messages correctly when paginating', async () => {
                // This test kills mutants on lines 255 and 263:
                // - Line 255: Math.min(100, Math.max(1, maxMessages - allMessages.length))
                // - Line 263: maxMessages - allMessages.length
                const messages: Message[] = [];
                for(let i = 0; i < 150; i++) {
                    messages.push(createMockMessage({
                        id:      (100_000_000_000_000_000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                const fetchCalls: { limit: number }[] = [];
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCalls.push({ limit: options.limit ?? 100 });
                    const limit = options.limit ?? 100;
                    let result = [...messages];

                    if(options.before) {
                        result = filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }

                    return result.slice(-limit).toReversed();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    limit:     125,
                });

                expect(result.messages).toHaveLength(125);
                expect(fetchCalls[0].limit).toBe(100);
                expect(fetchCalls[1].limit).toBe(25);
            });

            test('should return messages in chronological order (oldest first)', async () => {
                const messages = [
                    createMockMessage({ id: '100000000000000000', content: 'First' }),
                    createMockMessage({ id: '100000000000000001', content: 'Second' }),
                    createMockMessage({ id: '100000000000000002', content: 'Third' }),
                ];

                const channel = createMockChannel('123456789012345678', messages);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].content).toBe('First');
                expect(result.messages[1].content).toBe('Second');
                expect(result.messages[2].content).toBe('Third');
            });
        });

        describe('time range filtering', () => {
            test('should filter by startTime using snowflake conversion', async () => {
                const oldDate = new Date('2020-01-01T00:00:00.000Z');
                const newDate = new Date('2025-01-01T00:00:00.000Z');

                const oldSnowflake = timestampToSnowflake(oldDate);
                const newSnowflake = timestampToSnowflake(newDate);

                const messages = [
                    createMockMessage({ id: oldSnowflake, createdAt: oldDate, content: 'Old message' }),
                    createMockMessage({ id: newSnowflake, createdAt: newDate, content: 'New message' }),
                ];

                const channel = createMockChannel('123456789012345678', messages);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: new Date('2024-01-01T00:00:00.000Z'),
                });

                expect(every(result.messages, m =>
                    new Date(m.timestamp) >= new Date('2024-01-01T00:00:00.000Z')
                )).toBe(true);
            });

            test('should include message when ID equals afterSnowflake exactly (boundary test)', async () => {
                const boundaryDate = new Date('2025-01-15T00:00:00.000Z');
                const boundarySnowflake = timestampToSnowflake(boundaryDate);

                const olderSnowflake = (BigInt(boundarySnowflake) - 1n).toString();
                const newerSnowflake = (BigInt(boundarySnowflake) + 1n).toString();

                const messages = [
                    createMockMessage({
                        id:        olderSnowflake,
                        content:   'Before boundary',
                        createdAt: new Date(boundaryDate.getTime() - 1000),
                    }),
                    createMockMessage({
                        id:        boundarySnowflake,
                        content:   'At boundary',
                        createdAt: boundaryDate,
                    }),
                    createMockMessage({
                        id:        newerSnowflake,
                        content:   'After boundary',
                        createdAt: new Date(boundaryDate.getTime() + 1000),
                    }),
                ];

                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    let result = [...messages];
                    if(options.before) {
                        result = filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }
                    return result.toReversed();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: boundaryDate,
                });

                expect(some(result.messages, ['id', boundarySnowflake])).toBe(true);
                expect(some(result.messages, ['id', newerSnowflake])).toBe(true);
                expect(some(result.messages, ['id', olderSnowflake])).toBe(false);
            });

            test('should stop pagination loop when shouldStop is set to true by processBatch', async () => {
                // This test specifically targets the mutant that changes `shouldStop = true` to
                // `shouldStop = false` at line 219.
                const boundaryDate = new Date('2025-01-15T00:00:00.000Z');
                const boundarySnowflake = timestampToSnowflake(boundaryDate);

                const messages: Message[] = [];

                for(let i = 0; i < 50; i++) {
                    const snowflake = (BigInt(boundarySnowflake) - BigInt(50 - i)).toString();
                    messages.push(createMockMessage({
                        id:        snowflake,
                        content:   `Before ${i}`,
                        createdAt: new Date(boundaryDate.getTime() - (50 - i) * 1000),
                    }));
                }

                for(let i = 0; i < 50; i++) {
                    const snowflake = (BigInt(boundarySnowflake) + BigInt(i)).toString();
                    messages.push(createMockMessage({
                        id:        snowflake,
                        content:   `After ${i}`,
                        createdAt: new Date(boundaryDate.getTime() + i * 1000),
                    }));
                }

                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCallCount++;
                    const limit = options.limit ?? 100;
                    let result = [...messages];

                    if(options.before) {
                        result = filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }

                    return result.slice(-limit).toReversed();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: boundaryDate,
                });

                expect(result.messages).toHaveLength(50);
                expect(fetchCallCount).toBe(1);
            });
        });

        describe('error handling', () => {
            test('should throw ChannelNotAccessibleError when channel not found', async () => {
                const channels = new Map<string, TextChannel>();
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: 'nonexistent' });
                    expect(true).toBe(false);
                } catch (error) {
                    expect(error).toBeInstanceOf(ChannelNotAccessibleError);
                }
            });

            test('should throw ChannelNotAccessibleError when channel fetch returns null', async () => {
                const channels = new Map<string, TextChannel | null>([['123456789012345678', null]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: '123456789012345678' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ChannelNotAccessibleError);
                }
            });

            test('should rethrow ChannelNotAccessibleError from fetchMessages loop when thrown during message fetch', async () => {
                const channel = {
                    id:          '123456789012345678',
                    isTextBased: constant(true),
                    messages:    {
                        fetch: mock(async () => {
                            throw new ChannelNotAccessibleError('123456789012345678');
                        }),
                    },
                } as unknown as TextChannel;

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: '123456789012345678' });
                    expect(true).toBe(false);
                } catch (error) {
                    expect(error).toBeInstanceOf(ChannelNotAccessibleError);
                    expect((error as ChannelNotAccessibleError).context.channelId).toBe('123456789012345678');
                    expect(error).not.toBeInstanceOf(MessageFetchError);
                }
            });

            test('should use "Unknown error" as reason when non-Error value is thrown', async () => {
                const channel = {
                    id:          '123456789012345678',
                    isTextBased: constant(true),
                    messages:    {
                        fetch: mock(async () => {
                            throw 'network failure';
                        }),
                    },
                } as unknown as TextChannel;

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: '123456789012345678' });
                    expect(true).toBe(false);
                } catch (error) {
                    expect(error).toBeInstanceOf(MessageFetchError);
                    expect((error as MessageFetchError).message).toContain('Unknown error');
                }
            });
        });
    });

    describe('fetchById', () => {
        test('should fetch a single message by ID', async () => {
            const message = createMockMessage({
                id:      '100000000000000000',
                content: 'Specific message',
            });

            const channel = createMockChannel('123456789012345678', [message]);
            const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
            const client = createMockClient(channels);

            const fetcher = createMessageFetcher(client);
            const result = await fetcher.fetchById('123456789012345678', '100000000000000000');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('100000000000000000');
            expect(result!.content).toBe('Specific message');
        });

        test('should return null when message not found', async () => {
            const channel = {
                id:          '123456789012345678',
                isTextBased: constant(true),
                messages:    {
                    fetch: mock(async (id: string) => {
                        throw new Error(`Message ${id} not found`);
                    }),
                },
            } as unknown as TextChannel;

            const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
            const client = createMockClient(channels);

            const fetcher = createMessageFetcher(client);
            const result = await fetcher.fetchById('123456789012345678', 'nonexistent');

            expect(result).toBeNull();
        });
    });

    describe('fetchByIds', () => {
        test('should fetch multiple messages in batch', async () => {
            const messages = [
                createMockMessage({ id: '100000000000000001', content: 'First message' }),
                createMockMessage({ id: '100000000000000002', content: 'Second message' }),
                createMockMessage({ id: '100000000000000003', content: 'Third message' }),
            ];

            const channel = {
                id:          '123456789012345678',
                isTextBased: constant(true),
                messages:    {
                    fetch: mock(async (messageId: string) => {
                        const msg = find(messages, ['id', messageId]);
                        if(!msg) {
                            throw new Error('Not found');
                        }
                        return msg;
                    }),
                },
            } as unknown as TextChannel;

            const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
            const client = createMockClient(channels);

            const fetcher = createMessageFetcher(client);
            const result = await fetcher.fetchByIds('123456789012345678', ['100000000000000001', '100000000000000002', '100000000000000003']);

            expect(result).toHaveLength(3);
            expect(result[0].content).toBe('First message');
            expect(result[1].content).toBe('Second message');
            expect(result[2].content).toBe('Third message');
        });

        test('should filter out messages that fail to fetch (missing IDs)', async () => {
            const messages = [
                createMockMessage({ id: '100000000000000001', content: 'First message' }),
                createMockMessage({ id: '100000000000000002', content: 'Second message' }),
            ];

            const channel = {
                id:          '123456789012345678',
                isTextBased: constant(true),
                messages:    {
                    fetch: mock(async (messageId: string) => {
                        const msg = find(messages, ['id', messageId]);
                        if(!msg) {
                            throw new Error('Not found');
                        }
                        return msg;
                    }),
                },
            } as unknown as TextChannel;

            const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
            const client = createMockClient(channels);

            const fetcher = createMessageFetcher(client);
            const result = await fetcher.fetchByIds('123456789012345678', ['100000000000000001', '100000000000000002', '100000000000000003']);

            expect(result).toHaveLength(2);
            expect(result[0].content).toBe('First message');
            expect(result[1].content).toBe('Second message');
        });
    });
});

describe('ChannelNotAccessibleError', () => {
    test('should store channel ID and have correct error code', () => {
        const error = new ChannelNotAccessibleError('123456789012345678');
        expect(error).toBeInstanceOf(Error);
        expect(error.context.channelId).toBe('123456789012345678');
        expect(error.code).toBe(ErrorCode.CHANNEL_NOT_ACCESSIBLE);
    });
});

describe('MessageFetchError', () => {
    test('should store channel ID and reason with correct error code', () => {
        const error = new MessageFetchError('123456789012345678', 'Network timeout');
        expect(error).toBeInstanceOf(Error);
        expect(error.context.channelId).toBe('123456789012345678');
        expect(error.message).toContain('Network timeout');
        expect(error.code).toBe(ErrorCode.MESSAGE_FETCH_ERROR);
    });
});
