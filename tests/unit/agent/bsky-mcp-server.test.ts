import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createBskyMCPServer } from '../../../src/agent/bsky-mcp-server';
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
            getFeed:          mock(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({ items: [mockFeedItem()], cursor: 'cursor-abc' })),
            getNotifications: mock(async (): Promise<{ notifications: BskyNotification[], cursor?: string }> => ({ notifications: [mockNotification()], cursor: 'notif-cursor' })),
            searchPosts:      mock(async (): Promise<{ posts: BskyPost[], cursor?: string }> => ({ posts: [mockPost()], cursor: 'search-cursor' })),
            getPost:          mock(async (): Promise<BskyPost> => mockPost()),
            getProfile:       mock(async (): Promise<BskyAuthor> => mockAuthor()),
            getAuthorFeed:    mock(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({ items: [mockFeedItem()], cursor: 'author-cursor' })),
            likePost:         mock(async (): Promise<void> => { /* intentionally empty */ }),
            toggleFollow:     mock(async (): Promise<{ followed: boolean }> => ({ followed: true })),
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
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createBskyMCPServer(mockClient);
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(registeredTool.description).toBe(expectedDescription);
        });

        test.each([
            ['getFeed',          ['feedName', 'limit', 'cursor']],
            ['getNotifications', ['limit', 'cursor']],
            ['searchPosts',      ['query', 'limit', 'cursor']],
            ['getPost',          ['uri']],
            ['getProfile',       ['actor']],
            ['getAuthorFeed',    ['actor', 'limit', 'cursor']],
            ['likePost',         ['uri', 'cid']],
            ['toggleFollow',     ['actor']],
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

        test('should pass undefined feedName when not provided', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'getFeed');

            await handler({});

            expect(mockClient.getFeed).toHaveBeenCalledWith(undefined, undefined, undefined);
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
        test('should return success message', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Post liked successfully');
        });

        test('should pass uri and cid to client', async () => {
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            await handler({ uri: 'at://did:plc:xyz/app.bsky.feed.post/abc', cid: 'bafyreid123' });

            expect(mockClient.likePost).toHaveBeenCalledWith('at://did:plc:xyz/app.bsky.feed.post/abc', 'bafyreid123');
        });

        test('should return error result on client failure', async () => {
            (mockClient.likePost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Rate limited');
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: Rate limited');
        });

        test('should handle non-Error rejection', async () => {
            (mockClient.likePost as ReturnType<typeof mock>).mockImplementation(async () => {
                throw 'not allowed';
            });
            const server  = createBskyMCPServer(mockClient);
            const handler = getToolHandler(server, 'likePost');

            const result = await handler({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'bafyreiabc' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error: not allowed');
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
});
