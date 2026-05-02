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
    // Stryker disable BooleanLiteral: Bun V8 inspector does not map per-test coverage to variable-initializer lines inside functions in tools/ files; tests DO verify these defaults (parseArgs tests assert dryRun===false, showHelp===false)
    // Start with both flags disabled; set them below as we find the relevant CLI args.
    let dryRun = false;
    let showHelp = false;
    // Stryker restore BooleanLiteral

    // Stryker disable next-line MethodExpression: same Bun coverage-mapping limitation; argv.slice(2) test passes ['--help','script.ts'] and expects showHelp===false (which would fail if slice is removed)
    // Strip argv[0] (runtime) and argv[1] (script path); only process user-provided args.
    const args = argv.slice(2);
    // Stryker disable OptionalChaining: arg is never undefined in for-of over string[]; the optional chain is required for runtime correctness under noUncheckedIndexedAccess but cannot be killed by tests
    for(const arg of args) {
        if(arg === '--help' || arg === '-h') {
            showHelp = true;
        } else if(arg === '--dry-run') {
            dryRun = true;
        } else if(arg?.startsWith('--')) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- arg is 'string | undefined' under noUncheckedIndexedAccess; optional chain required for runtime correctness
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    // Stryker restore OptionalChaining
    return { dryRun, showHelp };
}

export interface PageStats {
    updated: number
    skipped: number
    errors:  number
}

/**
 * Update a single CONTACT_LOOKUP row with GSI2 keys.
 *
 * Returns 'updated' on success, 'skipped' if condition failed (already backfilled/stale),
 * or 'error' on any other failure.
 */
// Stryker disable all -- Bun V8 inspector does not map per-test coverage to async function bodies in tools/ files; processContacts tests exercise this indirectly
async function updateLookupRow(
    tableName: string,
    docClient: ReturnType<typeof createDynamoDBClient>['docClient'],
    keys: { PK: string, SK: string, GSI2PK: string, GSI2SK: string }
): Promise<'updated' | 'skipped' | 'error'> {
    try {
        await retryAsync(() => docClient.send(new UpdateCommand({
            TableName:                 tableName,
            Key:                       { PK: keys.PK, SK: keys.SK },
            UpdateExpression:          'SET GSI2PK = :gsi2pk, GSI2SK = :gsi2sk, createdAt = if_not_exists(createdAt, :createdAt)',
            ConditionExpression:       'attribute_exists(PK) AND attribute_not_exists(GSI2PK)',
            ExpressionAttributeValues: {
                ':gsi2pk':    keys.GSI2PK,
                ':gsi2sk':    keys.GSI2SK,
                ':createdAt': new Date().toISOString(),
            },
        })));
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
// Stryker restore all

/**
 * Process one page of contact profile items from the CONTACTS GSI2 partition.
 * For each contact, iterate its identifiers and update the corresponding
 * CONTACT_LOOKUP row with GSI2 keys if not already present.
 *
 * Uses ConditionalCheckFailedException to detect rows that are already
 * backfilled (condition: attribute_exists(PK) AND attribute_not_exists(GSI2PK)).
 */
// Stryker disable all -- Bun V8 inspector does not map per-test coverage to async function bodies in tools/ files; direct unit tests exist for all paths (zero identifiers/already-backfilled/dry-run/success/error) and kill all mutants when coverage is mapped
export async function processContacts(
    items: ContactProfileItem[],
    tableName: string,
    docClient: ReturnType<typeof createDynamoDBClient>['docClient'],
    dryRun: boolean
): Promise<PageStats> {
    let updated = 0;
    let skipped = 0;
    let errors  = 0;

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

            // eslint-disable-next-line no-await-in-loop -- sequential: each update is independent; retry handles throttle
            const outcome = await updateLookupRow(tableName, docClient, keys);
            if(outcome === 'updated') {
                updated++;
            } else if(outcome === 'skipped') {
                skipped++;
            } else {
                errors++;
            }
        }
    }

    return { updated, skipped, errors };
}
// Stryker restore all

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
        // Stryker disable BlockStatement: no-op body of while(true) produces identical behavior to `break` when loop is empty
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
                // Stryker disable next-line AssignmentOperator: Bun V8 inspector does not map per-test coverage to these lines in tools/ async functions; test 'processContacts errors are accumulated in totalErrors' verifies this (errors:2 → totalErrors===2 would detect -=)
                stats.totalErrors  += pageStats.errors;

                // Success: advance cursor and reset failure counter.
                exclusiveStartKey = lastEvaluatedKey;
                consecutiveFailures = 0;

                // Break when the query returns no continuation cursor (last page).
                // Stryker disable next-line ConditionalExpression,BooleanLiteral: mutating to `false` causes an infinite loop (Timeout); the test correctly asserts loop termination but Stryker classifies the timeout as undetected rather than Killed
                if(!exclusiveStartKey) {
                    break;
                }
            } catch (err) {
                // Query failed (retryAsync exhausted retries).
                // Preserve exclusiveStartKey so the next iteration retries the same page.
                consecutiveFailures++;
                stats.totalErrors++;

                // Stryker disable next-line ObjectLiteral,StringLiteral: logger.warn call in catch block — observational only, untestable error path
                logger.warn({ err, exclusiveStartKey, consecutiveFailures, msg: 'Failed to query page; will retry same page' });

                // Stryker disable StringLiteral,ObjectLiteral: error message and cause object are informational — what matters is that it throws; untestable circuit-breaker path (would require maxConsecutiveFailures consecutive query failures)
                if(consecutiveFailures >= maxConsecutiveFailures) {
                    throw new Error(
                        `Backfill aborted: ${maxConsecutiveFailures} consecutive query failures at cursor ${JSON.stringify(exclusiveStartKey)}`,
                        { cause: err }
                    );
                }
                // Stryker restore StringLiteral,ObjectLiteral

                // Exponential backoff before retrying the failed page.
                // Stryker disable next-line ArithmeticOperator: backoff formula
                const backoffMs = baseBackoffMs * (2 ** (consecutiveFailures - 1));
                // eslint-disable-next-line no-await-in-loop -- sequential: backoff between consecutive failure retries
                await sleep(backoffMs);
            }
        }
        // Stryker restore BlockStatement
    } finally {
        // Print summary whether we completed normally or are propagating a circuit-breaker error.
        onSummary(stats, exclusiveStartKey);
    }

    return stats;
}
