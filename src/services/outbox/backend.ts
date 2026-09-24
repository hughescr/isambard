import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { OutboxKeyGenerator } from './key-generator';
import { outboxItemSchema, type OutboxItem } from './types';
import { DynamoTableAccess } from '@/storage';

const TTL_HOURS = 24;

/**
 * DynamoDB backend for the persistent outbox.
 *
 * Items are stored under PK=OUTBOX#{service}, with SK sorted by priority then
 * insertion time so that dequeue always returns the highest-priority oldest item
 * first (ScanIndexForward=true).
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
     * Returns the next `limit` valid items in delivery order (priority, then oldest first).
     * Valid items remain in the outbox; malformed rows are deleted after validation fails.
     */
    async dequeue(service: string, limit = 10): Promise<OutboxItem[]> {
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

    /**
     * Remove a successfully delivered item from the outbox.
     */
    async markSent(item: OutboxItem): Promise<void> {
        const keys = OutboxKeyGenerator.createKeys(item);
        await this.deleteItem(keys);
    }

    /**
     * Record a delivery failure on an item (updates progress metadata in-place).
     */
    async markFailed(item: OutboxItem, error: string): Promise<void> {
        const updated: OutboxItem = {
            ...item,
            // Stryker disable next-line SpreadOperandDrop: progress schema contains only lastError and lastAttemptAt, both overwritten below.
            progress: {
                ...item.progress,
                lastError:     error,
                lastAttemptAt: new Date().toISOString(),
            },
        };
        const keys = OutboxKeyGenerator.createKeys(updated);
        const ttl = updated.ttl ?? OutboxBackend.expiresAt(Date.now(), { hours: TTL_HOURS });
        await this.putItem({ ...keys, ...updated, TTL: ttl });
    }
}
