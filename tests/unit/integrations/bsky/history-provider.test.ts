import { describe, test, expect, mock, beforeEach } from 'bun:test';
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
const mockGetPost           = mock(async (): Promise<BskyPost> => makePost());
const mockListConversations = mock(async (): Promise<{ conversations: BskyConversation[], cursor?: string }> => ({ conversations: [] }));
const mockGetMessages       = mock(async (): Promise<{ messages: BskyDirectMessage[], cursor?: string }> => ({ messages: [] }));

function makeMockClient(): BlueskyClient {
    return {
        getAuthorFeed:     mockGetAuthorFeed,
        getPost:           mockGetPost,
        listConversations: mockListConversations,
        getMessages:       mockGetMessages,
        ownHandle:         'me.bsky.social',
    } as unknown as BlueskyClient;
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
        mockGetPost.mockReset();
        mockListConversations.mockReset();
        mockGetMessages.mockReset();

        // Default: empty results
        mockGetAuthorFeed.mockImplementation(async () => ({ items: [] }));
        mockGetPost.mockImplementation(async () => makePost());
        mockListConversations.mockImplementation(async () => ({ conversations: [] }));
        mockGetMessages.mockImplementation(async () => ({ messages: [] }));

        client   = makeMockClient();
        provider = new BskyHistoryProvider(client);
    });

    test('has platform = "bsky"', () => {
        expect(provider.platform).toBe('bsky');
    });

    // ---------------------------------------------------------------------------
    // General mode (author feed)
    // ---------------------------------------------------------------------------

    describe('general mode (no metadata)', () => {
        test('fetches author feed with identifier as actor', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({
                items: [makeFeedItem({ text: 'Post one', createdAt: '2026-03-28T09:00:00.000Z' })],
            }));

            const results = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(mockGetAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 10);
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                platform:  'bsky',
                direction: 'inbound',
                timestamp: '2026-03-28T09:00:00.000Z',
            });
            expect(results[0].summary).toContain('@alice.bsky.social');
            expect(results[0].summary).toContain('Post one');
        });

        test('respects maxMessages parameter', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({ items: [] }));

            await provider.fetchHistory({ identifier: 'alice.bsky.social', maxMessages: 25 });

            expect(mockGetAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 25);
        });

        test('uses default of 10 when maxMessages not specified', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({ items: [] }));

            await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(mockGetAuthorFeed).toHaveBeenCalledWith('alice.bsky.social', 10);
        });

        test('truncates long post text to ~200 chars', async () => {
            const longText = 'A'.repeat(300);
            mockGetAuthorFeed.mockImplementation(async () => ({
                items: [makeFeedItem({ text: longText })],
            }));

            const results = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(results[0].summary.length).toBeLessThanOrEqual(220); // handle + ': ' + ~200 chars
        });

        test('returns empty array on API error', async () => {
            mockGetAuthorFeed.mockImplementation(async () => {
                throw new Error('API failure');
            });

            const results = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(results).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('returns empty array when feed is empty', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({ items: [] }));

            const results = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(results).toEqual([]);
        });

        test('converts multiple feed items to HistoryEntry[]', async () => {
            mockGetAuthorFeed.mockImplementation(async () => ({
                items: [
                    makeFeedItem({ text: 'First post',  createdAt: '2026-03-28T09:00:00.000Z', uri: 'at://uri1' }),
                    makeFeedItem({ text: 'Second post', createdAt: '2026-03-28T08:00:00.000Z', uri: 'at://uri2' }),
                ],
            }));

            const results = await provider.fetchHistory({ identifier: 'alice.bsky.social' });

            expect(results).toHaveLength(2);
            expect(results[0].summary).toContain('First post');
            expect(results[1].summary).toContain('Second post');
        });
    });

    // ---------------------------------------------------------------------------
    // Thread mode (parentUri metadata)
    // ---------------------------------------------------------------------------

    describe('thread mode (parentUri metadata)', () => {
        const PARENT_URI = 'at://did:plc:test/app.bsky.feed.post/parent123';

        test('fetches parent post when parentUri metadata provided', async () => {
            const parentPost = makePost({
                uri:       PARENT_URI,
                text:      'Parent post content',
                createdAt: '2026-03-27T12:00:00.000Z',
                author:    { did: 'did:plc:alice', handle: 'alice.bsky.social' },
            });
            mockGetPost.mockImplementation(async () => parentPost);

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { parentUri: PARENT_URI },
            });

            expect(mockGetPost).toHaveBeenCalledWith(PARENT_URI);
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                platform:  'bsky',
                timestamp: '2026-03-27T12:00:00.000Z',
            });
            expect(results[0].summary).toContain('Parent post content');
        });

        test('returns entry with inbound direction for parent post', async () => {
            const parentPost = makePost({
                uri:    PARENT_URI,
                author: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
            });
            mockGetPost.mockImplementation(async () => parentPost);

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { parentUri: PARENT_URI },
            });

            expect(results[0].direction).toBe('inbound');
        });

        test('does not call getAuthorFeed when parentUri is provided', async () => {
            mockGetPost.mockImplementation(async () => makePost({ uri: PARENT_URI }));

            await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { parentUri: PARENT_URI },
            });

            expect(mockGetAuthorFeed).not.toHaveBeenCalled();
        });

        test('returns empty array on API error in thread mode', async () => {
            mockGetPost.mockImplementation(async () => {
                throw new Error('Post not found');
            });

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { parentUri: PARENT_URI },
            });

            expect(results).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------------------
    // DM mode (bskyDid metadata)
    // ---------------------------------------------------------------------------

    describe('DM mode (bskyDid metadata)', () => {
        const ALICE_DID = 'did:plc:alice';

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

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { bskyDid: ALICE_DID },
            });

            expect(mockListConversations).toHaveBeenCalled();
            expect(mockGetMessages).toHaveBeenCalledWith('convo-alice', 10);
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                platform:  'bsky',
                timestamp: '2026-03-28T10:00:00.000Z',
            });
        });

        test('returns empty array when no conversation matches bskyDid', async () => {
            const convo = makeConversation({
                members: [
                    { did: 'did:plc:bob',  handle: 'bob.bsky.social' },
                    { did: 'did:plc:self', handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { bskyDid: ALICE_DID },
            });

            expect(results).toEqual([]);
            expect(mockGetMessages).not.toHaveBeenCalled();
        });

        test('sets direction correctly: inbound from other, outbound from self', async () => {
            const selfDid = 'did:plc:self';
            const convo = makeConversation({
                id:      'convo-alice',
                members: [
                    { did: ALICE_DID, handle: 'alice.bsky.social' },
                    { did: selfDid,   handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));
            mockGetMessages.mockImplementation(async () => ({
                messages: [
                    makeMessage({ senderDid: ALICE_DID, text: 'Hello!',   sentAt: '2026-03-28T10:00:00.000Z' }),
                    makeMessage({ senderDid: selfDid,   text: 'Hi back!', sentAt: '2026-03-28T10:01:00.000Z' }),
                ],
            }));

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { bskyDid: ALICE_DID, selfDid },
            });

            const inbound  = results.find(r => r.summary.includes('Hello!'));
            const outbound = results.find(r => r.summary.includes('Hi back!'));
            expect(inbound?.direction).toBe('inbound');
            expect(outbound?.direction).toBe('outbound');
        });

        test('defaults all DM directions to inbound when selfDid not provided', async () => {
            const convo = makeConversation({
                id:      'convo-alice',
                members: [
                    { did: ALICE_DID,       handle: 'alice.bsky.social' },
                    { did: 'did:plc:self',  handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));
            mockGetMessages.mockImplementation(async () => ({
                messages: [makeMessage({ senderDid: 'did:plc:self' })],
            }));

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { bskyDid: ALICE_DID },
                // No selfDid metadata
            });

            expect(results[0].direction).toBe('inbound');
        });

        test('respects maxMessages when fetching DM conversation messages', async () => {
            const convo = makeConversation({
                id:      'convo-alice',
                members: [
                    { did: ALICE_DID,      handle: 'alice.bsky.social' },
                    { did: 'did:plc:self', handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));
            mockGetMessages.mockImplementation(async () => ({ messages: [] }));

            await provider.fetchHistory({
                identifier:  'alice.bsky.social',
                maxMessages: 20,
                metadata:    { bskyDid: ALICE_DID },
            });

            expect(mockGetMessages).toHaveBeenCalledWith('convo-alice', 20);
        });

        test('returns empty array on listConversations API error', async () => {
            mockListConversations.mockImplementation(async () => {
                throw new Error('API failure');
            });

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { bskyDid: ALICE_DID },
            });

            expect(results).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('does not call getAuthorFeed when bskyDid is provided', async () => {
            const convo = makeConversation({
                id:      'convo-alice',
                members: [
                    { did: ALICE_DID,      handle: 'alice.bsky.social' },
                    { did: 'did:plc:self', handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));
            mockGetMessages.mockImplementation(async () => ({ messages: [] }));

            await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { bskyDid: ALICE_DID },
            });

            expect(mockGetAuthorFeed).not.toHaveBeenCalled();
        });

        test('includes DM text in summary', async () => {
            const convo = makeConversation({
                id:      'convo-alice',
                members: [
                    { did: ALICE_DID,      handle: 'alice.bsky.social' },
                    { did: 'did:plc:self', handle: 'me.bsky.social' },
                ],
            });
            mockListConversations.mockImplementation(async () => ({ conversations: [convo] }));
            mockGetMessages.mockImplementation(async () => ({
                messages: [makeMessage({ text: 'Interesting message content', senderDid: ALICE_DID })],
            }));

            const results = await provider.fetchHistory({
                identifier: 'alice.bsky.social',
                metadata:   { bskyDid: ALICE_DID },
            });

            expect(results[0].summary).toContain('Interesting message content');
        });
    });
});
