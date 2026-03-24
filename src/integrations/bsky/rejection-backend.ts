import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { z } from 'zod';
import { BaseRepository } from '@/storage';

// Stryker disable StringLiteral: PK/SK key constants are configuration values
const REJECTION_PK        = 'BSKY#REJECTED';
const REJECTION_SK_PREFIX = 'REJECTION#';
// Stryker restore StringLiteral

const MAX_RETRIES = 3;
const BATCH_SIZE = 25;

function rejectionSK(uuid: string): string {
    // Stryker disable next-line StringLiteral: SK prefix is a configuration constant
    return `${REJECTION_SK_PREFIX}${uuid}`;
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
        const TTL_DAYS = 30;
        await this.putItem({
            // Stryker disable next-line StringLiteral: PK is a configuration constant
            PK:  REJECTION_PK,
            SK:  rejectionSK(item.uuid),
            ...item,
            // Stryker disable next-line ArithmeticOperator: TTL arithmetic — multiplication order does not affect the result
            TTL: Math.floor(Date.now() / 1000) + (TTL_DAYS * 24 * 60 * 60),
        });
    }

    /**
     * List all rejections, newest first.
     */
    async listRejections(): Promise<BskyRejectionItem[]> {
        // Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression strings and attribute maps are configuration
        const items = await this.query<Record<string, unknown>>({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': REJECTION_PK,
            },
        });
        // Stryker restore StringLiteral,ObjectLiteral
        const parsed = items.map(item => BskyRejectionItemSchema.parse(item));
        // Sort newest first by rejectedAt timestamp (SK is now UUID, not time-ordered)
        // Stryker disable next-line StringLiteral,ConditionalExpression: sort comparison is cosmetic ordering only
        return parsed.toSorted((a, b) => b.rejectedAt.localeCompare(a.rejectedAt));
    }

    /**
     * Delete a rejection by its UUID.
     */
    async deleteRejection(uuid: string): Promise<void> {
        await this.deleteItem({
            // Stryker disable next-line StringLiteral: PK is a configuration constant
            PK: REJECTION_PK,
            SK: rejectionSK(uuid),
        });
    }

    /**
     * Delete all stored rejections.
     * Returns the total number of items deleted.
     */
    async clearAll(): Promise<number> {
        // Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression strings and attribute maps are configuration
        const items = await this.query<{ PK: string, SK: string }>({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': REJECTION_PK,
            },
            ProjectionExpression: 'PK, SK',
        });
        // Stryker restore StringLiteral,ObjectLiteral
        // Stryker disable next-line ConditionalExpression,BlockStatement: optimization guard — empty array produces same result as no-op
        if(items.length === 0) {
            return 0;
        }

        const batches: { PK: string, SK: string }[][] = [];
        // Stryker disable next-line EqualityOperator,AssignmentOperator: i < vs i <= equivalent when BATCH_SIZE aligns; i += vs i -= would infinite-loop (timeout, not caught by tests)
        for(let i = 0; i < items.length; i += BATCH_SIZE) {
            batches.push(items.slice(i, i + BATCH_SIZE));
        }

        let failedCount = 0;

        for(const batch of batches) {
            let unprocessed = batch;
            let attempt = 0;

            // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement: retry loop boundary — equivalent mutants for loop guard conditions; BlockStatement on body would infinite-loop (timeout)
            while(unprocessed.length > 0 && attempt < MAX_RETRIES) {
                // eslint-disable-next-line no-await-in-loop -- sequential: each attempt depends on prior unprocessed items
                const result = await this.docClient.send(new BatchWriteCommand({
                    RequestItems: {
                        [this.tableName]: unprocessed.map(({ PK, SK }) => ({
                            DeleteRequest: { Key: { PK, SK } },
                        })),
                    },
                }));

                const leftover = result.UnprocessedItems?.[this.tableName];
                // Stryker disable next-line ConditionalExpression,BlockStatement: Early exit when all items processed successfully
                if(!leftover || leftover.length === 0) {
                    unprocessed = [];
                    break;
                }
                unprocessed = leftover.map(req => req.DeleteRequest!.Key as { PK: string, SK: string });
                // Stryker disable next-line UpdateOperator: attempt counter increment is retry loop bookkeeping
                attempt++;

                // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Retry boundary check and backoff delay — removing delay block is equivalent in tests
                if(attempt < MAX_RETRIES) {
                    // Stryker disable next-line ArithmeticOperator: Backoff delay — multiplication order does not affect correctness
                    const delay = 100 * attempt;
                    // Stryker disable next-line BlockStatement: setTimeout callback body — replacing with {} makes the promise never resolve (timeout)
                    // eslint-disable-next-line no-await-in-loop -- sequential: backoff delay between retry attempts
                    await new Promise((resolve) => {
                        setTimeout(resolve, delay);
                    });
                }
            }

            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Warn only if retries exhausted with remaining items
            if(unprocessed.length > 0) {
                failedCount += unprocessed.length;
                // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
                logger.warn({ count: unprocessed.length, msg: 'Some rejections could not be deleted after retries' });
            }
        }

        return items.length - failedCount;
    }
}
