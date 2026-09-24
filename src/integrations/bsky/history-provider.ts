import { logger } from '@hughescr/logger';
import type { PlatformHistoryProvider, HistoryFetchParams, HistoryFetchResult, HistoryEntry } from '@/agent';
import type { BlueskyClient } from '@/integrations/bsky/client';
import type { BskyConversation } from '@/integrations/bsky/types';

const MAX_TEXT_LENGTH = 200;

/** Bounds each reverse-chronological author-feed or DM scan if its lower window boundary cannot be reached. */
const MAX_HISTORY_PAGES = 10;
/** Bounds paged DM discovery while still surfacing an unverified absence as truncated. */
const MAX_CONVERSATION_PAGES = 10;

/** Entries plus whether a bounded source may have left matching records unobserved. */
interface BskyPage {
    entries:   HistoryEntry[]
    truncated: boolean
}

interface CursorPage<T> {
    items:   T[]
    cursor?: string
}

interface WindowAppendResult {
    reachedStart:    boolean
    skippedMatching: boolean
}

interface ConversationSearch {
    conversation?: BskyConversation
    truncated:     boolean
}

/**
 * Bluesky history provider for the cross-platform history system.
 *
 * Reads the source named by the coordinator's `BskyHistoryQuery` scope:
 * - `direct-conversation`: the DM conversation that includes `participantDid`.
 * - `author-feed` (and no scope): the person's author feed.
 *
 * Feed and DM cursors are scanned in reverse chronological order through the
 * requested inclusive window. Scans stop when their lower boundary proves older
 * pages irrelevant, their cursor exhausts, the entry cap is reached, or their
 * local page cap is reached; any potentially relevant remainder is `truncated`.
 * Conversation discovery follows a separately bounded cursor scan, so an absent
 * participant is only complete once discovery cursor exhaustion proves it.
 *
 * DM entries carry `'mutual'` direction: the bot's own DID is not threaded
 * through the history port, so inbound/outbound cannot be told apart honestly.
 * A failed API call is reported as `unavailable`, never as an empty result.
 */
export class BskyHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'bsky';

    private readonly bskyClient: BlueskyClient;

    constructor(bskyClient: BlueskyClient) {
        this.bskyClient = bskyClient;
    }

    async fetchHistory(params: HistoryFetchParams): Promise<HistoryFetchResult> {
        const maxMessages = params.maxMessages ?? 10;
        const scope = params.scope;
        const isConversation = scope?.platform === 'bsky' && scope.kind === 'direct-conversation';
        const source = isConversation ? 'direct-conversation' : 'author-feed';

        try {
            const page = isConversation
                ? await this.fetchDMContext(scope.participantDid, maxMessages, params.startTime, params.endTime)
                : await this.fetchAuthorFeed(params.identifier, maxMessages, params.startTime, params.endTime);
            return { platform: 'bsky', entries: page.entries, coverage: 'complete', truncated: page.truncated, failures: [] };
        } catch (err: unknown) {
            logger.warn({ err, source }, 'BskyHistoryProvider: failed to fetch history');
            return {
                platform:  'bsky',
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [{ source, category: 'transient', error: err }],
            };
        }
    }

    // ---------------------------------------------------------------------------
    // Direct conversation
    // ---------------------------------------------------------------------------

    private async fetchDMContext(
        participantDid: string,
        maxMessages: number,
        startTime: Date | undefined,
        endTime: Date | undefined
    ): Promise<BskyPage> {
        const search = await this.findConversation(participantDid);
        if(!search.conversation) {
            return { entries: [], truncated: search.truncated };
        }

        return this.fetchWindowedPages(
            async (cursor) => {
                const response = cursor === undefined
                    ? await this.bskyClient.getMessages(search.conversation!.id, maxMessages)
                    : await this.bskyClient.getMessages(search.conversation!.id, maxMessages, cursor);
                return { items: response.messages, cursor: response.cursor };
            },
            message => message.sentAt,
            message => ({
                platform:  'bsky',
                timestamp: message.sentAt,
                summary:   truncate(message.text),
                direction: 'mutual',
            }),
            maxMessages,
            startTime,
            endTime
        );
    }

    private async findConversation(participantDid: string): Promise<ConversationSearch> {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();

        for(let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
            // eslint-disable-next-line no-await-in-loop -- Each cursor is supplied by the preceding response.
            const response = await this.fetchConversationPage(cursor);
            const conversation = response.conversations.find(
                item => item.members.some(member => member.did === participantDid)
            );
            if(conversation) {
                return { conversation, truncated: false };
            }
            if(response.cursor === undefined) {
                return { truncated: false };
            }
            if(seenCursors.has(response.cursor)) {
                return { truncated: true };
            }
            seenCursors.add(response.cursor);
            cursor = response.cursor;
        }

        return { truncated: true };
    }

    private async fetchConversationPage(cursor: string | undefined): ReturnType<BlueskyClient['listConversations']> {
        return cursor === undefined
            ? this.bskyClient.listConversations()
            : this.bskyClient.listConversations(undefined, cursor);
    }

    // ---------------------------------------------------------------------------
    // Author feed
    // ---------------------------------------------------------------------------

    private async fetchAuthorFeed(
        actor: string,
        maxMessages: number,
        startTime: Date | undefined,
        endTime: Date | undefined
    ): Promise<BskyPage> {
        return this.fetchWindowedPages(
            async (cursor) => {
                const response = cursor === undefined
                    ? await this.bskyClient.getAuthorFeed(actor, maxMessages)
                    : await this.bskyClient.getAuthorFeed(actor, maxMessages, cursor);
                return { items: response.items, cursor: response.cursor };
            },
            item => item.post.createdAt,
            item => ({
                platform:  'bsky',
                timestamp: item.post.createdAt,
                summary:   `@${item.post.author.handle}: ${truncate(item.post.text)}`,
                direction: 'inbound',
            }),
            maxMessages,
            startTime,
            endTime
        );
    }

    /** Collect reverse-chronological cursor pages, retaining only the requested inclusive time window. */
    private async fetchWindowedPages<T>(
        fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
        getTimestamp: (item: T) => string,
        mapEntry: (item: T) => HistoryEntry,
        maxMessages: number,
        startTime: Date | undefined,
        endTime: Date | undefined
    ): Promise<BskyPage> {
        const entries: HistoryEntry[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;

        for(let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
            // eslint-disable-next-line no-await-in-loop -- Each cursor is supplied by the preceding response.
            const response = await fetchPage(cursor);
            const { reachedStart, skippedMatching } = appendWindowEntries(
                response.items, entries, getTimestamp, mapEntry, maxMessages, startTime, endTime
            );

            if(skippedMatching) {
                return { entries, truncated: true };
            }
            if(reachedStart || response.cursor === undefined) {
                return { entries, truncated: false };
            }
            if(entries.length === maxMessages || seenCursors.has(response.cursor)) {
                return { entries, truncated: true };
            }
            seenCursors.add(response.cursor);
            cursor = response.cursor;
        }

        return { entries, truncated: true };
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendWindowEntries<T>(
    items: T[],
    entries: HistoryEntry[],
    getTimestamp: (item: T) => string,
    mapEntry: (item: T) => HistoryEntry,
    maxMessages: number,
    startTime: Date | undefined,
    endTime: Date | undefined
): WindowAppendResult {
    let reachedStart = false;
    let skippedMatching = false;

    for(const item of items) {
        const timestamp = new Date(getTimestamp(item));
        if(startTime && timestamp <= startTime) {
            reachedStart = true;
        }
        if(!isWithinWindow(timestamp, startTime, endTime)) {
            continue;
        }
        if(entries.length < maxMessages) {
            entries.push(mapEntry(item));
        } else {
            skippedMatching = true;
        }
    }

    return { reachedStart, skippedMatching };
}

function isWithinWindow(timestamp: Date, startTime: Date | undefined, endTime: Date | undefined): boolean {
    return (!startTime || timestamp >= startTime) && (!endTime || timestamp <= endTime);
}

function truncate(text: string): string {
    // Stryker disable next-line llm: MAX_TEXT_LENGTH is positive, so slice(0, n) and substring(0, n) are equivalent.
    return text.slice(0, MAX_TEXT_LENGTH);
}
