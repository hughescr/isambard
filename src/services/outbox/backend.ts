import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { OutboxKeyGenerator } from './key-generator';
import { outboxItemSchema, type OutboxItem, type OutboxService, type OutboxDiscardReason } from './types';
import { DynamoTableAccess } from '@/storage';

// DynamoDB removes expired rows asynchronously; expiry is not an application discard disposition.
const TTL_HOURS = 24;

/**
 * DynamoDB backend for the persistent outbox.
 *
 * Items are stored under PK=OUTBOX#discord, with SK sorted by priority then
 * dedupe key. ScanIndexForward=true processes high priority first; within each
 * tier the dedupe key, not insertion time, determines order.
 */
export class OutboxBackend extends DynamoTableAccess {
    /**
     * Enqueue an outbox item. Idempotent — re-enqueuing the same item
     * (same id) overwrites any existing record.
     */
    async enqueue(item: OutboxItem): Promise<void> {
        const keys = OutboxKeyGenerator.createKeys(item);
        const ttl = item.ttl ?? OutboxBackend.expiresAt(Date.now(), { hours: TTL_HOURS });
        await this.putItem({
            ...keys,
            ...item,
            TTL: ttl,
        });
    }

    /**
     * Returns the next `limit` valid items in key order (priority, then dedupe key).
     * Valid items remain in the outbox; malformed rows are deleted after validation fails.
     */
    async dequeue(service: OutboxService, limit = 10): Promise<OutboxItem[]> {
        const valid: OutboxItem[] = [];
        let cursor: Record<string, unknown> | undefined;
        do {
            // eslint-disable-next-line no-await-in-loop -- each query must use the preceding page's cursor
            const page = await this.docClient.send(new QueryCommand({
                TableName:                 this.tableName,
                KeyConditionExpression:    '#pk = :pk',
                ExpressionAttributeNames:  { '#pk': 'PK' },
                ExpressionAttributeValues: { ':pk': OutboxKeyGenerator.createServicePK(service) },
                ScanIndexForward:          true,
                Limit:                     limit - valid.length,
                ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
            }));
            for(const item of page.Items ?? []) {
                const raw: Record<string, unknown> = item;
                const parsed = outboxItemSchema.safeParse(raw);
                if(parsed.success) {
                    valid.push(parsed.data);
                } else {
                    try {
                        // eslint-disable-next-line no-await-in-loop -- malformed rows are deleted before advancing the paginated read loop
                        await this.deleteItem({ PK: raw.PK as string, SK: raw.SK as string });
                        logger.warn({ service, pk: raw.PK, sk: raw.SK, error: parsed.error }, 'Deleted malformed outbox item');
                    } catch (error: unknown) {
                        logger.error({ service, pk: raw.PK, sk: raw.SK, error }, 'Failed to delete malformed outbox item');
                    }
                }
            }
            cursor = page.LastEvaluatedKey;
        } while(cursor !== undefined && valid.length < limit);
        return valid.slice(0, limit);
    }

    private async remove(item: OutboxItem): Promise<void> {
        await this.deleteItem(OutboxKeyGenerator.createKeys(item));
    }

    /** Delete an item only after an external send succeeds; a failed delete leaves its outcome uncertain. */
    async acknowledgeDelivered(item: OutboxItem): Promise<void> {
        await this.remove(item);
    }

    /** Delete without sending and log the application-observed reason (not DynamoDB TTL expiry). */
    async discard(item: OutboxItem, reason: OutboxDiscardReason): Promise<void> {
        await this.remove(item);
        logger.warn({ itemId: item.id, service: item.service, reason, attemptCount: item.progress.attemptCount }, 'Discarded outbox item');
    }

    /** Persist retry metadata; a missing item.ttl refreshes the default TTL on a retry. */
    private async persistFailure(item: OutboxItem): Promise<void> {
        const keys = OutboxKeyGenerator.createKeys(item);
        const ttl = item.ttl ?? OutboxBackend.expiresAt(Date.now(), { hours: TTL_HOURS });
        await this.putItem({ ...keys, ...item, TTL: ttl });
    }

    async markFailed(item: OutboxItem, error: string, options: { retryable: boolean }): Promise<void> {
        const updated: OutboxItem = {
            ...item,
            progress: {
                attemptCount:  item.progress.attemptCount + 1,
                lastError:     error,
                lastAttemptAt: new Date().toISOString(),
            },
        };
        if(options.retryable) {
            await this.persistFailure(updated);
            return;
        }
        try {
            await this.discard(updated, 'permanent_error');
        } catch (deleteError: unknown) {
            // A failed terminal delete must leave an exhausted marker, not an item eligible to resend.
            await this.persistFailure(updated);
            throw deleteError;
        }
    }
}
