import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mockLogger } from '../../../setup';
import { EmailHistoryProvider } from '@/integrations/email/history-provider';
import type { WildDuckSearchResult, WildDuckSearchParams } from '@/integrations/email/wildduck-client';

// ---------------------------------------------------------------------------
// Mock WildDuckClient
// ---------------------------------------------------------------------------

const mockSearch = mock(async (_params: WildDuckSearchParams): Promise<WildDuckSearchResult[]> => []);

const mockClient = {
    search: mockSearch,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSearchResult(overrides: Partial<WildDuckSearchResult> = {}): WildDuckSearchResult {
    return {
        message: 'CleanInbox:42',
        from:    { name: 'Alice', address: 'alice@example.com' },
        to:      [{ address: 'bot@isambard.ai' }],
        subject: 'Hello there',
        date:    '2026-03-28T10:00:00.000Z',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailHistoryProvider', () => {
    let provider: EmailHistoryProvider;

    beforeEach(() => {
        mockSearch.mockClear();
        mockLogger.warn.mockClear();

        provider = new EmailHistoryProvider('bot@isambard.ai', mockClient);
    });

    test('has platform = "email"', () => {
        expect(provider.platform).toBe('email');
    });

    test('searches by correspondent with searchable=true (all regular mailboxes)', async () => {
        mockSearch.mockResolvedValueOnce([]);

        await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(mockSearch).toHaveBeenCalledTimes(1);
        const [params] = mockSearch.mock.calls[0];
        expect(params.query?.correspondent).toBe('alice@example.com');
        expect(params.searchable).toBe(true);
        expect(params.mailbox).toBeUndefined();
    });

    test('reports an empty search as complete coverage with no entries', async () => {
        mockSearch.mockResolvedValueOnce([]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toEqual({ platform: 'email', entries: [], coverage: 'complete', truncated: false, failures: [] });
    });

    test('converts inbound email to HistoryEntry', async () => {
        const searchResult = makeSearchResult({
            message: 'CleanInbox:42',
            from:    { name: 'Alice', address: 'alice@example.com' },
            to:      [{ address: 'bot@isambard.ai' }],
            subject: 'Hello there',
            date:    '2026-03-28T10:00:00.000Z',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            platform:  'email',
            timestamp: '2026-03-28T10:00:00.000Z',
            direction: 'inbound',
        });
        expect(result[0].summary).toContain('Alice <alice@example.com>');
        expect(result[0].summary).toContain('Hello there');
    });

    test('sets direction to outbound for Sent Mail messages (from bot)', async () => {
        const searchResult = makeSearchResult({
            message: 'Sent Mail:17',
            from:    { address: 'bot@isambard.ai' },
            to:      [{ address: 'alice@example.com' }],
            subject: 'Reply from bot',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('outbound');
    });

    test('sets direction to outbound for Sent Mail messages even when from is external sender', async () => {
        // This verifies the Sent Mail predicate independently of the from-address check.
        // If its delimiter or prefix check is removed, the external sender does not
        // match the bot address and the result would be inbound.
        // Also verifies the BlockStatement mutant on the Sent Mail return branch:
        // if the return is removed, the from check runs and returns 'inbound' since
        // 'alice@example.com' does not contain 'bot@isambard.ai'.
        const searchResult = makeSearchResult({
            message: 'Sent Mail:17',
            from:    { address: 'alice@example.com' },
            to:      [{ address: 'bot@isambard.ai' }],
            subject: 'External sender in Sent Mail',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('outbound');
    });

    test('does not treat a message without a folder delimiter as Sent Mail', async () => {
        mockSearch.mockResolvedValueOnce([
            makeSearchResult({
                message: 'Sent MailX',
                from:    { address: 'alice@example.com' },
            }),
            makeSearchResult({
                message: 'Sent Mail:17',
                from:    { address: 'alice@example.com' },
            }),
            makeSearchResult({
                message: 'Sent Mail:archive:17',
                from:    { address: 'alice@example.com' },
            }),
        ]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('inbound');
        expect(result[1].direction).toBe('outbound');
        expect(result[2].direction).toBe('inbound');
    });

    test('sets direction to outbound when from address exactly matches bot address case-insensitively', async () => {
        const searchResult = makeSearchResult({
            message: 'CleanInbox:99',
            from:    { address: 'BOT@ISAMBARD.AI' },
            to:      [{ address: 'alice@example.com' }],
            subject: 'Bot sent this somehow',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('outbound');
    });

    test('sets direction to inbound when a display name contains the bot address', async () => {
        mockSearch.mockResolvedValueOnce([makeSearchResult({
            message: 'CleanInbox:100',
            from:    { name: 'Relay via bot@isambard.ai', address: 'relay@example.com' },
        })]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('inbound');
    });

    test('keeps near-match and absent sender addresses inbound outside Sent Mail', async () => {
        mockSearch.mockResolvedValueOnce([
            makeSearchResult({ message: 'CleanInbox:101', from: { address: 'notbot@isambard.ai' } }),
            makeSearchResult({ message: 'CleanInbox:102', from: { address: 'bot@isambard.ai.example.org' } }),
            makeSearchResult({ message: 'CleanInbox:103', from: null }),
        ]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result.map(entry => entry.direction)).toEqual(['inbound', 'inbound', 'inbound']);
    });

    test('sets direction to inbound when from is not bot address and not Sent Mail', async () => {
        const searchResult = makeSearchResult({
            message: 'CleanInbox:1',
            from:    { address: 'alice@example.com' },
            to:      [{ address: 'bot@isambard.ai' }],
            subject: 'Inbound',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('inbound');
    });

    test('respects maxMessages cap', async () => {
        const results = Array.from({ length: 5 }, (_, i) =>
            makeSearchResult({ message: `CleanInbox:${i + 1}`, subject: `Email ${i + 1}` })
        );
        mockSearch.mockResolvedValueOnce(results);

        const { entries: result, truncated } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 3 });

        expect(result).toHaveLength(3);
        expect(truncated).toBe(true);
    });

    test('is not truncated when the in-window results exactly fill maxMessages', async () => {
        mockSearch.mockResolvedValueOnce([makeSearchResult(), makeSearchResult({ message: 'CleanInbox:43' })]);

        const { entries, truncated } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 2 });

        expect(entries).toHaveLength(2);
        expect(truncated).toBe(false);
    });

    test('honors a zero maxMessages cap', async () => {
        mockSearch.mockResolvedValueOnce([makeSearchResult()]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 0 });

        expect(result).toEqual([]);
    });

    test('returns all results when fewer than maxMessages', async () => {
        const results = [makeSearchResult(), makeSearchResult({ message: 'CleanInbox:43', subject: 'Second email' })];
        mockSearch.mockResolvedValueOnce(results);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 10 });

        expect(result).toHaveLength(2);
    });

    test('reports a failed search as unavailable with one transient failure, not as an empty result', async () => {
        const error = new Error('WildDuck connection refused');
        mockSearch.mockRejectedValueOnce(error);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toEqual({
            platform:  'email',
            entries:   [],
            coverage:  'unavailable',
            truncated: false,
            failures:  [{ source: 'wildduck-search', category: 'transient', error }],
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            { err: expect.any(Error), identifier: 'alice@example.com' },
            'EmailHistoryProvider: search failed'
        );
    });

    test('truncates long subjects in summary', async () => {
        const longSubject = 'A'.repeat(150);
        const searchResult = makeSearchResult({ subject: longSubject });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).toContain('A'.repeat(97));
        expect(result[0].summary).toContain('...');
        expect(result[0].summary).not.toContain('A'.repeat(101));
        expect(result[0].summary.length).toBeLessThan(400);
    });

    test('preserves the first character when truncating a subject', async () => {
        const longSubject = `Z${'A'.repeat(149)}`;
        mockSearch.mockResolvedValueOnce([makeSearchResult({ subject: longSubject })]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).toContain(`Z${'A'.repeat(99)}...`);
    });

    test('preserves a trailing space before the exact truncation ellipsis', async () => {
        const longSubject = `${'A'.repeat(99)} Z`;
        mockSearch.mockResolvedValueOnce([makeSearchResult({ subject: longSubject })]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).toBe(`Alice <alice@example.com> — "${'A'.repeat(99)} ..."`);
    });

    test('does not truncate subject at exactly the max length (100 chars)', async () => {
        // Verifies the BlockStatement in the truncate() guard:
        // if the early-return body is removed, even at-limit strings get '...' appended.
        const exactSubject = 'B'.repeat(100);
        const searchResult = makeSearchResult({ subject: exactSubject });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        // Subject at exactly max length should not have '...' appended
        expect(result[0].summary).toContain('B'.repeat(100));
        expect(result[0].summary).not.toContain('...');
    });

    test('does not truncate subject shorter than max length', async () => {
        const shortSubject = 'C'.repeat(50);
        const searchResult = makeSearchResult({ subject: shortSubject });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).toContain('C'.repeat(50));
        expect(result[0].summary).not.toContain('...');
    });

    test('filters results after startTime', async () => {
        const oldResult  = makeSearchResult({ message: 'CleanInbox:1', subject: 'Old email', date: '2026-01-01T00:00:00.000Z' });
        const newResult  = makeSearchResult({ message: 'CleanInbox:2', subject: 'New email', date: '2026-03-28T10:00:00.000Z' });
        mockSearch.mockResolvedValueOnce([oldResult, newResult]);

        const { entries: result } = await provider.fetchHistory({
            identifier: 'alice@example.com',
            startTime:  new Date('2026-02-01T00:00:00.000Z'),
        });

        expect(result).toHaveLength(1);
        expect(result[0].summary).toContain('New email');
    });

    test('includes result exactly at startTime boundary', async () => {
        // Verifies startTime filter uses strict < not <=: a message at exactly startTime is included.
        const atBoundary = makeSearchResult({ message: 'CleanInbox:1', subject: 'At boundary', date: '2026-02-01T00:00:00.000Z' });
        mockSearch.mockResolvedValueOnce([atBoundary]);

        const { entries: result } = await provider.fetchHistory({
            identifier: 'alice@example.com',
            startTime:  new Date('2026-02-01T00:00:00.000Z'),
        });

        expect(result).toHaveLength(1);
        expect(result[0].summary).toContain('At boundary');
    });

    test('filters results before endTime', async () => {
        const oldResult    = makeSearchResult({ message: 'CleanInbox:1', subject: 'Old email',   date: '2026-01-01T00:00:00.000Z' });
        const futureResult = makeSearchResult({ message: 'CleanInbox:2', subject: 'Future email', date: '2026-12-31T00:00:00.000Z' });
        mockSearch.mockResolvedValueOnce([oldResult, futureResult]);

        const { entries: result } = await provider.fetchHistory({
            identifier: 'alice@example.com',
            endTime:    new Date('2026-06-01T00:00:00.000Z'),
        });

        expect(result).toHaveLength(1);
        expect(result[0].summary).toContain('Old email');
    });

    test('includes result exactly at endTime boundary', async () => {
        // Verifies endTime filter uses strict > not >=: a message at exactly endTime is included.
        const atBoundary = makeSearchResult({ message: 'CleanInbox:1', subject: 'At end boundary', date: '2026-06-01T00:00:00.000Z' });
        mockSearch.mockResolvedValueOnce([atBoundary]);

        const { entries: result } = await provider.fetchHistory({
            identifier: 'alice@example.com',
            endTime:    new Date('2026-06-01T00:00:00.000Z'),
        });

        expect(result).toHaveLength(1);
        expect(result[0].summary).toContain('At end boundary');
    });

    test('filters by both startTime and endTime', async () => {
        const tooOld  = makeSearchResult({ message: 'CleanInbox:1', subject: 'Too old',   date: '2026-01-01T00:00:00.000Z' });
        const inRange = makeSearchResult({ message: 'CleanInbox:2', subject: 'In range',  date: '2026-03-15T00:00:00.000Z' });
        const tooNew  = makeSearchResult({ message: 'CleanInbox:3', subject: 'Too new',   date: '2026-06-01T00:00:00.000Z' });
        mockSearch.mockResolvedValueOnce([tooOld, inRange, tooNew]);

        const { entries: result } = await provider.fetchHistory({
            identifier: 'alice@example.com',
            startTime:  new Date('2026-02-01T00:00:00.000Z'),
            endTime:    new Date('2026-04-01T00:00:00.000Z'),
        });

        expect(result).toHaveLength(1);
        expect(result[0].summary).toContain('In range');
    });

    test('applies maxMessages cap after time filtering', async () => {
        const results = Array.from({ length: 4 }, (_, i) =>
            makeSearchResult({ message: `CleanInbox:${i + 1}`, subject: `Email ${i + 1}`, date: '2026-03-28T10:00:00.000Z' })
        );
        mockSearch.mockResolvedValueOnce(results);

        const { entries: result } = await provider.fetchHistory({
            identifier:  'alice@example.com',
            maxMessages: 2,
            startTime:   new Date('2026-03-01T00:00:00.000Z'),
        });

        expect(result).toHaveLength(2);
    });

    test('uses default maxMessages of 10 when not specified', async () => {
        const results = Array.from({ length: 15 }, (_, i) =>
            makeSearchResult({ message: `CleanInbox:${i + 1}`, subject: `Email ${i + 1}` })
        );
        mockSearch.mockResolvedValueOnce(results);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toHaveLength(10);
    });

    test('summary includes from address and subject', async () => {
        const searchResult = makeSearchResult({
            from:    { name: 'Bob Smith', address: 'bob@example.com' },
            subject: 'Meeting tomorrow',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).toBe('Bob Smith <bob@example.com> — "Meeting tomorrow"');
    });

    test('handles multiple messages and preserves all', async () => {
        const results = [
            makeSearchResult({ message: 'CleanInbox:1', subject: 'First',  date: '2026-03-28T09:00:00.000Z' }),
            makeSearchResult({ message: 'Sent Mail:2',  subject: 'Second', date: '2026-03-28T10:00:00.000Z', from: { address: 'bot@isambard.ai' } }),
        ];
        mockSearch.mockResolvedValueOnce(results);

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toHaveLength(2);
        expect(result.find(e => e.direction === 'inbound')).toBeDefined();
        expect(result.find(e => e.direction === 'outbound')).toBeDefined();
    });
});
