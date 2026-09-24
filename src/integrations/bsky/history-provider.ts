import { logger } from '@hughescr/logger';
import type { PlatformHistoryProvider, HistoryFetchParams, HistoryFetchResult, HistoryEntry } from '@/agent';
import type { BlueskyClient } from '@/integrations/bsky/client';

const MAX_TEXT_LENGTH = 200;

/** Entries plus whether the backend reported more beyond the page returned. */
interface BskyPage {
    entries:   HistoryEntry[]
    truncated: boolean
}

/**
 * Bluesky history provider for the cross-platform history system.
 *
 * Reads the source named by the coordinator's `BskyHistoryQuery` scope:
 * - `direct-conversation`: the DM conversation that includes `participantDid`.
 * - `author-feed` (and no scope): the person's author feed.
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
                ? await this.fetchDMContext(scope.participantDid, maxMessages)
                : await this.fetchAuthorFeed(params.identifier, maxMessages);
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

    private async fetchDMContext(participantDid: string, maxMessages: number): Promise<BskyPage> {
        const { conversations } = await this.bskyClient.listConversations();
        const convo = conversations.find(
            c => c.members.some(m => m.did === participantDid)
        );

        if(!convo) {
            return { entries: [], truncated: false };
        }

        const { messages, cursor } = await this.bskyClient.getMessages(convo.id, maxMessages);

        return {
            entries: messages.map((msg): HistoryEntry => ({
                platform:  'bsky',
                timestamp: msg.sentAt,
                summary:   truncate(msg.text),
                direction: 'mutual',
            })),
            truncated: cursor !== undefined,
        };
    }

    // ---------------------------------------------------------------------------
    // Author feed
    // ---------------------------------------------------------------------------

    private async fetchAuthorFeed(actor: string, maxMessages: number): Promise<BskyPage> {
        const { items, cursor } = await this.bskyClient.getAuthorFeed(actor, maxMessages);

        return {
            entries: items.map((item): HistoryEntry => ({
                platform:  'bsky',
                timestamp: item.post.createdAt,
                summary:   `@${item.post.author.handle}: ${truncate(item.post.text)}`,
                direction: 'inbound',
            })),
            truncated: cursor !== undefined,
        };
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string): string {
    // Stryker disable next-line llm: MAX_TEXT_LENGTH is positive, so slice(0, n) and substring(0, n) are equivalent.
    return text.slice(0, MAX_TEXT_LENGTH);
}
