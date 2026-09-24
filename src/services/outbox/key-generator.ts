import type { OutboxPriority, OutboxService } from './types';

const OUTBOX_PK_PREFIX = 'OUTBOX#';
const ITEM_SK_PREFIX   = 'ITEM#';

const PRIORITY_SORT: Record<OutboxPriority, string> = {
    high:   '0',
    medium: '1',
    low:    '2',
};

/**
 * DynamoDB key generator for outbox items.
 *
 * Key structure:
 *   PK: OUTBOX#{service}
 *   SK: ITEM#{prioritySortChar}#{dedupeKey}
 *
 * Using dedupeKey in the SK means re-enqueueing the same logical item
 * (same dedupeKey) naturally overwrites via PutItem — automatic deduplication.
 * Items within a priority tier are sorted by dedupeKey (UUID, effectively random).
 * Priority ordering (high before low) is the important ordering guarantee.
 */
export const OutboxKeyGenerator = {
    /**
     * Creates PK and SK for an outbox item.
     */
    createKeys(item: { service: OutboxService, priority: OutboxPriority, dedupeKey: string }): { PK: string, SK: string } {
        return {
            PK: `${OUTBOX_PK_PREFIX}${item.service}`,
            SK: `${ITEM_SK_PREFIX}${PRIORITY_SORT[item.priority]}#${item.dedupeKey}`,
        };
    },

    /**
     * Parses an SK back into its components.
     * Returns undefined if the SK is not in the expected format.
     */

    parseSK(sk: string): { priority: OutboxPriority, dedupeKey: string } | undefined {
        if(!sk.startsWith(ITEM_SK_PREFIX)) {
            return undefined;
        }
        const withoutPrefix = sk.slice(ITEM_SK_PREFIX.length);
        // Format: {priorityChar}#{dedupeKey}
        const hashIdx = withoutPrefix.indexOf('#');
        // Stryker disable next-line llm: indexOf returns only -1 or a non-negative index, so `=== -1` and `< 0` select the same branch.
        if(hashIdx === -1) {
            return undefined;
        }
        const priorityChar = withoutPrefix.slice(0, hashIdx);
        // Stryker disable next-line llm: the guard above returns on -1, so hashIdx + 1 is non-negative and slice and substring return the same suffix.
        const dedupeKey = withoutPrefix.slice(hashIdx + 1);

        const priorityEntry = Object.entries(PRIORITY_SORT).find(([, v]) => v === priorityChar);
        if(priorityEntry === undefined) {
            return undefined;
        }
        return {
            priority: priorityEntry[0] as OutboxPriority,
            dedupeKey,
        };
    },

    /**
     * Creates the PK for querying all items for a service.
     */
    createServicePK(service: OutboxService): string {
        return `${OUTBOX_PK_PREFIX}${service}`;
    },
};
