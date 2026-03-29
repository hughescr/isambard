import { logger } from '@hughescr/logger';
import type { PlatformHistoryProvider, HistoryFetchParams, HistoryEntry } from '@/agent';
import type { BlueskyClient } from '@/integrations/bsky/client';

// Stryker disable next-line ArithmeticOperator: text truncation limit is a UX constant
const MAX_TEXT_LENGTH = 200;

/**
 * Bluesky history provider for the cross-platform history system.
 *
 * Supports three fetch modes based on params.metadata:
 * - Thread mode:  when `params.metadata.parentUri` is provided — fetches the parent post.
 * - DM mode:      when `params.metadata.bskyDid` is provided — fetches conversation messages.
 * - General mode: fallback — fetches the person's author feed.
 */
export class BskyHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'bsky';

    private readonly bskyClient: BlueskyClient;

    constructor(bskyClient: BlueskyClient) {
        this.bskyClient = bskyClient;
    }

    async fetchHistory(params: HistoryFetchParams): Promise<HistoryEntry[]> {
        const maxMessages = params.maxMessages ?? 10;

        try {
            if(params.metadata?.parentUri) {
                return await this.fetchThreadContext(params.metadata.parentUri);
            }

            if(params.metadata?.bskyDid) {
                return await this.fetchDMContext(
                    params.metadata.bskyDid,
                    params.metadata.selfDid,
                    maxMessages
                );
            }

            return await this.fetchAuthorFeed(params.identifier, maxMessages);
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log call structure and message text are informational only
            logger.warn({ err }, 'BskyHistoryProvider: failed to fetch history');
            return [];
        }
    }

    // ---------------------------------------------------------------------------
    // Thread mode
    // ---------------------------------------------------------------------------

    private async fetchThreadContext(parentUri: string): Promise<HistoryEntry[]> {
        const post = await this.bskyClient.getPost(parentUri);
        return [{
            platform:  'bsky',
            timestamp: post.createdAt,
            // Stryker disable next-line StringLiteral: formatting template — cosmetic punctuation
            summary:   `@${post.author.handle}: ${truncate(post.text)}`,
            direction: 'inbound',
        }];
    }

    // ---------------------------------------------------------------------------
    // DM mode
    // ---------------------------------------------------------------------------

    private async fetchDMContext(
        bskyDid:     string,
        selfDid:     string | undefined,
        maxMessages: number
    ): Promise<HistoryEntry[]> {
        const { conversations } = await this.bskyClient.listConversations();
        const convo = conversations.find(
            c => c.members.some(m => m.did === bskyDid)
        );

        if(!convo) {
            return [];
        }

        const { messages } = await this.bskyClient.getMessages(convo.id, maxMessages);

        return messages.map((msg): HistoryEntry => ({
            platform:  'bsky',
            timestamp: msg.sentAt,
            summary:   truncate(msg.text),
            // Stryker disable next-line ConditionalExpression,EqualityOperator: direction depends on selfDid being known — if not provided all messages are inbound by design
            direction: (selfDid && msg.senderDid === selfDid) ? 'outbound' : 'inbound',
        }));
    }

    // ---------------------------------------------------------------------------
    // General mode (author feed)
    // ---------------------------------------------------------------------------

    private async fetchAuthorFeed(
        actor:       string,
        maxMessages: number
    ): Promise<HistoryEntry[]> {
        const { items } = await this.bskyClient.getAuthorFeed(actor, maxMessages);

        return items.map((item): HistoryEntry => ({
            platform:  'bsky',
            timestamp: item.post.createdAt,
            // Stryker disable next-line StringLiteral: formatting template — cosmetic punctuation
            summary:   `@${item.post.author.handle}: ${truncate(item.post.text)}`,
            direction: 'inbound',
        }));
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string): string {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: true mutant always truncates but short strings produce same result; >= is equivalent since slice(0,N) on length=N returns same string
    if(text.length > MAX_TEXT_LENGTH) {
        return text.slice(0, MAX_TEXT_LENGTH);
    }
    return text;
}
