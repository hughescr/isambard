import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mockLogger } from '../../../setup';
import { EmailFolder } from '@/config';
import { EmailHistoryProvider } from '@/integrations/email/history-provider';
import type { WildDuckSearchPage, WildDuckSearchPageRequest, WildDuckSearchRow } from '@/integrations/email/wildduck-client';

// ---------------------------------------------------------------------------
// Mock WildDuckClient: one page per mailbox, and WildDuck's mailbox ids
// ---------------------------------------------------------------------------

const MAILBOX_IDS: Record<string, string> = {
    [EmailFolder.CleanInbox]: 'id-clean-inbox',
    [EmailFolder.Archive]:    'id-archive',
    [EmailFolder.Drafts]:     'id-drafts',
    [EmailFolder.Sent]:       'id-sent-mail',
    [EmailFolder.Quarantine]: 'id-quarantine',
    [EmailFolder.Review]:     'id-review',
};

let mailboxIds: Record<string, string | undefined> = { ...MAILBOX_IDS };
let pages: Partial<Record<EmailFolder, WildDuckSearchPage | Error>> = {};
/** When set, every search waits for it before answering. */
let gate: Promise<void> | undefined;

const mockSearchPage = mock(async (request: WildDuckSearchPageRequest): Promise<WildDuckSearchPage> => {
    await gate;
    const page = pages[request.mailbox as EmailFolder] ?? { results: [] };
    if(page instanceof Error) {
        throw page;
    }
    return page;
});
const mockGetMailboxId = mock((mailboxPath: string): string | undefined => mailboxIds[mailboxPath]);

const mockClient = {
    searchPage:   mockSearchPage,
    getMailboxId: mockGetMailboxId,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let nextUid = 1;

function makeRow(folder: EmailFolder, overrides: Partial<WildDuckSearchRow> = {}): WildDuckSearchRow {
    const uid = nextUid++;
    return {
        message:   `${folder}:${uid}`,
        uid,
        mailboxId: MAILBOX_IDS[folder],
        intro:     '',
        from:      { name: 'Alice', address: 'alice@example.com' },
        to:        [{ address: 'bot@isambard.ai' }],
        subject:   'Hello there',
        date:      '2026-03-28T10:00:00.000Z',
        ...overrides,
    };
}

function inbox(...rows: WildDuckSearchRow[]): void {
    pages[EmailFolder.CleanInbox] = { results: rows };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailHistoryProvider', () => {
    let provider: EmailHistoryProvider;

    beforeEach(() => {
        mockSearchPage.mockClear();
        mockGetMailboxId.mockClear();
        mockLogger.warn.mockClear();
        mailboxIds = { ...MAILBOX_IDS };
        pages = {};
        gate = undefined;
        nextUid = 1;

        provider = new EmailHistoryProvider('bot@isambard.ai', mockClient);
    });

    test('has platform = "email"', () => {
        expect(provider.platform).toBe('email');
    });

    describe('mailbox scope', () => {
        test('searches CleanInbox, Archive and Sent Mail by correspondent, one request each and nothing wider', async () => {
            await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(mockSearchPage.mock.calls.map(([request]) => request)).toEqual([
                { query: { correspondent: 'alice@example.com' }, mailbox: EmailFolder.CleanInbox, limit: 20 },
                { query: { correspondent: 'alice@example.com' }, mailbox: EmailFolder.Archive, limit: 20 },
                { query: { correspondent: 'alice@example.com' }, mailbox: EmailFolder.Sent, limit: 20 },
            ]);
        });

        test('sends every mailbox request before any of them answers', async () => {
            let open = (): void => undefined;
            gate = new Promise<void>((resolve) => {
                open = resolve;
            });

            const pending = provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(mockSearchPage).toHaveBeenCalledTimes(3);
            open();
            await expect(pending).resolves.toMatchObject({ coverage: 'complete' });
        });

        test('drops and logs a row from another mailbox than the one searched', async () => {
            const kept = makeRow(EmailFolder.CleanInbox, { subject: 'Kept' });
            const stray = makeRow(EmailFolder.CleanInbox, { subject: 'Quarantined', mailboxId: MAILBOX_IDS[EmailFolder.Quarantine] });
            inbox(kept, stray);

            const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result.entries.map(entry => entry.summary)).toEqual(['Alice <alice@example.com> — "Kept"']);
            expect(result.coverage).toBe('complete');
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { mailbox: EmailFolder.CleanInbox, mailboxId: 'id-quarantine' },
                'EmailHistoryProvider: dropped a search row from outside the mailbox searched'
            );
        });

        test('does not search a mailbox whose id is unknown, and reports it as not configured', async () => {
            mailboxIds[EmailFolder.Archive] = undefined;
            inbox(makeRow(EmailFolder.CleanInbox));

            const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(mockSearchPage.mock.calls.map(([request]) => request.mailbox)).toEqual([EmailFolder.CleanInbox, EmailFolder.Sent]);
            expect(result.coverage).toBe('partial');
            expect(result.entries).toHaveLength(1);
            expect(result.failures).toEqual([{ source: 'wildduck-search:Archive', category: 'permanent_not_configured' }]);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { identifier: 'alice@example.com', mailbox: EmailFolder.Archive },
                'EmailHistoryProvider: mailbox id unknown, so it was not searched'
            );
        });

        test('searches nothing when no mailbox id is known', async () => {
            mailboxIds = {};

            const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(mockSearchPage).not.toHaveBeenCalled();
            expect(result).toEqual({
                platform:  'email',
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [
                    { source: 'wildduck-search:CleanInbox', category: 'permanent_not_configured' },
                    { source: 'wildduck-search:Archive', category: 'permanent_not_configured' },
                    { source: 'wildduck-search:Sent Mail', category: 'permanent_not_configured' },
                ],
            });
        });
    });

    describe('search failures', () => {
        test('reports one failed mailbox as partial coverage, keeping the others', async () => {
            const error = new Error('WildDuck connection refused');
            pages[EmailFolder.Archive] = error;
            inbox(makeRow(EmailFolder.CleanInbox));

            const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result.coverage).toBe('partial');
            expect(result.entries).toHaveLength(1);
            expect(result.failures).toEqual([{ source: 'wildduck-search:Archive', category: 'transient', error }]);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { err: error, identifier: 'alice@example.com', mailbox: EmailFolder.Archive },
                'EmailHistoryProvider: search failed'
            );
        });

        test('reports every mailbox failing as unavailable with one transient failure each, not as an empty result', async () => {
            const error = new Error('WildDuck connection refused');
            pages = { [EmailFolder.CleanInbox]: error, [EmailFolder.Archive]: error, [EmailFolder.Sent]: error };

            const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result).toEqual({
                platform:  'email',
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [
                    { source: 'wildduck-search:CleanInbox', category: 'transient', error },
                    { source: 'wildduck-search:Archive', category: 'transient', error },
                    { source: 'wildduck-search:Sent Mail', category: 'transient', error },
                ],
            });
        });
    });

    test('reports an empty search as complete coverage with no entries', async () => {
        const result = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toEqual({ platform: 'email', entries: [], coverage: 'complete', truncated: false, failures: [] });
    });

    test('converts inbound email to HistoryEntry', async () => {
        inbox(makeRow(EmailFolder.CleanInbox));

        const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

        expect(result).toEqual([{
            platform:  'email',
            timestamp: '2026-03-28T10:00:00.000Z',
            summary:   'Alice <alice@example.com> — "Hello there"',
            direction: 'inbound',
        }]);
    });

    describe('direction', () => {
        test('is outbound for a Sent Mail message even when from is an external sender', async () => {
            pages[EmailFolder.Sent] = { results: [makeRow(EmailFolder.Sent, { from: { address: 'alice@example.com' } })] };

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result.map(entry => entry.direction)).toEqual(['outbound']);
        });

        test('is inbound for an Archive message from someone else', async () => {
            pages[EmailFolder.Archive] = { results: [makeRow(EmailFolder.Archive)] };

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result.map(entry => entry.direction)).toEqual(['inbound']);
        });

        test('is outbound when the from address matches the bot address case-insensitively', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { from: { address: 'BOT@ISAMBARD.AI' } }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result[0].direction).toBe('outbound');
        });

        test('is inbound when a display name contains the bot address', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { from: { name: 'Relay via bot@isambard.ai', address: 'relay@example.com' } }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result[0].direction).toBe('inbound');
        });

        test('keeps near-match and absent sender addresses inbound outside Sent Mail', async () => {
            inbox(
                makeRow(EmailFolder.CleanInbox, { from: { address: 'notbot@isambard.ai' } }),
                makeRow(EmailFolder.CleanInbox, { from: { address: 'bot@isambard.ai.example.org' } }),
                makeRow(EmailFolder.CleanInbox, { from: null })
            );

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result.map(entry => entry.direction)).toEqual(['inbound', 'inbound', 'inbound']);
        });
    });

    describe('merging and the cap', () => {
        test('merges the mailboxes newest first', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { subject: 'Nine', date: '2026-03-28T09:00:00.000Z' }));
            pages[EmailFolder.Archive] = { results: [makeRow(EmailFolder.Archive, { subject: 'Eleven', date: '2026-03-28T11:00:00.000Z' })] };
            pages[EmailFolder.Sent] = { results: [makeRow(EmailFolder.Sent, { subject: 'Ten', date: '2026-03-28T10:00:00.000Z' })] };

            const { entries } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(entries.map(entry => entry.timestamp)).toEqual(['2026-03-28T11:00:00.000Z', '2026-03-28T10:00:00.000Z', '2026-03-28T09:00:00.000Z']);
        });

        test('keeps the newest messages across mailboxes when capping', async () => {
            inbox(
                makeRow(EmailFolder.CleanInbox, { subject: 'Inbox new', date: '2026-03-28T12:00:00.000Z' }),
                makeRow(EmailFolder.CleanInbox, { subject: 'Inbox old', date: '2026-03-01T12:00:00.000Z' })
            );
            pages[EmailFolder.Sent] = { results: [makeRow(EmailFolder.Sent, { subject: 'Sent mid', date: '2026-03-15T12:00:00.000Z' })] };

            const { entries, truncated } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 2 });

            expect(entries.map(entry => entry.summary)).toEqual(['Alice <alice@example.com> — "Inbox new"', 'Alice <alice@example.com> — "Sent mid"']);
            expect(truncated).toBe(true);
        });

        test('respects maxMessages cap', async () => {
            inbox(...Array.from({ length: 5 }, (_, i) => makeRow(EmailFolder.CleanInbox, { subject: `Email ${i + 1}` })));

            const { entries: result, truncated } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 3 });

            expect(result).toHaveLength(3);
            expect(truncated).toBe(true);
        });

        test('is not truncated when the in-window results exactly fill maxMessages', async () => {
            inbox(makeRow(EmailFolder.CleanInbox), makeRow(EmailFolder.CleanInbox));

            const { entries, truncated } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 2 });

            expect(entries).toHaveLength(2);
            expect(truncated).toBe(false);
        });

        test('is truncated when a mailbox has more matches than its page, even under the cap', async () => {
            pages[EmailFolder.Archive] = { results: [makeRow(EmailFolder.Archive)], nextCursor: 'cursor' };

            const { entries, truncated } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(entries).toHaveLength(1);
            expect(truncated).toBe(true);
        });

        test('honors a zero maxMessages cap', async () => {
            inbox(makeRow(EmailFolder.CleanInbox));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 0 });

            expect(result).toEqual([]);
        });

        test('returns all results when fewer than maxMessages', async () => {
            inbox(makeRow(EmailFolder.CleanInbox), makeRow(EmailFolder.CleanInbox, { subject: 'Second email' }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', maxMessages: 10 });

            expect(result).toHaveLength(2);
        });

        test('uses default maxMessages of 10 when not specified', async () => {
            inbox(...Array.from({ length: 15 }, (_, i) => makeRow(EmailFolder.CleanInbox, { subject: `Email ${i + 1}` })));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result).toHaveLength(10);
        });
    });

    describe('subjects', () => {
        test('truncates long subjects in summary', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { subject: 'A'.repeat(150) }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result[0].summary).toBe(`Alice <alice@example.com> — "${'A'.repeat(100)}..."`);
        });

        test('preserves the first character when truncating a subject', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { subject: `Z${'A'.repeat(149)}` }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result[0].summary).toContain(`Z${'A'.repeat(99)}...`);
        });

        test('preserves a trailing space before the exact truncation ellipsis', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { subject: `${'A'.repeat(99)} Z` }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result[0].summary).toBe(`Alice <alice@example.com> — "${'A'.repeat(99)} ..."`);
        });

        test('does not truncate subject at exactly the max length (100 chars)', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { subject: 'B'.repeat(100) }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result[0].summary).toBe(`Alice <alice@example.com> — "${'B'.repeat(100)}"`);
        });

        test('summary includes from address and subject', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { from: { name: 'Bob Smith', address: 'bob@example.com' }, subject: 'Meeting tomorrow' }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com' });

            expect(result[0].summary).toBe('Bob Smith <bob@example.com> — "Meeting tomorrow"');
        });
    });

    describe('time window', () => {
        test('filters results after startTime', async () => {
            inbox(
                makeRow(EmailFolder.CleanInbox, { subject: 'Old email', date: '2026-01-01T00:00:00.000Z' }),
                makeRow(EmailFolder.CleanInbox, { subject: 'New email', date: '2026-03-28T10:00:00.000Z' })
            );

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', startTime: new Date('2026-02-01T00:00:00.000Z') });

            expect(result.map(entry => entry.summary)).toEqual(['Alice <alice@example.com> — "New email"']);
        });

        test('includes result exactly at startTime boundary', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { subject: 'At boundary', date: '2026-02-01T00:00:00.000Z' }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', startTime: new Date('2026-02-01T00:00:00.000Z') });

            expect(result).toHaveLength(1);
        });

        test('filters results before endTime', async () => {
            inbox(
                makeRow(EmailFolder.CleanInbox, { subject: 'Old email', date: '2026-01-01T00:00:00.000Z' }),
                makeRow(EmailFolder.CleanInbox, { subject: 'Future email', date: '2026-12-31T00:00:00.000Z' })
            );

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', endTime: new Date('2026-06-01T00:00:00.000Z') });

            expect(result.map(entry => entry.summary)).toEqual(['Alice <alice@example.com> — "Old email"']);
        });

        test('includes result exactly at endTime boundary', async () => {
            inbox(makeRow(EmailFolder.CleanInbox, { subject: 'At end boundary', date: '2026-06-01T00:00:00.000Z' }));

            const { entries: result } = await provider.fetchHistory({ identifier: 'alice@example.com', endTime: new Date('2026-06-01T00:00:00.000Z') });

            expect(result).toHaveLength(1);
        });

        test('filters by both startTime and endTime', async () => {
            inbox(
                makeRow(EmailFolder.CleanInbox, { subject: 'Too old', date: '2026-01-01T00:00:00.000Z' }),
                makeRow(EmailFolder.CleanInbox, { subject: 'In range', date: '2026-03-15T00:00:00.000Z' }),
                makeRow(EmailFolder.CleanInbox, { subject: 'Too new', date: '2026-06-01T00:00:00.000Z' })
            );

            const { entries: result } = await provider.fetchHistory({
                identifier: 'alice@example.com',
                startTime:  new Date('2026-02-01T00:00:00.000Z'),
                endTime:    new Date('2026-04-01T00:00:00.000Z'),
            });

            expect(result.map(entry => entry.summary)).toEqual(['Alice <alice@example.com> — "In range"']);
        });

        test('applies maxMessages cap after time filtering', async () => {
            inbox(
                makeRow(EmailFolder.CleanInbox, { date: '2026-03-28T10:00:00.000Z' }),
                makeRow(EmailFolder.CleanInbox, { date: '2026-03-28T10:00:00.000Z' }),
                makeRow(EmailFolder.CleanInbox, { date: '2026-01-01T10:00:00.000Z' })
            );

            const { entries: result, truncated } = await provider.fetchHistory({
                identifier:  'alice@example.com',
                maxMessages: 2,
                startTime:   new Date('2026-03-01T00:00:00.000Z'),
            });

            expect(result).toHaveLength(2);
            expect(truncated).toBe(false);
        });
    });
});
