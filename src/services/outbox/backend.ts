import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { OutboxKeyGenerator } from './key-generator';
import { outboxItemSchema, type DrainerDiscardReason, type OutboxItem, type OutboxService, type OutboxDiscardReason } from './types';
import { DynamoTableAccess, type DeleteItemOptions } from '@/storage';

// DynamoDB removes expired rows asynchronously; expiry is not an application discard disposition,
// and it cannot be hooked, so a TTL deletion is never reported to Izzy. The drainer deliberately
// does not treat a row as terminal shortly before its TTL (#141): every retry, unknown outcome,
// deferral and pending discard rewrites the TTL below, and attempts are bounded (see the drainer),
// so a row the drainer processes reaches a reported terminal disposition within minutes. TTL can
// only fire on a row nothing processed for 24 hours, i.e. Discord or the process was down that
// whole time, when no drainer-side check could run anyway.
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
        await this.putItem(this.createPersistedRow(item));
    }

    private createPersistedRow(item: OutboxItem): Record<string, unknown> {
        const keys = OutboxKeyGenerator.createKeys(item);
        const ttl = item.ttl ?? OutboxBackend.expiresAt(Date.now(), { hours: TTL_HOURS });
        return {
            ...keys,
            ...item,
            TTL:                 ttl,
            outboxRowGeneration: crypto.randomUUID(),
        };
    }

    private static malformedRowDeleteCondition(raw: Record<string, unknown>): DeleteItemOptions['condition'] {
        const names = { '#generation': 'outboxRowGeneration' };
        if(typeof raw.outboxRowGeneration === 'string') {
            return {
                ConditionExpression:       '#generation = :generation',
                ExpressionAttributeNames:  names,
                ExpressionAttributeValues: { ':generation': raw.outboxRowGeneration },
            };
        }
        return {
            ConditionExpression:      'attribute_not_exists(#generation)',
            ExpressionAttributeNames: names,
        };
    }

    private async cleanupMalformedItem(raw: Record<string, unknown>, service: OutboxService, parseError: unknown): Promise<void> {
        try {
            await this.deleteItem(
                { PK: raw.PK as string, SK: raw.SK as string },
                { condition: OutboxBackend.malformedRowDeleteCondition(raw) }
            );
            logger.warn({ service, pk: raw.PK, sk: raw.SK, error: parseError }, 'Deleted malformed outbox item');
        } catch (error: unknown) {
            if(error instanceof Error && error.name === 'ConditionalCheckFailedException') {
                logger.debug({ service, pk: raw.PK, sk: raw.SK }, 'Preserved malformed outbox item rewritten before cleanup');
                return;
            }
            logger.error({ service, pk: raw.PK, sk: raw.SK, error }, 'Failed to delete malformed outbox item');
        }
    }

    /**
     * Returns the next `limit` valid items in key order (priority, then dedupe key).
     * Valid items remain in the outbox; malformed rows are deleted after validation fails.
     * `onDeferred` receives the `nextAttemptAt` of every scanned row that is not yet due, so the
     * drainer can re-arm a retry timer that an earlier, shorter timer displaced.
     */
    async dequeue(service: OutboxService, limit = 10, onDeferred?: (nextAttemptAt: string) => void): Promise<OutboxItem[]> {
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
                    const nextAttemptAt = parsed.data.progress.nextAttemptAt;
                    if(nextAttemptAt === undefined || new Date(nextAttemptAt).getTime() <= Date.now()) {
                        valid.push(parsed.data);
                    } else {
                        onDeferred?.(nextAttemptAt);
                    }
                } else {
                    // eslint-disable-next-line no-await-in-loop -- malformed rows are deleted before advancing the paginated read loop
                    await this.cleanupMalformedItem(raw, service, parsed.error);
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
        await this.putItem(this.createPersistedRow(item));
    }

    async markFailed(item: OutboxItem, error: string, options: { retryable: boolean, nextAttemptAt?: string }): Promise<void> {
        const updated: OutboxItem = {
            ...item,
            progress: {
                attemptCount:  item.progress.attemptCount + 1,
                lastError:     error,
                lastAttemptAt: new Date().toISOString(),
                // The replay settles an unknown outcome once it has checked history; one it never
                // settled (the channel fetch failed first) stays unknown, so it is never blind-replayed.
                outcome:       item.progress.outcome ?? 'retryable',
                ...(options.nextAttemptAt === undefined ? {} : { nextAttemptAt: options.nextAttemptAt }),
                // Part boundaries are sized from the delivery token, so a resumed replay must keep
                // both or it could skip or duplicate text after a partial delivery.
                ...(item.progress.deliveryToken === undefined ? {} : { deliveryToken: item.progress.deliveryToken }),
                ...(item.progress.deliveredParts === undefined ? {} : { deliveredParts: item.progress.deliveredParts }),
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

    /**
     * Postpone an item without spending a delivery attempt: every other progress field
     * (attemptCount, outcome, deliveryToken, deliveredParts) is kept as it was.
     */
    async defer(item: OutboxItem, reason: string, nextAttemptAt: string): Promise<void> {
        await this.persistFailure({ ...item, progress: { ...item.progress, lastError: reason, nextAttemptAt } });
    }

    /**
     * Keep a row whose discard the drainer decided but could not finish, so it is reported and
     * discarded on a later pass instead of being resent. The delivery error in `lastError` and every
     * other progress field are kept, so the eventual notice names the error that caused the discard.
     */
    async markPendingDiscard(item: OutboxItem, reason: DrainerDiscardReason, nextAttemptAt: string): Promise<void> {
        await this.persistFailure({ ...item, progress: { ...item.progress, pendingDiscard: reason, nextAttemptAt } });
    }

    /** Persist an ambiguous send outcome; it is never eligible for blind replay. */
    async markUnknown(item: OutboxItem, error: string, nextAttemptAt: string): Promise<void> {
        await this.persistFailure({
            ...item,
            progress: {
                ...item.progress,
                attemptCount:  item.progress.attemptCount + 1,
                lastError:     error,
                lastAttemptAt: new Date().toISOString(),
                nextAttemptAt,
                outcome:       'unknown',
            },
        });
    }
}
