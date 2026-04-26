import { describe, test, expect, mock, beforeEach } from 'bun:test';
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
        from:    'Alice <alice@example.com>',
        to:      ['bot@isambard.ai'],
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

    test('returns empty array when search returns no results', async () => {
        mockSearch.mockResolvedValueOnce([]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toEqual([]);
    });

    test('converts inbound email to HistoryEntry', async () => {
        const searchResult = makeSearchResult({
            message: 'CleanInbox:42',
            from:    'Alice <alice@example.com>',
            to:      ['bot@isambard.ai'],
            subject: 'Hello there',
            date:    '2026-03-28T10:00:00.000Z',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

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
            from:    'bot@isambard.ai',
            to:      ['alice@example.com'],
            subject: 'Reply from bot',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('outbound');
    });

    test('sets direction to outbound for Sent Mail messages even when from is external sender', async () => {
        // This verifies the folder-name check fires independently of the from-address check.
        // If ':' is mutated away in extractFolderName, folderName != 'Sent Mail' and
        // the external from does not match the bot address — direction would be 'inbound'.
        // Also verifies the BlockStatement mutant on the folderName==='Sent Mail' branch:
        // if the return is removed, the from check runs and returns 'inbound' since
        // 'alice@example.com' does not contain 'bot@isambard.ai'.
        const searchResult = makeSearchResult({
            message: 'Sent Mail:17',
            from:    'alice@example.com',
            to:      ['bot@isambard.ai'],
            subject: 'External sender in Sent Mail',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('outbound');
    });

    test('sets direction to outbound when from address matches bot address', async () => {
        const searchResult = makeSearchResult({
            message: 'CleanInbox:99',
            from:    'bot@isambard.ai',
            to:      ['alice@example.com'],
            subject: 'Bot sent this somehow',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('outbound');
    });

    test('sets direction to inbound when from is not bot address and not Sent Mail', async () => {
        const searchResult = makeSearchResult({
            message: 'CleanInbox:1',
            from:    'alice@example.com',
            to:      ['bot@isambard.ai'],
            subject: 'Inbound',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].direction).toBe('inbound');
    });

    test('respects maxMessages cap', async () => {
        const results = Array.from({ length: 5 }, (_, i) =>
            makeSearchResult({ message: `CleanInbox:${i + 1}`, subject: `Email ${i + 1}` })
        );
        mockSearch.mockResolvedValueOnce(results);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 3 });

        expect(result).toHaveLength(3);
    });

    test('returns all results when fewer than maxMessages', async () => {
        const results = [makeSearchResult(), makeSearchResult({ message: 'CleanInbox:43', subject: 'Second email' })];
        mockSearch.mockResolvedValueOnce(results);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 10 });

        expect(result).toHaveLength(2);
    });

    test('handles search errors gracefully by returning empty array', async () => {
        mockSearch.mockRejectedValueOnce(new Error('WildDuck connection refused'));

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toEqual([]);
    });

    test('truncates long subjects in summary', async () => {
        const longSubject = 'A'.repeat(150);
        const searchResult = makeSearchResult({ subject: longSubject });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).not.toContain('A'.repeat(101));
        expect(result[0].summary.length).toBeLessThan(400);
    });

    test('does not truncate subject at exactly the max length (100 chars)', async () => {
        // Verifies the BlockStatement in the truncate() guard:
        // if the early-return body is removed, even at-limit strings get '...' appended.
        const exactSubject = 'B'.repeat(100);
        const searchResult = makeSearchResult({ subject: exactSubject });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        // Subject at exactly max length should not have '...' appended
        expect(result[0].summary).toContain('B'.repeat(100));
        expect(result[0].summary).not.toContain('...');
    });

    test('does not truncate subject shorter than max length', async () => {
        const shortSubject = 'C'.repeat(50);
        const searchResult = makeSearchResult({ subject: shortSubject });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).toContain('C'.repeat(50));
        expect(result[0].summary).not.toContain('...');
    });

    test('filters results after startTime', async () => {
        const oldResult  = makeSearchResult({ message: 'CleanInbox:1', subject: 'Old email', date: '2026-01-01T00:00:00.000Z' });
        const newResult  = makeSearchResult({ message: 'CleanInbox:2', subject: 'New email', date: '2026-03-28T10:00:00.000Z' });
        mockSearch.mockResolvedValueOnce([oldResult, newResult]);

        const result = await provider.fetchHistory({
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

        const result = await provider.fetchHistory({
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

        const result = await provider.fetchHistory({
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

        const result = await provider.fetchHistory({
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

        const result = await provider.fetchHistory({
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

        const result = await provider.fetchHistory({
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

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toHaveLength(10);
    });

    test('summary includes from address and subject', async () => {
        const searchResult = makeSearchResult({
            from:    'Bob Smith <bob@example.com>',
            subject: 'Meeting tomorrow',
        });
        mockSearch.mockResolvedValueOnce([searchResult]);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result[0].summary).toContain('Bob Smith <bob@example.com>');
        expect(result[0].summary).toContain('Meeting tomorrow');
    });

    test('handles multiple messages and preserves all', async () => {
        const results = [
            makeSearchResult({ message: 'CleanInbox:1', subject: 'First',  date: '2026-03-28T09:00:00.000Z' }),
            makeSearchResult({ message: 'Sent Mail:2',  subject: 'Second', date: '2026-03-28T10:00:00.000Z', from: 'bot@isambard.ai' }),
        ];
        mockSearch.mockResolvedValueOnce(results);

        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toHaveLength(2);
        expect(result.find(e => e.direction === 'inbound')).toBeDefined();
        expect(result.find(e => e.direction === 'outbound')).toBeDefined();
    });
});
