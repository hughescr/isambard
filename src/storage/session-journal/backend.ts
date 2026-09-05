import {
    QueryCommand,
    type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { BaseRepository } from '../repositories/base';
import { journalEntrySchema, type JournalEntry, type SessionJournalItem, type SessionRole } from './types';

const SEQ_PAD_WIDTH = 6;

/**
 * Write-through backend for the session journal (SESSION_JOURNAL#<role> partition). Items carry
 * no `GSI1PK`/`GSI1SK`, so `LAYER#events` queries (context-builder.ts, event-delta-tracker.ts)
 * never see a journal row — the deliberate deviation from design 3.2/7.3 documented on
 * {@link SessionJournalItem}.
 */
export class SessionJournalBackend extends BaseRepository<SessionJournalItem> {
    /**
     * Per-instance monotonic counter disambiguating rows written in the same millisecond,
     * reset each process start. Astronomically unlikely to collide with a prior process's rows
     * at the same PK+millisecond, and even a collision would only reorder two same-instant rows
     * within one role's partition.
     */
    private seq = 0;

    /**
     * Appends one journal entry for `role`, deriving the sort key from `entry.at` plus an
     * internal sequence number. Never throws for a validation reason — the caller (P8's
     * {@link https://en.wikipedia.org/wiki/Write-ahead_logging | write-ahead} journal wrapper,
     * src/agent/session/journal.ts) already has a fully-typed `JournalEntry`; this only rejects
     * on a genuine DynamoDB failure.
     */
    async append(role: SessionRole, entry: JournalEntry, ttlDays = 30): Promise<void> {
        const ts = entry.at.toISOString();
        const seq = this.seq;
        this.seq += 1;
        const item: SessionJournalItem = {
            ...entry,
            PK:  `SESSION_JOURNAL#${role}`,
            SK:  `${ts}#${String(seq).padStart(SEQ_PAD_WIDTH, '0')}`,
            TTL: BaseRepository.ttlFromDays(ttlDays),
            at:  ts,
        };
        await this.putItem(item);
    }

    /**
     * Every journal entry for `role` written at or after `sinceIso`, ascending by write order.
     * Pages through `LastEvaluatedKey` until exhausted (pattern: src/storage/person-allowlist.ts
     * `list()`). A row that fails {@link journalEntrySchema} is skipped with one `logger.warn`
     * rather than aborting the whole read — a single corrupt row must not block crash recovery.
     */
    async readSince(role: SessionRole, sinceIso: string): Promise<JournalEntry[]> {
        const rawItems: Record<string, unknown>[] = [];
        let lastEvaluatedKey: Record<string, unknown> | undefined;

        do {
            const params: QueryCommandInput = {
                TableName:                 this.tableName,
                KeyConditionExpression:    '#pk = :pk AND #sk >= :since',
                ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
                ExpressionAttributeValues: { ':pk': `SESSION_JOURNAL#${role}`, ':since': sinceIso },
                ScanIndexForward:          true,
                ExclusiveStartKey:         lastEvaluatedKey,
            };
            // eslint-disable-next-line no-await-in-loop -- sequential pagination required by DynamoDB
            const result = await this.docClient.send(new QueryCommand(params));
            rawItems.push(...(result.Items ?? []));
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while(lastEvaluatedKey);

        const entries: JournalEntry[] = [];
        for(const raw of rawItems) {
            const parsed = journalEntrySchema.safeParse(raw);
            if(!parsed.success) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
                logger.warn({ role, raw, error: parsed.error, msg: 'SessionJournalBackend.readSince(): skipping malformed journal row' });
                continue;
            }
            entries.push(parsed.data);
        }
        return entries;
    }
}
