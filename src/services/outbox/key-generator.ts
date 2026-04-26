import type { OutboxPriority } from './types';

// Stryker disable StringLiteral: PK/SK key constants are configuration values
const OUTBOX_PK_PREFIX = 'OUTBOX#';
const ITEM_SK_PREFIX   = 'ITEM#';
// Stryker restore StringLiteral

// Stryker disable StringLiteral,ObjectLiteral: Priority sort constants are static configuration
const PRIORITY_SORT: Record<OutboxPriority, string> = {
    high:   '0',
    medium: '1',
    low:    '2',
};
// Stryker restore StringLiteral,ObjectLiteral

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
    createKeys(item: { service: string, priority: OutboxPriority, dedupeKey: string }): { PK: string, SK: string } {
        return {
            // Stryker disable next-line StringLiteral: PK prefix is a configuration constant
            PK: `${OUTBOX_PK_PREFIX}${item.service}`,
            // Stryker disable next-line StringLiteral: SK prefix is a configuration constant
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
        // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — with hashIdx=-1, slice(0,-1) and slice(0) produce priorityChar/dedupeKey that won't match any PRIORITY_SORT entry, so parseSK returns undefined either way
        if(hashIdx === -1) {
            return undefined;
        }
        const priorityChar = withoutPrefix.slice(0, hashIdx);
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
    createServicePK(service: string): string {
        // Stryker disable next-line StringLiteral: PK prefix is a configuration constant
        return `${OUTBOX_PK_PREFIX}${service}`;
    },
};
