import { logger } from '@hughescr/logger';
import type { WildDuckClient, WildDuckSearchParams, WildDuckSearchResult } from './wildduck-client';
import type { PlatformHistoryProvider, HistoryFetchParams, HistoryEntry } from '@/agent';

/** Maximum characters for subject truncation in summary */
const MAX_SUBJECT_CHARS = 100;

/** Default maximum messages to return */
const DEFAULT_MAX_MESSAGES = 10;

/**
 * Whether a WildDuck result belongs to the logical Sent Mail folder.
 * The message field is in the format 'FolderName:uid'.
 */
function isSentMailFolder(message: string): boolean {
    const colonIdx = message.lastIndexOf(':');
    return colonIdx !== -1 && message.slice(0, colonIdx) === 'Sent Mail';
}

/**
 * Truncate a string to a maximum number of characters, appending '...' if truncated.
 */
function truncate(text: string, maxChars: number): string {
    if(text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}...`;
}

/**
 * Determine the direction of an email based on the mailbox folder and sender address.
 * - 'outbound' if in 'Sent Mail' folder or from the bot's address
 * - 'inbound' otherwise
 */
function determineDirection(result: WildDuckSearchResult, botAddress: string): 'inbound' | 'outbound' {
    if(isSentMailFolder(result.message)) {
        return 'outbound';
    }
    // Check if the from address contains the bot's address
    if(result.from.toLowerCase().includes(botAddress.toLowerCase())) {
        return 'outbound';
    }
    return 'inbound';
}

/**
 * Convert a WildDuckSearchResult to a HistoryEntry.
 */
function toHistoryEntry(result: WildDuckSearchResult, botAddress: string): HistoryEntry {
    const direction  = determineDirection(result, botAddress);
    const subject    = truncate(result.subject, MAX_SUBJECT_CHARS);
    const summary    = `${result.from} — "${subject}"`;

    return {
        platform:  'email',
        timestamp: result.date,
        summary,
        direction,
    };
}

/**
 * Email history provider for the cross-platform history coordinator.
 *
 * Fetches recent email exchanges with a person by searching the CleanInbox
 * and Sent Mail mailboxes using WildDuck's correspondent search.
 */
export class EmailHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'email';

    constructor(
        private readonly botAddress:    string,
        private readonly wildDuckClient: Pick<WildDuckClient, 'search'>
    ) {}

    /**
     * Fetch email history for a person identified by their email address.
     * Returns an empty array on search failure.
     */
    async fetchHistory(params: HistoryFetchParams): Promise<HistoryEntry[]> {
        const maxMessages = params.maxMessages ?? DEFAULT_MAX_MESSAGES;

        const searchParams: WildDuckSearchParams = {
            query:      { correspondent: params.identifier },
            searchable: true,
        };

        let results: WildDuckSearchResult[];
        try {
            results = await this.wildDuckClient.search(searchParams);
        } catch (err) {
            logger.warn({ err, identifier: params.identifier }, 'EmailHistoryProvider: search failed');
            return [];
        }

        const filtered = results.filter((result) => {
            const date = new Date(result.date);
            if(params.startTime && date < params.startTime) {
                return false;
            }
            if(params.endTime && date > params.endTime) {
                return false;
            }
            // Stryker restore ConditionalExpression,LogicalOperator
            return true;
        });

        // Cap at maxMessages
        const capped = filtered.slice(0, maxMessages);

        return capped.map(result => toHistoryEntry(result, this.botAddress));
    }
}
