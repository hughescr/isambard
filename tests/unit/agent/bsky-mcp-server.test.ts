import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createBskyMCPServer } from '../../../src/agent/bsky-mcp-server';
import type { BskyAllowlist, BskyCheckpointManager } from '../../../src/integrations/bsky';
import type { BlueskyClient } from '../../../src/integrations/bsky/client';
import type { BskyEmbeddedRecord } from '../../../src/integrations/bsky/embeds';
import type { BskyRejectionBackend, BskyRejectionItem } from '../../../src/integrations/bsky/rejection-backend';
import type { BskyAuthor, BskyConversation, BskyDirectMessage, BskyFeedItem, BskyNotification, BskyPost } from '../../../src/integrations/bsky/types';
import type { SendRateLimiter } from '../../../src/integrations/email';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

// Helpers to build test data

const mockAuthor = (): BskyAuthor => ({
    did:         'did:plc:abc123',
    handle:      'alice.bsky.social',
    displayName: 'Alice',
});

const mockPost = (overrides: Partial<BskyPost> = {}): BskyPost => ({
    uri:         'at://did:plc:abc123/app.bsky.feed.post/xyz',
    cid:         'bafyreiabc',
    author:      mockAuthor(),
    text:        'Hello Bluesky!',
    createdAt:   '2025-01-01T00:00:00.000Z',
    replyCount:  0,
    likeCount:   0,
    repostCount: 0,
    indexedAt:   '2025-01-01T00:00:01.000Z',
    ...overrides,
});

const mockFeedItem = (overrides: Partial<BskyFeedItem> = {}): BskyFeedItem => ({
    post: mockPost(),
    ...overrides,
});

const mockNotification = (overrides: Partial<BskyNotification> = {}): BskyNotification => ({
    reason:    'like',
    uri:       'at://did:plc:abc123/app.bsky.feed.post/xyz',
    author:    mockAuthor(),
    indexedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
});

const mockDirectMessage = (overrides: Partial<BskyDirectMessage> = {}): BskyDirectMessage => ({
    id:        'msg-1',
    rev:       'rev-1',
    text:      'Hello there!',
    senderDid: 'did:plc:abc123',
    sentAt:    '2025-01-01T00:00:00.000Z',
    ...overrides,
});

const mockConversation = (overrides: Partial<BskyConversation> = {}): BskyConversation => ({
    id:          'convo-1',
    rev:         'rev-1',
    members:     [{ did: 'did:plc:abc123', handle: 'alice.bsky.social', displayName: 'Alice' }],
    muted:       false,
    unreadCount: 0,
    ...overrides,
});

describe.concurrent('createBskyMCPServer', () => {
    let mockClient: BlueskyClient;

    beforeEach(() => {
        mockClient = {
            getFeed:                   mock(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({ items: [mockFeedItem()], cursor: 'cursor-abc' })),
            getNotifications:          mock(async (): Promise<{ notifications: BskyNotification[], cursor?: string }> => ({ notifications: [mockNotification()], cursor: 'notif-cursor' })),
            searchPosts:               mock(async (): Promise<{ posts: BskyPost[], cursor?: string }> => ({ posts: [mockPost()], cursor: 'search-cursor' })),
            getPost:                   mock(async (): Promise<BskyPost> => mockPost()),
            getProfile:                mock(async (): Promise<BskyAuthor> => mockAuthor()),
            getAuthorFeed:             mock(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({ items: [mockFeedItem()], cursor: 'author-cursor' })),
            likePost:                  mock(async (): Promise<void> => { /* intentionally empty */ }),
            follow:                    mock(async (): Promise<{ alreadyFollowing: boolean }> => ({ alreadyFollowing: false })),
            unfollow:                  mock(async (): Promise<{ wasFollowing: boolean }> => ({ wasFollowing: true })),
            validatePostText:          mock(async (): Promise<void> => { /* intentionally empty */ }),
            validateDMText:            mock(async (): Promise<void> => { /* intentionally empty */ }),
            sendPost:                  mock(async (): Promise<{ uri: string, cid: string }> => ({ uri: 'at://did:plc:abc123/app.bsky.feed.post/newpost', cid: 'bafyreinew' })),
            replyToPost:               mock(async (): Promise<{ uri: string, cid: string }> => ({ uri: 'at://did:plc:abc123/app.bsky.feed.post/newreply', cid: 'bafyreireply' })),
            updateNotificationsSeen:   mock(async (): Promise<void> => { /* intentionally empty */ }),
            listConversations:         mock(async (): Promise<{ conversations: BskyConversation[], cursor?: string }> => ({ conversations: [mockConversation()], cursor: undefined })),
            getConversationForMembers: mock(async (): Promise<BskyConversation> => mockConversation()),
            getMessages:               mock(async (): Promise<{ messages: BskyDirectMessage[], cursor?: string }> => ({ messages: [mockDirectMessage()], cursor: undefined })),
            sendDirectMessage:         mock(async (): Promise<BskyDirectMessage> => mockDirectMessage()),
            markConversationRead:      mock(async (): Promise<void> => { /* intentionally empty */ }),
            ownHandle:                 'bot.bsky.social',
        } as unknown as BlueskyClient;
    });

    // Helper to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createBskyMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    describe('createBskyMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createBskyMCPServer({ client: mockClient });

            expect(server).toBeDefined();
            expect(server.name).toBe('bsky');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['getFeed',              'Read a Bluesky feed'],
            ['getNotifications',     'Get recent Bluesky notifications'],
            ['searchPosts',          'Search Bluesky posts'],
            ['getPost',              'Get a Bluesky post by AT URI'],
            ['getProfile',           'Get a Bluesky user profile'],
            ['getAuthorFeed',        "Read a user's recent posts on Bluesky"],
            ['likePost',             'Like a Bluesky post'],
            ['follow',               'Follow a Bluesky user'],
            ['unfollow',             'Unfollow a Bluesky user'],
            ['sendPost',             'Post a new message to Bluesky'],
            ['replyToPost',          'Reply to an existing Bluesky post. If the target author is on the allowlist, sends immediately. Otherwise, requests admin approval via Discord.'],
            ['listConversations',    'List Bluesky direct message conversations'],
            ['getDirectMessages',    'Get direct messages with specific Bluesky users. Automatically marks the conversation as read.'],
            ['sendDirectMessage',    'Send a direct message to Bluesky users. If recipients are on the allowlist, sends immediately. Otherwise, requests admin approval via Discord.'],
            ['listRejectedPosts',    'List Bluesky posts and DMs that were rejected by admin. Shows rejection reason and all parameters needed to retry with revised content.'],
            ['clearRejection',       'Clear a specific rejected post/DM after reviewing it. Use the uuid from listRejectedPosts.'],
            ['clearAllRejections',   'Clear all rejected posts/DMs after reviewing them.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createBskyMCPServer({ client: mockClient });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(registeredTool.description).toBe(expectedDescription);
        });

        test.each([
            ['getFeed',           ['feedName', 'limit', 'cursor', 'includeProcessed']],
            ['getNotifications',  ['limit', 'cursor', 'includeProcessed']],
            ['searchPosts',       ['query', 'limit', 'cursor']],
            ['getPost',           ['uri']],
            ['getProfile',        ['actor']],
            ['getAuthorFeed',     ['actor', 'limit', 'cursor', 'includeProcessed']],
            ['likePost',          ['uri', 'cid']],
            ['follow',            ['actor']],
            ['unfollow',          ['actor']],
            ['sendPost',          ['text']],
            ['replyToPost',       ['text', 'parentUri', 'parentCid', 'rootUri', 'rootCid']],
            ['listConversations',  ['limit', 'cursor', 'readState', 'status']],
            ['getDirectMessages',  ['recipients', 'limit', 'cursor']],
            ['sendDirectMessage',  ['recipients', 'text']],
            ['clearRejection',     ['uuid']],
        ])('should have %s tool with correct input schema fields', (toolName, expectedFields) => {
            const server = createBskyMCPServer({ client: mockClient });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            for(const field of expectedFields) {
                expect(registeredTool.inputSchema.shape[field]).toBeDefined();
            }
        });
    });

    describe('getFeed tool', () => {
        test('should return feed items as JSON', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { items: BskyFeedItem[], cursor: string };
            expect(parsed.items).toHaveLength(1);
            expect(parsed.items[0].post.text).toBe('Hello Bluesky!');
            expect(parsed.cursor).toBe('cursor-abc');
        });

        test('should pass feedName, limit, and cursor to client', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getFeed');

            await handler({ feedName: 'for-you', limit: 10, cursor: 'next-page' });

            expect(mockClient.getFeed).toHaveBeenCalledWith('for-you', 10, 'next-page');
        });

        test('should pass "for-you" as default feedName when not provided', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getFeed');

            await handler({});

            expect(mockClient.getFeed).toHaveBeenCalledWith('for-you', undefined, undefined);
        });

        test('should return error result on client failure', async () => {
            (mockClient.getFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Network error');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Network error');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'string error';
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: string error');
        });
    });

    describe('getNotifications tool', () => {
        test('should return notifications as JSON', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getNotifications');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { notifications: BskyNotification[], cursor: string };
            expect(parsed.notifications).toHaveLength(1);
            expect(parsed.notifications[0].reason).toBe('like');
            expect(parsed.cursor).toBe('notif-cursor');
        });

        test('should pass limit and cursor to client', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getNotifications');

            await handler({ limit: 5, cursor: 'notif-page' });

            expect(mockClient.getNotifications).toHaveBeenCalledWith(5, 'notif-page');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getNotifications as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Auth failed');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getNotifications');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Auth failed');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getNotifications as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 42;
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getNotifications');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: 42');
        });
    });

    describe('searchPosts tool', () => {
        test('should return posts as JSON', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'searchPosts');

            const result = await handler({ query: 'bluesky' });

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { posts: BskyPost[], cursor: string };
            expect(parsed.posts).toHaveLength(1);
            expect(parsed.posts[0].text).toBe('Hello Bluesky!');
            expect(parsed.cursor).toBe('search-cursor');
        });

        test('should pass query, limit, and cursor to client', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'searchPosts');

            await handler({ query: 'test query', limit: 20, cursor: 'search-page' });

            expect(mockClient.searchPosts).toHaveBeenCalledWith('test query', 20, 'search-page');
        });

        test('should return error result on client failure', async () => {
            (mockClient.searchPosts as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Search failed');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'searchPosts');

            const result = await handler({ query: 'test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Search failed');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.searchPosts as ReturnType<typeof mock>).mockImplementation(async () => {
                throw false;
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'searchPosts');

            const result = await handler({ query: 'test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: false');
        });
    });

    describe('getPost tool', () => {
        test('should return post as JSON', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getPost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' });

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as BskyPost;
            expect(parsed.text).toBe('Hello Bluesky!');
            expect(parsed.uri).toBe('at://did:plc:abc123/app.bsky.feed.post/xyz');
        });

        test('should pass uri to client', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getPost');

            await handler({ uri: 'at://did:plc:xyz/app.bsky.feed.post/abc' });

            expect(mockClient.getPost).toHaveBeenCalledWith('at://did:plc:xyz/app.bsky.feed.post/abc');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Post not found');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getPost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Post not found');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw { code: 404 };
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getPost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: [object Object]');
        });
    });

    describe('getProfile tool', () => {
        test('should return profile as JSON', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getProfile');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as BskyAuthor;
            expect(parsed.handle).toBe('alice.bsky.social');
            expect(parsed.displayName).toBe('Alice');
        });

        test('should pass actor to client', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getProfile');

            await handler({ actor: 'bob.bsky.social' });

            expect(mockClient.getProfile).toHaveBeenCalledWith('bob.bsky.social');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getProfile as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Profile not found');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getProfile');

            const result = await handler({ actor: 'unknown.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Profile not found');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getProfile as ReturnType<typeof mock>).mockImplementation(async () => {
                throw null;
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getProfile');

            const result = await handler({ actor: 'unknown.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: null');
        });
    });

    describe('getAuthorFeed tool', () => {
        test('should return author feed items as JSON', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getAuthorFeed');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { items: BskyFeedItem[], cursor: string };
            expect(parsed.items).toHaveLength(1);
            expect(parsed.items[0].post.author.handle).toBe('alice.bsky.social');
            expect(parsed.cursor).toBe('author-cursor');
        });

        test('should pass actor, limit, and cursor to client', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getAuthorFeed');

            await handler({ actor: 'alice.bsky.social', limit: 15, cursor: 'author-page' });

            expect(mockClient.getAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 15, 'author-page');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getAuthorFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Actor not found');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getAuthorFeed');

            const result = await handler({ actor: 'ghost.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Actor not found');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getAuthorFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw undefined;
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getAuthorFeed');

            const result = await handler({ actor: 'ghost.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: undefined');
        });
    });

    describe('likePost tool', () => {
        test('should return success message when post is not yet liked', async () => {
            // getPost returns post with no viewer.like
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => mockPost());

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post liked successfully');
        });

        test('should pass uri and cid to client when not already liked', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => mockPost());

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'likePost');

            await handler({ uri: 'at://did:plc:xyz/app.bsky.feed.post/abc', cid: 'bafyreid123' });

            expect(mockClient.likePost).toHaveBeenCalledWith('at://did:plc:xyz/app.bsky.feed.post/abc', 'bafyreid123');
        });

        test('should return "Post already liked" when viewer.like is set', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> =>
                mockPost({ viewer: { like: 'at://did:plc:abc123/app.bsky.feed.like/existinglike' } })
            );

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post already liked');
        });

        test('should not call likePost when post is already liked', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> =>
                mockPost({ viewer: { like: 'at://like/uri' } })
            );

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'likePost');

            await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(mockClient.likePost).not.toHaveBeenCalled();
        });

        test('should return error result on getPost failure', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Rate limited');
        });

        test('should return error result on likePost failure', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => mockPost());
            (mockClient.likePost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Like failed');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Like failed');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'not allowed';
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: not allowed');
        });
    });

    // ---------------------------------------------------------------------------
    // Checkpoint manager helpers
    // ---------------------------------------------------------------------------

    interface MockCheckpointManager {
        loadFeedCheckpoint:         ReturnType<typeof mock>
        saveFeedCheckpoint:         ReturnType<typeof mock>
        loadNotificationCheckpoint: ReturnType<typeof mock>
        saveNotificationCheckpoint: ReturnType<typeof mock>
        processFeedItems:           ReturnType<typeof mock>
        processNotifications:       ReturnType<typeof mock>
    }

    function createMockCheckpointManager(): MockCheckpointManager {
        return {
            loadFeedCheckpoint:         mock(async () => undefined),
            saveFeedCheckpoint:         mock(async () => undefined),
            loadNotificationCheckpoint: mock(async () => undefined),
            saveNotificationCheckpoint: mock(async () => undefined),
            processFeedItems:           mock(async (_feedName: string, items: BskyFeedItem[]) => ({ newItems: items, totalFetched: items.length })),
            // Default: no prior checkpoint (first poll) — hadExistingCheckpoint=false triggers updateNotificationsSeen
            processNotifications:       mock(async (notifications: BskyNotification[]) => ({ newNotifications: notifications, totalFetched: notifications.length, lastSeenAt: notifications[0]?.indexedAt, hadExistingCheckpoint: false })),
        };
    }

    describe('getFeed tool with checkpoint manager', () => {
        test('should filter out already-processed items', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            const allItems = [
                mockFeedItem({ post: mockPost({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' }) }),
                mockFeedItem({ post: mockPost({ uri: 'at://did:plc:abc123/app.bsky.feed.post/new1' }) }),
            ];
            // processFeedItems returns only the new item
            mockCheckpointManager.processFeedItems.mockImplementation(async () => ({
                newItems:     [allItems[1]],
                totalFetched: 2,
            }));

            (mockClient.getFeed as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({
                items:  allItems,
                cursor: 'cursor-abc',
            }));

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { items: BskyFeedItem[], newCount: number, totalFetched: number };
            expect(parsed.items).toHaveLength(1);
            expect(parsed.items[0].post.uri).toBe('at://did:plc:abc123/app.bsky.feed.post/new1');
            expect(parsed.newCount).toBe(1);
            expect(parsed.totalFetched).toBe(2);
        });

        test('should call processFeedItems with feedName and items', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getFeed');

            await handler({});

            expect(mockCheckpointManager.processFeedItems).toHaveBeenCalledTimes(1);
            const [feedNameArg] = mockCheckpointManager.processFeedItems.mock.calls[0] as [string, BskyFeedItem[]];
            expect(feedNameArg).toBe('for-you');
        });

        test('should include all items when includeProcessed is true', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({ includeProcessed: true });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { items: BskyFeedItem[] };
            // Should return the raw result without filtering
            expect(parsed.items).toHaveLength(1);
            expect(mockCheckpointManager.processFeedItems).not.toHaveBeenCalled();
        });

        test('should return newCount and totalFetched metadata', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { newCount: number, totalFetched: number, cursor: string };
            expect(parsed.newCount).toBe(1);
            expect(parsed.totalFetched).toBe(1);
            expect(parsed.cursor).toBe('cursor-abc');
        });

        test('should handle empty checkpoint (first fetch)', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { items: BskyFeedItem[], newCount: number };
            expect(parsed.items).toHaveLength(1);
            expect(parsed.newCount).toBe(1);
            expect(mockCheckpointManager.processFeedItems).toHaveBeenCalledTimes(1);
        });

        test('should use "for-you" as default feed name', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getFeed');

            await handler({});

            const [feedNameArg] = mockCheckpointManager.processFeedItems.mock.calls[0] as [string, BskyFeedItem[]];
            expect(feedNameArg).toBe('for-you');
        });
    });

    describe('getNotifications tool with checkpoint manager', () => {
        test('should filter out already-processed notifications', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            const allNotifications = [
                mockNotification({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' }),
                mockNotification({ uri: 'at://did:plc:abc123/app.bsky.feed.post/new1' }),
            ];
            // processNotifications returns only the new notification
            mockCheckpointManager.processNotifications.mockImplementation(async () => ({
                newNotifications:      [allNotifications[1]],
                totalFetched:          2,
                lastSeenAt:            '2025-01-01T00:00:00.000Z',
                hadExistingCheckpoint: true,
            }));

            (mockClient.getNotifications as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ notifications: BskyNotification[], cursor?: string }> => ({
                notifications: allNotifications,
                cursor:        'notif-cursor',
            }));

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getNotifications');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { notifications: BskyNotification[], newCount: number, totalFetched: number };
            expect(parsed.notifications).toHaveLength(1);
            expect(parsed.notifications[0].uri).toBe('at://did:plc:abc123/app.bsky.feed.post/new1');
            expect(parsed.newCount).toBe(1);
            expect(parsed.totalFetched).toBe(2);
        });

        test('should call updateNotificationsSeen', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getNotifications');

            await handler({});

            expect(mockClient.updateNotificationsSeen).toHaveBeenCalledTimes(1);
        });

        test('should not call updateNotificationsSeen when no new notifications and checkpoint already existed', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            mockCheckpointManager.processNotifications.mockImplementation(async () => ({
                newNotifications:      [],
                totalFetched:          0,
                lastSeenAt:            undefined,
                hadExistingCheckpoint: true,
            }));
            (mockClient.getNotifications as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ notifications: BskyNotification[], cursor?: string }> => ({
                notifications: [],
                cursor:        undefined,
            }));

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getNotifications');

            await handler({});

            expect(mockClient.updateNotificationsSeen).not.toHaveBeenCalled();
        });

        test('should call updateNotificationsSeen on first poll even with no new notifications', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            mockCheckpointManager.processNotifications.mockImplementation(async () => ({
                newNotifications:      [],
                totalFetched:          0,
                lastSeenAt:            undefined,
                hadExistingCheckpoint: false,
            }));
            (mockClient.getNotifications as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ notifications: BskyNotification[], cursor?: string }> => ({
                notifications: [],
                cursor:        undefined,
            }));

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getNotifications');

            await handler({});

            // First poll (no prior checkpoint) must mark seen to avoid re-processing on restart
            expect(mockClient.updateNotificationsSeen).toHaveBeenCalledTimes(1);
        });

        test('should include all notifications when includeProcessed is true', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getNotifications');

            const result = await handler({ includeProcessed: true });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { notifications: BskyNotification[] };
            // Should return raw result without filtering
            expect(parsed.notifications).toHaveLength(1);
            expect(mockCheckpointManager.processNotifications).not.toHaveBeenCalled();
        });

        test('should call processNotifications with all fetched notifications', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            const notifications         = [mockNotification({ uri: 'at://only/notif' })];
            (mockClient.getNotifications as ReturnType<typeof mock>).mockResolvedValueOnce({ notifications, cursor: undefined });

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getNotifications');
            await handler({});

            expect(mockCheckpointManager.processNotifications).toHaveBeenCalledTimes(1);
            const [notifArg] = mockCheckpointManager.processNotifications.mock.calls[0] as [BskyNotification[]];
            expect(notifArg).toHaveLength(1);
            expect(notifArg[0].uri).toBe('at://only/notif');
        });

        test('should call updateNotificationsSeen with max of indexedAt and current time', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            // Use a future timestamp — Math.max should pick it over Date.now()
            const futureDate = new Date(Date.now() + 60_000).toISOString();
            mockCheckpointManager.processNotifications.mockImplementation(async () => ({
                newNotifications: [mockNotification({ indexedAt: futureDate })],
                totalFetched:     1,
                lastSeenAt:       futureDate,
            }));
            (mockClient.getNotifications as ReturnType<typeof mock>).mockResolvedValueOnce({
                notifications: [mockNotification({ indexedAt: futureDate, uri: 'at://notif/1' })],
                cursor:        undefined,
            });

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getNotifications');
            await handler({});

            const seenAtArg = (mockClient.updateNotificationsSeen as ReturnType<typeof mock>).mock.calls[0][0] as string;
            // Since futureDate > Date.now(), Math.max should pick futureDate
            expect(new Date(seenAtArg).getTime()).toBeGreaterThanOrEqual(new Date(futureDate).getTime());
        });
    });

    describe('getAuthorFeed tool with checkpoint manager', () => {
        test('should filter out already-processed items', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            const allItems = [
                mockFeedItem({ post: mockPost({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' }) }),
                mockFeedItem({ post: mockPost({ uri: 'at://did:plc:abc123/app.bsky.feed.post/new1' }) }),
            ];
            // processFeedItems returns only the new item
            mockCheckpointManager.processFeedItems.mockImplementation(async () => ({
                newItems:     [allItems[1]],
                totalFetched: 2,
            }));

            (mockClient.getAuthorFeed as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({
                items:  allItems,
                cursor: 'author-cursor',
            }));

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getAuthorFeed');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { items: BskyFeedItem[], newCount: number, totalFetched: number };
            expect(parsed.items).toHaveLength(1);
            expect(parsed.items[0].post.uri).toBe('at://did:plc:abc123/app.bsky.feed.post/new1');
            expect(parsed.newCount).toBe(1);
            expect(parsed.totalFetched).toBe(2);
        });

        test('should use resolved DID as feed name for checkpoint', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getAuthorFeed');

            await handler({ actor: 'alice.bsky.social' });

            // getProfile is called to resolve actor to DID
            expect(mockClient.getProfile).toHaveBeenCalledWith('alice.bsky.social');
            // processFeedItems is keyed by DID, not handle
            const [feedNameArg] = mockCheckpointManager.processFeedItems.mock.calls[0] as [string, BskyFeedItem[]];
            expect(feedNameArg).toBe('did:plc:abc123');
        });

        test('should include all items when includeProcessed is true', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getAuthorFeed');

            const result = await handler({ actor: 'alice.bsky.social', includeProcessed: true });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { items: BskyFeedItem[] };
            // Should return raw result without filtering
            expect(parsed.items).toHaveLength(1);
            expect(mockCheckpointManager.processFeedItems).not.toHaveBeenCalled();
            // getProfile should not be called when includeProcessed is true (no checkpoint work)
            expect(mockClient.getProfile).not.toHaveBeenCalled();
        });

        test('should call processFeedItems with resolved DID and items', async () => {
            const mockCheckpointManager = createMockCheckpointManager();
            const items = [mockFeedItem({ post: mockPost({ uri: 'at://only/uri' }) })];
            (mockClient.getAuthorFeed as ReturnType<typeof mock>).mockResolvedValueOnce({ items, cursor: undefined });

            const server  = createBskyMCPServer({ client: mockClient, checkpointManager: mockCheckpointManager as unknown as BskyCheckpointManager });
            const handler = getToolHandler(server, 'getAuthorFeed');
            await handler({ actor: 'alice.bsky.social' });

            expect(mockCheckpointManager.processFeedItems).toHaveBeenCalledTimes(1);
            const [feedNameArg, itemsArg] = mockCheckpointManager.processFeedItems.mock.calls[0] as [string, BskyFeedItem[]];
            expect(feedNameArg).toBe('did:plc:abc123');
            expect(itemsArg).toHaveLength(1);
        });
    });

    describe('follow tool', () => {
        test('should return "Followed" message when not already following', async () => {
            (mockClient.follow as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ alreadyFollowing: boolean }> => ({ alreadyFollowing: false }));
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'follow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Followed alice.bsky.social successfully');
        });

        test('should return "Already following" message when already following', async () => {
            (mockClient.follow as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ alreadyFollowing: boolean }> => ({ alreadyFollowing: true }));
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'follow');

            const result = await handler({ actor: 'bob.bsky.social' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Already following bob.bsky.social');
        });

        test('should pass actor to client.follow', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'follow');

            await handler({ actor: 'carol.bsky.social' });

            expect(mockClient.follow).toHaveBeenCalledWith('carol.bsky.social');
        });

        test('should return error result on client failure', async () => {
            (mockClient.follow as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'follow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Rate limited');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.follow as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'forbidden';
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'follow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: forbidden');
        });
    });

    describe('unfollow tool', () => {
        test('should return "Unfollowed" message when was following', async () => {
            (mockClient.unfollow as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ wasFollowing: boolean }> => ({ wasFollowing: true }));
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'unfollow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Unfollowed alice.bsky.social successfully');
        });

        test('should return "Not following" message when was not following', async () => {
            (mockClient.unfollow as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ wasFollowing: boolean }> => ({ wasFollowing: false }));
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'unfollow');

            const result = await handler({ actor: 'bob.bsky.social' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Not following bob.bsky.social');
        });

        test('should pass actor to client.unfollow', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'unfollow');

            await handler({ actor: 'carol.bsky.social' });

            expect(mockClient.unfollow).toHaveBeenCalledWith('carol.bsky.social');
        });

        test('should return error result on client failure', async () => {
            (mockClient.unfollow as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'unfollow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Rate limited');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.unfollow as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'forbidden';
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'unfollow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: forbidden');
        });
    });

    describe('sendPost tool', () => {
        test('should return success message with URI', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'sendPost');

            const result = await handler({ text: 'Hello from Isambard!' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post sent successfully: at://did:plc:abc123/app.bsky.feed.post/newpost');
        });

        test('should pass text to client', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'sendPost');

            await handler({ text: 'My new post content' });

            expect(mockClient.sendPost).toHaveBeenCalledWith('My new post content');
        });

        test('should call rateLimiter.increment() after successful send', async () => {
            const mockRateLimiter = {
                isAtLimit:       mock(() => false),
                increment:       mock(() => { /* intentionally empty */ }),
                tokensRemaining: mock(() => 23),
            };
            const server  = createBskyMCPServer({ client: mockClient, rateLimiter: mockRateLimiter as unknown as SendRateLimiter });
            const handler = getToolHandler(server, 'sendPost');

            await handler({ text: 'Hello!' });

            expect(mockRateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('should append rate limit warning when at limit', async () => {
            const mockRateLimiter = {
                isAtLimit:       mock(() => true),
                increment:       mock(() => { /* intentionally empty */ }),
                tokensRemaining: mock(() => 0),
            };
            const server  = createBskyMCPServer({ client: mockClient, rateLimiter: mockRateLimiter as unknown as SendRateLimiter });
            const handler = getToolHandler(server, 'sendPost');

            const result = await handler({ text: 'Hello!' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post sent successfully: at://did:plc:abc123/app.bsky.feed.post/newpost Warning: send rate limit reached (0 tokens remaining).');
        });

        test('should return error result on client failure', async () => {
            (mockClient.sendPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'sendPost');

            const result = await handler({ text: 'Hello!' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Rate limited');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.sendPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'network failure';
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'sendPost');

            const result = await handler({ text: 'Hello!' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: network failure');
        });
    });

    describe('replyToPost tool', () => {
        test('should return error result when replyToPost throws BskyValidationError', async () => {
            const { BskyValidationError } = await import('@/integrations/bsky/errors');
            (mockClient.replyToPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<never> => {
                throw new BskyValidationError('Post exceeds 300 graphemes (301)', { graphemeLength: 301 });
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'x'.repeat(301),
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Post exceeds 300 graphemes');
            expect(mockClient.getPost).toHaveBeenCalled();
        });

        test('should send immediately when no allowlist provided (permissive default)', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Reply sent successfully: at://did:plc:abc123/app.bsky.feed.post/newreply');
        });

        test('should fetch parent post to determine author', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(mockClient.getPost).toHaveBeenCalledWith('at://did:plc:abc123/app.bsky.feed.post/parent');
        });

        test('should pass all args to client when no allowlist', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Top-level reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Top-level reply',
                'at://did:plc:abc123/app.bsky.feed.post/parent',
                'bafyreiparent',
                undefined,
                undefined
            );
        });

        test('should pass explicit rootUri and rootCid when provided', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Nested reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
                rootUri:   'at://did:plc:abc123/app.bsky.feed.post/root',
                rootCid:   'bafyreiroot',
            });

            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Nested reply',
                'at://did:plc:abc123/app.bsky.feed.post/parent',
                'bafyreiparent',
                'at://did:plc:abc123/app.bsky.feed.post/root',
                'bafyreiroot'
            );
        });

        test('should send immediately when target is on allowlist (by handle)', async () => {
            const mockAllowlist = { isAllowed: mock((_actor: string) => true) };
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'Allowlisted reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Reply sent successfully: at://did:plc:abc123/app.bsky.feed.post/newreply');
            expect(mockClient.replyToPost).toHaveBeenCalledTimes(1);
        });

        test('should check allowlist by handle then DID', async () => {
            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            const mockApproval = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, sendApprovalRequest: mockApproval });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Not allowlisted',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            // isAllowed called with handle first, then DID
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('alice.bsky.social');
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('did:plc:abc123');
        });

        test('should request approval when target is not on allowlist', async () => {
            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            const mockApproval  = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, sendApprovalRequest: mockApproval });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'Reply needing approval',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Reply to alice.bsky.social requires approval. Approval request sent to admin.');
            expect(mockApproval).toHaveBeenCalledWith(
                'Reply needing approval',
                'alice.bsky.social',
                'at://did:plc:abc123/app.bsky.feed.post/parent',
                'bafyreiparent',
                undefined,
                undefined
            );
            expect(mockClient.replyToPost).not.toHaveBeenCalled();
        });

        test('should pass rootUri and rootCid to approval request when provided', async () => {
            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            const mockApproval  = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, sendApprovalRequest: mockApproval });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Nested reply needing approval',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
                rootUri:   'at://did:plc:abc123/app.bsky.feed.post/root',
                rootCid:   'bafyreiroot',
            });

            expect(mockApproval).toHaveBeenCalledWith(
                'Nested reply needing approval',
                'alice.bsky.social',
                'at://did:plc:abc123/app.bsky.feed.post/parent',
                'bafyreiparent',
                'at://did:plc:abc123/app.bsky.feed.post/root',
                'bafyreiroot'
            );
        });

        test('should return informational message when no allowlist and no approval handler but target would need approval', async () => {
            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'Blocked reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Reply to alice.bsky.social requires approval but no approval handler is configured.');
            expect(mockClient.replyToPost).not.toHaveBeenCalled();
        });

        test('should return error result when approval callback throws', async () => {
            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            const mockApproval  = mock(async (): Promise<void> => {
                throw new Error('Discord unavailable');
            });
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, sendApprovalRequest: mockApproval });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'Reply needing approval',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            // Approval delivery failure returns an error result
            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('failed to send approval request');
        });

        test('should call rateLimiter.increment() after allowlisted send', async () => {
            const mockAllowlist   = { isAllowed: mock((_actor: string) => true) };
            const mockRateLimiter = {
                isAtLimit:       mock(() => false),
                increment:       mock(() => { /* intentionally empty */ }),
                tokensRemaining: mock(() => 22),
            };
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, rateLimiter: mockRateLimiter as unknown as SendRateLimiter });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Allowlisted reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(mockRateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('should append rate limit warning when at limit after allowlisted send', async () => {
            const mockAllowlist   = { isAllowed: mock((_actor: string) => true) };
            const mockRateLimiter = {
                isAtLimit:       mock(() => true),
                increment:       mock(() => { /* intentionally empty */ }),
                tokensRemaining: mock(() => 0),
            };
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, rateLimiter: mockRateLimiter as unknown as SendRateLimiter });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'Allowlisted reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Reply sent successfully: at://did:plc:abc123/app.bsky.feed.post/newreply Warning: send rate limit reached (0 tokens remaining).');
        });

        test('should send immediately when replying to own post (self-reply bypass)', async () => {
            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            // Return a post authored by the bot itself
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> =>
                mockPost({ author: { did: 'did:plc:botself', handle: 'bot.bsky.social' } })
            );
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'Threading my own post',
                parentUri: 'at://did:plc:botself/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Reply sent successfully: at://did:plc:abc123/app.bsky.feed.post/newreply');
            expect(mockClient.replyToPost).toHaveBeenCalledTimes(1);
            // Allowlist should not have been checked (or at least replyToPost was called regardless)
            expect(mockAllowlist.isAllowed).not.toHaveBeenCalled();
        });

        test('should return error result on getPost failure', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Post not found');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Post not found');
        });

        test('should return error result on replyToPost failure', async () => {
            (mockClient.replyToPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Reply failed');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Reply failed');
        });

        test('should handle non-Error rejection from replyToPost', async () => {
            (mockClient.replyToPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'auth failure';
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: auth failure');
        });

        test('should validate text before requesting approval when target is not allowlisted', async () => {
            const { BskyValidationError } = await import('@/integrations/bsky/errors');
            (mockClient.validatePostText as ReturnType<typeof mock>).mockImplementation(async (): Promise<never> => {
                throw new BskyValidationError('Post exceeds 300 graphemes (301)', { graphemeLength: 301 });
            });
            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            const mockApproval  = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, sendApprovalRequest: mockApproval });
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'x'.repeat(301),
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Post exceeds 300 graphemes');
            expect(mockApproval).not.toHaveBeenCalled();
        });

        test('should auto-resolve root from parent replyRef when rootUri/rootCid omitted (nested reply)', async () => {
            // Parent post is itself a reply — it has a replyRef pointing to the real root
            const nestedParent = mockPost({
                uri:      'at://did:plc:abc123/app.bsky.feed.post/middle',
                cid:      'bafyreimiddle',
                replyRef: {
                    root:   { uri: 'at://did:plc:abc123/app.bsky.feed.post/rootpost', cid: 'bafyreiroot' },
                    parent: { uri: 'at://did:plc:abc123/app.bsky.feed.post/original', cid: 'bafyreioriginal' },
                },
            });
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => nestedParent);

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Deeply nested reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/middle',
                parentCid: 'bafyreimiddle',
            });

            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Deeply nested reply',
                'at://did:plc:abc123/app.bsky.feed.post/middle',
                'bafyreimiddle',
                'at://did:plc:abc123/app.bsky.feed.post/rootpost',
                'bafyreiroot'
            );
        });

        test('should pass undefined root when parent has no replyRef (top-level reply)', async () => {
            // Parent is a top-level post — no replyRef
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => mockPost());

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Top-level reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/xyz',
                parentCid: 'bafyreiabc',
            });

            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Top-level reply',
                'at://did:plc:abc123/app.bsky.feed.post/xyz',
                'bafyreiabc',
                undefined,
                undefined
            );
        });

        test('should prefer explicit rootUri/rootCid over parent replyRef', async () => {
            // Parent has a replyRef, but caller also provides explicit root args
            const nestedParent = mockPost({
                uri:      'at://did:plc:abc123/app.bsky.feed.post/middle',
                cid:      'bafyreimiddle',
                replyRef: {
                    root:   { uri: 'at://did:plc:abc123/app.bsky.feed.post/actualroot', cid: 'bafyreiactualroot' },
                    parent: { uri: 'at://did:plc:abc123/app.bsky.feed.post/original',   cid: 'bafyreioriginal' },
                },
            });
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => nestedParent);

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Reply with explicit root',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/middle',
                parentCid: 'bafyreimiddle',
                rootUri:   'at://did:plc:abc123/app.bsky.feed.post/explicitroot',
                rootCid:   'bafyreiexplicit',
            });

            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Reply with explicit root',
                'at://did:plc:abc123/app.bsky.feed.post/middle',
                'bafyreimiddle',
                'at://did:plc:abc123/app.bsky.feed.post/explicitroot',
                'bafyreiexplicit'
            );
        });

        test('should ignore partial explicit root (only rootUri provided) and use replyRef for both values', async () => {
            // Atomic pair: if only rootUri is given (no rootCid), fall back to replyRef for BOTH
            const nestedParent = mockPost({
                uri:      'at://did:plc:abc123/app.bsky.feed.post/middle',
                cid:      'bafyreimiddle',
                replyRef: {
                    root:   { uri: 'at://did:plc:abc123/app.bsky.feed.post/rootpost', cid: 'bafyreiroot' },
                    parent: { uri: 'at://did:plc:abc123/app.bsky.feed.post/original', cid: 'bafyreioriginal' },
                },
            });
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => nestedParent);

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Partial root reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/middle',
                parentCid: 'bafyreimiddle',
                rootUri:   'at://did:plc:abc123/app.bsky.feed.post/partialroot',
                // rootCid deliberately omitted — incomplete pair should fall back to replyRef entirely
            });

            // Both root values should come from replyRef, not a mix of explicit rootUri + replyRef rootCid
            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Partial root reply',
                'at://did:plc:abc123/app.bsky.feed.post/middle',
                'bafyreimiddle',
                'at://did:plc:abc123/app.bsky.feed.post/rootpost',
                'bafyreiroot'
            );
        });

        test('should ignore partial explicit root (only rootCid provided) and use replyRef for both values', async () => {
            // Atomic pair: if only rootCid is given (no rootUri), fall back to replyRef for BOTH
            const nestedParent = mockPost({
                uri:      'at://did:plc:abc123/app.bsky.feed.post/middle',
                cid:      'bafyreimiddle',
                replyRef: {
                    root:   { uri: 'at://did:plc:abc123/app.bsky.feed.post/rootpost', cid: 'bafyreiroot' },
                    parent: { uri: 'at://did:plc:abc123/app.bsky.feed.post/original', cid: 'bafyreioriginal' },
                },
            });
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => nestedParent);

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Partial root reply',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/middle',
                parentCid: 'bafyreimiddle',
                rootCid:   'bafyreipartial',
                // rootUri deliberately omitted — incomplete pair should fall back to replyRef entirely
            });

            // Both root values should come from replyRef, not a mix of replyRef rootUri + explicit rootCid
            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Partial root reply',
                'at://did:plc:abc123/app.bsky.feed.post/middle',
                'bafyreimiddle',
                'at://did:plc:abc123/app.bsky.feed.post/rootpost',
                'bafyreiroot'
            );
        });

        test('should pass undefined root when partial explicit root provided and parent has no replyRef', async () => {
            // Atomic pair: if only rootUri is given (no rootCid) and parent is a top-level post (no replyRef),
            // the partial arg is discarded and there is no replyRef to fall back to — both resolved values are undefined
            const topLevelParent = mockPost({
                uri: 'at://did:plc:abc123/app.bsky.feed.post/top',
                cid: 'bafyreitop',
                // no replyRef — this is a top-level post
            });
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => topLevelParent);

            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Partial root, no replyRef',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/top',
                parentCid: 'bafyreitop',
                rootUri:   'at://did:plc:abc123/app.bsky.feed.post/partialroot',
                // rootCid deliberately omitted — incomplete pair discarded; no replyRef to fall back to
            });

            // Both root values are undefined: partial arg discarded, no replyRef available
            expect(mockClient.replyToPost).toHaveBeenCalledWith(
                'Partial root, no replyRef',
                'at://did:plc:abc123/app.bsky.feed.post/top',
                'bafyreitop',
                undefined,
                undefined
            );
        });

        test('should pass resolved root to sendApprovalRequest for non-allowlisted nested replies', async () => {
            const nestedParent = mockPost({
                uri:      'at://did:plc:abc123/app.bsky.feed.post/middle',
                cid:      'bafyreimiddle',
                replyRef: {
                    root:   { uri: 'at://did:plc:abc123/app.bsky.feed.post/rootpost', cid: 'bafyreiroot' },
                    parent: { uri: 'at://did:plc:abc123/app.bsky.feed.post/original', cid: 'bafyreioriginal' },
                },
            });
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => nestedParent);

            const mockAllowlist = { isAllowed: mock((_actor: string) => false) };
            const mockApproval  = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist as unknown as BskyAllowlist, sendApprovalRequest: mockApproval });
            const handler = getToolHandler(server, 'replyToPost');

            await handler({
                text:      'Nested reply needing approval',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/middle',
                parentCid: 'bafyreimiddle',
            });

            expect(mockApproval).toHaveBeenCalledWith(
                'Nested reply needing approval',
                'alice.bsky.social',
                'at://did:plc:abc123/app.bsky.feed.post/middle',
                'bafyreimiddle',
                'at://did:plc:abc123/app.bsky.feed.post/rootpost',
                'bafyreiroot'
            );
        });
    });

    // -------------------------------------------------------------------------
    // listConversations tool
    // -------------------------------------------------------------------------

    describe('listConversations tool', () => {
        test('should return conversations as JSON with members transformed (DIDs stripped)', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listConversations');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { conversations: { members: unknown[] }[] };
            expect(parsed.conversations).toHaveLength(1);
            const member = parsed.conversations[0]?.members[0] as Record<string, unknown>;
            expect(member.handle).toBe('alice.bsky.social');
            expect(member.did).toBeUndefined();
        });

        test('should replace senderDid with senderHandle in lastMessage', async () => {
            (mockClient.listConversations as ReturnType<typeof mock>).mockResolvedValueOnce({
                conversations: [mockConversation({
                    members:     [{ did: 'did:plc:abc123', handle: 'alice.bsky.social' }],
                    lastMessage: mockDirectMessage({ senderDid: 'did:plc:abc123' }),
                })],
                cursor: undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listConversations');

            const result = await handler({});

            const parsed = JSON.parse(textContent(result.content[0])) as { conversations: { lastMessage: Record<string, unknown> }[] };
            const msg = parsed.conversations[0]?.lastMessage ?? {};
            expect(msg.senderHandle).toBe('alice.bsky.social');
            expect(msg.senderDid).toBeUndefined();
        });

        test('should pass limit, cursor, readState, status to client.listConversations', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listConversations');

            await handler({ limit: 5, cursor: 'page-cursor', readState: 'unread', status: 'accepted' });

            expect(mockClient.listConversations).toHaveBeenCalledWith(5, 'page-cursor', 'unread', 'accepted');
        });

        test('should pass undefined cursor when not provided to client.listConversations', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listConversations');

            await handler({ limit: 5, readState: 'unread', status: 'accepted' });

            expect(mockClient.listConversations).toHaveBeenCalledWith(5, undefined, 'unread', 'accepted');
        });

        test('should return cursor when present', async () => {
            (mockClient.listConversations as ReturnType<typeof mock>).mockResolvedValueOnce({
                conversations: [],
                cursor:        'next-convo-cursor',
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listConversations');

            const result = await handler({});

            const parsed = JSON.parse(textContent(result.content[0])) as { cursor: string };
            expect(parsed.cursor).toBe('next-convo-cursor');
        });

        test('should return error result on client failure', async () => {
            (mockClient.listConversations as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('DM service unavailable');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listConversations');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: DM service unavailable');
        });
    });

    // -------------------------------------------------------------------------
    // getDirectMessages tool
    // -------------------------------------------------------------------------

    describe('getDirectMessages tool', () => {
        test('should resolve handles to DIDs and fetch messages', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            expect(result.isError).toBeUndefined();
            expect(mockClient.getProfile).toHaveBeenCalledWith('alice.bsky.social');
            expect(mockClient.getConversationForMembers).toHaveBeenCalled();
            expect(mockClient.getMessages).toHaveBeenCalled();
        });

        test('should auto-mark conversation as read', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            await handler({ recipients: ['alice.bsky.social'] });

            expect(mockClient.markConversationRead).toHaveBeenCalledWith('convo-1');
        });

        test('should transform senderDid to senderHandle in messages', async () => {
            (mockClient.getMessages as ReturnType<typeof mock>).mockResolvedValueOnce({
                messages: [mockDirectMessage({ senderDid: 'did:plc:abc123' })],
                cursor:   undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            const parsed = JSON.parse(textContent(result.content[0])) as { messages: Record<string, unknown>[] };
            const msg = parsed.messages[0] ?? {};
            expect(msg.senderHandle).toBe('alice.bsky.social');
            expect(msg.senderDid).toBeUndefined();
        });

        test('should call getMessages with conversation ID and optional limit', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            await handler({ recipients: ['alice.bsky.social'], limit: 20 });

            expect(mockClient.getMessages).toHaveBeenCalledWith('convo-1', 20, undefined);
        });

        test('should pass cursor to getMessages when provided', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            await handler({ recipients: ['alice.bsky.social'], limit: 10, cursor: 'msg-cursor-xyz' });

            expect(mockClient.getMessages).toHaveBeenCalledWith('convo-1', 10, 'msg-cursor-xyz');
        });

        test('should return error result when getProfile fails', async () => {
            (mockClient.getProfile as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Handle not found');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['unknown.bsky.social'] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Handle not found');
        });

        test('should return error result when getConversationForMembers fails', async () => {
            (mockClient.getConversationForMembers as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Conversation not found');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Conversation not found');
        });

        test('should still return messages when markConversationRead throws', async () => {
            (mockClient.markConversationRead as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Mark read failed');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { messages: unknown[] };
            expect(parsed.messages).toHaveLength(1);
        });

        test('should pass through embed field when message has a forwarded post', async () => {
            const mockEmbed: BskyEmbeddedRecord = {
                uri:       'at://did:plc:abc123/app.bsky.feed.post/forwarded1',
                cid:       'bafyforwarded1',
                author:    { did: 'did:plc:abc123', handle: 'alice.bsky.social', displayName: 'Alice' },
                text:      'Original post text',
                createdAt: '2025-01-10T08:00:00.000Z',
                indexedAt: '2025-01-10T08:00:01.000Z',
            };
            (mockClient.getMessages as ReturnType<typeof mock>).mockResolvedValueOnce({
                messages: [mockDirectMessage({ senderDid: 'did:plc:abc123', embed: mockEmbed })],
                cursor:   undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            const parsed = JSON.parse(textContent(result.content[0])) as { messages: Record<string, unknown>[] };
            const msg = parsed.messages[0] ?? {};
            expect(msg.embed).toBeDefined();
            expect((msg.embed as BskyEmbeddedRecord).uri).toBe('at://did:plc:abc123/app.bsky.feed.post/forwarded1');
            expect((msg.embed as BskyEmbeddedRecord).text).toBe('Original post text');
        });

        test('should not include embed field in response when message has no embed', async () => {
            (mockClient.getMessages as ReturnType<typeof mock>).mockResolvedValueOnce({
                messages: [mockDirectMessage({ senderDid: 'did:plc:abc123' })],
                cursor:   undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            const parsed = JSON.parse(textContent(result.content[0])) as { messages: Record<string, unknown>[] };
            const msg = parsed.messages[0] ?? {};
            expect(msg.embed).toBeUndefined();
        });

        test('should append video embed hint when a message contains a video in nested embeds', async () => {
            const mockEmbedWithVideo: BskyEmbeddedRecord = {
                uri:       'at://did:plc:abc123/app.bsky.feed.post/vidpost',
                cid:       'bafyvid1',
                author:    { did: 'did:plc:abc123', handle: 'alice.bsky.social', displayName: 'Alice' },
                text:      'Check this video',
                createdAt: '2025-01-10T08:00:00.000Z',
                indexedAt: '2025-01-10T08:00:01.000Z',
                embeds:    [{ type: 'video', video: { cid: 'vidcid', playlist: 'https://video.bsky.app/watch/abc/playlist.m3u8' } }],
            };
            (mockClient.getMessages as ReturnType<typeof mock>).mockResolvedValueOnce({
                messages: [mockDirectMessage({ senderDid: 'did:plc:abc123', embed: mockEmbedWithVideo })],
                cursor:   undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            expect(result.content).toHaveLength(2);
            const hint = textContent(result.content[1]);
            expect(hint).toContain('processLocalVideoEmbed');
            expect(hint).toContain('https://video.bsky.app/watch/abc/playlist.m3u8');
        });

        test('should not append video hint when messages have no video embeds', async () => {
            (mockClient.getMessages as ReturnType<typeof mock>).mockResolvedValueOnce({
                messages: [mockDirectMessage({ senderDid: 'did:plc:abc123' })],
                cursor:   undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            expect(result.content).toHaveLength(1);
        });

        test('should use singular label when exactly one video embed is found', async () => {
            const mockEmbedWithVideo: BskyEmbeddedRecord = {
                uri:       'at://did:plc:abc123/app.bsky.feed.post/vidpost',
                cid:       'bafyvid1',
                author:    { did: 'did:plc:abc123', handle: 'alice.bsky.social', displayName: 'Alice' },
                text:      'Single video',
                createdAt: '2025-01-10T08:00:00.000Z',
                indexedAt: '2025-01-10T08:00:01.000Z',
                embeds:    [{ type: 'video', video: { cid: 'vidcid', playlist: 'https://video.bsky.app/watch/one/playlist.m3u8' } }],
            };
            (mockClient.getMessages as ReturnType<typeof mock>).mockResolvedValueOnce({
                messages: [mockDirectMessage({ senderDid: 'did:plc:abc123', embed: mockEmbedWithVideo })],
                cursor:   undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            const hint = textContent(result.content[1]);
            expect(hint).toContain('contains a video embed');
            expect(hint).not.toContain('contains video embeds');
        });

        test('should use plural label when multiple video embeds are found across messages', async () => {
            const makeVideoEmbed = (playlist: string): BskyEmbeddedRecord => ({
                uri:       'at://did:plc:abc123/app.bsky.feed.post/vidpost',
                cid:       'bafyvid',
                author:    { did: 'did:plc:abc123', handle: 'alice.bsky.social', displayName: 'Alice' },
                text:      'Video message',
                createdAt: '2025-01-10T08:00:00.000Z',
                indexedAt: '2025-01-10T08:00:01.000Z',
                embeds:    [{ type: 'video', video: { cid: 'vidcid', playlist } }],
            });
            (mockClient.getMessages as ReturnType<typeof mock>).mockResolvedValueOnce({
                messages: [
                    mockDirectMessage({ senderDid: 'did:plc:abc123', embed: makeVideoEmbed('https://video.bsky.app/watch/one/playlist.m3u8') }),
                    mockDirectMessage({ senderDid: 'did:plc:abc123', embed: makeVideoEmbed('https://video.bsky.app/watch/two/playlist.m3u8') }),
                ],
                cursor: undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getDirectMessages');

            const result = await handler({ recipients: ['alice.bsky.social'] });

            const hint = textContent(result.content[1]);
            expect(hint).toContain('contains video embeds');
            expect(hint).toContain('https://video.bsky.app/watch/one/playlist.m3u8');
            expect(hint).toContain('https://video.bsky.app/watch/two/playlist.m3u8');
        });
    });

    describe('listConversations tool with embed in lastMessage', () => {
        test('should pass through embed field in lastMessage of conversations', async () => {
            const mockEmbed: BskyEmbeddedRecord = {
                uri:       'at://did:plc:abc123/app.bsky.feed.post/shared1',
                cid:       'bafyshared1',
                author:    { did: 'did:plc:abc123', handle: 'alice.bsky.social', displayName: 'Alice' },
                text:      'Shared post text',
                createdAt: '2025-01-14T09:00:00.000Z',
                indexedAt: '2025-01-14T09:00:01.000Z',
            };
            (mockClient.listConversations as ReturnType<typeof mock>).mockResolvedValueOnce({
                conversations: [mockConversation({
                    lastMessage: mockDirectMessage({ senderDid: 'did:plc:abc123', embed: mockEmbed }),
                })],
                cursor: undefined,
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listConversations');

            const result = await handler({});

            const parsed  = JSON.parse(textContent(result.content[0])) as { conversations: { lastMessage?: Record<string, unknown> }[] };
            const lastMsg = parsed.conversations[0]?.lastMessage ?? {};
            expect(lastMsg.embed).toBeDefined();
            expect((lastMsg.embed as BskyEmbeddedRecord).uri).toBe('at://did:plc:abc123/app.bsky.feed.post/shared1');
            expect((lastMsg.embed as BskyEmbeddedRecord).text).toBe('Shared post text');
        });
    });

    // -------------------------------------------------------------------------
    // sendDirectMessage tool
    // -------------------------------------------------------------------------

    describe('sendDirectMessage tool', () => {
        test('should return error when sendDirectMessage throws a validation error', async () => {
            (mockClient.sendDirectMessage as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Text exceeds 1000 graphemes');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'A'.repeat(1001) });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Text exceeds 1000 graphemes');
        });

        test('should resolve handles to profiles before checking allowlist', async () => {
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => true),
            } as unknown as BskyAllowlist;

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist });
            const handler = getToolHandler(server, 'sendDirectMessage');

            await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(mockClient.getProfile).toHaveBeenCalledWith('alice.bsky.social');
        });

        test('should send DM immediately when recipient is on allowlist', async () => {
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => true),
            } as unknown as BskyAllowlist;

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(mockClient.sendDirectMessage).toHaveBeenCalledTimes(1);
            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toContain('DM sent successfully');
        });

        test('should send DM immediately when no allowlist is configured', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(mockClient.sendDirectMessage).toHaveBeenCalledTimes(1);
            expect(result.isError).toBeUndefined();
        });

        test('should send DM immediately when recipient is own handle (self-DM)', async () => {
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as BskyAllowlist;
            // getProfile returns own handle
            (mockClient.getProfile as ReturnType<typeof mock>).mockResolvedValueOnce({
                did: 'did:plc:bot', handle: 'bot.bsky.social',
            });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['bot.bsky.social'], text: 'Testing myself' });

            expect(mockClient.sendDirectMessage).toHaveBeenCalledTimes(1);
            expect(result.isError).toBeUndefined();
        });

        test('should trigger approval when recipient is not on allowlist', async () => {
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as BskyAllowlist;
            const sendDMApprovalRequest = mock(async (): Promise<void> => { /* intentionally empty */ });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist, sendDMApprovalRequest });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(mockClient.sendDirectMessage).not.toHaveBeenCalled();
            expect(sendDMApprovalRequest).toHaveBeenCalledTimes(1);
            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toContain('approval');
        });

        test('should call sendDMApprovalRequest with text, handles, and convoId', async () => {
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as BskyAllowlist;
            const sendDMApprovalRequest = mock(async (): Promise<void> => { /* intentionally empty */ });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist, sendDMApprovalRequest });
            const handler = getToolHandler(server, 'sendDirectMessage');

            await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(sendDMApprovalRequest).toHaveBeenCalledWith('Hello!', ['alice.bsky.social'], 'convo-1');
        });

        test('should return informational text when not allowed and no approval callback', async () => {
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as BskyAllowlist;

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(mockClient.sendDirectMessage).not.toHaveBeenCalled();
            expect(result.isError).toBeUndefined();
        });

        test('should return error when approval request fails', async () => {
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as BskyAllowlist;
            const sendDMApprovalRequest = mock(async (): Promise<void> => {
                throw new Error('Discord channel not found');
            });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist, sendDMApprovalRequest });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(result.isError).toBe(true);
        });

        test('should increment rateLimiter when DM is sent', async () => {
            const mockRateLimiter: SendRateLimiter = {
                increment:       mock(() => { /* intentionally empty */ }),
                isAtLimit:       mock(() => false),
                tokensRemaining: mock(() => 20),
            } as unknown as SendRateLimiter;

            const server  = createBskyMCPServer({ client: mockClient, rateLimiter: mockRateLimiter });
            const handler = getToolHandler(server, 'sendDirectMessage');

            await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(mockRateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('should return error when getConversationForMembers fails', async () => {
            (mockClient.getConversationForMembers as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Conversation lookup failed');
            });
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Conversation lookup failed');
        });

        test('should NOT treat multi-recipient DM as self-DM even when first recipient is own handle', async () => {
            // Mutant 3: isSelfDM → true would bypass allowlist and send immediately even with 2 recipients
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as BskyAllowlist;
            const sendDMApprovalRequest = mock(async (): Promise<void> => { /* intentionally empty */ });
            // First recipient resolves to bot's own handle; second resolves to someone else
            (mockClient.getProfile as ReturnType<typeof mock>)
                .mockResolvedValueOnce({ did: 'did:plc:bot', handle: 'bot.bsky.social' })
                .mockResolvedValueOnce({ did: 'did:plc:abc123', handle: 'alice.bsky.social' });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist, sendDMApprovalRequest });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['bot.bsky.social', 'alice.bsky.social'], text: 'Group chat!' });

            // Should go through approval path (isSelfDM is false for 2 recipients)
            expect(mockClient.sendDirectMessage).not.toHaveBeenCalled();
            expect(sendDMApprovalRequest).toHaveBeenCalledTimes(1);
            expect(result.isError).toBeUndefined();
        });

        test('should require ALL recipients to be allowlisted (not just any one)', async () => {
            // Mutant 5: every → some — if "some" were used, one allowlisted recipient would bypass approval
            const isAllowedMock = mock((handleOrDid: string) => handleOrDid === 'alice.bsky.social');
            const mockAllowlist: BskyAllowlist = {
                isAllowed: isAllowedMock,
            } as unknown as BskyAllowlist;
            const sendDMApprovalRequest = mock(async (): Promise<void> => { /* intentionally empty */ });
            // Two recipients: alice (allowlisted by handle), bob (not allowlisted)
            (mockClient.getProfile as ReturnType<typeof mock>)
                .mockResolvedValueOnce({ did: 'did:plc:aliceabc', handle: 'alice.bsky.social' })
                .mockResolvedValueOnce({ did: 'did:plc:bobabc', handle: 'bob.bsky.social' });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist, sendDMApprovalRequest });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social', 'bob.bsky.social'], text: 'Hello both!' });

            // Bob is NOT allowlisted, so approval should be triggered even though Alice is
            expect(mockClient.sendDirectMessage).not.toHaveBeenCalled();
            expect(sendDMApprovalRequest).toHaveBeenCalledTimes(1);
            expect(result.isError).toBeUndefined();
        });

        test('should allow DM when recipient handle is allowlisted (handle OR DID check)', async () => {
            // Mutant 6: || → && — if AND were used, handle-allowlisted recipients without DID allowlist would be blocked
            const isAllowedMock = mock((handleOrDid: string) => handleOrDid === 'alice.bsky.social');
            const mockAllowlist: BskyAllowlist = {
                isAllowed: isAllowedMock,
            } as unknown as BskyAllowlist;
            // getProfile returns alice's handle; DID is NOT in the allowlist
            (mockClient.getProfile as ReturnType<typeof mock>)
                .mockResolvedValueOnce({ did: 'did:plc:aliceabc', handle: 'alice.bsky.social' });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'Hello!' });

            // Handle is allowlisted → should send immediately without approval
            expect(mockClient.sendDirectMessage).toHaveBeenCalledTimes(1);
            expect(result.isError).toBeUndefined();
        });

        test('should include all recipients in approval request (not just non-allowlisted)', async () => {
            // Approval request receives ALL resolved handles, regardless of allowlist status.
            // The embed shows all participants so the admin knows who the DM is for.
            const isAllowedMock = mock((handleOrDid: string) => handleOrDid === 'alice.bsky.social');
            const mockAllowlist: BskyAllowlist = {
                isAllowed: isAllowedMock,
            } as unknown as BskyAllowlist;
            const sendDMApprovalRequest = mock(async (): Promise<void> => { /* intentionally empty */ });
            // Two recipients: alice (allowlisted by handle, not DID), bob (not allowlisted)
            (mockClient.getProfile as ReturnType<typeof mock>)
                .mockResolvedValueOnce({ did: 'did:plc:aliceabc', handle: 'alice.bsky.social' })
                .mockResolvedValueOnce({ did: 'did:plc:bobabc', handle: 'bob.bsky.social' });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist, sendDMApprovalRequest });
            const handler = getToolHandler(server, 'sendDirectMessage');

            await handler({ recipients: ['alice.bsky.social', 'bob.bsky.social'], text: 'Hello!' });

            // Approval request should include ALL recipients (alice and bob)
            expect(sendDMApprovalRequest).toHaveBeenCalledWith('Hello!', ['alice.bsky.social', 'bob.bsky.social'], 'convo-1');
        });

        test('should validate text before requesting approval when recipients are not allowlisted', async () => {
            const { BskyValidationError } = await import('@/integrations/bsky/errors');
            (mockClient.validateDMText as ReturnType<typeof mock>).mockImplementation(async (): Promise<never> => {
                throw new BskyValidationError('DM text exceeds 1000 graphemes (1001)', { graphemeLength: 1001 });
            });
            const mockAllowlist: BskyAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as BskyAllowlist;
            const sendDMApprovalRequest = mock(async (): Promise<void> => { /* intentionally empty */ });

            const server  = createBskyMCPServer({ client: mockClient, allowlist: mockAllowlist, sendDMApprovalRequest });
            const handler = getToolHandler(server, 'sendDirectMessage');

            const result = await handler({ recipients: ['alice.bsky.social'], text: 'A'.repeat(1001) });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('DM text exceeds 1000 graphemes');
            expect(sendDMApprovalRequest).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // listRejectedPosts tool
    // -------------------------------------------------------------------------

    describe('listRejectedPosts tool', () => {
        const mockRejectionBackend = {
            listRejections:  mock(async (): Promise<BskyRejectionItem[]> => []),
            deleteRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
            clearAll:        mock(async (): Promise<number> => 0),
            recordRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
        } as unknown as BskyRejectionBackend;

        test('should return items as JSON when rejections exist', async () => {
            const rejectedItem: BskyRejectionItem = {
                type:         'reply',
                uuid:         'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                text:         'My revised reply',
                targetHandle: 'alice.bsky.social',
                parentUri:    'at://did:plc:abc123/app.bsky.feed.post/xyz',
                parentCid:    'bafyreiabc',
                reason:       'Too aggressive',
                rejectedAt:   '2026-01-01T00:00:00.000Z',
            };
            (mockRejectionBackend.listRejections as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<BskyRejectionItem[]> => [rejectedItem]
            );

            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: mockRejectionBackend });
            const handler = getToolHandler(server, 'listRejectedPosts');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as BskyRejectionItem[];
            expect(parsed).toHaveLength(1);
            expect(parsed[0].type).toBe('reply');
        });

        test('should return text message when no rejections exist', async () => {
            (mockRejectionBackend.listRejections as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<BskyRejectionItem[]> => []
            );

            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: mockRejectionBackend });
            const handler = getToolHandler(server, 'listRejectedPosts');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('No rejected posts or DMs pending review.');
        });

        test('should return error when rejectionBackend is not configured', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'listRejectedPosts');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Rejection tracking is not configured');
        });

        test('should return error result when backend throws', async () => {
            const throwingBackend = {
                listRejections:  mock(async (): Promise<BskyRejectionItem[]> => { throw new Error('DynamoDB unavailable'); }),
                deleteRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
                clearAll:        mock(async (): Promise<number> => 0),
                recordRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
            } as unknown as BskyRejectionBackend;
            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: throwingBackend });
            const handler = getToolHandler(server, 'listRejectedPosts');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: DynamoDB unavailable');
        });
    });

    // -------------------------------------------------------------------------
    // clearRejection tool
    // -------------------------------------------------------------------------

    describe('clearRejection tool', () => {
        const mockRejectionBackend = {
            listRejections:  mock(async (): Promise<BskyRejectionItem[]> => []),
            deleteRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
            clearAll:        mock(async (): Promise<number> => 0),
            recordRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
        } as unknown as BskyRejectionBackend;

        test('should call deleteRejection with the provided uuid', async () => {
            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: mockRejectionBackend });
            const handler = getToolHandler(server, 'clearRejection');

            const result = await handler({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

            expect(result.isError).toBeUndefined();
            expect(mockRejectionBackend.deleteRejection).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
            expect(textContent(result.content[0])).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        });

        test('should return error when rejectionBackend is not configured', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'clearRejection');

            const result = await handler({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Rejection tracking is not configured');
        });

        test('should return error result when backend throws', async () => {
            const throwingBackend = {
                listRejections:  mock(async (): Promise<BskyRejectionItem[]> => []),
                deleteRejection: mock(async (): Promise<void> => { throw new Error('DynamoDB unavailable'); }),
                clearAll:        mock(async (): Promise<number> => 0),
                recordRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
            } as unknown as BskyRejectionBackend;
            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: throwingBackend });
            const handler = getToolHandler(server, 'clearRejection');

            const result = await handler({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: DynamoDB unavailable');
        });
    });

    // -------------------------------------------------------------------------
    // clearAllRejections tool
    // -------------------------------------------------------------------------

    describe('clearAllRejections tool', () => {
        const mockRejectionBackend = {
            listRejections:  mock(async (): Promise<BskyRejectionItem[]> => []),
            deleteRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
            clearAll:        mock(async (): Promise<number> => 3),
            recordRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
        } as unknown as BskyRejectionBackend;

        test('should call clearAll and return count-based success message for multiple items', async () => {
            (mockRejectionBackend.clearAll as ReturnType<typeof mock>).mockImplementation(async (): Promise<number> => 3);
            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: mockRejectionBackend });
            const handler = getToolHandler(server, 'clearAllRejections');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Cleared 3 rejections.');
        });

        test('should use singular form when exactly one rejection is cleared', async () => {
            (mockRejectionBackend.clearAll as ReturnType<typeof mock>).mockImplementation(async (): Promise<number> => 1);
            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: mockRejectionBackend });
            const handler = getToolHandler(server, 'clearAllRejections');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Cleared 1 rejection.');
        });

        test('should return no-op message when count is zero', async () => {
            (mockRejectionBackend.clearAll as ReturnType<typeof mock>).mockImplementation(async (): Promise<number> => 0);
            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: mockRejectionBackend });
            const handler = getToolHandler(server, 'clearAllRejections');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('No rejections to clear.');
        });

        test('should return error when rejectionBackend is not configured', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'clearAllRejections');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Rejection tracking is not configured');
        });

        test('should return error result when backend throws', async () => {
            const throwingBackend = {
                listRejections:  mock(async (): Promise<BskyRejectionItem[]> => []),
                deleteRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
                clearAll:        mock(async (): Promise<number> => { throw new Error('DynamoDB unavailable'); }),
                recordRejection: mock(async (): Promise<void> => { /* intentionally empty */ }),
            } as unknown as BskyRejectionBackend;
            const server  = createBskyMCPServer({ client: mockClient, rejectionBackend: throwingBackend });
            const handler = getToolHandler(server, 'clearAllRejections');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: DynamoDB unavailable');
        });
    });

    // -------------------------------------------------------------------------
    // processVideoEmbed tool — path validation
    // -------------------------------------------------------------------------

    describe('processVideoEmbed tool — path validation', () => {
        test('should return error when outputDir contains path traversal', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'processVideoEmbed');

            const result = await handler({ url: 'https://example.com/video.m3u8', outputDir: '../../../tmp/evil' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
        });

        test('should return error when outputDir is an absolute path outside cwd', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'processVideoEmbed');

            const result = await handler({ url: 'https://example.com/video.m3u8', outputDir: '/etc/evil' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
        });
    });

    // -------------------------------------------------------------------------
    // processLocalVideoEmbed tool — path validation
    // -------------------------------------------------------------------------

    describe('processLocalVideoEmbed tool — path validation', () => {
        test('should return error when videoPath contains path traversal', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'processLocalVideoEmbed');

            const result = await handler({ videoPath: '../../../etc/passwd', outputDir: 'output' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toMatch(/outside the working directory|SECURITY/u);
        });

        test('should return error when outputDir contains path traversal', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'processLocalVideoEmbed');

            const result = await handler({ videoPath: 'video.mp4', outputDir: '../../../tmp/evil' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
        });

        test('should return error when outputDir is an absolute path outside cwd', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'processLocalVideoEmbed');

            const result = await handler({ videoPath: 'video.mp4', outputDir: '/etc/evil' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
        });
    });

    // -------------------------------------------------------------------------
    // getVideoFrames tool — path validation and frame count cap
    // -------------------------------------------------------------------------

    describe('getVideoFrames tool — path validation and frame count cap', () => {
        test('should return error when videoPath contains path traversal', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'getVideoFrames');

            const result = await handler({ videoPath: '../../../etc/passwd', startTime: 0, endTime: 5, count: 3 });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toMatch(/outside the working directory|SECURITY/u);
        });

        test('should reject frame count exceeding max via Zod schema', () => {
            const server         = createBskyMCPServer({ client: mockClient });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.getVideoFrames;
            const countSchema    = registeredTool.inputSchema.shape.count as { safeParse: (v: unknown) => { success: boolean } };
            const parseResult    = countSchema.safeParse(21);

            expect(parseResult.success).toBe(false);
        });

        test('should accept frame count at the max', () => {
            const server         = createBskyMCPServer({ client: mockClient });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.getVideoFrames;
            const countSchema    = registeredTool.inputSchema.shape.count as { safeParse: (v: unknown) => { success: boolean } };
            const parseResult    = countSchema.safeParse(20);

            expect(parseResult.success).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // generateVideoSpectrogram tool — path validation
    // -------------------------------------------------------------------------

    describe('generateVideoSpectrogram tool — path validation', () => {
        test('should return error when videoPath contains path traversal', async () => {
            const server  = createBskyMCPServer({ client: mockClient });
            const handler = getToolHandler(server, 'generateVideoSpectrogram');

            const result = await handler({ videoPath: '../../../etc/passwd' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toMatch(/outside the working directory|SECURITY/u);
        });
    });
});
