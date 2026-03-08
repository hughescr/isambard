import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mockLogger } from '../../../setup';
import { BskyError, BskyAuthError, BskyRateLimitError } from '@/integrations/bsky/errors';

// ---------------------------------------------------------------------------
// Mock return types (loose enough for test data flexibility)
// ---------------------------------------------------------------------------

interface MockFeedItem { post: Record<string, unknown>, reply?: Record<string, unknown> }
interface MockNotification { uri: string, author: Record<string, unknown>, reason: string, indexedAt: string, [k: string]: unknown }
interface MockFeedResponse { data: { feed: MockFeedItem[], cursor?: string } }
interface MockPostsResponse { data: { posts: Record<string, unknown>[] } }
interface MockNotifResponse { data: { notifications: MockNotification[], cursor?: string } }
interface MockProfileResponse { data: Record<string, unknown> }
interface MockSearchResponse { data: { posts: Record<string, unknown>[], cursor?: string } }
interface MockLikeResponse { uri: string, cid: string }

// ---------------------------------------------------------------------------
// Mock @atproto/api
// ---------------------------------------------------------------------------

const mockLogin               = mock(async (): Promise<Record<string, unknown>> => ({}));
const mockGetTimeline         = mock(async (): Promise<MockFeedResponse> => ({ data: { feed: [] } }));
const mockGetFeed             = mock(async (): Promise<MockFeedResponse> => ({ data: { feed: [] } }));
const mockGetAuthorFeed       = mock(async (): Promise<MockFeedResponse> => ({ data: { feed: [] } }));
const mockGetPosts            = mock(async (): Promise<MockPostsResponse> => ({ data: { posts: [] } }));
const mockListNotifications   = mock(async (): Promise<MockNotifResponse> => ({ data: { notifications: [] } }));
const mockGetProfile          = mock(async (): Promise<MockProfileResponse> => ({ data: {} }));
const mockSearchPosts         = mock(async (): Promise<MockSearchResponse> => ({ data: { posts: [] } }));
const mockLike                = mock(async (): Promise<MockLikeResponse> => ({ uri: 'at://like/uri', cid: 'like-cid' }));
const mockFollow              = mock(async (): Promise<{ uri: string, cid: string }> => ({ uri: 'at://follow/uri', cid: 'follow-cid' }));
const mockDeleteFollow        = mock(async (): Promise<void> => undefined);

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('@atproto/api', () => ({
    AtpAgent: class MockAtpAgent {
        app = {
            bsky: {
                feed: {
                    getFeed:     mockGetFeed,
                    searchPosts: mockSearchPosts,
                },
            },
        };

        login             = mockLogin;
        getTimeline       = mockGetTimeline;
        getAuthorFeed     = mockGetAuthorFeed;
        getPosts          = mockGetPosts;
        listNotifications = mockListNotifications;
        getProfile        = mockGetProfile;
        like              = mockLike;
        follow            = mockFollow;
        deleteFollow      = mockDeleteFollow;
    },
}));

// Import AFTER mocks are registered
const { BlueskyClient } = await import('@/integrations/bsky/client');

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const CLIENT_OPTIONS = {
    handle:      'test.bsky.social',
    appPassword: 'app-password-secret',
};

const AUTHOR_BASIC = {
    did:         'did:plc:author123',
    handle:      'author.bsky.social',
    displayName: 'Test Author',
    avatar:      'https://cdn.bsky.app/avatar.jpg',
};

const AUTHOR_BASIC_NO_OPTIONAL = {
    did:    'did:plc:author123',
    handle: 'author.bsky.social',
};

const POST_RECORD = {
    $type:     'app.bsky.feed.post',
    text:      'Hello Bluesky!',
    createdAt: '2026-03-07T12:00:00.000Z',
};

const POST_VIEW = {
    uri:         'at://did:plc:author123/app.bsky.feed.post/abc123',
    cid:         'bafypost123',
    author:      AUTHOR_BASIC,
    record:      POST_RECORD,
    replyCount:  3,
    likeCount:   42,
    repostCount: 7,
    indexedAt:   '2026-03-07T12:00:01.000Z',
};

const POST_VIEW_NO_COUNTS = {
    uri:    'at://did:plc:author123/app.bsky.feed.post/abc456',
    cid:    'bafypost456',
    author: AUTHOR_BASIC,
    record: POST_RECORD,
};

const FEED_VIEW_POST = {
    post: POST_VIEW,
};

const FEED_VIEW_POST_WITH_REPLY = {
    post:  POST_VIEW,
    reply: {
        parent: POST_VIEW,
        root:   POST_VIEW,
    },
};

const NOTIFICATION = {
    uri:       'at://did:plc:author123/app.bsky.feed.like/xyz',
    cid:       'bafynotif123',
    author:    { ...AUTHOR_BASIC, description: 'Some bio' },
    reason:    'like',
    isRead:    false,
    indexedAt: '2026-03-07T12:05:00.000Z',
    record:    {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a duck-typed XRPCError-like object.
 * The implementation uses duck typing (checks .status and .error properties)
 * rather than instanceof, so we just need an Error with those fields.
 */
function makeXRPCError(status: number, error = 'Error', message = 'Something failed'): Error {
    const err = new Error(message) as Error & { status: number, error: string };
    err.status = status;
    err.error  = error;
    return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.concurrent('BlueskyClient', () => {
    beforeEach(() => {
        mockLogin.mockReset();
        mockGetTimeline.mockReset();
        mockGetFeed.mockReset();
        mockGetAuthorFeed.mockReset();
        mockGetPosts.mockReset();
        mockListNotifications.mockReset();
        mockGetProfile.mockReset();
        mockSearchPosts.mockReset();
        mockLike.mockReset();
        mockFollow.mockReset();
        mockDeleteFollow.mockReset();
        mockLogger.error.mockClear();
    });

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    describe('constructor', () => {
        test('creates client with default service URL', () => {
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client).toBeInstanceOf(BlueskyClient);
        });

        test('creates client with custom service URL', () => {
            const client = new BlueskyClient({ ...CLIENT_OPTIONS, serviceUrl: 'https://custom.bsky.app' });
            expect(client).toBeInstanceOf(BlueskyClient);
        });
    });

    // -----------------------------------------------------------------------
    // login()
    // -----------------------------------------------------------------------

    describe('login()', () => {
        test('calls agent.login with handle and appPassword', async () => {
            mockLogin.mockResolvedValueOnce({});
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            expect(mockLogin).toHaveBeenCalledWith({
                identifier: 'test.bsky.social',
                password:   'app-password-secret',
            });
        });

        test('resolves successfully on valid credentials', async () => {
            mockLogin.mockResolvedValueOnce({ data: { did: 'did:plc:user123' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.login()).resolves.toBeUndefined();
        });

        test('throws BskyAuthError on authentication failure (401)', async () => {
            mockLogin.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired', 'Invalid credentials'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.login()).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on rate limit (429)', async () => {
            mockLogin.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded', 'Too many requests'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.login()).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic XRPC failure', async () => {
            mockLogin.mockRejectedValueOnce(makeXRPCError(500, 'InternalError', 'Server error'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.login()).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on plain Error', async () => {
            mockLogin.mockRejectedValueOnce(new Error('Network timeout'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.login()).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on unknown non-Error value', async () => {
            mockLogin.mockRejectedValueOnce('string error');
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.login()).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // getFeed()
    // -----------------------------------------------------------------------

    describe('getFeed()', () => {
        test('uses getTimeline when feedName is undefined', async () => {
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [FEED_VIEW_POST], cursor: 'next-cursor' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(mockGetTimeline).toHaveBeenCalledWith({ limit: undefined, cursor: undefined });
            expect(result.items).toHaveLength(1);
            expect(result.cursor).toBe('next-cursor');
        });

        test('uses getTimeline when feedName is "following"', async () => {
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.getFeed('following', 25, 'cursor-abc');
            expect(mockGetTimeline).toHaveBeenCalledWith({ limit: 25, cursor: 'cursor-abc' });
        });

        test('uses discover feed URI when feedName is "for-you"', async () => {
            mockGetFeed.mockResolvedValueOnce({ data: { feed: [FEED_VIEW_POST], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed('for-you');
            expect(mockGetFeed).toHaveBeenCalledWith(expect.objectContaining({
                feed: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot',
            }));
            expect(result.items).toHaveLength(1);
        });

        test('uses discover feed URI when feedName is "discover"', async () => {
            mockGetFeed.mockResolvedValueOnce({ data: { feed: [], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.getFeed('discover');
            expect(mockGetFeed).toHaveBeenCalledWith(expect.objectContaining({
                feed: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot',
            }));
        });

        test('passes raw at:// URI through as-is', async () => {
            const customFeedUri = 'at://did:plc:custom/app.bsky.feed.generator/my-feed';
            mockGetFeed.mockResolvedValueOnce({ data: { feed: [], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.getFeed(customFeedUri);
            expect(mockGetFeed).toHaveBeenCalledWith({ feed: customFeedUri, limit: undefined, cursor: undefined });
        });

        test('passes limit and cursor to getFeed', async () => {
            mockGetFeed.mockResolvedValueOnce({ data: { feed: [], cursor: 'page-2' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed('discover', 10, 'page-1');
            expect(mockGetFeed).toHaveBeenCalledWith({ feed: expect.any(String), limit: 10, cursor: 'page-1' });
            expect(result.cursor).toBe('page-2');
        });

        test('normalizes feed items correctly', async () => {
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [FEED_VIEW_POST], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0]).toMatchObject({
                post: {
                    uri:         POST_VIEW.uri,
                    cid:         POST_VIEW.cid,
                    text:        'Hello Bluesky!',
                    createdAt:   '2026-03-07T12:00:00.000Z',
                    replyCount:  3,
                    likeCount:   42,
                    repostCount: 7,
                    author:      {
                        did:         AUTHOR_BASIC.did,
                        handle:      AUTHOR_BASIC.handle,
                        displayName: AUTHOR_BASIC.displayName,
                        avatar:      AUTHOR_BASIC.avatar,
                    },
                },
            });
        });

        test('normalizes feed item with reply context', async () => {
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [FEED_VIEW_POST_WITH_REPLY], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].reply).toBeDefined();
            expect(result.items[0].reply?.parent).toMatchObject({ uri: POST_VIEW.uri });
            expect(result.items[0].reply?.root).toMatchObject({ uri: POST_VIEW.uri });
        });

        test('omits reply when reply.parent is a NotFoundPost', async () => {
            const feedItemWithNotFound = {
                post:  POST_VIEW,
                reply: {
                    parent: { $type: 'app.bsky.feed.defs#notFoundPost', uri: 'at://notfound', notFound: true },
                    root:   POST_VIEW,
                },
            };
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [feedItemWithNotFound], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].reply).toBeUndefined();
        });

        test('defaults counts to 0 when undefined', async () => {
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [{ post: POST_VIEW_NO_COUNTS }], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].post.replyCount).toBe(0);
            expect(result.items[0].post.likeCount).toBe(0);
            expect(result.items[0].post.repostCount).toBe(0);
        });

        test('omits optional author fields when not present', async () => {
            const postWithMinimalAuthor = {
                ...POST_VIEW,
                author: AUTHOR_BASIC_NO_OPTIONAL,
            };
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [{ post: postWithMinimalAuthor }], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            const author = result.items[0].post.author;
            expect(author.displayName).toBeUndefined();
            expect(author.avatar).toBeUndefined();
        });

        test('throws BskyAuthError on 401', async () => {
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getFeed()).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getFeed()).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getFeed()).rejects.toBeInstanceOf(BskyError);
        });

        test('includes status in context for generic XRPC errors', async () => {
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(500, 'InternalError', 'Server error'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyError | undefined;
            try {
                await client.getFeed();
            } catch (e) {
                thrownError = e as BskyError;
            }
            expect(thrownError?.context).toMatchObject({ status: 500 });
        });
    });

    // -----------------------------------------------------------------------
    // getAuthorFeed()
    // -----------------------------------------------------------------------

    describe('getAuthorFeed()', () => {
        test('calls getAuthorFeed with actor', async () => {
            mockGetAuthorFeed.mockResolvedValueOnce({ data: { feed: [], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.getAuthorFeed('author.bsky.social');
            expect(mockGetAuthorFeed).toHaveBeenCalledWith({
                actor:  'author.bsky.social',
                limit:  undefined,
                cursor: undefined,
            });
        });

        test('passes limit and cursor', async () => {
            mockGetAuthorFeed.mockResolvedValueOnce({ data: { feed: [], cursor: 'next' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getAuthorFeed('did:plc:author123', 20, 'prev-cursor');
            expect(mockGetAuthorFeed).toHaveBeenCalledWith({ actor: 'did:plc:author123', limit: 20, cursor: 'prev-cursor' });
            expect(result.cursor).toBe('next');
        });

        test('normalizes posts in feed', async () => {
            mockGetAuthorFeed.mockResolvedValueOnce({ data: { feed: [FEED_VIEW_POST], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getAuthorFeed('did:plc:author123');
            expect(result.items).toHaveLength(1);
            expect(result.items[0].post.text).toBe('Hello Bluesky!');
        });

        test('throws BskyAuthError on 401', async () => {
            mockGetAuthorFeed.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getAuthorFeed('actor')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockGetAuthorFeed.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getAuthorFeed('actor')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic XRPC failure', async () => {
            mockGetAuthorFeed.mockRejectedValueOnce(makeXRPCError(503, 'Unavailable'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getAuthorFeed('actor')).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on plain Error', async () => {
            mockGetAuthorFeed.mockRejectedValueOnce(new Error('Connection error'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getAuthorFeed('actor')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // getPost()
    // -----------------------------------------------------------------------

    describe('getPost()', () => {
        test('fetches and normalizes a single post', async () => {
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_VIEW] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(mockGetPosts).toHaveBeenCalledWith({ uris: [POST_VIEW.uri] });
            expect(post.uri).toBe(POST_VIEW.uri);
            expect(post.text).toBe('Hello Bluesky!');
        });

        test('throws BskyError when post not found (empty array)', async () => {
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getPost('at://missing/post')).rejects.toBeInstanceOf(BskyError);
        });

        test('not-found error context includes uri', async () => {
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyError | undefined;
            try {
                await client.getPost('at://missing/post');
            } catch (e) {
                thrownError = e as BskyError;
            }
            expect(thrownError?.context).toMatchObject({ uri: 'at://missing/post' });
        });

        test('throws BskyAuthError on 401 from API', async () => {
            mockGetPosts.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getPost('at://uri')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockGetPosts.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getPost('at://uri')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic API error', async () => {
            mockGetPosts.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getPost('at://uri')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // getNotifications()
    // -----------------------------------------------------------------------

    describe('getNotifications()', () => {
        test('fetches and normalizes notifications', async () => {
            mockListNotifications.mockResolvedValueOnce({
                data: { notifications: [NOTIFICATION], cursor: 'notif-cursor' },
            });
            const client  = new BlueskyClient(CLIENT_OPTIONS);
            const result  = await client.getNotifications();
            expect(mockListNotifications).toHaveBeenCalledWith({ limit: undefined, cursor: undefined });
            expect(result.notifications).toHaveLength(1);
            expect(result.cursor).toBe('notif-cursor');
        });

        test('passes limit and cursor', async () => {
            mockListNotifications.mockResolvedValueOnce({ data: { notifications: [], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.getNotifications(30, 'cursor-x');
            expect(mockListNotifications).toHaveBeenCalledWith({ limit: 30, cursor: 'cursor-x' });
        });

        test('normalizes notification fields correctly', async () => {
            mockListNotifications.mockResolvedValueOnce({
                data: { notifications: [NOTIFICATION], cursor: undefined },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getNotifications();
            expect(result.notifications[0]).toMatchObject({
                reason:    'like',
                uri:       NOTIFICATION.uri,
                indexedAt: NOTIFICATION.indexedAt,
                author:    {
                    did:    AUTHOR_BASIC.did,
                    handle: AUTHOR_BASIC.handle,
                },
            });
        });

        test('normalizes ProfileView author with description', async () => {
            const notifWithDesc = {
                ...NOTIFICATION,
                author: { ...AUTHOR_BASIC, description: 'My bio' },
            };
            mockListNotifications.mockResolvedValueOnce({
                data: { notifications: [notifWithDesc], cursor: undefined },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getNotifications();
            expect(result.notifications[0].author.description).toBe('My bio');
        });

        test('filters out unknown notification reasons', async () => {
            const unknownNotif = { ...NOTIFICATION, reason: 'starterpack-joined' };
            mockListNotifications.mockResolvedValueOnce({
                data: { notifications: [unknownNotif, NOTIFICATION], cursor: undefined },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getNotifications();
            expect(result.notifications).toHaveLength(1);
            expect(result.notifications[0].reason).toBe('like');
        });

        test('handles all known reasons', async () => {
            const reasons: ('like' | 'repost' | 'follow' | 'mention' | 'reply' | 'quote')[] = ['like', 'repost', 'follow', 'mention', 'reply', 'quote'];
            const notifications = reasons.map(reason => ({ ...NOTIFICATION, reason }));
            mockListNotifications.mockResolvedValueOnce({
                data: { notifications, cursor: undefined },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getNotifications();
            expect(result.notifications).toHaveLength(6);
        });

        test('throws BskyAuthError on 401', async () => {
            mockListNotifications.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getNotifications()).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockListNotifications.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getNotifications()).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockListNotifications.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getNotifications()).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // getProfile()
    // -----------------------------------------------------------------------

    describe('getProfile()', () => {
        const DETAILED_PROFILE = {
            did:            'did:plc:author123',
            handle:         'author.bsky.social',
            displayName:    'Test Author',
            avatar:         'https://cdn.bsky.app/avatar.jpg',
            description:    'Software developer',
            followersCount: 1234,
            followsCount:   567,
            postsCount:     89,
        };

        test('fetches and normalizes a profile', async () => {
            mockGetProfile.mockResolvedValueOnce({ data: DETAILED_PROFILE });
            const client  = new BlueskyClient(CLIENT_OPTIONS);
            const profile = await client.getProfile('author.bsky.social');
            expect(mockGetProfile).toHaveBeenCalledWith({ actor: 'author.bsky.social' });
            expect(profile).toMatchObject({
                did:            'did:plc:author123',
                handle:         'author.bsky.social',
                displayName:    'Test Author',
                description:    'Software developer',
                followersCount: 1234,
                followsCount:   567,
                postsCount:     89,
            });
        });

        test('omits optional fields when not present', async () => {
            mockGetProfile.mockResolvedValueOnce({
                data: { did: 'did:plc:minimal', handle: 'minimal.bsky.social' },
            });
            const client  = new BlueskyClient(CLIENT_OPTIONS);
            const profile = await client.getProfile('minimal.bsky.social');
            expect(profile.displayName).toBeUndefined();
            expect(profile.avatar).toBeUndefined();
            expect(profile.description).toBeUndefined();
            expect(profile.followersCount).toBeUndefined();
            expect(profile.followsCount).toBeUndefined();
            expect(profile.postsCount).toBeUndefined();
        });

        test('preserves zero counts', async () => {
            mockGetProfile.mockResolvedValueOnce({
                data: {
                    did:            'did:plc:zero',
                    handle:         'zero.bsky.social',
                    followersCount: 0,
                    followsCount:   0,
                    postsCount:     0,
                },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const profile = await client.getProfile('zero.bsky.social');
            expect(profile.followersCount).toBe(0);
            expect(profile.followsCount).toBe(0);
            expect(profile.postsCount).toBe(0);
        });

        test('throws BskyAuthError on 401', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getProfile('actor')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getProfile('actor')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getProfile('actor')).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on plain Error', async () => {
            mockGetProfile.mockRejectedValueOnce(new Error('DNS lookup failed'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.getProfile('actor')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // searchPosts()
    // -----------------------------------------------------------------------

    describe('searchPosts()', () => {
        test('calls searchPosts with query', async () => {
            mockSearchPosts.mockResolvedValueOnce({ data: { posts: [], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.searchPosts('bun runtime');
            expect(mockSearchPosts).toHaveBeenCalledWith({ q: 'bun runtime', limit: undefined, cursor: undefined });
        });

        test('passes limit and cursor', async () => {
            mockSearchPosts.mockResolvedValueOnce({ data: { posts: [], cursor: 'search-next' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.searchPosts('typescript', 15, 'search-prev');
            expect(mockSearchPosts).toHaveBeenCalledWith({ q: 'typescript', limit: 15, cursor: 'search-prev' });
            expect(result.cursor).toBe('search-next');
        });

        test('normalizes posts in results', async () => {
            mockSearchPosts.mockResolvedValueOnce({ data: { posts: [POST_VIEW], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.searchPosts('hello');
            expect(result.posts).toHaveLength(1);
            expect(result.posts[0]).toMatchObject({
                uri:  POST_VIEW.uri,
                text: 'Hello Bluesky!',
            });
        });

        test('throws BskyAuthError on 401', async () => {
            mockSearchPosts.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.searchPosts('q')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockSearchPosts.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.searchPosts('q')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockSearchPosts.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.searchPosts('q')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // likePost()
    // -----------------------------------------------------------------------

    describe('likePost()', () => {
        test('calls agent.like with uri and cid', async () => {
            mockLike.mockResolvedValueOnce({ uri: 'at://like/uri', cid: 'like-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.likePost('at://post/uri', 'post-cid');
            expect(mockLike).toHaveBeenCalledWith('at://post/uri', 'post-cid');
        });

        test('resolves to void on success', async () => {
            mockLike.mockResolvedValueOnce({ uri: 'at://like/uri', cid: 'like-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.likePost('at://uri', 'cid123')).resolves.toBeUndefined();
        });

        test('throws BskyAuthError on 401', async () => {
            mockLike.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.likePost('at://uri', 'cid')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockLike.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.likePost('at://uri', 'cid')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockLike.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.likePost('at://uri', 'cid')).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on plain Error', async () => {
            mockLike.mockRejectedValueOnce(new Error('Socket closed'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.likePost('at://uri', 'cid')).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on unknown non-Error', async () => {
            mockLike.mockRejectedValueOnce({ code: 'UNKNOWN' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.likePost('at://uri', 'cid')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // toggleFollow()
    // -----------------------------------------------------------------------

    describe('toggleFollow()', () => {
        const PROFILE_DID = 'did:plc:target456';

        test('follows when not currently following (viewer has no following field)', async () => {
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social', viewer: {} } });
            mockFollow.mockResolvedValueOnce({ uri: 'at://follow/uri', cid: 'follow-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.toggleFollow('target.bsky.social');
            expect(mockFollow).toHaveBeenCalledWith(PROFILE_DID);
            expect(mockDeleteFollow).not.toHaveBeenCalled();
            expect(result).toEqual({ followed: true });
        });

        test('unfollows when currently following (viewer.following is set)', async () => {
            const followUri = 'at://follow/record/uri';
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social', viewer: { following: followUri } } });
            mockDeleteFollow.mockResolvedValueOnce(undefined);
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.toggleFollow('target.bsky.social');
            expect(mockDeleteFollow).toHaveBeenCalledWith(followUri);
            expect(mockFollow).not.toHaveBeenCalled();
            expect(result).toEqual({ followed: false });
        });

        test('follows when viewer is undefined', async () => {
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social' } });
            mockFollow.mockResolvedValueOnce({ uri: 'at://follow/uri', cid: 'follow-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.toggleFollow('did:plc:target456');
            expect(mockFollow).toHaveBeenCalledWith(PROFILE_DID);
            expect(result).toEqual({ followed: true });
        });

        test('throws BskyAuthError on 401', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.toggleFollow('target.bsky.social')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.toggleFollow('target.bsky.social')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.toggleFollow('target.bsky.social')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // Error mapping edge cases
    // -----------------------------------------------------------------------

    describe('error mapping', () => {
        test('auth error includes originalMessage in context', async () => {
            mockLogin.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired', 'Invalid credentials'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyAuthError | undefined;
            try {
                await client.login();
            } catch (e) {
                thrownError = e as BskyAuthError;
            }
            expect(thrownError?.context).toMatchObject({ originalMessage: 'Invalid credentials' });
        });

        test('rate limit error includes error code in context', async () => {
            mockLogin.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded', 'Too many requests'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyRateLimitError | undefined;
            try {
                await client.login();
            } catch (e) {
                thrownError = e as BskyRateLimitError;
            }
            expect(thrownError?.context).toMatchObject({ error: 'RateLimitExceeded' });
        });

        test('plain Error logs via logger.error with error context', async () => {
            const plainError = new Error('Network timeout');
            mockLogin.mockRejectedValueOnce(plainError);
            const client = new BlueskyClient(CLIENT_OPTIONS);
            try {
                await client.login();
            } catch{
                // expected
            }
            expect(mockLogger.error).toHaveBeenCalledWith({ err: plainError }, expect.any(String));
        });

        test('non-Error unknown value logs via logger.error with value context', async () => {
            const unknownErr = 'raw string error';
            mockLike.mockRejectedValueOnce(unknownErr);
            const client = new BlueskyClient(CLIENT_OPTIONS);
            try {
                await client.likePost('at://uri', 'cid');
            } catch{
                // expected
            }
            expect(mockLogger.error).toHaveBeenCalledWith({ err: unknownErr }, expect.any(String));
        });

        test('plain Error context includes originalMessage', async () => {
            mockLogin.mockRejectedValueOnce(new Error('DNS timeout'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyError | undefined;
            try {
                await client.login();
            } catch (e) {
                thrownError = e as BskyError;
            }
            expect(thrownError?.context).toMatchObject({ originalMessage: 'DNS timeout' });
        });
    });
});
