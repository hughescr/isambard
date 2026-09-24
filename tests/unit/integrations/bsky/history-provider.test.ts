import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { HistoryFetchParams } from '../../../../src/agent/history-providers/types';
import type { BlueskyClient } from '../../../../src/integrations/bsky/client';
import { BskyHistoryProvider } from '../../../../src/integrations/bsky/history-provider';
import type { BskyConversation, BskyDirectMessage, BskyFeedItem, BskyPost } from '../../../../src/integrations/bsky/types';
import { mockLogger } from '../../../setup';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makePost(overrides: Partial<BskyPost> = {}): BskyPost {
    return {
        uri:         'at://did:plc:test/app.bsky.feed.post/post1',
        cid:         'bafy1',
        author:      { did: 'did:plc:alice', handle: 'alice.bsky.social' },
        text:        'Hello world',
        createdAt:   '2026-03-28T10:00:00.000Z',
        replyCount:  0,
        likeCount:   0,
        repostCount: 0,
        indexedAt:   '2026-03-28T10:00:00.000Z',
        ...overrides,
    };
}

function makeFeedItem(postOverrides: Partial<BskyPost> = {}): BskyFeedItem {
    return { post: makePost(postOverrides) };
}

function makeMessage(overrides: Partial<BskyDirectMessage> = {}): BskyDirectMessage {
    return {
        id:        'msg-1',
        rev:       'rev-1',
        text:      'Hey there',
        senderDid: 'did:plc:alice',
        sentAt:    '2026-03-28T10:00:00.000Z',
        ...overrides,
    };
}

function makeConversation(overrides: Partial<BskyConversation> = {}): BskyConversation {
    const members = [
        { did: 'did:plc:alice', handle: 'alice.bsky.social' },
        { did: 'did:plc:self',  handle: 'me.bsky.social' },
    ];
    return {
        id:          'convo-abc',
        rev:         'rev-1',
        members,
        muted:       false,
        unreadCount: 0,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Mock BlueskyClient
// ---------------------------------------------------------------------------

const mockGetAuthorFeed     = mock(async (): Promise<{ items: BskyFeedItem[], cursor?: string }> => ({ items: [] }));
const mockListConversations = mock(async (): Promise<{ conversations: BskyConversation[], cursor?: string }> => ({ conversations: [] }));
const mockGetMessages       = mock(async (): Promise<{ messages: BskyDirectMessage[], cursor?: string }> => ({ messages: [] }));

function makeMockClient(): BlueskyClient {
    return {
        getAuthorFeed:     mockGetAuthorFeed,
        listConversations: mockListConversations,
        getMessages:       mockGetMessages,
        ownHandle:         'me.bsky.social',
    } as unknown as BlueskyClient;
}

const ALICE_DID = 'did:plc:alice';

function conversationParams(overrides: Partial<HistoryFetchParams> = {}): HistoryFetchParams {
    return {
        identifier: 'alice.bsky.social',
        scope:      { platform: 'bsky', kind: 'direct-conversation', participantDid: ALICE_DID },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BskyHistoryProvider', () => {
    let client:   BlueskyClient;
    let provider: BskyHistoryProvider;

    beforeEach(() => {
        mockLogger.warn.mockReset();
        mockGetAuthorFeed.mockReset();
        mockListConversations.mockReset();
        mockGetMessages.mockReset();

        // Default: empty results
        mockGetAuthorFeed.mockImplementation(async () => ({ items: [] }));
        mockListConversations.mockImplementation(async () => ({ conversations: [] }));
        mockGetMessages.mockImplementation(async () => ({ messages: [] }));

        client   = makeMockClient();
        provider = new BskyHistoryProvider(client);
    });

    test('has platform = "bsky"', () => {
        expect(provider.platform).toBe('bsky');
    });

    // ---------------------------------------------------------------------------
    // Author feed
    // ---------------------------------------------------------------------------

    describe('author-feed scope', () => {
        test('fetches author feed with identifier as actor', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({
                items: [makeFeedItem({ text: 'Post one', createdAt: '2026-03-28T09:00:00.000Z' })],
            }));

            const { entries: results } = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(mockGetAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 10);
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                platform:  'bsky',
                direction: 'inbound',
                timestamp: '2026-03-28T09:00:00.000Z',
            });
            expect(results[0].summary).toBe('@alice.bsky.social: Post one');
        });

        test('reads the author feed for an explicit author-feed scope', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({ items: [makeFeedItem({ text: 'scoped' })] }));

            const result = await provider.fetchHistory({ identifier: 'alice.bsky.social', scope: { platform: 'bsky', kind: 'author-feed' } });

            expect(result.entries.map(entry => entry.summary)).toEqual(['@alice.bsky.social: scoped']);
            expect(mockListConversations).not.toHaveBeenCalled();
        });

        test('respects maxMessages parameter', async () => {
            await provider.fetchHistory({ identifier: 'alice.bsky.social', maxMessages: 25 });

            expect(mockGetAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 25);
        });

        test('uses default of 10 when maxMessages not specified', async () => {
            await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(mockGetAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 10);
        });

        test('truncates long post text to ~200 chars', async () => {
            const longText = 'A'.repeat(300);
            mockGetAuthorFeed.mockImplementation(async () => ({
                items: [makeFeedItem({ text: longText })],
            }));

            const { entries: results } = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(results[0].summary.length).toBeLessThanOrEqual(220); // handle + ': ' + ~200 chars
        });

        test('preserves text of exactly 200 chars without truncating', async () => {
            const text200 = 'B'.repeat(200);
            mockGetAuthorFeed.mockImplementation(async () => ({
                items: [makeFeedItem({ text: text200 })],
            }));

            const { entries: results } = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(results[0].summary).toBe(`@alice.bsky.social: ${text200}`);
        });

        test('reports an author-feed API error as unavailable with one transient failure', async () => {
            const error = new Error('API failure');
            mockGetAuthorFeed.mockImplementation(async () => {
                throw error;
            });

            const result = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(result).toEqual({
                platform:  'bsky',
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [{ source: 'author-feed', category: 'transient', error }],
            });
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: error, source: 'author-feed' }, 'BskyHistoryProvider: failed to fetch history');
        });

        test('reports an empty author feed as complete coverage with no entries', async () => {
            const result = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(result).toEqual({ platform: 'bsky', entries: [], coverage: 'complete', truncated: false, failures: [] });
        });

        test('marks the author feed truncated when the API returns a next-page cursor', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({ items: [makeFeedItem()], cursor: 'next-page' }));

            const result = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(result.truncated).toBe(true);
            expect(result.coverage).toBe('complete');
        });

        test('converts multiple feed items to HistoryEntry[]', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({
                items: [
                    makeFeedItem({ text: 'First post',  createdAt: '2026-03-28T09:00:00.000Z', uri: 'at://uri1' }),
                    makeFeedItem({ text: 'Second post', createdAt: '2026-03-28T08:00:00.000Z', uri: 'at://uri2' }),
                ],
            }));

            const { entries: results } = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(results).toHaveLength(2);
            expect(results[0].summary).toContain('First post');
            expect(results[1].summary).toContain('Second post');
        });
    });

    // ---------------------------------------------------------------------------
    // Direct conversation
    // ---------------------------------------------------------------------------

    describe('direct-conversation scope', () => {
        test('lists conversations and finds matching one by DID', async () => {
            const convo = makeConversation({
                id:      'convo-alice',
                members: [
                    { did: ALICE_DID,       handle: 'alice.bsky.social' },
                    { did: 'did:plc:self',  handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));
            mockGetMessages.mockImplementation(async () => ({
                messages: [makeMessage({ text: 'Hi Alice', senderDid: 'did:plc:self', sentAt: '2026-03-28T10:00:00.000Z' })],
            }));

            const result = await provider.fetchHistory(conversationParams());

            expect(mockListConversations).toHaveBeenCalled();
            expect(mockGetMessages).toHaveBeenCalledWith('convo-alice', 10);
            expect(result).toEqual({
                platform:  'bsky',
                entries:   [{ platform: 'bsky', timestamp: '2026-03-28T10:00:00.000Z', summary: 'Hi Alice', direction: 'mutual' }],
                coverage:  'complete',
                truncated: false,
                failures:  [],
            });
        });

        test('reports no matching conversation as complete coverage with no entries', async () => {
            const convo = makeConversation({
                members: [
                    { did: 'did:plc:bob',  handle: 'bob.bsky.social' },
                    { did: 'did:plc:self', handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));

            const result = await provider.fetchHistory(conversationParams());

            expect(result).toEqual({ platform: 'bsky', entries: [], coverage: 'complete', truncated: false, failures: [] });
            expect(mockGetMessages).not.toHaveBeenCalled();
        });

        test('reports every DM as mutual direction because the bot DID is not known to the port', async () => {
            const convo = makeConversation({ id: 'convo-alice' });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));
            mockGetMessages.mockImplementation(async () => ({
                messages: [
                    makeMessage({ senderDid: ALICE_DID,      text: 'Hello!',   sentAt: '2026-03-28T10:00:00.000Z' }),
                    makeMessage({ senderDid: 'did:plc:self', text: 'Hi back!', sentAt: '2026-03-28T10:01:00.000Z' }),
                ],
            }));

            const { entries } = await provider.fetchHistory(conversationParams());

            expect(entries.map(entry => entry.direction)).toEqual(['mutual', 'mutual']);
        });

        test('marks the conversation truncated when the API returns a next-page cursor', async () => {
            mockListConversations.mockImplementation(async () => ({ conversations: [makeConversation()] }));
            mockGetMessages.mockImplementation(async () => ({ messages: [makeMessage()], cursor: 'older' }));

            const result = await provider.fetchHistory(conversationParams());

            expect(result.truncated).toBe(true);
        });

        test('respects maxMessages when fetching DM conversation messages', async () => {
            const convo = makeConversation({ id: 'convo-alice' });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));

            await provider.fetchHistory(conversationParams({ maxMessages: 20 }));

            expect(mockGetMessages).toHaveBeenCalledWith('convo-alice', 20);
        });

        test('reports a listConversations API error as unavailable with one transient failure', async () => {
            const error = new Error('API failure');
            mockListConversations.mockImplementation(async () => {
                throw error;
            });

            const result = await provider.fetchHistory(conversationParams());

            expect(result).toEqual({
                platform:  'bsky',
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [{ source: 'direct-conversation', category: 'transient', error }],
            });
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: error, source: 'direct-conversation' }, 'BskyHistoryProvider: failed to fetch history');
        });

        test('does not call getAuthorFeed for a direct-conversation scope', async () => {
            mockListConversations.mockImplementation(async () => ({ conversations: [makeConversation()] }));

            await provider.fetchHistory(conversationParams());

            expect(mockGetAuthorFeed).not.toHaveBeenCalled();
        });

        test('includes DM text in summary', async () => {
            mockListConversations.mockImplementation(async () => ({ conversations: [makeConversation()] }));
            mockGetMessages.mockImplementation(async () => ({
                messages: [makeMessage({ text: 'Interesting message content', senderDid: ALICE_DID })],
            }));

            const { entries: results } = await provider.fetchHistory(conversationParams());

            expect(results[0].summary).toContain('Interesting message content');
        });
    });
});
