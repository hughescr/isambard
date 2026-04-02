import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mockLogger } from '../../../setup';
import { BskyError, BskyAuthError, BskyRateLimitError, BskyValidationError } from '@/integrations/bsky/errors';
import type { ServiceHealthRegistry } from '@/services';

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
interface MockPostResponse { uri: string, cid: string }

// ---------------------------------------------------------------------------
// Mock @atproto/api
// ---------------------------------------------------------------------------

const mockAgentPost           = mock(async (): Promise<MockPostResponse> => ({ uri: 'at://new/post/uri', cid: 'new-post-cid' }));
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
const mockUpdateSeen          = mock(async (): Promise<void> => undefined);

const mockListConvos         = mock(async (): Promise<{ data: { convos: unknown[], cursor?: string } }> => ({ data: { convos: [] } }));
const mockGetConvoForMembers = mock(async (): Promise<{ data: { convo: unknown } }> => ({ data: { convo: {} } }));
const mockGetMessages        = mock(async (): Promise<{ data: { messages: unknown[], cursor?: string } }> => ({ data: { messages: [] } }));
const mockSendMessage        = mock(async (): Promise<{ data: unknown }> => ({ data: {} }));
const mockUpdateRead         = mock(async (): Promise<{ data: unknown }> => ({ data: {} }));

const mockWithProxy = mock(() => ({
    chat: {
        bsky: {
            convo: {
                listConvos:         mockListConvos,
                getConvoForMembers: mockGetConvoForMembers,
                getMessages:        mockGetMessages,
                sendMessage:        mockSendMessage,
                updateRead:         mockUpdateRead,
            },
        },
    },
}));

// RichText mock state — tests can override these per-test via mockRichTextState
const mockDetectFacets = mock(async (): Promise<void> => undefined);

const mockRichTextState = {
    graphemeLength: 10,
    text:           'Hello Bluesky!',
    facets:         undefined as Record<string, unknown>[] | undefined,
};

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
        like                    = mockLike;
        follow                  = mockFollow;
        deleteFollow            = mockDeleteFollow;
        updateSeenNotifications = mockUpdateSeen;
        post                    = mockAgentPost;
        withProxy               = mockWithProxy;
    },
    RichText: class MockRichText {
        detectFacets = mockDetectFacets;
        get graphemeLength() { return mockRichTextState.graphemeLength; }
        get text()           { return mockRichTextState.text; }
        // eslint-disable-next-line sonarjs/function-return-type -- Getter returns the mock state which can be undefined
        get facets(): Record<string, unknown>[] | undefined { return mockRichTextState.facets; }
    },
    ChatBskyConvoDefs: {
        isMessageView: (v: unknown) => {
            const record = v as Record<string, unknown>;
            return record.$type === 'chat.bsky.convo.defs#messageView' || (typeof record.text === 'string' && typeof record.sender === 'object' && record.sender !== null);
        },
    },
    AppBskyEmbedRecord: {
        isView: (v: unknown) => {
            const record = v as Record<string, unknown>;
            return record.$type === 'app.bsky.embed.record#view' || (typeof record.record === 'object' && record.record !== null);
        },
        isViewRecord: (v: unknown) => {
            const record = v as Record<string, unknown>;
            return record.$type === 'app.bsky.embed.record#viewRecord' || (typeof record.uri === 'string' && typeof record.cid === 'string' && typeof record.author === 'object' && record.author !== null && typeof record.value === 'object' && record.value !== null);
        },
    },
    AppBskyEmbedImages: {
        isView: (v: unknown) => {
            const record = v as Record<string, unknown>;
            return record.$type === 'app.bsky.embed.images#view';
        },
    },
    AppBskyEmbedVideo: {
        isView: (v: unknown) => {
            const record = v as Record<string, unknown>;
            return record.$type === 'app.bsky.embed.video#view';
        },
    },
    AppBskyEmbedExternal: {
        isView: (v: unknown) => {
            const record = v as Record<string, unknown>;
            return record.$type === 'app.bsky.embed.external#view';
        },
    },
    AppBskyEmbedRecordWithMedia: {
        isView: (v: unknown) => {
            const record = v as Record<string, unknown>;
            return record.$type === 'app.bsky.embed.recordWithMedia#view';
        },
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
    uri:       'at://did:plc:author123/app.bsky.feed.post/abc456',
    cid:       'bafypost456',
    author:    AUTHOR_BASIC,
    record:    POST_RECORD,
    indexedAt: '2026-03-07T12:00:01.000Z',
};

const ROOT_POST_VIEW = {
    uri:         'at://did:plc:author123/app.bsky.feed.post/root000',
    cid:         'bafyroot000',
    author:      AUTHOR_BASIC,
    record:      POST_RECORD,
    replyCount:  5,
    likeCount:   10,
    repostCount: 2,
    indexedAt:   '2026-03-07T11:59:00.000Z',
};

const REPLY_REF = {
    root:   { uri: ROOT_POST_VIEW.uri,  cid: ROOT_POST_VIEW.cid },
    parent: { uri: POST_VIEW.uri,       cid: POST_VIEW.cid },
};

const POST_RECORD_WITH_REPLY = {
    ...POST_RECORD,
    reply: REPLY_REF,
};

const POST_VIEW_WITH_REPLY_REF = {
    ...POST_VIEW,
    uri:    'at://did:plc:author123/app.bsky.feed.post/reply123',
    cid:    'bafyreply123',
    record: POST_RECORD_WITH_REPLY,
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
        mockAgentPost.mockReset();
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
        mockUpdateSeen.mockReset();
        mockDetectFacets.mockReset();
        mockListConvos.mockReset();
        mockGetConvoForMembers.mockReset();
        mockGetMessages.mockReset();
        mockSendMessage.mockReset();
        mockUpdateRead.mockReset();
        mockWithProxy.mockReset();
        mockWithProxy.mockImplementation(() => ({
            chat: {
                bsky: {
                    convo: {
                        listConvos:         mockListConvos,
                        getConvoForMembers: mockGetConvoForMembers,
                        getMessages:        mockGetMessages,
                        sendMessage:        mockSendMessage,
                        updateRead:         mockUpdateRead,
                    },
                },
            },
        }));
        // Default login resolves successfully; individual tests may override with mockResolvedValueOnce
        mockLogin.mockResolvedValue({});
        mockRichTextState.graphemeLength = 10;
        mockRichTextState.text           = 'Hello Bluesky!';
        mockRichTextState.facets         = undefined;
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

        test('ownHandle returns the configured handle', () => {
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.ownHandle).toBe('test.bsky.social');
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

        test('configures chat proxy after successful login', async () => {
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            expect(mockWithProxy).toHaveBeenCalledWith('bsky_chat', 'did:web:api.bsky.chat');
        });

        test('throws BskyError when chat method called before login', () => {
            const uninitializedClient = new BlueskyClient({ handle: 'test.bsky.social', appPassword: 'test-password' });
            expect(uninitializedClient.listConversations()).rejects.toThrow('Chat not available');
        });

        test('getConversationForMembers re-throws BskyError unchanged when called before login', () => {
            const uninitializedClient = new BlueskyClient({ handle: 'test.bsky.social', appPassword: 'test-password' });
            expect(uninitializedClient.getConversationForMembers(['did:plc:test'])).rejects.toThrow('Chat not available');
        });

        test('getMessages re-throws BskyError unchanged when called before login', () => {
            const uninitializedClient = new BlueskyClient({ handle: 'test.bsky.social', appPassword: 'test-password' });
            expect(uninitializedClient.getMessages('convo-id')).rejects.toThrow('Chat not available');
        });

        test('sendDirectMessage re-throws BskyError unchanged when called before login', () => {
            const uninitializedClient = new BlueskyClient({ handle: 'test.bsky.social', appPassword: 'test-password' });
            expect(uninitializedClient.sendDirectMessage('convo-id', 'hello')).rejects.toThrow('Chat not available');
        });

        test('markConversationRead re-throws BskyError unchanged when called before login', () => {
            const uninitializedClient = new BlueskyClient({ handle: 'test.bsky.social', appPassword: 'test-password' });
            expect(uninitializedClient.markConversationRead('convo-id')).rejects.toThrow('Chat not available');
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

        test('uses for-you feed URI when feedName is "for-you"', async () => {
            mockGetFeed.mockResolvedValueOnce({ data: { feed: [FEED_VIEW_POST], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed('for-you');
            expect(mockGetFeed).toHaveBeenCalledWith(expect.objectContaining({
                feed: 'at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you',
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

        test('"for-you" and "discover" resolve to different feed URIs', async () => {
            mockGetFeed.mockResolvedValueOnce({ data: { feed: [], cursor: undefined } });
            mockGetFeed.mockResolvedValueOnce({ data: { feed: [], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.getFeed('for-you');
            await client.getFeed('discover');
            const forYouCall   = (mockGetFeed.mock.calls[0] as unknown as [{ feed: string }])[0].feed;
            const discoverCall = (mockGetFeed.mock.calls[1] as unknown as [{ feed: string }])[0].feed;
            expect(forYouCall).not.toBe(discoverCall);
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
                    indexedAt:   '2026-03-07T12:00:01.000Z',
                    author:      {
                        did:         AUTHOR_BASIC.did,
                        handle:      AUTHOR_BASIC.handle,
                        displayName: AUTHOR_BASIC.displayName,
                        avatar:      AUTHOR_BASIC.avatar,
                    },
                },
            });
        });

        test('includes viewer state when present', async () => {
            const postWithViewer = {
                ...POST_VIEW,
                viewer: { like: 'at://like/uri', repost: 'at://repost/uri' },
            };
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [{ post: postWithViewer }], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].post.viewer).toEqual({
                like:   'at://like/uri',
                repost: 'at://repost/uri',
            });
        });

        test('omits viewer when not present on post', async () => {
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [FEED_VIEW_POST], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].post.viewer).toBeUndefined();
        });

        test('normalizes viewer with all boolean fields', async () => {
            const postWithFullViewer = {
                ...POST_VIEW,
                viewer: {
                    like:              'at://like/uri',
                    repost:            'at://repost/uri',
                    bookmarked:        true,
                    threadMuted:       false,
                    replyDisabled:     true,
                    embeddingDisabled: false,
                    pinned:            true,
                },
            };
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [{ post: postWithFullViewer }], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].post.viewer).toEqual({
                like:              'at://like/uri',
                repost:            'at://repost/uri',
                bookmarked:        true,
                threadMuted:       false,
                replyDisabled:     true,
                embeddingDisabled: false,
                pinned:            true,
            });
        });

        test('normalizes viewer with false boolean fields explicitly', async () => {
            const postWithBooleans = {
                ...POST_VIEW,
                viewer: {
                    bookmarked:  false,
                    threadMuted: false,
                },
            };
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [{ post: postWithBooleans }], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].post.viewer).toEqual({
                bookmarked:  false,
                threadMuted: false,
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

        test('includes replyRef in feed item post when post record has a reply field', async () => {
            const feedItemWithReplyRefPost = { post: POST_VIEW_WITH_REPLY_REF };
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [feedItemWithReplyRefPost], cursor: undefined } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            expect(result.items[0].post.replyRef).toEqual({
                root:   { uri: ROOT_POST_VIEW.uri, cid: ROOT_POST_VIEW.cid },
                parent: { uri: POST_VIEW.uri,      cid: POST_VIEW.cid },
            });
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

        test('returns replyRef when post record has a reply field', async () => {
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_VIEW_WITH_REPLY_REF] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW_WITH_REPLY_REF.uri);
            expect(post.replyRef).toEqual({
                root:   { uri: ROOT_POST_VIEW.uri, cid: ROOT_POST_VIEW.cid },
                parent: { uri: POST_VIEW.uri,      cid: POST_VIEW.cid },
            });
        });

        test('returns no replyRef for a top-level post (no reply field in record)', async () => {
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_VIEW] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.replyRef).toBeUndefined();
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
    // follow()
    // -----------------------------------------------------------------------

    describe('follow()', () => {
        const PROFILE_DID = 'did:plc:target456';

        test('follows when not currently following (viewer has no following field)', async () => {
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social', viewer: {} } });
            mockFollow.mockResolvedValueOnce({ uri: 'at://follow/uri', cid: 'follow-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.follow('target.bsky.social');
            expect(mockFollow).toHaveBeenCalledWith(PROFILE_DID);
            expect(mockDeleteFollow).not.toHaveBeenCalled();
            expect(result).toEqual({ alreadyFollowing: false });
        });

        test('returns alreadyFollowing: true when already following (viewer.following present)', async () => {
            const followUri = 'at://follow/record/uri';
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social', viewer: { following: followUri } } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.follow('target.bsky.social');
            expect(mockFollow).not.toHaveBeenCalled();
            expect(mockDeleteFollow).not.toHaveBeenCalled();
            expect(result).toEqual({ alreadyFollowing: true });
        });

        test('follows when viewer is undefined', async () => {
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social' } });
            mockFollow.mockResolvedValueOnce({ uri: 'at://follow/uri', cid: 'follow-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.follow('did:plc:target456');
            expect(mockFollow).toHaveBeenCalledWith(PROFILE_DID);
            expect(result).toEqual({ alreadyFollowing: false });
        });

        test('throws BskyAuthError on 401', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.follow('target.bsky.social')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.follow('target.bsky.social')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.follow('target.bsky.social')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // unfollow()
    // -----------------------------------------------------------------------

    describe('unfollow()', () => {
        const PROFILE_DID = 'did:plc:target456';

        test('unfollows when currently following (viewer.following present)', async () => {
            const followUri = 'at://follow/record/uri';
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social', viewer: { following: followUri } } });
            mockDeleteFollow.mockResolvedValueOnce(undefined);
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.unfollow('target.bsky.social');
            expect(mockDeleteFollow).toHaveBeenCalledWith(followUri);
            expect(mockFollow).not.toHaveBeenCalled();
            expect(result).toEqual({ wasFollowing: true });
        });

        test('returns wasFollowing: false when not following (no viewer.following)', async () => {
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social', viewer: {} } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.unfollow('target.bsky.social');
            expect(mockDeleteFollow).not.toHaveBeenCalled();
            expect(result).toEqual({ wasFollowing: false });
        });

        test('returns wasFollowing: false when viewer is undefined', async () => {
            mockGetProfile.mockResolvedValueOnce({ data: { did: PROFILE_DID, handle: 'target.bsky.social' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.unfollow('target.bsky.social');
            expect(mockDeleteFollow).not.toHaveBeenCalled();
            expect(result).toEqual({ wasFollowing: false });
        });

        test('throws BskyAuthError on 401', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.unfollow('target.bsky.social')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.unfollow('target.bsky.social')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockGetProfile.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.unfollow('target.bsky.social')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // validatePostText()
    // -----------------------------------------------------------------------

    describe('validatePostText()', () => {
        test('resolves when text is within 300 graphemes', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 150;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.validatePostText('Short text');
            expect(mockDetectFacets).toHaveBeenCalledTimes(1);
        });

        test('throws BskyValidationError when text exceeds 300 graphemes', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 301;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyValidationError | undefined;
            try {
                await client.validatePostText('x'.repeat(301));
            } catch (e) {
                thrownError = e as BskyValidationError;
            }
            expect(thrownError).toBeInstanceOf(BskyValidationError);
            expect(thrownError?.context).toMatchObject({ graphemeLength: 301 });
        });

        test('resolves when text is exactly 300 graphemes (boundary)', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 300;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: unknown;
            try {
                await client.validatePostText('x'.repeat(300));
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeUndefined();
        });

        test('calls detectFacets on the RichText instance', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 10;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.validatePostText('Hello!');
            expect(mockDetectFacets).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // validateDMText()
    // -----------------------------------------------------------------------

    describe('validateDMText()', () => {
        test('resolves when text is within 1000 graphemes', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 500;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.validateDMText('Medium text');
            expect(mockDetectFacets).toHaveBeenCalledTimes(1);
        });

        test('throws BskyValidationError when text exceeds 1000 graphemes', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 1001;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyValidationError | undefined;
            try {
                await client.validateDMText('x'.repeat(1001));
            } catch (e) {
                thrownError = e as BskyValidationError;
            }
            expect(thrownError).toBeInstanceOf(BskyValidationError);
            expect(thrownError?.context).toMatchObject({ graphemeLength: 1001 });
        });

        test('resolves when text is exactly 1000 graphemes (boundary)', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 1000;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: unknown;
            try {
                await client.validateDMText('x'.repeat(1000));
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // sendPost()
    // -----------------------------------------------------------------------

    describe('sendPost()', () => {
        test('calls agent.post with rt.text and rt.facets', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.text   = 'Hello @user.bsky.social!';
            mockRichTextState.facets = [{ $type: 'app.bsky.richtext.facet' }];
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://new/post/uri', cid: 'new-post-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.sendPost('Hello @user.bsky.social!');
            expect(mockAgentPost).toHaveBeenCalledWith({
                text:   'Hello @user.bsky.social!',
                facets: [{ $type: 'app.bsky.richtext.facet' }],
            });
        });

        test('returns uri and cid from agent.post response', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://result/uri', cid: 'result-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.sendPost('Hello Bluesky!');
            expect(result).toEqual({ uri: 'at://result/uri', cid: 'result-cid' });
        });

        test('calls detectFacets on the RichText instance', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://uri', cid: 'cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.sendPost('Hello!');
            expect(mockDetectFacets).toHaveBeenCalledTimes(1);
        });

        test('throws BskyValidationError when grapheme length exceeds 300', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 301;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyValidationError | undefined;
            try {
                await client.sendPost('x'.repeat(301));
            } catch (e) {
                thrownError = e as BskyValidationError;
            }
            expect(thrownError).toBeInstanceOf(BskyValidationError);
            expect(thrownError?.context).toMatchObject({ graphemeLength: 301 });
        });

        test('succeeds when grapheme length is exactly 300', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 300;
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://uri', cid: 'cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.sendPost('x'.repeat(300))).resolves.toMatchObject({ uri: 'at://uri', cid: 'cid' });
        });

        test('throws BskyAuthError on 401 from agent.post', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.sendPost('Hello!')).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429 from agent.post', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.sendPost('Hello!')).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic Error from agent.post', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce(new Error('Socket closed'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.sendPost('Hello!')).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on non-Error value from agent.post', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce({ code: 'UNKNOWN' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.sendPost('Hello!')).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // replyToPost()
    // -----------------------------------------------------------------------

    describe('replyToPost()', () => {
        const PARENT_URI = 'at://did:plc:author123/app.bsky.feed.post/parent001';
        const PARENT_CID = 'bafy-parent-cid';
        const ROOT_URI   = 'at://did:plc:author123/app.bsky.feed.post/root001';
        const ROOT_CID   = 'bafy-root-cid';

        test('calls agent.post with text, facets, and reply ref', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.text   = 'Reply text';
            mockRichTextState.facets = undefined;
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://reply/uri', cid: 'reply-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.replyToPost('Reply text', PARENT_URI, PARENT_CID, ROOT_URI, ROOT_CID);
            expect(mockAgentPost).toHaveBeenCalledWith({
                text:   'Reply text',
                facets: undefined,
                reply:  {
                    root:   { uri: ROOT_URI,   cid: ROOT_CID },
                    parent: { uri: PARENT_URI, cid: PARENT_CID },
                },
            });
        });

        test('defaults root to parent when rootUri/rootCid omitted', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.text = 'Top-level reply';
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://reply/uri', cid: 'reply-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.replyToPost('Top-level reply', PARENT_URI, PARENT_CID);
            expect(mockAgentPost).toHaveBeenCalledWith({
                text:   'Top-level reply',
                facets: undefined,
                reply:  {
                    root:   { uri: PARENT_URI, cid: PARENT_CID },
                    parent: { uri: PARENT_URI, cid: PARENT_CID },
                },
            });
        });

        test('returns uri and cid from agent.post response', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://reply/result', cid: 'reply-result-cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.replyToPost('Text', PARENT_URI, PARENT_CID);
            expect(result).toEqual({ uri: 'at://reply/result', cid: 'reply-result-cid' });
        });

        test('throws BskyValidationError when grapheme length exceeds 300', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 301;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            let thrownError: BskyValidationError | undefined;
            try {
                await client.replyToPost('x'.repeat(301), PARENT_URI, PARENT_CID);
            } catch (e) {
                thrownError = e as BskyValidationError;
            }
            expect(thrownError).toBeInstanceOf(BskyValidationError);
            expect(thrownError?.context).toMatchObject({ graphemeLength: 301 });
        });

        test('succeeds when grapheme length is exactly 300', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockRichTextState.graphemeLength = 300;
            mockAgentPost.mockResolvedValueOnce({ uri: 'at://uri', cid: 'cid' });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.replyToPost('x'.repeat(300), PARENT_URI, PARENT_CID)).resolves.toMatchObject({ uri: 'at://uri', cid: 'cid' });
        });

        test('throws BskyAuthError on 401', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.replyToPost('Text', PARENT_URI, PARENT_CID)).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.replyToPost('Text', PARENT_URI, PARENT_CID)).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic Error', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce(new Error('Network error'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.replyToPost('Text', PARENT_URI, PARENT_CID)).rejects.toBeInstanceOf(BskyError);
        });

        test('throws BskyError on non-Error value', async () => {
            mockDetectFacets.mockResolvedValueOnce(undefined);
            mockAgentPost.mockRejectedValueOnce('raw error');
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.replyToPost('Text', PARENT_URI, PARENT_CID)).rejects.toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // updateNotificationsSeen()
    // -----------------------------------------------------------------------

    describe('updateNotificationsSeen()', () => {
        test('calls API with provided seenAt timestamp', async () => {
            mockUpdateSeen.mockResolvedValueOnce(undefined);
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.updateNotificationsSeen('2026-03-07T12:00:00.000Z');
            expect(mockUpdateSeen).toHaveBeenCalledWith('2026-03-07T12:00:00.000Z');
        });

        test('uses current time when seenAt not provided', async () => {
            mockUpdateSeen.mockResolvedValueOnce(undefined);
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.updateNotificationsSeen();
            expect(mockUpdateSeen).toHaveBeenCalledWith(expect.any(String));
        });

        test('throws BskyAuthError on 401', async () => {
            mockUpdateSeen.mockRejectedValueOnce(makeXRPCError(401, 'AuthenticationRequired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.updateNotificationsSeen()).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('throws BskyRateLimitError on 429', async () => {
            mockUpdateSeen.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.updateNotificationsSeen()).rejects.toBeInstanceOf(BskyRateLimitError);
        });

        test('throws BskyError on generic failure', async () => {
            mockUpdateSeen.mockRejectedValueOnce(makeXRPCError(500, 'InternalError'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            expect(client.updateNotificationsSeen()).rejects.toBeInstanceOf(BskyError);
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

    // -----------------------------------------------------------------------
    // Conversation test data
    // -----------------------------------------------------------------------

    const CONVO_MEMBER = {
        did:         'did:plc:member1',
        handle:      'alice.bsky.social',
        displayName: 'Alice',
        avatar:      'https://cdn.bsky.app/avatar1.jpg',
    };

    const MESSAGE_VIEW = {
        $type:  'chat.bsky.convo.defs#messageView',
        id:     'msg-001',
        rev:    'rev-001',
        text:   'Hello there!',
        sender: { did: 'did:plc:member1' },
        sentAt: '2025-01-15T10:00:00.000Z',
    };

    const DELETED_MESSAGE_VIEW = {
        $type:  'chat.bsky.convo.defs#deletedMessageView',
        id:     'msg-deleted',
        rev:    'rev-deleted',
        sender: { did: 'did:plc:member1' },
        sentAt: '2025-01-15T09:00:00.000Z',
    };

    const CONVO_VIEW = {
        id:          'convo-001',
        rev:         'convo-rev-001',
        members:     [CONVO_MEMBER],
        lastMessage: MESSAGE_VIEW,
        muted:       false,
        unreadCount: 2,
        status:      'accepted',
    };

    // -----------------------------------------------------------------------
    // listConversations()
    // -----------------------------------------------------------------------

    describe('listConversations()', () => {
        test('returns normalized conversations with cursor', async () => {
            mockListConvos.mockResolvedValueOnce({
                data: { convos: [CONVO_VIEW], cursor: 'next-cursor' },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.listConversations(10, 'prev-cursor');
            expect(mockListConvos).toHaveBeenCalledWith({ limit: 10, cursor: 'prev-cursor', readState: undefined, status: undefined });
            expect(result.cursor).toBe('next-cursor');
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0]).toMatchObject({
                id:          'convo-001',
                rev:         'convo-rev-001',
                muted:       false,
                unreadCount: 2,
                status:      'accepted',
            });
        });

        test('maps member profiles to BskyConversationMember', async () => {
            mockListConvos.mockResolvedValueOnce({
                data: { convos: [CONVO_VIEW] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.listConversations();
            const member = result.conversations[0]?.members[0];
            expect(member).toMatchObject({
                did:         'did:plc:member1',
                handle:      'alice.bsky.social',
                displayName: 'Alice',
                avatar:      'https://cdn.bsky.app/avatar1.jpg',
            });
        });

        test('normalizes lastMessage when it is a MessageView', async () => {
            mockListConvos.mockResolvedValueOnce({
                data: { convos: [CONVO_VIEW] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.listConversations();
            expect(result.conversations[0]?.lastMessage).toMatchObject({
                id:        'msg-001',
                rev:       'rev-001',
                text:      'Hello there!',
                senderDid: 'did:plc:member1',
                sentAt:    '2025-01-15T10:00:00.000Z',
            });
        });

        test('omits lastMessage when it is a DeletedMessageView', async () => {
            mockListConvos.mockResolvedValueOnce({
                data: { convos: [{ ...CONVO_VIEW, lastMessage: DELETED_MESSAGE_VIEW }] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.listConversations();
            expect(result.conversations[0]?.lastMessage).toBeUndefined();
        });

        test('handles empty conversations list', async () => {
            mockListConvos.mockResolvedValueOnce({ data: { convos: [] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.listConversations();
            expect(result.conversations).toEqual([]);
            expect(result.cursor).toBeUndefined();
        });

        test('maps 401 to BskyAuthError', async () => {
            mockListConvos.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Unauthorized'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            let thrownError: unknown;
            try {
                await client.listConversations();
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeInstanceOf(BskyAuthError);
        });

        test('maps generic errors to BskyError', async () => {
            mockListConvos.mockRejectedValueOnce(makeXRPCError(500, 'InternalError', 'Server error'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            let thrownError: unknown;
            try {
                await client.listConversations();
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeInstanceOf(BskyError);
        });
    });

    // -----------------------------------------------------------------------
    // getConversationForMembers()
    // -----------------------------------------------------------------------

    describe('getConversationForMembers()', () => {
        test('passes member DIDs to API', async () => {
            mockGetConvoForMembers.mockResolvedValueOnce({ data: { convo: CONVO_VIEW } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            await client.getConversationForMembers(['did:plc:member1', 'did:plc:member2']);
            expect(mockGetConvoForMembers).toHaveBeenCalledWith({ members: ['did:plc:member1', 'did:plc:member2'] });
        });

        test('returns normalized conversation', async () => {
            mockGetConvoForMembers.mockResolvedValueOnce({ data: { convo: CONVO_VIEW } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getConversationForMembers(['did:plc:member1']);
            expect(result).toMatchObject({ id: 'convo-001', unreadCount: 2 });
        });

        test('maps errors to BskyError', async () => {
            mockGetConvoForMembers.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Unauthorized'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            let thrownError: unknown;
            try {
                await client.getConversationForMembers(['did:plc:member1']);
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeInstanceOf(BskyAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // getMessages()
    // -----------------------------------------------------------------------

    describe('getMessages()', () => {
        test('returns normalized messages with cursor', async () => {
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_VIEW], cursor: 'msg-cursor' },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001', 20, 'prev-cursor');
            expect(mockGetMessages).toHaveBeenCalledWith({ convoId: 'convo-001', limit: 20, cursor: 'prev-cursor' });
            expect(result.cursor).toBe('msg-cursor');
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0]).toMatchObject({
                id:        'msg-001',
                text:      'Hello there!',
                senderDid: 'did:plc:member1',
            });
        });

        test('filters out DeletedMessageView entries', async () => {
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_VIEW, DELETED_MESSAGE_VIEW] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0]?.id).toBe('msg-001');
        });

        test('handles empty messages list', async () => {
            mockGetMessages.mockResolvedValueOnce({ data: { messages: [] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages).toEqual([]);
            expect(result.cursor).toBeUndefined();
        });

        test('maps errors to BskyError', async () => {
            mockGetMessages.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Unauthorized'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            let thrownError: unknown;
            try {
                await client.getMessages('convo-001');
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeInstanceOf(BskyAuthError);
        });

        test('normalizes embedded record URI and basic fields when message has a forwarded post', async () => {
            const MESSAGE_WITH_EMBED = {
                ...MESSAGE_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:       'app.bsky.embed.record#viewRecord',
                        uri:         'at://did:plc:author123/app.bsky.feed.post/forwarded1',
                        cid:         'bafyforwarded1',
                        author:      CONVO_MEMBER,
                        value:       { text: 'Original post text', createdAt: '2025-01-10T08:00:00.000Z' },
                        indexedAt:   '2025-01-10T08:00:01.000Z',
                        replyCount:  3,
                        likeCount:   10,
                        repostCount: 2,
                    },
                },
            };
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_WITH_EMBED] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages).toHaveLength(1);
            const embed = result.messages[0]?.embed;
            expect(embed).toBeDefined();
            expect(embed?.uri).toBe('at://did:plc:author123/app.bsky.feed.post/forwarded1');
            expect(embed?.cid).toBe('bafyforwarded1');
            expect(embed?.text).toBe('Original post text');
            expect(embed?.createdAt).toBe('2025-01-10T08:00:00.000Z');
            expect(embed?.indexedAt).toBe('2025-01-10T08:00:01.000Z');
        });

        test('normalizes embedded record counts and author when message has a forwarded post', async () => {
            const MESSAGE_WITH_EMBED = {
                ...MESSAGE_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:       'app.bsky.embed.record#viewRecord',
                        uri:         'at://did:plc:author123/app.bsky.feed.post/forwarded1',
                        cid:         'bafyforwarded1',
                        author:      CONVO_MEMBER,
                        value:       { text: 'Original post text', createdAt: '2025-01-10T08:00:00.000Z' },
                        indexedAt:   '2025-01-10T08:00:01.000Z',
                        replyCount:  3,
                        likeCount:   10,
                        repostCount: 2,
                    },
                },
            };
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_WITH_EMBED] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            const embed = result.messages[0]?.embed;
            expect(embed?.replyCount).toBe(3);
            expect(embed?.likeCount).toBe(10);
            expect(embed?.repostCount).toBe(2);
            expect(embed?.author.handle).toBe('alice.bsky.social');
        });

        test('omits embed when message has no embed field', async () => {
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_VIEW] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages[0]?.embed).toBeUndefined();
        });

        test('omits embed when embed record is not a ViewRecord (e.g. ViewNotFound)', async () => {
            const MESSAGE_WITH_NOT_FOUND_EMBED = {
                ...MESSAGE_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:    'app.bsky.embed.record#viewNotFound',
                        uri:      'at://did:plc:author123/app.bsky.feed.post/gone',
                        notFound: true,
                    },
                },
            };
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_WITH_NOT_FOUND_EMBED] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages[0]?.embed).toBeUndefined();
        });

        test('normalizes embedded record in lastMessage of listConversations', async () => {
            const MESSAGE_WITH_EMBED = {
                $type:  'chat.bsky.convo.defs#messageView',
                id:     'msg-embed',
                rev:    'rev-embed',
                text:   'Check this out',
                sender: { did: 'did:plc:member1' },
                sentAt: '2025-01-15T11:00:00.000Z',
                embed:  {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:     'app.bsky.embed.record#viewRecord',
                        uri:       'at://did:plc:author123/app.bsky.feed.post/shared1',
                        cid:       'bafyshared1',
                        author:    CONVO_MEMBER,
                        value:     { text: 'Shared post text', createdAt: '2025-01-14T09:00:00.000Z' },
                        indexedAt: '2025-01-14T09:00:01.000Z',
                    },
                },
            };
            mockListConvos.mockResolvedValueOnce({
                data: { convos: [{ ...CONVO_VIEW, lastMessage: MESSAGE_WITH_EMBED }] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result    = await client.listConversations();
            const lastEmbed = result.conversations[0]?.lastMessage?.embed;
            expect(lastEmbed).toBeDefined();
            expect(lastEmbed?.uri).toBe('at://did:plc:author123/app.bsky.feed.post/shared1');
            expect(lastEmbed?.text).toBe('Shared post text');
        });

        test('omits optional count fields from embedded record when absent', async () => {
            const MESSAGE_WITH_EMBED_NO_COUNTS = {
                ...MESSAGE_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:     'app.bsky.embed.record#viewRecord',
                        uri:       'at://did:plc:author123/app.bsky.feed.post/nocounts',
                        cid:       'bafynocounts',
                        author:    CONVO_MEMBER,
                        value:     { text: 'No counts post', createdAt: '2025-01-10T08:00:00.000Z' },
                        indexedAt: '2025-01-10T08:00:01.000Z',
                    },
                },
            };
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_WITH_EMBED_NO_COUNTS] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            const embed  = result.messages[0]?.embed;
            expect(embed).toBeDefined();
            expect(embed?.replyCount).toBeUndefined();
            expect(embed?.likeCount).toBeUndefined();
            expect(embed?.repostCount).toBeUndefined();
        });

        test('falls back to empty string for embedded record text when value.text is not a string', async () => {
            const MESSAGE_WITH_NON_STRING_VALUE = {
                ...MESSAGE_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:     'app.bsky.embed.record#viewRecord',
                        uri:       'at://did:plc:author123/app.bsky.feed.post/notext',
                        cid:       'bafynotext',
                        author:    CONVO_MEMBER,
                        value:     { text: 42, createdAt: '2025-01-10T08:00:00.000Z' },
                        indexedAt: '2025-01-10T08:00:01.000Z',
                    },
                },
            };
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_WITH_NON_STRING_VALUE] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages[0]?.embed?.text).toBe('');
        });

        test('falls back to empty string for embedded record createdAt when value.createdAt is not a string', async () => {
            const MESSAGE_WITH_NO_CREATED_AT = {
                ...MESSAGE_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:     'app.bsky.embed.record#viewRecord',
                        uri:       'at://did:plc:author123/app.bsky.feed.post/nocreatedat',
                        cid:       'bafynocreatedat',
                        author:    CONVO_MEMBER,
                        value:     { text: 'Some text', createdAt: null },
                        indexedAt: '2025-01-10T08:00:01.000Z',
                    },
                },
            };
            mockGetMessages.mockResolvedValueOnce({
                data: { messages: [MESSAGE_WITH_NO_CREATED_AT] },
            });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages[0]?.embed?.createdAt).toBe('');
        });

        test('deduplicates DID lookups across multiple messages in a single getMessages call', async () => {
            const MENTION_FACET = {
                index:    { byteStart: 0, byteEnd: 20 },
                features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:crossmsg123' }],
            };
            const MESSAGE_A = {
                ...MESSAGE_VIEW,
                id:     'msg-a',
                facets: [MENTION_FACET],
            };
            const MESSAGE_B = {
                ...MESSAGE_VIEW,
                id:     'msg-b',
                facets: [MENTION_FACET],
            };
            mockGetMessages.mockResolvedValueOnce({ data: { messages: [MESSAGE_A, MESSAGE_B] } });
            mockGetProfile.mockResolvedValue({ data: { did: 'did:plc:crossmsg123', handle: 'crossmsg.bsky.social' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            // getProfile should only be called once even though both messages mention the same DID
            expect(mockGetProfile).toHaveBeenCalledTimes(1);
            expect(result.messages[0]?.facets?.[0]?.features?.[0]).toEqual({ type: 'mention', handle: 'crossmsg.bsky.social' });
            expect(result.messages[1]?.facets?.[0]?.features?.[0]).toEqual({ type: 'mention', handle: 'crossmsg.bsky.social' });
        });
    });

    // -----------------------------------------------------------------------
    // sendDirectMessage()
    // -----------------------------------------------------------------------

    describe('sendDirectMessage()', () => {
        test('sends message with text and facets and returns normalized message', async () => {
            mockRichTextState.text   = 'Hello Alice!';
            mockRichTextState.facets = [{ index: { byteStart: 0, byteEnd: 5 }, features: [] }];
            mockSendMessage.mockResolvedValueOnce({ data: MESSAGE_VIEW });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.sendDirectMessage('convo-001', 'Hello Alice!');
            expect(mockSendMessage).toHaveBeenCalledWith({
                convoId: 'convo-001',
                message: {
                    text:   'Hello Alice!',
                    facets: [{ index: { byteStart: 0, byteEnd: 5 }, features: [] }],
                },
            });
            expect(result).toMatchObject({ id: 'msg-001', text: 'Hello there!', senderDid: 'did:plc:member1' });
        });

        test('throws BskyValidationError when text exceeds 1000 graphemes', async () => {
            mockRichTextState.graphemeLength = 1001;
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            let thrownError: unknown;
            try {
                await client.sendDirectMessage('convo-001', 'x'.repeat(1001));
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeInstanceOf(BskyValidationError);
            expect((thrownError as BskyValidationError).context).toMatchObject({ graphemeLength: 1001 });
        });

        test('sends message when text is exactly 1000 graphemes (boundary)', async () => {
            mockRichTextState.graphemeLength = 1000;
            mockRichTextState.text   = 'x'.repeat(1000);
            mockSendMessage.mockResolvedValueOnce({ data: MESSAGE_VIEW });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.sendDirectMessage('convo-001', 'x'.repeat(1000));
            expect(result).toBeDefined();
            expect(mockSendMessage).toHaveBeenCalledTimes(1);
        });

        test('maps other errors to BskyError but re-throws BskyValidationError', async () => {
            mockRichTextState.graphemeLength = 10;
            mockSendMessage.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Unauthorized'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            let thrownError: unknown;
            try {
                await client.sendDirectMessage('convo-001', 'Hello!');
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeInstanceOf(BskyAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // markConversationRead()
    // -----------------------------------------------------------------------

    describe('markConversationRead()', () => {
        test('calls updateRead with convoId', async () => {
            mockUpdateRead.mockResolvedValueOnce({ data: {} });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            await client.markConversationRead('convo-001');
            expect(mockUpdateRead).toHaveBeenCalledWith({ convoId: 'convo-001' });
        });

        test('maps errors to BskyError', async () => {
            mockUpdateRead.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Unauthorized'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            let thrownError: unknown;
            try {
                await client.markConversationRead('convo-001');
            } catch (e) {
                thrownError = e;
            }
            expect(thrownError).toBeInstanceOf(BskyAuthError);
        });
    });

    // -----------------------------------------------------------------------
    // Post embed normalization (normalizePostEmbed via getPost / getFeed)
    // -----------------------------------------------------------------------

    describe('post embed normalization', () => {
        test('normalizes image embed in a post', async () => {
            const POST_WITH_IMAGE_EMBED = {
                ...POST_VIEW,
                embed: {
                    $type:  'app.bsky.embed.images#view',
                    images: [
                        {
                            thumb:    'https://cdn.bsky.app/thumb.jpg',
                            fullsize: 'https://cdn.bsky.app/full.jpg',
                            alt:      'A test image',
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_IMAGE_EMBED] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toEqual({
                type:   'images',
                images: [{
                    thumb:    'https://cdn.bsky.app/thumb.jpg',
                    fullsize: 'https://cdn.bsky.app/full.jpg',
                    alt:      'A test image',
                }],
            });
        });

        test('normalizes image embed with aspect ratio', async () => {
            const POST_WITH_IMAGE_AR = {
                ...POST_VIEW,
                embed: {
                    $type:  'app.bsky.embed.images#view',
                    images: [
                        {
                            thumb:       'https://cdn.bsky.app/thumb.jpg',
                            fullsize:    'https://cdn.bsky.app/full.jpg',
                            alt:         'Wide image',
                            aspectRatio: { width: 16, height: 9 },
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_IMAGE_AR] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toMatchObject({
                type:   'images',
                images: [{ aspectRatio: { width: 16, height: 9 } }],
            });
        });

        test('normalizes video embed in a post', async () => {
            const POST_WITH_VIDEO_EMBED = {
                ...POST_VIEW,
                embed: {
                    $type:     'app.bsky.embed.video#view',
                    cid:       'bafyvideo123',
                    playlist:  'https://video.bsky.app/playlist.m3u8',
                    thumbnail: 'https://video.bsky.app/thumb.jpg',
                    alt:       'A test video',
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_VIDEO_EMBED] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toEqual({
                type:  'video',
                video: {
                    cid:       'bafyvideo123',
                    playlist:  'https://video.bsky.app/playlist.m3u8',
                    thumbnail: 'https://video.bsky.app/thumb.jpg',
                    alt:       'A test video',
                },
            });
        });

        test('normalizes video embed without optional fields', async () => {
            const POST_WITH_MINIMAL_VIDEO = {
                ...POST_VIEW,
                embed: {
                    $type:    'app.bsky.embed.video#view',
                    cid:      'bafyvideo456',
                    playlist: 'https://video.bsky.app/playlist2.m3u8',
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_MINIMAL_VIDEO] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toMatchObject({ type: 'video', video: { cid: 'bafyvideo456' } });
            expect((post.embed as { type: 'video', video: { thumbnail?: string } }).video.thumbnail).toBeUndefined();
        });

        test('normalizes video embed with aspect ratio', async () => {
            const POST_WITH_VIDEO_AR = {
                ...POST_VIEW,
                embed: {
                    $type:       'app.bsky.embed.video#view',
                    cid:         'bafyvideo789',
                    playlist:    'https://video.bsky.app/playlist3.m3u8',
                    aspectRatio: { width: 4, height: 3 },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_VIDEO_AR] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toMatchObject({
                type:  'video',
                video: { aspectRatio: { width: 4, height: 3 } },
            });
        });

        test('normalizes external link embed in a post', async () => {
            const POST_WITH_EXTERNAL_EMBED = {
                ...POST_VIEW,
                embed: {
                    $type:    'app.bsky.embed.external#view',
                    external: {
                        uri:         'https://example.com/article',
                        title:       'Example Article',
                        description: 'An interesting article',
                        thumb:       'https://example.com/thumb.jpg',
                    },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_EXTERNAL_EMBED] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toEqual({
                type:     'external',
                external: {
                    uri:         'https://example.com/article',
                    title:       'Example Article',
                    description: 'An interesting article',
                    thumbnail:   'https://example.com/thumb.jpg',
                },
            });
        });

        test('normalizes external embed without thumbnail', async () => {
            const POST_WITH_EXTERNAL_NO_THUMB = {
                ...POST_VIEW,
                embed: {
                    $type:    'app.bsky.embed.external#view',
                    external: {
                        uri:         'https://example.com/article2',
                        title:       'No Thumbnail Article',
                        description: 'No image here',
                    },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_EXTERNAL_NO_THUMB] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toMatchObject({ type: 'external' });
            expect((post.embed as { type: 'external', external: { thumbnail?: string } }).external.thumbnail).toBeUndefined();
        });

        test('normalizes record embed (quote post)', async () => {
            const POST_WITH_RECORD_EMBED = {
                ...POST_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:     'app.bsky.embed.record#viewRecord',
                        uri:       'at://did:plc:author123/app.bsky.feed.post/quoted1',
                        cid:       'bafyquoted1',
                        author:    AUTHOR_BASIC,
                        value:     { text: 'Quoted post text', createdAt: '2026-03-01T10:00:00.000Z' },
                        indexedAt: '2026-03-01T10:00:01.000Z',
                    },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_RECORD_EMBED] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toMatchObject({
                type:   'record',
                record: {
                    uri:       'at://did:plc:author123/app.bsky.feed.post/quoted1',
                    cid:       'bafyquoted1',
                    text:      'Quoted post text',
                    createdAt: '2026-03-01T10:00:00.000Z',
                    indexedAt: '2026-03-01T10:00:01.000Z',
                    author:    { handle: AUTHOR_BASIC.handle },
                },
            });
        });

        test('normalizes recordWithMedia embed', async () => {
            const POST_WITH_RECORD_WITH_MEDIA = {
                ...POST_VIEW,
                embed: {
                    $type:  'app.bsky.embed.recordWithMedia#view',
                    record: {
                        record: {
                            $type:     'app.bsky.embed.record#viewRecord',
                            uri:       'at://did:plc:author123/app.bsky.feed.post/quoted2',
                            cid:       'bafyquoted2',
                            author:    AUTHOR_BASIC,
                            value:     { text: 'Post with attached media', createdAt: '2026-03-02T10:00:00.000Z' },
                            indexedAt: '2026-03-02T10:00:01.000Z',
                        },
                    },
                    media: {
                        $type:  'app.bsky.embed.images#view',
                        images: [{
                            thumb:    'https://cdn.bsky.app/media-thumb.jpg',
                            fullsize: 'https://cdn.bsky.app/media-full.jpg',
                            alt:      'Attached image',
                        }],
                    },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_RECORD_WITH_MEDIA] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toMatchObject({
                type:   'recordWithMedia',
                record: { uri: 'at://did:plc:author123/app.bsky.feed.post/quoted2', text: 'Post with attached media' },
                media:  { type: 'images' },
            });
        });

        test('returns undefined embed for recordWithMedia when record is not a ViewRecord', async () => {
            const POST_WITH_INVALID_RWM = {
                ...POST_VIEW,
                embed: {
                    $type:  'app.bsky.embed.recordWithMedia#view',
                    record: {
                        record: {
                            $type:    'app.bsky.embed.record#viewNotFound',
                            uri:      'at://did:plc:author123/app.bsky.feed.post/gone',
                            notFound: true,
                        },
                    },
                    media: {
                        $type:  'app.bsky.embed.images#view',
                        images: [],
                    },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_INVALID_RWM] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toBeUndefined();
        });

        test('returns undefined embed for recordWithMedia when media is unrecognized type', async () => {
            const POST_WITH_UNKNOWN_MEDIA = {
                ...POST_VIEW,
                embed: {
                    $type:  'app.bsky.embed.recordWithMedia#view',
                    record: {
                        record: {
                            $type:     'app.bsky.embed.record#viewRecord',
                            uri:       'at://did:plc:author123/app.bsky.feed.post/quoted3',
                            cid:       'bafyquoted3',
                            author:    AUTHOR_BASIC,
                            value:     { text: 'Post text', createdAt: '2026-03-03T10:00:00.000Z' },
                            indexedAt: '2026-03-03T10:00:01.000Z',
                        },
                    },
                    media: {
                        $type: 'app.bsky.embed.unknown#view',
                    },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_UNKNOWN_MEDIA] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toBeUndefined();
        });

        test('returns undefined embed for unknown embed type', async () => {
            const POST_WITH_UNKNOWN_EMBED = {
                ...POST_VIEW,
                embed: {
                    $type: 'app.bsky.embed.future#view',
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_UNKNOWN_EMBED] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toBeUndefined();
        });

        test('returns undefined embed when post has no embed field', async () => {
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_VIEW] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toBeUndefined();
        });

        test('normalizes nested embeds on a quoted post', async () => {
            const POST_WITH_NESTED_EMBEDS = {
                ...POST_VIEW,
                embed: {
                    $type:  'app.bsky.embed.record#view',
                    record: {
                        $type:     'app.bsky.embed.record#viewRecord',
                        uri:       'at://did:plc:author123/app.bsky.feed.post/quoted-with-image',
                        cid:       'bafyquotedimg1',
                        author:    AUTHOR_BASIC,
                        value:     { text: 'Post with an image', createdAt: '2026-03-04T10:00:00.000Z' },
                        indexedAt: '2026-03-04T10:00:01.000Z',
                        embeds:    [
                            {
                                $type:  'app.bsky.embed.images#view',
                                images: [{
                                    thumb:    'https://cdn.bsky.app/nested-thumb.jpg',
                                    fullsize: 'https://cdn.bsky.app/nested-full.jpg',
                                    alt:      'Nested image',
                                }],
                            },
                        ],
                    },
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_NESTED_EMBEDS] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.embed).toMatchObject({ type: 'record' });
            const recordEmbed = post.embed as { type: 'record', record: { embeds?: { type: string }[] } };
            expect(recordEmbed.record.embeds).toHaveLength(1);
            expect(recordEmbed.record.embeds?.[0]).toMatchObject({ type: 'images' });
        });
    });

    // -----------------------------------------------------------------------
    // Facet normalization (normalizeFacets via getPost / getMessages)
    // -----------------------------------------------------------------------

    describe('facet normalization', () => {
        test('normalizes mention facet with DID resolved to handle', async () => {
            const POST_WITH_MENTION = {
                ...POST_VIEW,
                record: {
                    ...POST_RECORD,
                    facets: [
                        {
                            index:    { byteStart: 6, byteEnd: 28 },
                            features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:mentioned123' }],
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_MENTION] } });
            mockGetProfile.mockResolvedValueOnce({ data: { did: 'did:plc:mentioned123', handle: 'mentioned.bsky.social' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.facets).toHaveLength(1);
            expect(post.facets?.[0]).toEqual({
                index:    { byteStart: 6, byteEnd: 28 },
                features: [{ type: 'mention', handle: 'mentioned.bsky.social' }],
            });
        });

        test('falls back to DID if getProfile throws during mention resolution', async () => {
            const POST_WITH_MENTION = {
                ...POST_VIEW,
                record: {
                    ...POST_RECORD,
                    facets: [
                        {
                            index:    { byteStart: 0, byteEnd: 20 },
                            features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:unknown999' }],
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_MENTION] } });
            mockGetProfile.mockRejectedValueOnce(new Error('Profile not found'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.facets?.[0]?.features?.[0]).toEqual({ type: 'mention', handle: 'did:plc:unknown999' });
        });

        test('deduplicates DID lookups within a single post (caching)', async () => {
            const POST_WITH_DUPLICATE_MENTIONS = {
                ...POST_VIEW,
                record: {
                    ...POST_RECORD,
                    facets: [
                        {
                            index:    { byteStart: 0, byteEnd: 20 },
                            features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:cached123' }],
                        },
                        {
                            index:    { byteStart: 30, byteEnd: 50 },
                            features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:cached123' }],
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_DUPLICATE_MENTIONS] } });
            mockGetProfile.mockResolvedValueOnce({ data: { did: 'did:plc:cached123', handle: 'cached.bsky.social' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            // getProfile should only be called once even with two facets for the same DID
            expect(mockGetProfile).toHaveBeenCalledTimes(1);
            expect(post.facets).toHaveLength(2);
            expect(post.facets?.[0]?.features?.[0]).toEqual({ type: 'mention', handle: 'cached.bsky.social' });
            expect(post.facets?.[1]?.features?.[0]).toEqual({ type: 'mention', handle: 'cached.bsky.social' });
        });

        test('deduplicates DID lookups across multiple posts in a single getFeed call', async () => {
            const MENTION_FACET = {
                index:    { byteStart: 0, byteEnd: 20 },
                features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:crosspost123' }],
            };
            const POST_A = {
                ...POST_VIEW,
                uri:    'at://did:plc:author123/app.bsky.feed.post/post-a',
                cid:    'bafypost-a',
                record: { ...POST_RECORD, facets: [MENTION_FACET] },
            };
            const POST_B = {
                ...POST_VIEW,
                uri:    'at://did:plc:author123/app.bsky.feed.post/post-b',
                cid:    'bafypost-b',
                record: { ...POST_RECORD, facets: [MENTION_FACET] },
            };
            mockGetTimeline.mockResolvedValueOnce({ data: { feed: [{ post: POST_A }, { post: POST_B }], cursor: undefined } });
            mockGetProfile.mockResolvedValue({ data: { did: 'did:plc:crosspost123', handle: 'crosspost.bsky.social' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const result = await client.getFeed();
            // getProfile should only be called once even though both posts mention the same DID
            expect(mockGetProfile).toHaveBeenCalledTimes(1);
            expect(result.items[0]?.post.facets?.[0]?.features?.[0]).toEqual({ type: 'mention', handle: 'crosspost.bsky.social' });
            expect(result.items[1]?.post.facets?.[0]?.features?.[0]).toEqual({ type: 'mention', handle: 'crosspost.bsky.social' });
        });

        test('normalizes link facet', async () => {
            const POST_WITH_LINK = {
                ...POST_VIEW,
                record: {
                    ...POST_RECORD,
                    facets: [
                        {
                            index:    { byteStart: 10, byteEnd: 32 },
                            features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/article' }],
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_LINK] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.facets?.[0]).toEqual({
                index:    { byteStart: 10, byteEnd: 32 },
                features: [{ type: 'link', uri: 'https://example.com/article' }],
            });
        });

        test('normalizes tag facet', async () => {
            const POST_WITH_TAG = {
                ...POST_VIEW,
                record: {
                    ...POST_RECORD,
                    facets: [
                        {
                            index:    { byteStart: 20, byteEnd: 35 },
                            features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'typescript' }],
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_TAG] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.facets?.[0]).toEqual({
                index:    { byteStart: 20, byteEnd: 35 },
                features: [{ type: 'tag', tag: 'typescript' }],
            });
        });

        test('skips unknown feature types', async () => {
            const POST_WITH_UNKNOWN_FACET = {
                ...POST_VIEW,
                record: {
                    ...POST_RECORD,
                    facets: [
                        {
                            index:    { byteStart: 0, byteEnd: 10 },
                            features: [{ $type: 'app.bsky.richtext.facet#future', data: 'something' }],
                        },
                    ],
                },
            };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_WITH_UNKNOWN_FACET] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            // Facet with all-unknown features should be omitted
            expect(post.facets).toBeUndefined();
        });

        test('returns undefined facets when post has no facets', async () => {
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [POST_VIEW] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            const post   = await client.getPost(POST_VIEW.uri);
            expect(post.facets).toBeUndefined();
        });

        test('omits facets when record.facets is empty array', async () => {
            const postView = { ...POST_VIEW, record: { ...POST_RECORD, facets: [] } };
            mockGetPosts.mockResolvedValueOnce({ data: { posts: [postView] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getPost(POST_VIEW.uri);
            expect(result.facets).toBeUndefined();
        });

        test('normalizes facets in a DM message', async () => {
            const MESSAGE_WITH_FACETS = {
                ...MESSAGE_VIEW,
                facets: [
                    {
                        index:    { byteStart: 0, byteEnd: 22 },
                        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
                    },
                ],
            };
            mockGetMessages.mockResolvedValueOnce({ data: { messages: [MESSAGE_WITH_FACETS] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages[0]?.facets).toHaveLength(1);
            expect(result.messages[0]?.facets?.[0]).toEqual({
                index:    { byteStart: 0, byteEnd: 22 },
                features: [{ type: 'link', uri: 'https://example.com' }],
            });
        });

        test('returns undefined facets when DM has no facets', async () => {
            mockGetMessages.mockResolvedValueOnce({ data: { messages: [MESSAGE_VIEW] } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages[0]?.facets).toBeUndefined();
        });

        test('normalizes mention facet in a DM message', async () => {
            const MESSAGE_WITH_MENTION_FACET = {
                ...MESSAGE_VIEW,
                facets: [
                    {
                        index:    { byteStart: 5, byteEnd: 28 },
                        features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:dm-mentioned' }],
                    },
                ],
            };
            mockGetMessages.mockResolvedValueOnce({ data: { messages: [MESSAGE_WITH_MENTION_FACET] } });
            mockGetProfile.mockResolvedValueOnce({ data: { did: 'did:plc:dm-mentioned', handle: 'dm-mentioned.bsky.social' } });
            const client = new BlueskyClient(CLIENT_OPTIONS);
            await client.login();
            const result = await client.getMessages('convo-001');
            expect(result.messages[0]?.facets?.[0]?.features?.[0]).toEqual({
                type:   'mention',
                handle: 'dm-mentioned.bsky.social',
            });
        });
    });

    // -----------------------------------------------------------------------
    // Health registry integration
    // -----------------------------------------------------------------------

    describe('health registry', () => {
        test('sends CONNECTION_LOST to health registry on runtime 401 error', async () => {
            const mockSendEvent    = mock(() => undefined);
            const healthRegistry   = { sendEvent: mockSendEvent } as unknown as ServiceHealthRegistry;
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Token expired'));
            const client = new BlueskyClient({ ...CLIENT_OPTIONS, healthRegistry });
            expect(client.getFeed()).rejects.toBeInstanceOf(BskyAuthError);
            await Promise.resolve();
            expect(mockSendEvent).toHaveBeenCalledWith('bluesky', 'CONNECTION_LOST', expect.objectContaining({ error: expect.any(String) }));
        });

        test('does not send CONNECTION_LOST on rate limit error (429)', async () => {
            const mockSendEvent  = mock(() => undefined);
            const healthRegistry = { sendEvent: mockSendEvent } as unknown as ServiceHealthRegistry;
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(429, 'RateLimitExceeded', 'Too many requests'));
            const client = new BlueskyClient({ ...CLIENT_OPTIONS, healthRegistry });
            expect(client.getFeed()).rejects.toBeInstanceOf(BskyRateLimitError);
            await Promise.resolve();
            expect(mockSendEvent).not.toHaveBeenCalled();
        });

        test('does not send CONNECTION_LOST on generic XRPC error', async () => {
            const mockSendEvent  = mock(() => undefined);
            const healthRegistry = { sendEvent: mockSendEvent } as unknown as ServiceHealthRegistry;
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(500, 'InternalError', 'Server error'));
            const client = new BlueskyClient({ ...CLIENT_OPTIONS, healthRegistry });
            expect(client.getFeed()).rejects.toBeInstanceOf(BskyError);
            await Promise.resolve();
            expect(mockSendEvent).not.toHaveBeenCalled();
        });

        test('does not send CONNECTION_LOST when no health registry provided', async () => {
            mockGetTimeline.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Token expired'));
            const client = new BlueskyClient(CLIENT_OPTIONS);
            // Should not throw from missing registry
            expect(client.getFeed()).rejects.toBeInstanceOf(BskyAuthError);
        });

        test('does not send CONNECTION_LOST on login 401 (handled by reconnection loop)', async () => {
            const mockSendEvent  = mock(() => undefined);
            const healthRegistry = { sendEvent: mockSendEvent } as unknown as ServiceHealthRegistry;
            mockLogin.mockRejectedValueOnce(makeXRPCError(401, 'AuthRequired', 'Invalid credentials'));
            const client = new BlueskyClient({ ...CLIENT_OPTIONS, healthRegistry });
            expect(client.login()).rejects.toBeInstanceOf(BskyAuthError);
            await Promise.resolve();
            expect(mockSendEvent).not.toHaveBeenCalled();
        });
    });
});
