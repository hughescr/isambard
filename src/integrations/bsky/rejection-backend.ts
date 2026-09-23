import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { z } from 'zod';
import { type BskyReplyInput, createAtUri, createCid } from '@/integrations/bsky/types';
import { BaseRepository, createPrefixedKey } from '@/storage';

const REJECTION_PK        = 'BSKY#REJECTED';
const REJECTION_SK_PREFIX = 'REJECTION';

const TTL_DAYS = 30;
const MAX_RETRIES = 3;
const BATCH_SIZE = 25;

function rejectionSK(uuid: string): string {
    return createPrefixedKey(REJECTION_SK_PREFIX, uuid);
}

// Persisted (wire) schemas — the DynamoDB row shape. Kept as flat, independently-optional
// root fields exactly as historically written; never change this shape in place. Domain code
// sees the nested BskyReplyInput shape instead, via toStoredReply()/fromStoredReply() below.
const StoredBskyRejectedReplySchema = z.object({
    type:         z.literal('reply'),
    uuid:         z.uuid(),
    text:         z.string(),
    targetHandle: z.string(),
    parentUri:    z.string(),
    parentCid:    z.string(),
    rootUri:      z.string().optional(),
    rootCid:      z.string().optional(),
    reason:       z.string(),
    rejectedAt:   z.string(),
});

const StoredBskyRejectedDMSchema = z.object({
    type:             z.literal('dm'),
    uuid:             z.uuid(),
    text:             z.string(),
    recipientHandles: z.array(z.string()),
    convoId:          z.string(),
    reason:           z.string(),
    rejectedAt:       z.string(),
});

const StoredBskyRejectionItemSchema = z.discriminatedUnion('type', [StoredBskyRejectedReplySchema, StoredBskyRejectedDMSchema]);

type StoredBskyRejectedReply = z.infer<typeof StoredBskyRejectedReplySchema>;

/** Domain shape of a rejected Bluesky reply — the strong ref is a single {@link BskyReplyInput}, not four flat optional strings. */
export interface BskyRejectedReply {
    type:         'reply'
    uuid:         string
    text:         string
    targetHandle: string
    reply:        BskyReplyInput
    reason:       string
    rejectedAt:   string
}

export type BskyRejectedDM = z.infer<typeof StoredBskyRejectedDMSchema>;
export type BskyRejectionItem = BskyRejectedReply | BskyRejectedDM;

/** Flatten a domain reply-rejection into the persisted (wire) row shape. */
function toStoredReply(item: BskyRejectedReply): StoredBskyRejectedReply {
    return {
        type:         'reply',
        uuid:         item.uuid,
        text:         item.text,
        targetHandle: item.targetHandle,
        parentUri:    item.reply.parent.uri,
        parentCid:    item.reply.parent.cid,
        ...(item.reply.root ? { rootUri: item.reply.root.uri, rootCid: item.reply.root.cid } : {}),
        reason:       item.reason,
        rejectedAt:   item.rejectedAt,
    };
}

/**
 * Unflatten a persisted reply-rejection row into the domain shape.
 * Throws (via createAtUri/createCid) if parentUri/parentCid are empty or malformed —
 * callers must treat that as a single-row failure, not abort the whole listing.
 */
function fromStoredReply(row: StoredBskyRejectedReply): BskyRejectedReply {
    return {
        type:         'reply',
        uuid:         row.uuid,
        text:         row.text,
        targetHandle: row.targetHandle,
        reply:        {
            parent: { uri: createAtUri(row.parentUri), cid: createCid(row.parentCid) },
            root:   (row.rootUri !== undefined && row.rootCid !== undefined) ? { uri: createAtUri(row.rootUri), cid: createCid(row.rootCid) } : undefined,
        },
        reason:     row.reason,
        rejectedAt: row.rejectedAt,
    };
}

/**
 * DynamoDB backend for storing rejected Bluesky posts/DMs.
 * Allows the agent to see rejection reasons and retry with revised content.
 */
export class BskyRejectionBackend extends BaseRepository<BskyRejectionItem> {
    /**
     * Store a rejected Bluesky post or DM.
     */
    async recordRejection(item: BskyRejectionItem): Promise<void> {
        const stored = item.type === 'reply' ? toStoredReply(item) : item;
        await this.putItem({
            PK:  REJECTION_PK,
            SK:  rejectionSK(item.uuid),
            ...stored,
            TTL: BskyRejectionBackend.ttlFromDays(TTL_DAYS),
        });
    }

    /**
     * List all rejections, newest first.
     *
     * A row that fails to parse (malformed shape) or fails to unflatten into a domain
     * strong ref (e.g. a legacy row persisted with an empty parentUri/parentCid before
     * strong refs were validated) is logged and skipped rather than aborting the whole
     * listing — one bad row must not hide every other pending rejection from context.
     */
    async listRejections(): Promise<BskyRejectionItem[]> {
        const items = await this.query<Record<string, unknown>>({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': REJECTION_PK,
            },
        });

        const results: BskyRejectionItem[] = [];
        for(const item of items) {
            const parsedRow = StoredBskyRejectionItemSchema.safeParse(item);
            if(!parsedRow.success) {
                logger.warn({ error: parsedRow.error, msg: 'Skipping malformed Bluesky rejection row' });
                continue;
            }
            if(parsedRow.data.type === 'dm') {
                results.push(parsedRow.data);
                continue;
            }
            try {
                results.push(fromStoredReply(parsedRow.data));
            } catch (err) {
                logger.warn({ err, uuid: parsedRow.data.uuid, msg: 'Skipping Bluesky rejection row with an invalid strong ref' });
            }
        }

        // Sort newest first by rejectedAt timestamp (SK is now UUID, not time-ordered)
        return results.toSorted((a, b) => b.rejectedAt.localeCompare(a.rejectedAt));
    }

    /**
     * Delete a rejection by its UUID.
     */
    async deleteRejection(uuid: string): Promise<void> {
        await this.deleteItem({
            PK: REJECTION_PK,
            SK: rejectionSK(uuid),
        });
    }

    /**
     * Delete all stored rejections.
     * Returns the total number of items deleted.
     */
    async clearAll(): Promise<number> {
        const items = await this.query<{ PK: string, SK: string }>({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': REJECTION_PK,
            },
            ProjectionExpression: 'PK, SK',
        });
        const batches = Array.from(
            { length: Math.ceil(items.length / BATCH_SIZE) },
            (_, index) => items.slice(
                // Stryker disable next-line llm: index is an integer Array.from index and BATCH_SIZE an integer constant, so Math.floor on their product is the identity
                index * BATCH_SIZE,
                (index + 1) * BATCH_SIZE
            )
        );

        let failedCount = 0;

        for(const batch of batches) {
            let unprocessed = batch;
            for(let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                // eslint-disable-next-line no-await-in-loop -- sequential: each attempt depends on prior unprocessed items
                const result = await this.docClient.send(new BatchWriteCommand({
                    RequestItems: {
                        [this.tableName]: unprocessed.map(({ PK, SK }) => ({
                            DeleteRequest: { Key: { PK, SK } },
                        })),
                    },
                }));

                const leftover = result.UnprocessedItems?.[this.tableName];
                // Stryker disable next-line llm: array .length is never negative, so === 0 and <= 0 are equivalent
                if(!leftover || leftover.length === 0) {
                    unprocessed = [];
                    break;
                }
                unprocessed = leftover.flatMap(req => (req.DeleteRequest ? [req.DeleteRequest.Key as { PK: string, SK: string }] : []));
                if(attempt + 1 < MAX_RETRIES) {
                    const delay = 100 * (attempt + 1);
                    // eslint-disable-next-line no-await-in-loop -- sequential: backoff delay between retry attempts
                    await new Promise((resolve) => {
                        setTimeout(resolve, delay);
                    });
                }
            }

            if(unprocessed.length > 0) {
                failedCount += unprocessed.length;
                logger.warn({ count: unprocessed.length, msg: 'Some rejections could not be deleted after retries' });
            }
        }

        return items.length - failedCount;
    }
}
