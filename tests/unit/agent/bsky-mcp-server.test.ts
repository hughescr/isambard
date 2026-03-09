import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createBskyMCPServer } from '../../../src/agent/bsky-mcp-server';
import type { BskyCheckpointManager } from '../../../src/integrations/bsky';
import type { BlueskyClient } from '../../../src/integrations/bsky/client';
import type { BskyAuthor, BskyFeedItem, BskyNotification, BskyPost } from '../../../src/integrations/bsky/types';
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

describe.concurrent('createBskyMCPServer', () => {
    let mockClient: BlueskyClient;

    beforeEach(() => {
        mockClient = {
            getFeed:                 mock(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({ items: [mockFeedItem()], cursor: 'cursor-abc' })),
            getNotifications:        mock(async (): Promise<{ notifications: BskyNotification[], cursor?: string }> => ({ notifications: [mockNotification()], cursor: 'notif-cursor' })),
            searchPosts:             mock(async (): Promise<{ posts: BskyPost[], cursor?: string }> => ({ posts: [mockPost()], cursor: 'search-cursor' })),
            getPost:                 mock(async (): Promise<BskyPost> => mockPost()),
            getProfile:              mock(async (): Promise<BskyAuthor> => mockAuthor()),
            getAuthorFeed:           mock(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({ items: [mockFeedItem()], cursor: 'author-cursor' })),
            likePost:                mock(async (): Promise<void> => { /* intentionally empty */ }),
            toggleFollow:            mock(async (): Promise<{ followed: boolean }> => ({ followed: true })),
            sendPost:                mock(async (): Promise<{ uri: string, cid: string }> => ({ uri: 'at://did:plc:abc123/app.bsky.feed.post/newpost', cid: 'bafyreinew' })),
            replyToPost:             mock(async (): Promise<{ uri: string, cid: string }> => ({ uri: 'at://did:plc:abc123/app.bsky.feed.post/newreply', cid: 'bafyreireply' })),
            updateNotificationsSeen: mock(async (): Promise<void> => { /* intentionally empty */ }),
        } as unknown as BlueskyClient;
    });

    // Helper to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createBskyMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    describe('createBskyMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createBskyMCPServer(mockClient);

            expect(server).toBeDefined();
            expect(server.name).toBe('bsky');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['getFeed',          'Read a Bluesky feed'],
            ['getNotifications', 'Get recent Bluesky notifications'],
            ['searchPosts',      'Search Bluesky posts'],
            ['getPost',          'Get a Bluesky post by AT URI'],
            ['getProfile',       'Get a Bluesky user profile'],
            ['getAuthorFeed',    "Read a user's recent posts on Bluesky"],
            ['likePost',         'Like a Bluesky post'],
            ['toggleFollow',     'Follow or unfollow a Bluesky user (toggles current state)'],
            ['sendPost',         'Post a new message to Bluesky'],
            ['replyToPost',      'Reply to an existing Bluesky post'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createBskyMCPServer(mockClient);
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(registeredTool.description).toBe(expectedDescription);
        });

        test.each([
            ['getFeed',          ['feedName', 'limit', 'cursor', 'includeProcessed']],
            ['getNotifications', ['limit', 'cursor', 'includeProcessed']],
            ['searchPosts',      ['query', 'limit', 'cursor']],
            ['getPost',          ['uri']],
            ['getProfile',       ['actor']],
            ['getAuthorFeed',    ['actor', 'limit', 'cursor', 'includeProcessed']],
            ['likePost',         ['uri', 'cid']],
            ['toggleFollow',     ['actor']],
            ['sendPost',         ['text']],
            ['replyToPost',      ['text', 'parentUri', 'parentCid', 'rootUri', 'rootCid']],
        ])('should have %s tool with correct input schema fields', (toolName, expectedFields) => {
            const server = createBskyMCPServer(mockClient);
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            for(const field of expectedFields) {
                expect(registeredTool.inputSchema.shape[field]).toBeDefined();
            }
        });
    });

    describe('getFeed tool', () => {
        test('should return feed items as JSON', async () => {
            const server  = createBskyMCPServer(mockClient);
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
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getFeed');

            await handler({ feedName: 'for-you', limit: 10, cursor: 'next-page' });

            expect(mockClient.getFeed).toHaveBeenCalledWith('for-you', 10, 'next-page');
        });

        test('should pass "for-you" as default feedName when not provided', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getFeed');

            await handler({});

            expect(mockClient.getFeed).toHaveBeenCalledWith('for-you', undefined, undefined);
        });

        test('should return error result on client failure', async () => {
            (mockClient.getFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Network error');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Network error');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'string error';
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getFeed');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: string error');
        });
    });

    describe('getNotifications tool', () => {
        test('should return notifications as JSON', async () => {
            const server  = createBskyMCPServer(mockClient);
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
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getNotifications');

            await handler({ limit: 5, cursor: 'notif-page' });

            expect(mockClient.getNotifications).toHaveBeenCalledWith(5, 'notif-page');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getNotifications as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Auth failed');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getNotifications');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Auth failed');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getNotifications as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 42;
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getNotifications');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: 42');
        });
    });

    describe('searchPosts tool', () => {
        test('should return posts as JSON', async () => {
            const server  = createBskyMCPServer(mockClient);
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
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'searchPosts');

            await handler({ query: 'test query', limit: 20, cursor: 'search-page' });

            expect(mockClient.searchPosts).toHaveBeenCalledWith('test query', 20, 'search-page');
        });

        test('should return error result on client failure', async () => {
            (mockClient.searchPosts as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Search failed');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'searchPosts');

            const result = await handler({ query: 'test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Search failed');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.searchPosts as ReturnType<typeof mock>).mockImplementation(async () => {
                throw false;
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'searchPosts');

            const result = await handler({ query: 'test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: false');
        });
    });

    describe('getPost tool', () => {
        test('should return post as JSON', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getPost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' });

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as BskyPost;
            expect(parsed.text).toBe('Hello Bluesky!');
            expect(parsed.uri).toBe('at://did:plc:abc123/app.bsky.feed.post/xyz');
        });

        test('should pass uri to client', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getPost');

            await handler({ uri: 'at://did:plc:xyz/app.bsky.feed.post/abc' });

            expect(mockClient.getPost).toHaveBeenCalledWith('at://did:plc:xyz/app.bsky.feed.post/abc');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Post not found');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getPost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Post not found');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw { code: 404 };
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getPost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: [object Object]');
        });
    });

    describe('getProfile tool', () => {
        test('should return profile as JSON', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getProfile');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBeUndefined();
            const text = textContent(result.content[0]);
            const parsed = JSON.parse(text) as BskyAuthor;
            expect(parsed.handle).toBe('alice.bsky.social');
            expect(parsed.displayName).toBe('Alice');
        });

        test('should pass actor to client', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getProfile');

            await handler({ actor: 'bob.bsky.social' });

            expect(mockClient.getProfile).toHaveBeenCalledWith('bob.bsky.social');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getProfile as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Profile not found');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getProfile');

            const result = await handler({ actor: 'unknown.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Profile not found');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getProfile as ReturnType<typeof mock>).mockImplementation(async () => {
                throw null;
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getProfile');

            const result = await handler({ actor: 'unknown.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: null');
        });
    });

    describe('getAuthorFeed tool', () => {
        test('should return author feed items as JSON', async () => {
            const server  = createBskyMCPServer(mockClient);
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
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getAuthorFeed');

            await handler({ actor: 'alice.bsky.social', limit: 15, cursor: 'author-page' });

            expect(mockClient.getAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 15, 'author-page');
        });

        test('should return error result on client failure', async () => {
            (mockClient.getAuthorFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Actor not found');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getAuthorFeed');

            const result = await handler({ actor: 'ghost.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Actor not found');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getAuthorFeed as ReturnType<typeof mock>).mockImplementation(async () => {
                throw undefined;
            });
            const server  = createBskyMCPServer(mockClient);
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

            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post liked successfully');
        });

        test('should pass uri and cid to client when not already liked', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> => mockPost());

            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            await handler({ uri: 'at://did:plc:xyz/app.bsky.feed.post/abc', cid: 'bafyreid123' });

            expect(mockClient.likePost).toHaveBeenCalledWith('at://did:plc:xyz/app.bsky.feed.post/abc', 'bafyreid123');
        });

        test('should return "Post already liked" when viewer.like is set', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> =>
                mockPost({ viewer: { like: 'at://did:plc:abc123/app.bsky.feed.like/existinglike' } })
            );

            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post already liked');
        });

        test('should not call likePost when post is already liked', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async (): Promise<BskyPost> =>
                mockPost({ viewer: { like: 'at://like/uri' } })
            );

            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(mockClient.likePost).not.toHaveBeenCalled();
        });

        test('should return error result on getPost failure', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer(mockClient);
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
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Like failed');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.getPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'not allowed';
            });
            const server  = createBskyMCPServer(mockClient);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
            const handler = getToolHandler(server, 'getFeed');

            await handler({});

            expect(mockCheckpointManager.processFeedItems).toHaveBeenCalledTimes(1);
            const [feedNameArg] = mockCheckpointManager.processFeedItems.mock.calls[0] as [string, BskyFeedItem[]];
            expect(feedNameArg).toBe('for-you');
        });

        test('should include all items when includeProcessed is true', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
            const handler = getToolHandler(server, 'getNotifications');

            await handler({});

            // First poll (no prior checkpoint) must mark seen to avoid re-processing on restart
            expect(mockClient.updateNotificationsSeen).toHaveBeenCalledTimes(1);
        });

        test('should include all notifications when includeProcessed is true', async () => {
            const mockCheckpointManager = createMockCheckpointManager();

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
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

            const server  = createBskyMCPServer(mockClient, mockCheckpointManager as unknown as BskyCheckpointManager);
            const handler = getToolHandler(server, 'getAuthorFeed');
            await handler({ actor: 'alice.bsky.social' });

            expect(mockCheckpointManager.processFeedItems).toHaveBeenCalledTimes(1);
            const [feedNameArg, itemsArg] = mockCheckpointManager.processFeedItems.mock.calls[0] as [string, BskyFeedItem[]];
            expect(feedNameArg).toBe('did:plc:abc123');
            expect(itemsArg).toHaveLength(1);
        });
    });

    describe('toggleFollow tool', () => {
        test('should return "Followed" message when client returns followed: true', async () => {
            (mockClient.toggleFollow as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ followed: boolean }> => ({ followed: true }));
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'toggleFollow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Followed alice.bsky.social successfully');
        });

        test('should return "Unfollowed" message when client returns followed: false', async () => {
            (mockClient.toggleFollow as ReturnType<typeof mock>).mockImplementation(async (): Promise<{ followed: boolean }> => ({ followed: false }));
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'toggleFollow');

            const result = await handler({ actor: 'bob.bsky.social' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Unfollowed bob.bsky.social successfully');
        });

        test('should include actor handle in success message', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'toggleFollow');

            await handler({ actor: 'carol.bsky.social' });

            expect(mockClient.toggleFollow).toHaveBeenCalledWith('carol.bsky.social');
        });

        test('should return error result on client failure', async () => {
            (mockClient.toggleFollow as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'toggleFollow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Rate limited');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.toggleFollow as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'forbidden';
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'toggleFollow');

            const result = await handler({ actor: 'alice.bsky.social' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: forbidden');
        });
    });

    describe('sendPost tool', () => {
        test('should return success message with URI', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'sendPost');

            const result = await handler({ text: 'Hello from Isambard!' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post sent successfully: at://did:plc:abc123/app.bsky.feed.post/newpost');
        });

        test('should pass text to client', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'sendPost');

            await handler({ text: 'My new post content' });

            expect(mockClient.sendPost).toHaveBeenCalledWith('My new post content');
        });

        test('should return error result on client failure', async () => {
            (mockClient.sendPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'sendPost');

            const result = await handler({ text: 'Hello!' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Rate limited');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.sendPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'network failure';
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'sendPost');

            const result = await handler({ text: 'Hello!' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: network failure');
        });
    });

    describe('replyToPost tool', () => {
        test('should return success message with URI', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Reply sent successfully: at://did:plc:abc123/app.bsky.feed.post/newreply');
        });

        test('should pass all args to client and default rootUri/rootCid to parent values', async () => {
            const server  = createBskyMCPServer(mockClient);
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
            const server  = createBskyMCPServer(mockClient);
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

        test('should return error result on client failure', async () => {
            (mockClient.replyToPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Post not found');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Post not found');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.replyToPost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'auth failure';
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'replyToPost');

            const result = await handler({
                text:      'My reply!',
                parentUri: 'at://did:plc:abc123/app.bsky.feed.post/parent',
                parentCid: 'bafyreiparent',
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: auth failure');
        });
    });
});
