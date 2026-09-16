/**
 * Contact Reconciliation Logic
 *
 * Two-phase reconciliation to ensure contact data consistency:
 *   Phase A: Query all CONTACT_LOOKUP rows via GSI2PK=CONTACT_LOOKUPS; detect orphans:
 *            - Profile missing → delete lookup (true orphan).
 *            - Profile exists but no longer claims the identifier → delete lookup (stray).
 *   Phase B: Scan all CONTACT profile rows (GSI2PK=CONTACTS); detect missing lookups
 *            (profile claims identifier but no lookup row exists) → create.
 *
 * Rate-limited via operationDelayMs between DynamoDB operations (~1 op/sec by default).
 * Supports graceful cancellation via AbortSignal (passed in ReconcilerOptions).
 */

import { type BatchWriteCommandInput, type BatchWriteCommandOutput, type DynamoDBDocumentClient, type QueryCommandOutput, QueryCommand, GetCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type DynamoDBClientHolder, resolveDocClientGetter } from '../../client-holder';
import { ContactKeyGenerator } from '../key-generator';
import { contactSchema, type ContactId, type PlatformType } from '../types';
import { BatchWriteExhaustedError } from '@/errors';

// ============================================================================
// Batch Write Retry
// ============================================================================

/** Maximum number of BatchWrite retry attempts for unprocessed items (reconciler). */
const RECONCILER_BATCH_WRITE_MAX_RETRIES = 3;

/** Base delay in ms for BatchWrite retry backoff (reconciler). */
const RECONCILER_BATCH_WRITE_BASE_DELAY_MS = 100;

/**
 * Shared batch-write-with-retry helper for the reconciler.
 * Retries unprocessed items up to RECONCILER_BATCH_WRITE_MAX_RETRIES times
 * with exponential backoff.
 *
 * @throws if items remain unprocessed after all retries
 */
async function batchWriteWithRetry(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    sleep:     (ms: number, signal?: AbortSignal) => Promise<void>,
    requests:  NonNullable<NonNullable<BatchWriteCommandInput['RequestItems']>[string]>,
    signal?:   AbortSignal
): Promise<void> {
    let pending: NonNullable<BatchWriteCommandInput['RequestItems']> = { [tableName]: requests };

    for(let attempt = 0; attempt < RECONCILER_BATCH_WRITE_MAX_RETRIES; attempt++) {
        const batchWriteSignalOpts = signal ? { abortSignal: signal } : undefined;
        // eslint-disable-next-line no-await-in-loop -- sequential: retry loop for unprocessed items
        const result: BatchWriteCommandOutput = await docClient.send(new BatchWriteCommand({
            RequestItems: pending,
        }), batchWriteSignalOpts);

        const hasUnprocessed = result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0;

        if(!hasUnprocessed) {
            return;
        }

        if(attempt < RECONCILER_BATCH_WRITE_MAX_RETRIES - 1) {
            const delay = RECONCILER_BATCH_WRITE_BASE_DELAY_MS * 2 ** attempt;
            // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay
            await sleepWithOptionalSignal(sleep, delay, signal);
        }

        const nextPending: NonNullable<BatchWriteCommandInput['RequestItems']> = {};
        // Stryker disable next-line llm: the truthiness guard above already returned for every falsy UnprocessedItems value, so ?? and || are identical here.
        for(const table of Object.keys(result.UnprocessedItems ?? {})) {
            const unprocessed = result.UnprocessedItems?.[table];
            if(unprocessed !== undefined) {
                nextPending[table] = unprocessed;
            }
        }
        // Stryker disable next-line llm: DynamoDB cannot return an undefined table value, so nextPending reproduces every returned unprocessed item.
        pending = nextPending;
    }

    // Stryker disable next-line llm: pending is initialized and reassigned only to object literals, so the nullish fallback is unreachable.
    const remainingCount = Object.values(pending).reduce((count, items) => count + items.length, 0);
    throw new BatchWriteExhaustedError('ContactReconciler.batchWriteWithRetry', remainingCount, RECONCILER_BATCH_WRITE_MAX_RETRIES);
}

// ============================================================================
// Types
// ============================================================================

/**
 * Dependencies for the contact reconciler.
 */
export interface ContactReconcilerDeps {
    /** DynamoDB document client or client holder (holder resolves to live client on each call) */
    docClient: DynamoDBDocumentClient | DynamoDBClientHolder
    /** DynamoDB table name */
    tableName: string
    /**
     * Sleep function for rate-limiting.
     * Defaults to setTimeout-based delay in production.
     * Inject a no-op for tests.
     * Accepts an optional AbortSignal to wake early on cancellation.
     */
    sleep:     (ms: number, signal?: AbortSignal) => Promise<void>
}

/** @internal Resolved deps with a concrete docClient. */
interface ResolvedContactReconcilerDeps {
    docClient: DynamoDBDocumentClient
    tableName: string
    sleep:     (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Options for a contact reconciliation run.
 */
export interface ContactReconcilerOptions {
    /** Delay between DynamoDB operations in milliseconds (0 = unlimited) */
    operationDelayMs:          number
    /** DynamoDB page size for scans (default: 25) */
    scanPageSize:              number
    /**
     * Minimum age (ms) a lookup row must be before Phase A treats it as stray.
     * Protects against false-positive deletion of in-flight lookups written by
     * putContact (step 1: write lookup; step 2: write profile).
     * Default: 300_000 (5 minutes).
     */
    strayLookupAgeThresholdMs: number
    /** Optional abort signal — when aborted the run exits promptly */
    signal?:                   AbortSignal
}

/**
 * Progress for a single reconciliation phase.
 */
export interface ContactReconciliationPhase {
    /** Number of items scanned */
    itemsScanned: number
    /** Number of errors encountered */
    errors:       number
}

/**
 * Phase A progress: orphan lookup detection and cleanup.
 */
export interface PhaseAProgress extends ContactReconciliationPhase {
    /** Number of orphan lookup rows deleted */
    orphanLookupsDeleted: number
}

/**
 * Phase B progress: missing lookup detection and repair.
 */
export interface PhaseBProgress extends ContactReconciliationPhase {
    /** Number of missing lookup rows created */
    missingLookupsCreated: number
}

/**
 * Complete result of a contact reconciliation run.
 */
export interface ContactReconciliationResult {
    /** Whether both phases completed with no errors */
    success:         boolean
    /** Whether the run was cancelled via AbortSignal (success is still true when aborted) */
    aborted?:        boolean
    /** Phase A (orphan lookup) results */
    phaseA:          PhaseAProgress
    /** Phase B (missing lookup) results */
    phaseB:          PhaseBProgress
    /** Total duration in milliseconds */
    totalDurationMs: number
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Call `sleep` without passing the signal argument when it is undefined.
 * This keeps the call signature clean for callers that don't use signals
 * and avoids breaking existing test matchers that check exact arguments.
 */
function sleepWithOptionalSignal(
    sleep:  (ms: number, signal?: AbortSignal) => Promise<void>,
    ms:     number,
    signal: AbortSignal | undefined
): Promise<void> {
    return signal ? sleep(ms, signal) : sleep(ms);
}

/**
 * Returns true when the error is an AbortError (from AbortController.abort()).
 * Matches DOMException with name='AbortError' and plain Error objects with name='AbortError'.
 */
function isAbortError(err: unknown): boolean {
    // DOMException is an Error subclass in the Bun runtime, so the same check covers
    // both abort sources without a duplicate branch.
    return err instanceof Error && err.name === 'AbortError';
}

/**
 * Sleeps for the given delay (if operationDelayMs > 0) and returns true if the caller should break out of its loop.
 * Returns true on AbortError (graceful abort) or if signal becomes aborted after sleep.
 * Re-throws non-abort errors.
 */
async function sleepAndCheckAbort(
    deps:    ResolvedContactReconcilerDeps,
    options: ContactReconcilerOptions
): Promise<boolean> {
    if(options.signal?.aborted) {
        return true;
    }
    if(options.operationDelayMs === 0) {
        return false;
    }
    try {
        await sleepWithOptionalSignal(deps.sleep, options.operationDelayMs, options.signal);
    } catch (error) {
        if(isAbortError(error)) {
            return true; // Graceful abort — caller must break without counting error
        }
        throw error; // Re-throw unexpected errors
    }
    // Stryker disable next-line llm: AbortSignal.aborted is boolean, so === true and ?? false agree for boolean or undefined.
    return options.signal?.aborted === true;
}

// ============================================================================
// Phase A: Orphan Lookup Detection
// ============================================================================

/**
 * Determine if a lookup row should be deleted.
 *
 * Returns true if:
 *   - The profile doesn't exist (true orphan) AND the lookup is old enough, OR
 *   - The profile exists but no longer claims this platform+value (stray lookup)
 *     AND the lookup is old enough (createdAt older than strayLookupAgeThresholdMs).
 *
 * The age check applies to BOTH true orphans and stray lookups.
 * This prevents false-positive deletion of in-flight lookups written by putContact:
 * step 1 writes the lookup row; step 2 writes the profile. During that window the
 * profile is missing, making the lookup look like a true orphan.
 */
function isLookupOrphanOrStray(
    profileItem:            Record<string, unknown> | undefined,
    platform:               PlatformType,
    value:                  string,
    lookupCreatedAt:        string | undefined,
    strayLookupAgeThresholdMs: number
): boolean {
    if(!profileItem) {
        // True orphan: profile is missing.
        // Apply the same age guard as stray lookups to protect in-flight putContact writes:
        // step 1 (write lookup) may complete before step 2 (write profile) during a concurrent write.
        if(lookupCreatedAt !== undefined) {
            const ageMs = Date.now() - new Date(lookupCreatedAt).getTime();
            if(ageMs < strayLookupAgeThresholdMs) {
                return false; // Too young: may be an in-flight write (putContact step 1 completed, step 2 pending)
            }
        }
        return true;
    }
    // Fix 2: stray check — profile exists but may no longer claim this identifier
    const rawIdentifiers: unknown = profileItem.identifiers; // raw from DynamoDB
    if(!Array.isArray(rawIdentifiers)) {
        return false; // No identifiers array — treat as valid (conservative)
    }
    const normalizedValue = value.toLowerCase().trim(); // normalize for comparison
    const profileClaims = (rawIdentifiers as { platform: unknown, value: unknown }[])
        .some(id => id.platform === platform && typeof id.value === 'string' && id.value.toLowerCase().trim() === normalizedValue);
    if(profileClaims) {
        return false; // Valid lookup — profile still claims it
    }
    // Stray lookup: profile exists but no longer claims this identifier.
    // Only delete if the lookup is old enough (protects in-flight writes).
    if(lookupCreatedAt !== undefined) {
        const ageMs = Date.now() - new Date(lookupCreatedAt).getTime();
        if(ageMs < strayLookupAgeThresholdMs) {
            return false; // Too young: may be an in-flight write
        }
    }
    return true; // stray if profile does not claim this lookup
}

/**
 * Process one page of CONTACT_LOOKUP items in Phase A.
 * For each item, calls processPhaseAItem and accumulates counts.
 * Returns { orphansDeleted, errors } for the page.
 */
async function processPhaseAPage(
    deps:    ResolvedContactReconcilerDeps,
    options: ContactReconcilerOptions,
    items:   { PK: string, SK: string, personId: string, createdAt?: string }[]
): Promise<{ orphansDeleted: number, errors: number }> {
    let orphansDeleted = 0;
    let errors = 0;

    // Stryker disable next-line llm: items is a required array parameter and its only call site already coalesces `result.Items ?? []`, so the fallback is unreachable.
    for(const item of items) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB op per lookup row
            const deleted = await processPhaseAItem(deps, options, item);
            if(deleted) {
                orphansDeleted++;
            }
        } catch (error) {
            logger.warn({ error, item, msg: 'ContactReconciler Phase A: error processing lookup item' });
            errors++;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limiting delay between operations
        if(await sleepAndCheckAbort(deps, options)) {
            break;
        }
    }

    return { orphansDeleted, errors };
}

/**
 * Process one CONTACT_LOOKUP item in Phase A:
 *   - Check if the referenced profile exists (GetCommand).
 *   - If orphan or stray (and old enough): delete and return true.
 *   - If valid or too young to be stray: return false.
 * Throws on DynamoDB errors (caller counts error and continues).
 */
async function processPhaseAItem(
    deps:    ResolvedContactReconcilerDeps,
    options: ContactReconcilerOptions,
    item:    { PK: string, SK: string, personId: string, createdAt?: string }
): Promise<boolean> {
    const personId = ContactKeyGenerator.parsePersonIdFromLookupSK(item.SK);
    const profileKeys = ContactKeyGenerator.createProfileKeys(personId);

    // GetCommand (consistent read) for the referenced profile
    const phaseAGetSignalOpts = options.signal ? { abortSignal: options.signal } : undefined;
    const profileResult = await deps.docClient.send(new GetCommand({
        TableName:      deps.tableName,
        Key:            profileKeys,
        ConsistentRead: true,
    }), phaseAGetSignalOpts);

    // Fix 4: check abort after the read, before the write
    if(options.signal?.aborted) {
        return false;
    }

    const { platform, value } = ContactKeyGenerator.parseLookupPK(item.PK);
    const shouldDelete = isLookupOrphanOrStray(
        profileResult.Item,
        platform,
        value,
        item.createdAt,
        // Stryker disable next-line llm: strayLookupAgeThresholdMs is required and populated by the validated configuration default.
        options.strayLookupAgeThresholdMs
    );

    if(shouldDelete) {
        // Orphan or stray: delete the lookup row
        const phaseADeleteSignalOpts = options.signal ? { abortSignal: options.signal } : undefined;
        await deps.docClient.send(new DeleteCommand({
            TableName: deps.tableName,
            Key:       { PK: item.PK, SK: item.SK },
        }), phaseADeleteSignalOpts);
        logger.debug({ pk: item.PK, sk: item.SK, msg: 'ContactReconciler Phase A: deleted orphan/stray lookup' });
    }

    return shouldDelete;
}

/**
 * Query all CONTACT_LOOKUP rows via GSI2PK=CONTACT_LOOKUPS.
 *
 * Now that createLookupKeys() sets GSI2PK='CONTACT_LOOKUPS' on every lookup row,
 * Phase A can use a GSI2 Query instead of a full table scan. This is efficient
 * and consistent with how Phase B queries profiles via GSI2PK=CONTACTS.
 *
 * For each lookup row found:
 *   1. Check if the referenced profile exists (GetCommand on the profile PK/SK).
 *   2. If profile is missing → true orphan → delete the lookup row.
 *   3. If profile exists but its identifiers no longer include this lookup's
 *      platform+value → stray lookup → delete the lookup row.
 */
async function runPhaseA(
    deps: ResolvedContactReconcilerDeps,
    options: ContactReconcilerOptions
): Promise<PhaseAProgress> {
    const progress: PhaseAProgress = {
        itemsScanned:         0,
        errors:               0,
        orphanLookupsDeleted: 0,
    };

    let lastKey: Record<string, unknown> | undefined;

    do {
        // Stryker disable next-line llm: in this condition, undefined and false are equally falsy, so ?? false cannot affect control flow.
        if(options.signal?.aborted) {
            break;
        }

        const currentKey = lastKey;
        let result: QueryCommandOutput;

        try {
            const phaseAQuerySignalOpts = options.signal ? { abortSignal: options.signal } : undefined;
            // Query all CONTACT_LOOKUP rows via GSI2PK=CONTACT_LOOKUPS
            // eslint-disable-next-line no-await-in-loop -- sequential: pagination depends on prior response cursor
            result = await deps.docClient.send(new QueryCommand({
                TableName:                 deps.tableName,
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'CONTACT_LOOKUPS' },
                Limit:                     options.scanPageSize,
                ExclusiveStartKey:         currentKey,
            }), phaseAQuerySignalOpts);
        } catch (error) {
            logger.warn({ error, msg: 'ContactReconciler Phase A: failed to query lookup rows' });
            progress.errors++;
            break;
        }

        const items = (result.Items ?? []) as { PK: string, SK: string, personId: string, createdAt?: string }[];

        // Count the page items as scanned after a successful fetch
        progress.itemsScanned += items.length;

        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB ops per page
        const pageResult = await processPhaseAPage(deps, options, items);
        progress.orphanLookupsDeleted += pageResult.orphansDeleted;
        progress.errors += pageResult.errors;

        lastKey = result.LastEvaluatedKey;
    } while(lastKey);

    return progress;
}

// ============================================================================
// Phase B: Missing Lookup Detection
// ============================================================================

/**
 * Check one identifier for a missing lookup row and create it if absent.
 * Returns true if a lookup was created, false if already exists.
 * Throws on DynamoDB errors (caller counts error and continues).
 *
 * Uses GetCommand (ConsistentRead) for the lookup check and batchWriteWithRetry
 * to handle UnprocessedItems from BatchWriteCommand.
 */
async function repairIdentifierLookup(
    deps:    ResolvedContactReconcilerDeps,
    options: ContactReconcilerOptions,
    personId: ContactId,
    platform: PlatformType,
    value:   string
): Promise<boolean> {
    const lookupKeys = ContactKeyGenerator.createLookupKeys(platform, value, personId);

    // Use GetCommand with ConsistentRead instead of QueryCommand
    const phaseBGetSignalOpts = options.signal ? { abortSignal: options.signal } : undefined;
    const lookupResult = await deps.docClient.send(new GetCommand({
        TableName:      deps.tableName,
        Key:            { PK: lookupKeys.PK, SK: lookupKeys.SK },
        ConsistentRead: true,
    }), phaseBGetSignalOpts);

    // Fix 4: check abort after the read, before the write
    // Stryker disable next-line llm: optional chaining and guarded signal access have identical truthiness.
    if(options.signal?.aborted) {
        return false;
    }

    if(!lookupResult.Item) {
        // Missing lookup: create it with all keys including GSI2
        const lookupItem = {
            ...lookupKeys,
            personId,
            createdAt: new Date().toISOString(),
        };
        // Fix 3 + Fix 5: use batchWriteWithRetry (handles UnprocessedItems) and pass signal for abort propagation
        await batchWriteWithRetry(deps.docClient, deps.tableName, deps.sleep, [{ PutRequest: { Item: lookupItem } }], options.signal);
        logger.debug({ pk: lookupKeys.PK, sk: lookupKeys.SK, personId, msg: 'ContactReconciler Phase B: created missing lookup' });
        return true;
    }

    return false;
}

/**
 * Result of processing one contact profile's identifiers.
 */
interface ProfileRepairResult {
    lookupsCreated: number
    errors:         number
}

/**
 * Process one contact profile: for each identifier, repair a missing lookup row.
 * Throws on parse error (caller counts error and skips profile).
 */
async function repairProfileLookups(
    deps: ResolvedContactReconcilerDeps,
    options: ContactReconcilerOptions,
    rawItem: Record<string, unknown>
): Promise<ProfileRepairResult> {
    const { PK: _pk, SK: _sk, GSI2PK: _gsi2pk, GSI2SK: _gsi2sk, ...rest } = rawItem;
    const contact = contactSchema.parse(rest);

    let lookupsCreated = 0;
    let errors = 0;

    for(const identifier of contact.identifiers) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB op
            const wasCreated = await repairIdentifierLookup(deps, options, contact.personId, identifier.platform, identifier.value);
            if(wasCreated) {
                lookupsCreated++;
            }
        } catch (error) {
            logger.warn({ error, identifier, personId: contact.personId, msg: 'ContactReconciler Phase B: error processing identifier' });
            errors++;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limiting delay
        if(await sleepAndCheckAbort(deps, options)) {
            break;
        }
    }

    return { lookupsCreated, errors };
}

/**
 * Process one page of profile items in Phase B.
 * For each profile, call repairProfileLookups and accumulate counts.
 * Returns { lookupsCreated, errors } for the page.
 */
async function processPhaseBPage(
    deps:     ResolvedContactReconcilerDeps,
    options:  ContactReconcilerOptions,
    rawItems: Record<string, unknown>[]
): Promise<{ lookupsCreated: number, errors: number }> {
    let lookupsCreated = 0;
    let errors = 0;

    for(const rawItem of rawItems) {
        if(options.signal?.aborted) {
            break;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB operations
            const repairResult = await repairProfileLookups(deps, options, rawItem);
            // Stryker disable next-line llm: lookupsCreated is always a numeric counter, for which n || 0 equals n.
            lookupsCreated += repairResult.lookupsCreated;
            errors += repairResult.errors;
        } catch (error) {
            logger.warn({ error, item: rawItem, msg: 'ContactReconciler Phase B: error processing profile' });
            errors += 1;
        }

        // Fix 11: inter-profile sleep in Phase B outer loop
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limiting delay between profiles
        if(await sleepAndCheckAbort(deps, options)) {
            break;
        }
    }

    return { lookupsCreated, errors };
}

/**
 * For each contact profile, verify that a lookup row exists for every identifier.
 * If a lookup row is missing, create it.
 */
async function runPhaseB(
    deps: ResolvedContactReconcilerDeps,
    options: ContactReconcilerOptions
): Promise<PhaseBProgress> {
    const progress: PhaseBProgress = {
        itemsScanned:          0,
        errors:                0,
        missingLookupsCreated: 0,
    };

    let lastKey: Record<string, unknown> | undefined;

    do {
        if(options.signal?.aborted) {
            break;
        }

        const currentKey = lastKey;
        let result: QueryCommandOutput;

        try {
            // Query all contact profiles via GSI2PK=CONTACTS
            const phaseBQuerySignalOpts = options.signal ? { abortSignal: options.signal } : undefined;
            // eslint-disable-next-line no-await-in-loop -- sequential: pagination depends on prior response cursor
            result = await deps.docClient.send(new QueryCommand({
                TableName:                 deps.tableName,
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'CONTACTS' },
                Limit:                     options.scanPageSize,
                ExclusiveStartKey:         currentKey,
            }), phaseBQuerySignalOpts);
        } catch (error) {
            logger.warn({ error, msg: 'ContactReconciler Phase B: failed to scan profiles' });
            progress.errors++;
            break;
        }

        const rawItems = (result.Items ?? []) as Record<string, unknown>[];
        progress.itemsScanned += rawItems.length;

        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB operations per page
        const pageResult = await processPhaseBPage(deps, options, rawItems);
        // Stryker disable next-line llm: pageResult.lookupsCreated is always a numeric counter, for which n || 0 equals n.
        progress.missingLookupsCreated += pageResult.lookupsCreated;
        progress.errors += pageResult.errors;

        lastKey = result.LastEvaluatedKey; // undefined signals end of pagination
    } while(lastKey !== undefined);

    return progress;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run complete contact reconciliation (Phase A + Phase B).
 *
 * Phase A: Delete orphan and stray lookup rows.
 *   - Orphan: lookup points to a missing profile.
 *   - Stray: profile exists but no longer claims the identifier.
 * Phase B: Create missing lookup rows (profile claims identifier with no lookup).
 *
 * Both phases are rate-limited to avoid overwhelming DynamoDB.
 * Errors in individual items are logged and counted but do not abort the run.
 * Pass options.signal to abort an in-flight run promptly.
 *
 * @param deps    - DynamoDB client and table configuration
 * @param options - Reconciliation run options (delay, page size, abort signal)
 * @returns       - Result summary including per-phase stats
 */
export async function runContactReconciliation(
    deps: ContactReconcilerDeps,
    options: ContactReconcilerOptions
): Promise<ContactReconciliationResult> {
    const startTime = Date.now();

    // Resolve holder → raw docClient once at run-start so we use the live client.
    const resolvedDeps: ResolvedContactReconcilerDeps = {
        ...deps,
        docClient: resolveDocClientGetter(deps.docClient)(),
    };

    logger.info({ msg: 'Starting contact reconciliation' });

    const phaseA = await runPhaseA(resolvedDeps, options);

    logger.info({
        phase:                'A',
        itemsScanned:         phaseA.itemsScanned,
        orphanLookupsDeleted: phaseA.orphanLookupsDeleted,
        errors:               phaseA.errors,
        msg:                  'Contact reconciliation Phase A complete',
    });

    const phaseB = await runPhaseB(resolvedDeps, options);

    logger.info({
        phase:                 'B',
        itemsScanned:          phaseB.itemsScanned,
        missingLookupsCreated: phaseB.missingLookupsCreated,
        errors:                phaseB.errors,
        msg:                   'Contact reconciliation Phase B complete',
    });

    const endTime = Date.now();
    const totalDurationMs = endTime - startTime;
    // Stryker disable next-line llm: wasAborted is only used as an if condition, where boolean-or-undefined has the same truthiness as === true.
    const wasAborted = options.signal?.aborted === true;
    // Stryker disable next-line llm: both error counts start at zero and only increase, so === 0 and <= 0 are equivalent.
    const success = phaseA.errors === 0 && phaseB.errors === 0;

    logger.info({
        success,
        totalDurationMs,
        msg: 'Contact reconciliation complete',
    });

    if(wasAborted) {
        return {
            success: true,
            aborted: true,
            phaseA,
            phaseB,
            totalDurationMs,
        };
    }

    return {
        success,
        phaseA,
        phaseB,
        totalDurationMs,
    };
}
