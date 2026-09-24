import {
    type BskyFeedCheckpoint,
    type BskyNotificationCheckpoint,
    type BskyDmCheckpoint,
    bskyFeedCheckpointSchema,
    bskyNotificationCheckpointSchema,
    bskyDmCheckpointSchema,
    MAX_PROCESSED_URIS
} from './types';
import { sanitizeFeedName } from './uri-sanitizer';
import type { BskyFeedItem, BskyNotification, BskyConversation } from '@/integrations/bsky/types';
import type { OperationalStateKey, OperationalStateSchema, OperationalStateStore } from '@/storage';

/**
 * Options for creating a BskyCheckpointManager.
 */
interface BskyCheckpointManagerOptions {
    store: OperationalStateStore
}

/** Operational-state key of the notification checkpoint. */
const NOTIFICATION_CHECKPOINT_KEY: OperationalStateKey = { owner: 'bsky', name: 'notifications/checkpoint' };

/** Operational-state key of the DM checkpoint. */
const DM_CHECKPOINT_KEY: OperationalStateKey = { owner: 'bsky', name: 'dm/checkpoint' };

/** Operational-state key of a feed checkpoint: `{ owner: 'bsky', name: 'feeds/{sanitizedFeedName}/checkpoint' }`. */
function feedCheckpointKey(feedName: string): OperationalStateKey {
    return { owner: 'bsky', name: `feeds/${sanitizeFeedName(feedName)}/checkpoint` };
}

/**
 * Manages Bluesky checkpoints for tracking processed feed posts, notifications and DMs.
 * Persists them in the operational-state store (src/storage/operational-state), not as memories.
 *
 * Keys, all in the `bsky` partition: `feeds/{sanitizedFeedName}/checkpoint`,
 * `notifications/checkpoint` and `dm/checkpoint`.
 */
export class BskyCheckpointManager {
    private readonly store: OperationalStateStore;

    constructor(options: BskyCheckpointManagerOptions) {
        this.store = options.store;
    }

    /**
     * Generic helper: loads a checkpoint and parses it with the given schema. An absent or
     * invalid persisted checkpoint is treated as absent.
     */
    private async loadCheckpoint<T>(key: OperationalStateKey, schema: OperationalStateSchema<T>): Promise<T | undefined> {
        const read = await this.store.read(key, schema);
        return read.value;
    }

    /**
     * Generic helper: saves a checkpoint (an idempotent upsert).
     */
    private async saveCheckpoint(key: OperationalStateKey, checkpoint: unknown): Promise<void> {
        await this.store.put(key, checkpoint);
    }

    /**
     * Loads the checkpoint for a feed.
     *
     * @param feedName - Feed name or AT URI
     * @returns The checkpoint data, or undefined if not found or invalid
     */
    async loadFeedCheckpoint(feedName: string): Promise<BskyFeedCheckpoint | undefined> {
        return this.loadCheckpoint(feedCheckpointKey(feedName), bskyFeedCheckpointSchema);
    }

    /**
     * Saves (upserts) a feed checkpoint.
     * Applies FIFO eviction to processedUris if over MAX_PROCESSED_URIS.
     *
     * @param checkpoint - The checkpoint data to save
     */
    async saveFeedCheckpoint(checkpoint: BskyFeedCheckpoint): Promise<void> {
        const bounded = { ...checkpoint, processedUris: checkpoint.processedUris.slice(-MAX_PROCESSED_URIS) };

        await this.saveCheckpoint(feedCheckpointKey(checkpoint.feedName), bounded);
    }

    /**
     * Loads the notification checkpoint.
     *
     * @returns The checkpoint data, or undefined if not found or invalid
     */
    async loadNotificationCheckpoint(): Promise<BskyNotificationCheckpoint | undefined> {
        return this.loadCheckpoint(NOTIFICATION_CHECKPOINT_KEY, bskyNotificationCheckpointSchema);
    }

    /**
     * Saves (upserts) the notification checkpoint.
     * Applies FIFO eviction to processedUris if over MAX_PROCESSED_URIS.
     *
     * @param checkpoint - The checkpoint data to save
     */
    async saveNotificationCheckpoint(checkpoint: BskyNotificationCheckpoint): Promise<void> {
        const bounded = { ...checkpoint, processedUris: checkpoint.processedUris.slice(-MAX_PROCESSED_URIS) };

        await this.saveCheckpoint(NOTIFICATION_CHECKPOINT_KEY, bounded);
    }

    /**
     * Processes a batch of feed items in a single DynamoDB round-trip.
     * Loads the checkpoint once, filters new items, updates processedUris, and saves.
     *
     * @param feedName - Feed name or AT URI (used as checkpoint key)
     * @param items - All fetched feed items
     * @returns newItems (not yet processed) and totalFetched count
     */
    async processFeedItems(feedName: string, items: BskyFeedItem[]): Promise<{ newItems: BskyFeedItem[], totalFetched: number }> {
        const checkpoint   = await this.loadFeedCheckpoint(feedName);
        const processedSet = new Set(checkpoint?.processedUris);
        const newItems     = items.filter(item => !processedSet.has(item.post.uri));
        const totalFetched = items.length;

        // Compute high-water mark (max ISO timestamp via lexicographic sort)
        const allIndexedAts = items.map(item => item.post.indexedAt);
        const maxIndexedAt  = allIndexedAts.length > 0
            ? allIndexedAts.toSorted((a, b) => a.localeCompare(b)).at(-1)
            : checkpoint?.lastIndexedAt;

        // Build deduplicated processedUris
        const updatedUris = [...new Set([...(checkpoint?.processedUris ?? []), ...items.map(item => item.post.uri)])];

        const now = new Date().toISOString();
        const updatedCheckpoint: BskyFeedCheckpoint = {
            service:       'bsky',
            type:          'feed',
            feedName,
            lastIndexedAt: maxIndexedAt,
            processedUris: updatedUris,
            updatedAt:     now,
        };

        await this.saveFeedCheckpoint(updatedCheckpoint);

        return { newItems, totalFetched };
    }

    /**
     * Processes a batch of notifications in a single DynamoDB round-trip.
     * Loads the checkpoint once, filters new notifications, updates processedUris, and saves.
     * Does NOT call updateNotificationsSeen — that is a client operation left to the caller.
     *
     * @param notifications - All fetched notifications
     * @returns newNotifications (not yet processed), totalFetched count, lastSeenAt (max indexedAt), and hadExistingCheckpoint
     */
    async processNotifications(notifications: BskyNotification[]): Promise<{ newNotifications: BskyNotification[], totalFetched: number, lastSeenAt: string | undefined, hadExistingCheckpoint: boolean }> {
        const checkpoint          = await this.loadNotificationCheckpoint();
        const hadExistingCheckpoint = !!checkpoint;
        const processedSet        = new Set(checkpoint?.processedUris);
        const newNotifications    = notifications.filter(n => !processedSet.has(n.uri));
        const totalFetched        = notifications.length;

        // Compute lastSeenAt (max indexedAt of fetched notifications via lexicographic sort)
        const sortedIndexedAts = notifications.map(n => n.indexedAt).toSorted((a, b) => a.localeCompare(b));
        // Stryker disable next-line llm: a non-empty map of required BskyNotification.indexedAt strings has a defined final element.
        const lastSeenAt = notifications.length > 0 ? sortedIndexedAts.at(-1) : checkpoint?.lastSeenAt;

        // Build deduplicated processedUris
        const updatedUris = [...new Set([...(checkpoint?.processedUris ?? []), ...notifications.map(n => n.uri)])];

        const now = new Date().toISOString();
        await this.saveNotificationCheckpoint({
            service:       'bsky',
            type:          'notification',
            lastSeenAt,
            processedUris: updatedUris,
            updatedAt:     now,
        });

        return { newNotifications, totalFetched, lastSeenAt, hadExistingCheckpoint };
    }

    /**
     * Loads the DM checkpoint.
     *
     * @returns The checkpoint data, or undefined if not found or invalid
     */
    async loadDmCheckpoint(): Promise<BskyDmCheckpoint | undefined> {
        return this.loadCheckpoint(DM_CHECKPOINT_KEY, bskyDmCheckpointSchema);
    }

    /**
     * Saves (upserts) the DM checkpoint.
     * Applies FIFO eviction to processedMessageIds if over MAX_PROCESSED_URIS.
     *
     * @param checkpoint - The checkpoint data to save
     */
    async saveDmCheckpoint(checkpoint: BskyDmCheckpoint): Promise<void> {
        const bounded = { ...checkpoint, processedMessageIds: checkpoint.processedMessageIds.slice(-MAX_PROCESSED_URIS) };

        await this.saveCheckpoint(DM_CHECKPOINT_KEY, bounded);
    }

    /**
     * Processes a batch of fetched conversations in a single DynamoDB round-trip.
     * Loads the checkpoint once, filters conversations whose lastMessage is new, updates
     * processedMessageIds, and saves. Does NOT call any Bluesky API — that is left to the caller.
     *
     * Dedupe is per-message (`lastMessage.id`), not per-conversation: a new message arriving in
     * an already-processed conversation raises the conversation again rather than being
     * permanently suppressed by a stale convo-id key. A conversation with `unreadCount === 0` or
     * no `lastMessage` is never a new event and never touches the checkpoint.
     *
     * Skips the save entirely when nothing would change (`newConvos` empty and `lastSeenSentAt`
     * unchanged) — a tick with zero unread activity must not write to DynamoDB (review finding:
     * an unconditional write here turns the poller's fixed cadence into a perpetual no-op write
     * against a free-tier table).
     *
     * @param convos - All fetched conversations
     * @returns newConvos (unread, not-yet-processed by lastMessage.id — each entry is guaranteed
     *   to carry a `lastMessage`), totalFetched count, lastSeenSentAt (max candidate
     *   lastMessage.sentAt), and hadExistingCheckpoint
     */
    async processDirectMessages(convos: BskyConversation[]): Promise<{ newConvos: (BskyConversation & { lastMessage: NonNullable<BskyConversation['lastMessage']> })[], totalFetched: number, lastSeenSentAt: string | undefined, hadExistingCheckpoint: boolean }> {
        const checkpoint            = await this.loadDmCheckpoint();
        const hadExistingCheckpoint = !!checkpoint;
        const processedSet          = new Set(checkpoint?.processedMessageIds);
        const totalFetched          = convos.length;

        // Candidates: unread conversations that actually carry a lastMessage — a convo with no
        // lastMessage cannot be an unread event.
        const candidates = convos.filter(
            (c): c is BskyConversation & { lastMessage: NonNullable<BskyConversation['lastMessage']> } =>
                // eslint-disable-next-line @stylistic/operator-linebreak -- Keep the operator with the first predicate so the Stryker directive targets only the second predicate.
                c.unreadCount > 0 &&
                // Stryker disable next-line llm: lastMessage is BskyDirectMessage | undefined, so Boolean() cannot differ from !== undefined
                c.lastMessage !== undefined
        );
        const newConvos  = candidates.filter(c => !processedSet.has(c.lastMessage.id));

        // Compute high-water mark (max ISO timestamp via lexicographic sort) over candidates only.
        const candidateSentAts = candidates.map(c => c.lastMessage.sentAt);
        // Stryker disable next-line llm: Array.length is a non-negative integer, so > 0 and >= 1 are equivalent.
        const lastSeenSentAt   = candidateSentAts.length > 0
            ? candidateSentAts.toSorted((a, b) => a.localeCompare(b)).at(-1)
            : checkpoint?.lastSeenSentAt;

        // Build deduplicated processed lastMessage IDs.
        const updatedMessageIds = [...new Set([...(checkpoint?.processedMessageIds ?? []), ...candidates.map(c => c.lastMessage.id)])];

        // Stryker disable next-line llm: Array.length is a non-negative integer, so > 0 and >= 1 are equivalent.
        if(newConvos.length > 0 || lastSeenSentAt !== checkpoint?.lastSeenSentAt) {
            const now = new Date().toISOString();
            await this.saveDmCheckpoint({
                service:             'bsky',
                type:                'dm',
                lastSeenSentAt,
                processedMessageIds: updatedMessageIds,
                updatedAt:           now,
            });
        }

        return { newConvos, totalFetched, lastSeenSentAt, hadExistingCheckpoint };
    }

    /**
     * Removes the given `lastMessage.id` values from the DM checkpoint's `processedMessageIds`,
     * so a batch already marked processed by {@link processDirectMessages} is treated as new
     * again on the next tick. Used by `dm-poller.ts` when `notify()` returns `false` (the
     * conductor is not yet open) — the checkpoint was already advanced before delivery was
     * attempted, so without this the batch would be silently and permanently lost rather than
     * retried (review finding).
     *
     * No-op (no save) when there is no checkpoint, or none of `ids` are present.
     *
     * @param ids - `lastMessage.id` values to remove from `processedMessageIds`
     */
    async unprocessDirectMessages(ids: string[]): Promise<void> {
        const checkpoint = await this.loadDmCheckpoint();
        if(!checkpoint) {
            return;
        }

        const idSet     = new Set(ids);
        const remaining = checkpoint.processedMessageIds.filter(id => !idSet.has(id));
        if(remaining.length === checkpoint.processedMessageIds.length) {
            return;
        }

        await this.saveDmCheckpoint({ ...checkpoint, processedMessageIds: remaining, updatedAt: new Date().toISOString() });
    }
}
