import { BaseRepository } from '@/storage';
import { OutboxKeyGenerator } from './key-generator';
import { outboxItemSchema, type OutboxItem } from './types';

const TTL_HOURS = 24;

/**
 * DynamoDB backend for the persistent outbox.
 *
 * Items are stored under PK=OUTBOX#{service}, with SK sorted by priority then
 * insertion time so that dequeue always returns the highest-priority oldest item
 * first (ScanIndexForward=true).
 */
export class OutboxBackend extends BaseRepository<OutboxItem> {
    /**
     * Enqueue an outbox item. Idempotent — re-enqueuing the same item
     * (same id) overwrites any existing record.
     */
    async enqueue(item: OutboxItem): Promise<void> {
        const keys = OutboxKeyGenerator.createKeys(item);
        // Stryker disable next-line ArithmeticOperator: TTL arithmetic — multiplication order does not affect result
        const ttl = item.ttl ?? Math.floor(Date.now() / 1000) + (TTL_HOURS * 60 * 60);
        await this.putItem({
            ...keys,
            ...item,
            TTL: ttl,
        });
    }

    /**
     * Returns the next `limit` items in delivery order (priority, then oldest first).
     * Does not remove them from the outbox.
     */
    async dequeue(service: string, limit: number = 10): Promise<OutboxItem[]> {
        // Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression strings and attribute maps are configuration
        const items = await this.query<Record<string, unknown>>({
            KeyConditionExpression:    '#pk = :pk',
            ExpressionAttributeNames:  { '#pk': 'PK' },
            ExpressionAttributeValues: {
                ':pk': OutboxKeyGenerator.createServicePK(service),
            },
            ScanIndexForward: true,
            Limit:            limit,
        });
        // Stryker restore StringLiteral,ObjectLiteral
        return items.map(item => outboxItemSchema.parse(item));
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
            progress: {
                ...item.progress,
                lastError:     error,
                lastAttemptAt: new Date().toISOString(),
            },
        };
        const keys = OutboxKeyGenerator.createKeys(updated);
        // Stryker disable next-line ArithmeticOperator: TTL arithmetic — multiplication order does not affect result
        const ttl = updated.ttl ?? Math.floor(Date.now() / 1000) + (TTL_HOURS * 60 * 60);
        await this.putItem({ ...keys, ...updated, TTL: ttl });
    }
}
