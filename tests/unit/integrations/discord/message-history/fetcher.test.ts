import _ from 'lodash';
import { describe, it, expect, mock } from 'bun:test';
import type { Client, TextChannel, Message, Collection, User } from 'discord.js';
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
function buildAttachmentsMap(attachments: { url: string, name: string, contentType?: string | null }[]): Map<string, { url: string, name: string, contentType: string | null }> {
    const attachmentMap = new Map<string, { url: string, name: string, contentType: string | null }>();
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
            emoji: { toString: _.constant(r.emoji) },
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
    attachments?:       { url: string, name: string, contentType?: string | null }[]
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
    const embedsArray = _.map(embeds, e => ({
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
        } as unknown as Collection<string, { url: string, name: string, contentType: string | null }>,
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
            const beforeIdx = _.findIndex(messages, ['id', options.before]);
            if(beforeIdx > 0) {
                result = messages.slice(0, beforeIdx);
            } else if(beforeIdx === -1) {
                // before snowflake is smaller than all messages, filter by snowflake comparison
                result = _.filter(messages, m => BigInt(m.id) < BigInt(options.before!));
            }
        }

        // Return messages in descending order (newest first) and limit
        return result.slice(-limit).reverse();
    };

    const fetch = fetchBehavior ?? defaultFetchBehavior;

    const mockCollection = (msgs: Message[]): Collection<string, Message> => {
        const map = new Map<string, Message>();
        for(const m of msgs) {
            map.set(m.id, m);
        }
        return {
            values:            () => map.values(),
            size:              map.size,
            first:             () => (msgs.length > 0 ? msgs[0] : undefined),
            last:              () => (msgs.length > 0 ? msgs[msgs.length - 1] : undefined),
            [Symbol.iterator]: () => map.values(),
        } as unknown as Collection<string, Message>;
    };

    return {
        id:          channelId,
        isTextBased: _.constant(true),
        messages:    {
            fetch: mock(async (options: { limit?: number, before?: string } | string) => {
                // Handle single message fetch by ID
                if(_.isString(options)) {
                    const msg = _.find(messages, ['id', options]);
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

describe('createMessageFetcher', () => {
    describe('fetchMessages', () => {
        describe('basic message fetching', () => {
            it('should fetch messages from a channel', async () => {
                const message = createMockMessage({
                    id:      '100000000000000000',
                    content: 'Hello world',
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages).toHaveLength(1);
                expect(result.messages[0].content).toBe('Hello world');
            });

            it('should transform message to DiscordSearchResult format', async () => {
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

            it('should handle DM messages with null guildId', async () => {
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

            it('should include attachments in transformed message', async () => {
                const message = createMockMessage({
                    id:          '100000000000000000',
                    attachments: [
                        { url: 'https://cdn.discord.com/image.png', name: 'image.png', contentType: 'image/png' },
                        { url: 'https://cdn.discord.com/doc.pdf', name: 'doc.pdf', contentType: 'application/pdf' },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].attachments).toHaveLength(2);
                expect(result.messages[0].attachments[0]).toEqual({
                    url:         'https://cdn.discord.com/image.png',
                    filename:    'image.png',
                    contentType: 'image/png',
                });
            });

            it('should include embeds in transformed message', async () => {
                const message = createMockMessage({
                    id:     '100000000000000000',
                    embeds: [
                        { title: 'Embed Title', description: 'Embed description', url: 'https://example.com' },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].embeds).toHaveLength(1);
                expect(result.messages[0].embeds[0]).toEqual({
                    title:       'Embed Title',
                    description: 'Embed description',
                    url:         'https://example.com',
                });
            });

            it('should NOT include title in embed when embed.title is null', async () => {
                // This test specifically targets the mutant that changes
                // `if(embed.title)` to `if(true)` at line 99.
                // If the mutation survives, the embed would have `title: null`
                // instead of omitting the title property entirely.
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

                // Verify the embed only has description, not title or url
                expect(result.messages[0].embeds).toHaveLength(1);
                expect(result.messages[0].embeds[0]).toEqual({ description: 'Description only' });
                // These assertions catch the `if(true)` mutation which would add null properties
                expect('title' in result.messages[0].embeds[0]).toBe(false);
                expect('url' in result.messages[0].embeds[0]).toBe(false);
                expect(_.has(result.messages[0].embeds[0], 'title')).toBe(false);
            });

            it('should include reactions in transformed message', async () => {
                const message = createMockMessage({
                    id:        '100000000000000000',
                    reactions: [
                        { emoji: '👍', count: 5 },
                        { emoji: '❤️', count: 3 },
                    ],
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].reactions).toHaveLength(2);
                expect(result.messages[0].reactions[0]).toEqual({ emoji: '👍', count: 5 });
                expect(result.messages[0].reactions[1]).toEqual({ emoji: '❤️', count: 3 });
            });

            it('should include replyTo for reply messages', async () => {
                const message = createMockMessage({
                    id:        '100000000000000000',
                    replyToId: '99999999999999999',
                });

                const channel = createMockChannel('123456789012345678', [message]);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages[0].replyTo).toBe('99999999999999999');
            });

            it('should not include replyTo for non-reply messages', async () => {
                const message = createMockMessage({
                    id:        '100000000000000000',
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
            it('should paginate when fetching more than 100 messages', async () => {
                // Create 150 messages with ascending snowflake IDs
                const messages: Message[] = [];
                for(let i = 0; i < 150; i++) {
                    messages.push(createMockMessage({
                        id:      (100000000000000000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCallCount++;
                    const limit = options.limit ?? 100;
                    let result = [...messages];

                    if(options.before) {
                        result = _.filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }

                    // Return in descending order (newest first)
                    return result.slice(-limit).reverse();
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

            it('should use before parameter correctly for pagination', async () => {
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
                        return messages.reverse();
                    }
                    return [];
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(fetchCalls[0].before).toBeUndefined();
            });

            it('should update cursor to last message ID for subsequent fetch when paginating', async () => {
                // This tests the cursor assignment block at line 272-273
                // Create 150 messages to trigger pagination (more than DISCORD_API_MAX_MESSAGES = 100)
                const messages: Message[] = [];
                for(let i = 0; i < 150; i++) {
                    messages.push(createMockMessage({
                        id:      (100000000000000000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                const fetchCalls: { before?: string, limit?: number }[] = [];
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCalls.push({ before: options.before, limit: options.limit });
                    const limit = options.limit ?? 100;
                    let result = [...messages];

                    if(options.before) {
                        result = _.filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }

                    // Return in descending order (newest first)
                    return result.slice(-limit).reverse();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    limit:     150,
                });

                // Should have made at least 2 fetch calls
                expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
                // First call should have no before
                expect(fetchCalls[0].before).toBeUndefined();
                // Second call should have before set to the oldest message ID from first batch
                expect(fetchCalls[1].before).toBeDefined();
                // The cursor should be the oldest message from the previous batch (last in the array returned)
                // With 100 messages descending, the oldest would be at position 100 - so ID ending in 49 (149 - 100)
                expect(BigInt(fetchCalls[1].before!)).toBeLessThan(BigInt(fetchCalls[0].before ?? '100000000000000150'));
            });

            it('should stop fetching when batch returns empty', async () => {
                // This tests the empty batch break block at line 252-254
                // We need:
                // - First batch to return exactly fetchOptions.limit messages (bypasses line 266-268)
                // - First batch messages should not trigger shouldStop from processBatch
                // - Second batch to return empty (triggers break at line 252-254)
                //
                // With limit:10, first batch of 10 messages won't trigger processBatch's shouldStop
                // because allMessages.length (0) + batch messages (10) = 10 which equals maxMessages
                // Wait - that WILL trigger shouldStop!
                //
                // Let's use limit:1000 (larger than 100) so first batch is 100 messages
                // 100 < 1000, so no shouldStop, but batch.size (100) < limit (1000) - that breaks at 266!
                //
                // The only way to reach line 252-254 is:
                // - Large limit (e.g., 1000)
                // - First batch returns exactly 100 (DISCORD_API_MAX_MESSAGES)
                // - Second batch returns 0
                const messages: Message[] = [];
                for(let i = 0; i < 100; i++) {
                    messages.push(createMockMessage({
                        id:      (100000000000000000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', messages, (_options) => {
                    fetchCallCount++;
                    if(fetchCallCount === 1) {
                        // Return all 100 messages (equals limit of 100)
                        return [...messages].reverse();
                    }
                    // Second call returns empty to trigger batch.size === 0 break
                    return [];
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                // Request limit of 1000, first batch will be 100 (DISCORD_API_MAX_MESSAGES)
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678', limit: 1000 });

                // Verify we got messages from first batch
                expect(result.messages).toHaveLength(100);
                // Verify 2 fetch calls: first returns 100, second returns empty (break)
                expect(fetchCallCount).toBe(2);
            });

            it('should not make additional fetch calls after empty batch', async () => {
                // Verify the break statement prevents additional calls
                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', [], (_options) => {
                    fetchCallCount++;
                    return []; // Always empty
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                await fetcher.fetchMessages({ channelId: '123456789012345678' });

                // Only one call should be made since first returns empty
                expect(fetchCallCount).toBe(1);
            });

            it('should respect limit parameter', async () => {
                const messages: Message[] = [];
                for(let i = 0; i < 50; i++) {
                    messages.push(createMockMessage({
                        id:      (100000000000000000n + BigInt(i)).toString(),
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

            it('should set hasMore to true when more messages exist', async () => {
                const messages: Message[] = [];
                for(let i = 0; i < 50; i++) {
                    messages.push(createMockMessage({
                        id: (100000000000000000n + BigInt(i)).toString(),
                    }));
                }

                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    const limit = options.limit ?? 100;
                    // Always return the requested limit to simulate more available
                    return messages.slice(0, limit).reverse();
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

            it('should set hasMore to false when all messages fetched', async () => {
                const messages = [
                    createMockMessage({ id: '100000000000000000' }),
                    createMockMessage({ id: '100000000000000001' }),
                ];

                const channel = createMockChannel('123456789012345678', messages, () => {
                    return messages.reverse();
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
        });

        describe('time range filtering', () => {
            it('should filter by startTime using snowflake conversion', async () => {
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

                // Should only include messages after startTime
                expect(_.every(result.messages, m =>
                    new Date(m.timestamp) >= new Date('2024-01-01T00:00:00.000Z')
                )).toBe(true);
            });

            it('should filter by endTime using snowflake conversion', async () => {
                const oldDate = new Date('2020-01-01T00:00:00.000Z');
                const newDate = new Date('2025-01-01T00:00:00.000Z');

                const oldSnowflake = timestampToSnowflake(oldDate);
                const newSnowflake = timestampToSnowflake(newDate);

                const messages = [
                    createMockMessage({ id: oldSnowflake, createdAt: oldDate, content: 'Old message' }),
                    createMockMessage({ id: newSnowflake, createdAt: newDate, content: 'New message' }),
                ];

                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    // Filter by before parameter (which should be set to endTime snowflake)
                    let result = [...messages];
                    if(options.before) {
                        result = _.filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }
                    return result.reverse();
                });
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    endTime:   new Date('2024-01-01T00:00:00.000Z'),
                });

                // Should only include messages before endTime
                expect(_.every(result.messages, m =>
                    new Date(m.timestamp) <= new Date('2024-01-01T00:00:00.000Z')
                )).toBe(true);
            });

            it('should filter by both startTime and endTime', async () => {
                const dates = [
                    new Date('2020-01-01T00:00:00.000Z'),
                    new Date('2023-06-15T00:00:00.000Z'),
                    new Date('2025-01-01T00:00:00.000Z'),
                ];

                const messages = _.map(dates, (date, i) =>
                    createMockMessage({
                        id:        timestampToSnowflake(date),
                        createdAt: date,
                        content:   `Message ${i}`,
                    })
                );

                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    let result = [...messages];
                    if(options.before) {
                        result = _.filter(result, m => BigInt(m.id) < BigInt(options.before!));
                    }
                    return result.reverse();
                });
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: new Date('2022-01-01T00:00:00.000Z'),
                    endTime:   new Date('2024-01-01T00:00:00.000Z'),
                });

                // Should only include the middle message
                expect(result.messages).toHaveLength(1);
                expect(result.messages[0].content).toBe('Message 1');
            });

            it('should include message when ID equals afterSnowflake exactly (boundary test)', async () => {
                // Tests: BigInt(message.id) < BigInt(afterSnowflake)
                // When message.id === afterSnowflake, condition is false, so message IS included
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
                        result = _.filter(messages, m => BigInt(m.id) < BigInt(options.before!));
                    }
                    return result.reverse();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: boundaryDate, // afterSnowflake = boundarySnowflake
                });

                // Message at boundary should be included (id >= afterSnowflake)
                expect(_.some(result.messages, ['id', boundarySnowflake])).toBe(true);
                // Message after boundary should be included
                expect(_.some(result.messages, ['id', newerSnowflake])).toBe(true);
                // Message before boundary should NOT be included
                expect(_.some(result.messages, ['id', olderSnowflake])).toBe(false);
            });

            it('should stop but NOT include message when ID is less than afterSnowflake', async () => {
                // Tests the < boundary - message with ID less than afterSnowflake triggers stop
                const boundaryDate = new Date('2025-01-15T00:00:00.000Z');
                const boundarySnowflake = timestampToSnowflake(boundaryDate);

                const olderSnowflake = (BigInt(boundarySnowflake) - 1n).toString();

                const messages = [
                    createMockMessage({
                        id:        olderSnowflake,
                        content:   'Before boundary',
                        createdAt: new Date(boundaryDate.getTime() - 1000),
                    }),
                ];

                const channel = createMockChannel('123456789012345678', messages, () => {
                    return messages.reverse();
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: boundaryDate,
                });

                // Message before boundary should NOT be included
                expect(result.messages).toHaveLength(0);
            });
        });

        describe('error handling', () => {
            it('should throw ChannelNotAccessibleError when channel not found', async () => {
                const channels = new Map<string, TextChannel>();
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: 'nonexistent' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ChannelNotAccessibleError);
                }
            });

            it('should rethrow ChannelNotAccessibleError from getChannel when thrown during channel fetch', async () => {
                // This tests the rethrow block at line 184-186
                const client = {
                    channels: {
                        fetch: mock(async () => {
                            throw new ChannelNotAccessibleError('test-channel');
                        }),
                    },
                } as unknown as Client;

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: 'test-channel' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ChannelNotAccessibleError);
                    expect((error as ChannelNotAccessibleError).channelId).toBe('test-channel');
                }
            });

            it('should rethrow ChannelNotAccessibleError from fetchMessages loop when thrown during message fetch', async () => {
                // This tests the rethrow block at line 279-281
                const channel = {
                    id:          '123456789012345678',
                    isTextBased: _.constant(true),
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
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(ChannelNotAccessibleError);
                    expect((error as ChannelNotAccessibleError).channelId).toBe('123456789012345678');
                    // Verify it's NOT wrapped in MessageFetchError
                    expect(error).not.toBeInstanceOf(MessageFetchError);
                }
            });

            it('should throw ChannelNotAccessibleError when channel fetch returns null', async () => {
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

            it('should throw MessageFetchError on generic fetch failure', async () => {
                const channel = {
                    id:          '123456789012345678',
                    isTextBased: _.constant(true),
                    messages:    {
                        fetch: mock(async () => {
                            throw new Error('Network error');
                        }),
                    },
                } as unknown as TextChannel;

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: '123456789012345678' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(MessageFetchError);
                }
            });

            it('should include channel ID in error', async () => {
                const channels = new Map<string, TextChannel>();
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: '123456789012345678' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect((error as ChannelNotAccessibleError).channelId).toBe('123456789012345678');
                }
            });

            it('should use "Unknown error" as reason when non-Error value is thrown', async () => {
                const channel = {
                    id:          '123456789012345678',
                    isTextBased: _.constant(true),
                    messages:    {
                        fetch: mock(async () => {
                            // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw to trigger 'Unknown error' branch
                            throw 'network failure';
                        }),
                    },
                } as unknown as TextChannel;

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);

                try {
                    await fetcher.fetchMessages({ channelId: '123456789012345678' });
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(MessageFetchError);
                    expect((error as MessageFetchError).message).toContain('Unknown error');
                }
            });
        });

        describe('empty results', () => {
            it('should return empty array when no messages exist', async () => {
                const channel = createMockChannel('123456789012345678', []);
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages).toHaveLength(0);
                expect(result.hasMore).toBe(false);
            });

            it('should return empty array when time range matches no messages', async () => {
                const messages = [
                    createMockMessage({
                        id:        timestampToSnowflake(new Date('2020-01-01T00:00:00.000Z')),
                        createdAt: new Date('2020-01-01T00:00:00.000Z'),
                    }),
                ];

                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    if(options.before) {
                        return [];
                    }
                    return messages;
                });
                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: new Date('2025-01-01T00:00:00.000Z'),
                });

                expect(result.messages).toHaveLength(0);
            });
        });

        describe('message ordering', () => {
            it('should return messages in chronological order (oldest first)', async () => {
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

        describe('pagination loop conditionals', () => {
            it('should NOT include before parameter on first fetch when cursor is undefined', async () => {
                const messages = [
                    createMockMessage({ id: '100000000000000000', content: 'First' }),
                ];

                const fetchCalls: { limit?: number, before?: string }[] = [];
                const channel = createMockChannel('123456789012345678', messages, (options) => {
                    fetchCalls.push({ ...options });
                    return messages;
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                await fetcher.fetchMessages({ channelId: '123456789012345678' });

                // First fetch should NOT have 'before' key at all
                expect('before' in fetchCalls[0]).toBe(false);
            });

            it('should terminate loop immediately when batch returns zero messages', async () => {
                // Return empty batch on first call - loop should terminate immediately
                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', [], (_options) => {
                    fetchCallCount++;
                    if(fetchCallCount > 1) {
                        throw new Error('Should not fetch more than once when batch is empty');
                    }
                    // Return empty array (simulating batch.size === 0)
                    return [];
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678' });

                expect(result.messages).toHaveLength(0);
                expect(fetchCallCount).toBe(1);
            });

            it('should terminate loop when batch has size 0 even during pagination', async () => {
                // To test the batch.size === 0 break during pagination:
                // - First batch must return exactly DISCORD_API_MAX_MESSAGES (100) messages
                // - This ensures batch.size == limit, so we don't break at "fewer than limit" check
                // - Second batch returns 0 to trigger the break at line 252-254
                const messages: Message[] = [];
                for(let i = 0; i < 100; i++) {
                    messages.push(createMockMessage({
                        id:      (100000000000000000n + BigInt(i)).toString(),
                        content: `Message ${i}`,
                    }));
                }

                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', messages, (_options) => {
                    fetchCallCount++;
                    // First call: return all 100 messages
                    // Second call: return empty (batch.size === 0)
                    if(fetchCallCount === 1) {
                        return [...messages].reverse();
                    }
                    return [];
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                // Use limit of 1000 so first batch (100) is less than limit but equals DISCORD_API_MAX_MESSAGES
                const result = await fetcher.fetchMessages({ channelId: '123456789012345678', limit: 1000 });

                // Should have stopped after empty batch on second call
                expect(fetchCallCount).toBe(2);
                expect(result.messages).toHaveLength(100);
            });

            it('should terminate loop when lastMessage is undefined after spread', async () => {
                // This tests the edge case where batch.values() returns an empty iterator
                // after all messages are filtered out by afterSnowflake
                const messages = [
                    createMockMessage({ id: '100000000000000000', content: 'Old message' }),
                ];

                let fetchCallCount = 0;
                const channel = createMockChannel('123456789012345678', messages, () => {
                    fetchCallCount++;
                    if(fetchCallCount > 2) {
                        throw new Error('Should not fetch more than twice');
                    }
                    // Return messages but they'll be filtered by afterSnowflake
                    return messages;
                });

                const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
                const client = createMockClient(channels);

                const fetcher = createMessageFetcher(client);
                // Use startTime after all messages - this exercises the filtering
                const result = await fetcher.fetchMessages({
                    channelId: '123456789012345678',
                    startTime: new Date('2030-01-01T00:00:00.000Z'),
                });

                // Should have completed without infinite loop
                expect(result.messages).toHaveLength(0);
            });
        });
    });

    describe('fetchById', () => {
        it('should fetch a single message by ID', async () => {
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

        it('should return null when message not found', async () => {
            const channel = {
                id:          '123456789012345678',
                isTextBased: _.constant(true),
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

        it('should throw ChannelNotAccessibleError when channel not found', async () => {
            const channels = new Map<string, TextChannel>();
            const client = createMockClient(channels);

            const fetcher = createMessageFetcher(client);

            try {
                await fetcher.fetchById('nonexistent', '100000000000000000');
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(ChannelNotAccessibleError);
            }
        });

        it('should transform single message to DiscordSearchResult format', async () => {
            const message = createMockMessage({
                id:                '100000000000000000',
                content:           'Test',
                channelId:         '123456789012345678',
                guildId:           '987654321098765432',
                authorId:          '111111111111111111',
                authorUsername:    'user',
                authorDisplayName: 'User Name',
                createdAt:         new Date('2025-01-15T12:00:00.000Z'),
                attachments:       [{ url: 'https://test.com/file.png', name: 'file.png' }],
                embeds:            [{ title: 'Title' }],
                reactions:         [{ emoji: '👍', count: 1 }],
                replyToId:         '99999999999999999',
            });

            const channel = createMockChannel('123456789012345678', [message]);
            const channels = new Map<string, TextChannel>([['123456789012345678', channel]]);
            const client = createMockClient(channels);

            const fetcher = createMessageFetcher(client);
            const result = await fetcher.fetchById('123456789012345678', '100000000000000000');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('100000000000000000');
            expect(result!.channelId).toBe(createChannelId('123456789012345678'));
            expect(result!.guildId).toBe(createGuildId('987654321098765432'));
            expect(result!.author.id).toBe('111111111111111111');
            expect(result!.author.username).toBe('user');
            expect(result!.author.displayName).toBe('User Name');
            expect(result!.content).toBe('Test');
            expect(result!.timestamp).toBe('2025-01-15T12:00:00.000Z');
            expect(result!.attachments).toHaveLength(1);
            expect(result!.embeds).toHaveLength(1);
            expect(result!.reactions).toHaveLength(1);
            expect(result!.replyTo).toBe('99999999999999999');
        });
    });
});

describe('ChannelNotAccessibleError', () => {
    it('should be an instance of Error', () => {
        const error = new ChannelNotAccessibleError('123456789012345678');
        expect(error).toBeInstanceOf(Error);
    });

    it('should have correct name', () => {
        const error = new ChannelNotAccessibleError('123456789012345678');
        expect(error.name).toBe('ChannelNotAccessibleError');
    });

    it('should include channel ID in message', () => {
        const error = new ChannelNotAccessibleError('123456789012345678');
        expect(error.message).toContain('123456789012345678');
    });

    it('should store channel ID', () => {
        const error = new ChannelNotAccessibleError('123456789012345678');
        expect(error.channelId).toBe('123456789012345678');
    });

    it('should have correct error code', () => {
        const error = new ChannelNotAccessibleError('123456789012345678');
        expect(error.code).toBe('CHANNEL_NOT_ACCESSIBLE');
    });
});

describe('MessageFetchError', () => {
    it('should be an instance of Error', () => {
        const error = new MessageFetchError('123456789012345678', 'Test error');
        expect(error).toBeInstanceOf(Error);
    });

    it('should have correct name', () => {
        const error = new MessageFetchError('123456789012345678', 'Test error');
        expect(error.name).toBe('MessageFetchError');
    });

    it('should include channel ID in message', () => {
        const error = new MessageFetchError('123456789012345678', 'Test error');
        expect(error.message).toContain('123456789012345678');
    });

    it('should include reason in message', () => {
        const error = new MessageFetchError('123456789012345678', 'Network timeout');
        expect(error.message).toContain('Network timeout');
    });

    it('should store channel ID', () => {
        const error = new MessageFetchError('123456789012345678', 'Test');
        expect(error.channelId).toBe('123456789012345678');
    });

    it('should have correct error code', () => {
        const error = new MessageFetchError('123456789012345678', 'Test');
        expect(error.code).toBe('MESSAGE_FETCH_ERROR');
    });
});
