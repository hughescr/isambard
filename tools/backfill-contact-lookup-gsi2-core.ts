/**
 * Core backfill logic for CONTACT_LOOKUP GSI2 keys, extracted for testability.
 *
 * This module is imported by both the CLI entrypoint (backfill-contact-lookup-gsi2.ts)
 * and by unit tests.  It has no top-level side-effects so it is safe to import in tests.
 *
 * See backfill-contact-lookup-gsi2.ts for CLI usage.
 */

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import pLimit from 'p-limit';
import type { createDynamoDBClient } from '@/storage';
import { ContactKeyGenerator } from '@/storage/contacts/key-generator';
import { contactSchema, type ContactId, type ContactIdentifier } from '@/storage/contacts/types';
import { retryAsync } from '@/utils/retry/retry-async';

export interface BackfillOptions {
    dryRun:   boolean
    showHelp: boolean
}

/**
 * A contact profile item as returned from the CONTACTS GSI2 partition.
 * Contains the personId and identifiers array needed to compute expected lookup row keys.
 */
export interface ContactProfileItem {
    PK:          string
    SK:          string
    personId:    string
    identifiers: ContactIdentifier[]
}

export function parseArgs(argv: string[]): BackfillOptions {
    // Start with both flags disabled; set them below as we find the relevant CLI args.
    let dryRun = false;
    let showHelp = false;

    // Strip argv[0] (runtime) and argv[1] (script path); only process user-provided args.
    const args = argv.slice(2);
    for(const arg of args) {
        if(arg === '--help' || arg === '-h') {
            showHelp = true;
        } else if(arg === '--dry-run') {
            dryRun = true;
        } else if(arg.startsWith('--')) {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    return { dryRun, showHelp };
}

export interface PageStats {
    updated: number
    skipped: number
    errors:  number
}

const MAX_CONCURRENT_UPDATES = 4;
const UPDATE_INTERVAL_MS = 250;

/** Space actual request starts; share this pacer across pages and retries. */
export function createUpdateRateLimiter(
    now:   () => number = Date.now,
    sleep: (ms: number) => Promise<void> = ms => new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    })
): () => Promise<void> {
    // Stryker disable next-line NumberLiteralValue: initial nextStart is read only through Math.max(0, nextStart - now()), so any value <= 0 is indistinguishable for non-negative clocks
    let nextStart = 0;
    let tail: Promise<void> = Promise.resolve();
    function recordStart(): void {
        // Rebase after the timer actually wakes. Stalled timers must not release
        // queued requests in a burst using reservations made before the stall.
        nextStart = now() + UPDATE_INTERVAL_MS;
    }
    return () => {
        const ticket = tail.then(async () => {
            // Stryker disable next-line NumberLiteralValue: waitMs is consumed only by if(waitMs > 0), so clamping to -1 instead of 0 is unobservable
            const waitMs = Math.max(0, nextStart - now());
            if(waitMs > 0) {
                await sleep(waitMs);
            }
            recordStart();
            return undefined;
        });
        tail = ticket.catch(() => undefined);
        return ticket;
    };
}

/**
 * Update a single CONTACT_LOOKUP row with GSI2 keys.
 *
 * Returns 'updated' on success, 'skipped' if condition failed (already backfilled/stale),
 * or 'error' on any other failure.
 */
async function updateLookupRow(
    tableName: string,
    docClient: ReturnType<typeof createDynamoDBClient>['docClient'],
    keys: { PK: string, SK: string, GSI2PK: string, GSI2SK: string },
    pace: () => Promise<void>
): Promise<'updated' | 'skipped' | 'error'> {
    try {
        await retryAsync(async () => {
            await pace();
            return docClient.send(new UpdateCommand({
                TableName:                 tableName,
                Key:                       { PK: keys.PK, SK: keys.SK },
                UpdateExpression:          'SET GSI2PK = :gsi2pk, GSI2SK = :gsi2sk, createdAt = if_not_exists(createdAt, :createdAt)',
                ConditionExpression:       'attribute_exists(PK) AND attribute_not_exists(GSI2PK)',
                ExpressionAttributeValues: {
                    ':gsi2pk':    keys.GSI2PK,
                    ':gsi2sk':    keys.GSI2SK,
                    ':createdAt': new Date().toISOString(),
                },
            }));
        });
        logger.debug({ pk: keys.PK, sk: keys.SK, gsi2sk: keys.GSI2SK, msg: 'Updated CONTACT_LOOKUP row with GSI2 keys' });
        return 'updated';
    } catch (error) {
        if(error instanceof Error && error.name === 'ConditionalCheckFailedException') {
            // Row already has GSI2PK or row no longer exists — treat as already backfilled/stale
            return 'skipped';
        }
        logger.warn({ pk: keys.PK, sk: keys.SK, err: error, msg: 'Failed to update row after retries' });
        return 'error';
    }
}

/**
 * Process one page of contact profile items from the CONTACTS GSI2 partition.
 * For each contact, iterate its identifiers and update the corresponding
 * CONTACT_LOOKUP row with GSI2 keys if not already present.
 *
 * Uses ConditionalCheckFailedException to detect rows that are already
 * backfilled (condition: attribute_exists(PK) AND attribute_not_exists(GSI2PK)).
 */
export async function processContacts(
    items: ContactProfileItem[],
    tableName: string,
    docClient: ReturnType<typeof createDynamoDBClient>['docClient'],
    dryRun: boolean,
    pace: () => Promise<void> = createUpdateRateLimiter()
): Promise<PageStats> {
    let updated = 0;
    let skipped = 0;
    let errors  = 0;
    const pending: ReturnType<typeof ContactKeyGenerator.createLookupKeys>[] = [];

    for(const item of items) {
        // Parse the contact to get identifiers — use contactSchema.pick to avoid full validation
        // of fields we don't need (notes, _internal, etc. might be missing in older records).
        // We only need personId + identifiers, so parse just those.
        let personId: string;
        let identifiers: ContactIdentifier[];
        try {
            const parsed = contactSchema.pick({ personId: true, identifiers: true }).parse(item);
            personId    = parsed.personId;
            identifiers = parsed.identifiers;
        } catch (error) {
            logger.warn({ pk: item.PK, err: error, msg: 'Skipping contact: failed to parse personId/identifiers' });
            errors++;
            continue;
        }

        for(const identifier of identifiers) {
            const keys = ContactKeyGenerator.createLookupKeys(identifier.platform, identifier.value, personId as ContactId);

            if(dryRun) {
                process.stdout.write(`[dry-run] Would update: PK=${keys.PK} SK=${keys.SK} → GSI2PK=${keys.GSI2PK} GSI2SK=${keys.GSI2SK}\n`);
                updated++;
                continue;
            }

            pending.push(keys);
        }
    }

    const limit = pLimit(MAX_CONCURRENT_UPDATES);
    const outcomes = await Promise.all(pending.map(keys => limit(() => updateLookupRow(tableName, docClient, keys, pace))));
    for(const outcome of outcomes) {
        if(outcome === 'updated') {
            updated++;
        } else if(outcome === 'skipped') {
            skipped++;
        } else {
            errors++;
        }
    }

    return { updated, skipped, errors };
}

/** Summary statistics accumulated during the backfill run. */
export interface BackfillStats {
    totalScanned: number
    totalUpdated: number
    totalSkipped: number
    totalErrors:  number
}

/** Type of function that queries one page of contact profile items from DynamoDB GSI2. */
export type QueryPageFn = (exclusiveStartKey: Record<string, unknown> | undefined) => Promise<{
    items:            ContactProfileItem[]
    lastEvaluatedKey: Record<string, unknown> | undefined
}>;

/** Type of function that processes one page of contact profile items. */
export type ProcessContactsFn = (items: ContactProfileItem[]) => Promise<PageStats>;

/**
 * Run the backfill query loop.
 *
 * This is the core loop logic, extracted for testability.
 * Callers inject `queryPage` and `processContacts` so tests can simulate
 * DynamoDB failures without real network calls.
 *
 * @param queryPage - Fetch one page of contact profile items starting from the given cursor.
 * @param processOnePage - Process contact items from one page and return counts.
 * @param onSummary - Called with the running stats when summary should be printed (on completion or circuit-break).
 * @param sleep - Injectable sleep for backoff (allows fake timers in tests).
 * @param maxConsecutiveFailures - Number of consecutive query failures before aborting.
 * @param baseBackoffMs - Base backoff delay (ms) between consecutive failure retries.
 */
export async function runBackfillLoop(
    queryPage:              QueryPageFn,
    processOnePage:         ProcessContactsFn,
    onSummary:              (stats: BackfillStats, lastCursor: Record<string, unknown> | undefined) => void,
    sleep:                  (ms: number) => Promise<void>,
    maxConsecutiveFailures: number,
    baseBackoffMs:          number
): Promise<BackfillStats> {
    const stats: BackfillStats = {
        totalScanned: 0,
        totalUpdated: 0,
        totalSkipped: 0,
        totalErrors:  0,
    };

    let exclusiveStartKey: Record<string, unknown> | undefined;
    let consecutiveFailures = 0;

    try {
        while(true) {
            try {
                const pageStartKey = exclusiveStartKey;
                // eslint-disable-next-line no-await-in-loop -- sequential pagination
                const { items, lastEvaluatedKey } = await queryPage(pageStartKey);

                stats.totalScanned += items.length;

                // eslint-disable-next-line no-await-in-loop -- sequential pagination
                const pageStats = await processOnePage(items);
                stats.totalUpdated += pageStats.updated;
                stats.totalSkipped += pageStats.skipped;
                stats.totalErrors  += pageStats.errors;

                // Success: advance cursor and reset failure counter.
                exclusiveStartKey = lastEvaluatedKey;
                consecutiveFailures = 0;

                // Break when the query returns no continuation cursor (last page).
                if(!exclusiveStartKey) {
                    break;
                }
            } catch (err) {
                // Query failed (retryAsync exhausted retries).
                // Preserve exclusiveStartKey so the next iteration retries the same page.
                consecutiveFailures++;
                stats.totalErrors++;

                logger.warn({ err, exclusiveStartKey, consecutiveFailures, msg: 'Failed to query page; will retry same page' });

                if(consecutiveFailures >= maxConsecutiveFailures) {
                    throw new Error(
                        `Backfill aborted: ${maxConsecutiveFailures} consecutive query failures at cursor ${JSON.stringify(exclusiveStartKey)}`,
                        { cause: err }
                    );
                }

                // Exponential backoff before retrying the failed page.
                const backoffMs = baseBackoffMs * (2 ** (consecutiveFailures - 1));
                // eslint-disable-next-line no-await-in-loop -- sequential: backoff between consecutive failure retries
                await sleep(backoffMs);
            }
        }
    } finally {
        // Print summary whether we completed normally or are propagating a circuit-breaker error.
        onSummary(stats, exclusiveStartKey);
    }

    return stats;
}
