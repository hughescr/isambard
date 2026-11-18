import { logger } from '@hughescr/logger';
import { formatAddressForDisplay } from './types';
import type { WildDuckClient, WildDuckSearchRow } from './wildduck-client';
import type { PlatformHistoryProvider, HistoryFetchParams, HistoryFetchResult, HistoryEntry, HistoryFetchFailure } from '@/agent';
import { EmailFolder, READABLE_EMAIL_FOLDERS } from '@/config';

/** Maximum characters for subject truncation in summary */
const MAX_SUBJECT_CHARS = 100;

/** Failure source label prefix for a mailbox's correspondent search (`wildduck-search:<mailbox>`). */
const SEARCH_SOURCE = 'wildduck-search';

/** Default maximum messages to return */
const DEFAULT_MAX_MESSAGES = 10;

/**
 * The mailboxes the history is drawn from: the ones Izzy can read, less Drafts. A draft has not
 * been exchanged with anyone (it is pending approval, rejected, or the stored copy of one that was
 * sent, which Sent Mail holds), so showing it as an outbound email would misstate the history.
 */
const HISTORY_FOLDERS: readonly EmailFolder[] = READABLE_EMAIL_FOLDERS.filter(folder => folder !== EmailFolder.Drafts);

/** Rows asked of each mailbox: WildDuck's default page size, and the most messages a caller asks for. */
const MAILBOX_SEARCH_LIMIT = 20;

/** A search row with the mailbox it was searched in. */
interface MailboxRow {
    folder: EmailFolder
    row:    WildDuckSearchRow
}

/** One mailbox's search: its rows and whether it has more, or why it could not be read. */
type MailboxSearch = { rows: MailboxRow[], more: boolean } | { failure: HistoryFetchFailure };

/** The coverage of a fetch from how many mailboxes were read and how many failed. */
function coverageOf(readCount: number, failureCount: number): HistoryFetchResult['coverage'] {
    if(failureCount === 0) {
        return 'complete';
    }
    return readCount === 0 ? 'unavailable' : 'partial';
}

/**
 * Truncate a string to a maximum number of characters, appending '...' if truncated.
 */
function truncate(text: string, maxChars: number): string {
    if(text.length <= maxChars) {
        return text;
    }
    // Stryker disable next-line llm: the sole caller passes the positive constant MAX_SUBJECT_CHARS, and slice(0, n) and substring(0, n) only differ for negative n
    return `${text.slice(0, maxChars)}...`;
}

/**
 * Determine the direction of an email based on the mailbox it is in and its sender address.
 * - 'outbound' if in Sent Mail or from the bot's address
 * - 'inbound' otherwise
 */
function determineDirection({ folder, row }: MailboxRow, botAddress: string): 'inbound' | 'outbound' {
    if(folder === EmailFolder.Sent) {
        return 'outbound';
    }
    if(row.from?.address?.toLowerCase() === botAddress.toLowerCase()) {
        return 'outbound';
    }
    return 'inbound';
}

/**
 * Convert a search row to a HistoryEntry.
 */
function toHistoryEntry(found: MailboxRow, botAddress: string): HistoryEntry {
    const direction  = determineDirection(found, botAddress);
    const subject    = truncate(found.row.subject, MAX_SUBJECT_CHARS);
    const summary    = `${formatAddressForDisplay(found.row.from)} — "${subject}"`;

    return {
        platform:  'email',
        timestamp: found.row.date,
        summary,
        direction,
    };
}

/**
 * Email history provider for the cross-platform history coordinator.
 *
 * Fetches recent email exchanges with a person: a correspondent search of CleanInbox, Archive and
 * Sent Mail, one request per mailbox, all at once. A mailbox whose WildDuck id is unknown is not
 * searched at all (never a search without a mailbox, which would reach every one), and a row from
 * any other mailbox than the one searched is dropped.
 */
export class EmailHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'email';

    constructor(
        private readonly botAddress:    string,
        private readonly wildDuckClient: Pick<WildDuckClient, 'searchPage' | 'getMailboxId'>
    ) {}

    /**
     * Fetch email history for a person identified by their email address, newest first. Each
     * mailbox that could not be searched is one failure: some failing is `partial` coverage, all of
     * them `unavailable`, never an empty (complete) result.
     */
    async fetchHistory(params: HistoryFetchParams): Promise<HistoryFetchResult> {
        const maxMessages = params.maxMessages ?? DEFAULT_MAX_MESSAGES;

        const searches = await Promise.all(HISTORY_FOLDERS.map(folder => this.searchMailbox(folder, params.identifier)));
        const failures = searches.flatMap(search => ('failure' in search ? [search.failure] : []));
        const read = searches.flatMap(search => ('failure' in search ? [] : [search]));

        const filtered = read.flatMap(search => search.rows).filter(({ row }) => {
            const date = new Date(row.date);
            if(params.startTime && date < params.startTime) {
                return false;
            }
            if(params.endTime && date > params.endTime) {
                return false;
            }
            return true;
        });
        filtered.sort((a, b) => Date.parse(b.row.date) - Date.parse(a.row.date));

        // Cap at maxMessages
        const capped = filtered.slice(0, maxMessages);

        return {
            platform:  'email',
            entries:   capped.map(found => toHistoryEntry(found, this.botAddress)),
            coverage:  coverageOf(read.length, failures.length),
            truncated: capped.length < filtered.length || read.some(search => search.more),
            failures,
        };
    }

    /** One mailbox's correspondent search, its rows checked to be in that mailbox. */
    private async searchMailbox(folder: EmailFolder, identifier: string): Promise<MailboxSearch> {
        const source = `${SEARCH_SOURCE}:${folder}`;
        const mailboxId = this.wildDuckClient.getMailboxId(folder);
        if(mailboxId === undefined) {
            logger.warn({ identifier, mailbox: folder }, 'EmailHistoryProvider: mailbox id unknown, so it was not searched');
            return { failure: { source, category: 'permanent_not_configured' } };
        }
        let page;
        try {
            page = await this.wildDuckClient.searchPage({ query: { correspondent: identifier }, mailbox: folder, limit: MAILBOX_SEARCH_LIMIT });
        } catch (err) {
            logger.warn({ err, identifier, mailbox: folder }, 'EmailHistoryProvider: search failed');
            return { failure: { source, category: 'transient', error: err } };
        }
        const rows = page.results.filter((row) => {
            if(row.mailboxId === mailboxId) {
                return true;
            }
            logger.warn({ mailbox: folder, mailboxId: row.mailboxId }, 'EmailHistoryProvider: dropped a search row from outside the mailbox searched');
            return false;
        });
        return { rows: rows.map(row => ({ folder, row })), more: page.nextCursor !== undefined };
    }
}
