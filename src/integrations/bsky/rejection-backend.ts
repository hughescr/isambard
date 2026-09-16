import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { z } from 'zod';
import { BaseRepository, createPrefixedKey } from '@/storage';

const REJECTION_PK        = 'BSKY#REJECTED';
const REJECTION_SK_PREFIX = 'REJECTION';

const TTL_DAYS = 30;
const MAX_RETRIES = 3;
const BATCH_SIZE = 25;

function rejectionSK(uuid: string): string {
    return createPrefixedKey(REJECTION_SK_PREFIX, uuid);
}

const BskyRejectedReplySchema = z.object({
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

const BskyRejectedDMSchema = z.object({
    type:             z.literal('dm'),
    uuid:             z.uuid(),
    text:             z.string(),
    recipientHandles: z.array(z.string()),
    convoId:          z.string(),
    reason:           z.string(),
    rejectedAt:       z.string(),
});

const BskyRejectionItemSchema = z.discriminatedUnion('type', [BskyRejectedReplySchema, BskyRejectedDMSchema]);

export type BskyRejectedReply = z.infer<typeof BskyRejectedReplySchema>;
export type BskyRejectedDM = z.infer<typeof BskyRejectedDMSchema>;
export type BskyRejectionItem = z.infer<typeof BskyRejectionItemSchema>;

/**
 * DynamoDB backend for storing rejected Bluesky posts/DMs.
 * Allows the agent to see rejection reasons and retry with revised content.
 */
export class BskyRejectionBackend extends BaseRepository<BskyRejectionItem> {
    /**
     * Store a rejected Bluesky post or DM.
     */
    async recordRejection(item: BskyRejectionItem): Promise<void> {
        await this.putItem({
            PK:  REJECTION_PK,
            SK:  rejectionSK(item.uuid),
            ...item,
            TTL: BskyRejectionBackend.ttlFromDays(TTL_DAYS),
        });
    }

    /**
     * List all rejections, newest first.
     */
    async listRejections(): Promise<BskyRejectionItem[]> {
        const items = await this.query<Record<string, unknown>>({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': REJECTION_PK,
            },
        });
        const parsed = items.map(item => BskyRejectionItemSchema.parse(item));
        // Sort newest first by rejectedAt timestamp (SK is now UUID, not time-ordered)
        return parsed.toSorted((a, b) => b.rejectedAt.localeCompare(a.rejectedAt));
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
            (_, index) => items.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE)
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
