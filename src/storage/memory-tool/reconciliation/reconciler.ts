/**
 * Core Tag Index Reconciliation Logic
 *
 * Three-phase reconciliation system:
 * - Phase A: Scan memory items via GSI1, ensure tag indices are complete and up-to-date
 * - Phase B: Scan tag indices, delete orphaned entries
 * - Phase C: Verify META_COUNT atomic counters match actual tag index item counts
 */

import { type DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type DynamoDBClientHolder, resolveDocClientGetter } from '../../client-holder';
import { type RcuPacer, createRcuPacer, waitForRcuPacer, recordRcuPage } from '../../utils/rcu-pacing';
import { MemoryToolKeyGenerator, normalizeTags } from '../key-generator';
import { type MemoryPath, type MemoryToolItemData, type MemoryToolItem, type TagIndexReadItem, createMemoryPath, classifyMemoryPath, type IndexLayer, SEARCHABLE_NAMESPACES, decodePendingRenameIndexCleanup, type PendingRenameIndexCleanup  } from '../types';
import type { PhaseAProgress, PhaseBProgress, PhaseCProgress, ReconciliationResult } from './types';

// ============================================================================
// Dependencies & Options
// ============================================================================

/**
 * Operations reconciliation needs, independent of the concrete tag-index backend.
 * For create/refresh, `tags` picks which TAG# rows to write and `allTags` is the memory's full
 * tag set stored on each of them (multi-tag AND search and the staleness check both read it).
 */
export interface TagIndexReconciliationOps {
    createTagIndexItems:  (path: MemoryPath, tags: Set<string>, updatedAt: string, contentPreview: string, layer: IndexLayer, allTags: Set<string>) => Promise<void>
    refreshTagIndexItems: (path: MemoryPath, tags: Set<string>, updatedAt: string, contentPreview: string, layer: IndexLayer, allTags: Set<string>) => Promise<void>
    deleteTagIndexItems:  (path: MemoryPath, tags: Set<string>) => Promise<void>
    /**
     * `pacing`, when given, requests `ReturnConsumedCapacity` and paces subsequent pages against
     * the shared `pacer` at `rateLimitRcuPerSec` (see reconciler.ts's `ReconcilerPacers`), so this
     * GSI2 enumeration is capacity-paced the same way as the reconciler's own GSI1/GSI2/base-table
     * reads, and shares the reconciler's GSI2 pacing debt. Omitted, behaviour is unchanged (no
     * ConsumedCapacity requested, no pacing) -- the live memory-mcp-server list-tags tool call.
     * `pacing.signal`, when given, cancels the pacing wait promptly and is checked before every
     * page's query, matching the abort behaviour of the reconciler's own read loops.
     */
    listTagCounts:        (pacing?: { pacer: RcuPacer, rateLimitRcuPerSec: number, signal?: AbortSignal }) => Promise<{ tag: string, count: number }[]>
}

/**
 * Dependencies interface for testability
 */
export interface ReconcilerDeps {
    docClient: DynamoDBDocumentClient | DynamoDBClientHolder
    tableName: string
    tagIndex:  TagIndexReconciliationOps
    getMemory: (path: MemoryPath) => Promise<MemoryToolItemData | undefined>
}

/** @internal Resolved deps with a concrete docClient (holder already resolved at run-start). */
type ResolvedReconcilerDeps = Omit<ReconcilerDeps, 'docClient'> & { docClient: DynamoDBDocumentClient };

/**
 * Options for reconciliation run
 */
export interface ReconcilerOptions {
    /** Delay between operations in milliseconds (default 1000) */
    operationDelayMs:    number
    /** DynamoDB page size (default 25) */
    scanPageSize:        number
    /**
     * Ceiling, in RCU/s, applied uniformly to every reconciler read loop's DynamoDB pagination when
     * set -- but only ever lowers a resource's own provisioned default, never raises it (see
     * `rcuRateFor`/`DEFAULT_RATE_LIMIT_RCU_PER_SEC`); a value above a resource's provisioned budget
     * is silently capped at that budget.
     */
    rateLimitRcuPerSec?: number
    /** Backoff configuration */
    backoff:             { baseDelayMs: number, maxAttempts: number }
    /** Abort signal for cancellation */
    signal?:             AbortSignal
}

/**
 * Per-resource RCU debt carried for the whole reconciliation run (not just within one pagination
 * loop), so pacing holds across pages, GSI1 layers, tags and phases. `gsi2` is shared by Phase A's
 * legacy rename-cleanup fallback, Phase B's tag-name enumeration and Phase C's tag-count
 * enumeration (all three query GSI2's TAG_COUNTS partition); `base` is shared by Phase B's per-tag
 * index scan and Phase C's per-tag COUNT scan (both query the base table).
 */
export interface ReconcilerPacers {
    gsi1: RcuPacer
    gsi2: RcuPacer
    base: RcuPacer
}

/** @internal - exported for testing */
export function createReconcilerPacers(): ReconcilerPacers {
    return { gsi1: createRcuPacer(), gsi2: createRcuPacer(), base: createRcuPacer() };
}

/**
 * Default RCU/s ceiling per resource, used when `options.rateLimitRcuPerSec` is unset, and also the
 * hard upper bound each resource's effective rate can never exceed even when it is set. Matches
 * sst/dynamo.ts's provisioned capacity for each (base table 5, GSI1 2, GSI2 1) -- the binding
 * constraint this pacing exists to respect.
 */
const DEFAULT_RATE_LIMIT_RCU_PER_SEC: Readonly<Record<keyof ReconcilerPacers, number>> = {
    gsi1: 2,
    gsi2: 1,
    base: 5,
};

/**
 * `options.rateLimitRcuPerSec`, when set, is a single operator override applied to every resource --
 * but only as a ceiling that can lower a resource's own provisioned budget, never raise it: the
 * result is always `Math.min(override, DEFAULT_RATE_LIMIT_RCU_PER_SEC[resource])`. Each resource's
 * provisioned capacity (sst/dynamo.ts) is fixed by the AWS free tier, so no config value may pace a
 * read loop above it.
 * @internal - exported for testing
 */
export function rcuRateFor(resource: keyof ReconcilerPacers, options: ReconcilerOptions): number {
    const provisioned = DEFAULT_RATE_LIMIT_RCU_PER_SEC[resource];
    return options.rateLimitRcuPerSec === undefined ? provisioned : Math.min(options.rateLimitRcuPerSec, provisioned);
}

/**
 * Waits out any RCU debt already owed on `pacer` by an earlier read of the same resource.
 * @internal - exported for testing
 */
export async function waitBeforeReconcilerRead(pacer: RcuPacer, signal: AbortSignal | undefined): Promise<void> {
    await waitForRcuPacer(pacer, () => Date.now(), ms => delay(ms, signal));
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Compare two Sets for equality (same size and same elements)
 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if(a.size !== b.size) {
        return false;
    }
    for(const item of a) {
        if(!b.has(item)) {
            return false;
        }
    }
    return true;
}

/** Only a real DOM abort exception escapes item-level error accounting. */
export function isAbortError(error: unknown): error is DOMException {
    return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Delay that respects abort signal
 * @internal - exported for testing
 */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if(ms <= 0) {
        return;
    }

    return new Promise((resolve, reject) => {
        if(signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }

        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort(): void {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
        }
        signal?.addEventListener('abort', onAbort);
    });
}

/**
 * Retry with exponential backoff for DynamoDB operations
 * @internal - exported for testing
 */
export async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    backoff: { baseDelayMs: number, maxAttempts: number },
    context: string,
    signal?: AbortSignal
): Promise<T | undefined> {
    // Stryker disable next-line llm: maxAttempts is schema-validated as an integer, making <= N equivalent to < N + 1.
    for(let attempt = 1; attempt <= backoff.maxAttempts; attempt++) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop, each attempt depends on prior failure
            return await operation();
        } catch (error) {
            if(signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const isThrottled = typeof error === 'object' && error !== null && 'name' in error
              && (error.name === 'ProvisionedThroughputExceededException' || error.name === 'ThrottlingException');

            // Stryker disable next-line llm: integer attempts make < N equivalent to <= N - 1.
            if(isThrottled && attempt < backoff.maxAttempts) {
                // Stryker disable next-line llm: exponentiation and Math.pow are equivalent for these numeric operands.
                const delayMs = backoff.baseDelayMs * 2 ** (attempt - 1);
                // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between attempts
                await delay(delayMs, signal);
                logger.debug({ attempt, context, msg: `Reconciler retry ${attempt}/${backoff.maxAttempts}` });
                continue;
            }

            // Non-throttling error or exhausted retries
            logger.warn({ error, context, msg: `Reconciler operation failed after ${attempt} attempts` });
            return undefined;
        }
    }
    return undefined;
}

// ============================================================================
// Phase A: Scan Memory Items
// ============================================================================

interface PhaseAContext {
    deps:     ResolvedReconcilerDeps
    options:  ReconcilerOptions
    progress: PhaseAProgress
    pacers:   ReconcilerPacers
}

/**
 * Check if tag index item exists for a given memory path and tag
 */
async function checkTagIndexExists(
    ctx: PhaseAContext,
    memoryPath: MemoryPath,
    tag: string
): Promise<TagIndexReadItem | undefined> {
    const result = await retryWithBackoff(
        async () => ctx.deps.docClient.send(new QueryCommand({
            TableName:                 ctx.deps.tableName,
            KeyConditionExpression:    'PK = :pk AND SK = :sk',
            ExpressionAttributeValues: {
                ':pk': `TAG#${tag}`,
                ':sk': `PATH#${memoryPath}`,
            },
            Limit: 1,
        })),
        ctx.options.backoff,
        `checkTagIndexExists:${tag}:${memoryPath}`,
        ctx.options.signal
    );

    return result?.Items?.[0] as TagIndexReadItem | undefined;
}

/**
 * Check if tag index item is stale (needs refresh)
 */
function isTagIndexStale(
    memoryItem: MemoryToolItem,
    indexItem: TagIndexReadItem,
    namespace: IndexLayer
): boolean {
    return (
        indexItem.contentPreview !== (memoryItem.contentPreview ?? '')
        // A persisted layer is an untrusted string: legacy /users rows say 'unknown'.
        || indexItem.layer !== namespace
        || indexItem.updatedAt !== memoryItem.updatedAt
        || !setsEqual(indexItem.tags, normalizeTags(memoryItem.tags))
    );
}

/**
 * Process a single memory item's tag indices
 */
async function processMemoryItemTags(
    ctx: PhaseAContext,
    memoryItem: MemoryToolItem
): Promise<void> {
    const normalizedTags = normalizeTags(memoryItem.tags);
    const layer = classifyMemoryPath(memoryItem.path).namespace;

    for(const tag of normalizedTags) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB op per tag
            const existingIndex = await checkTagIndexExists(ctx, memoryItem.path, tag);

            if(!existingIndex) {
                // Create the missing row, carrying the memory's full tag set (not just this tag)
                // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB write per tag
                await ctx.deps.tagIndex.createTagIndexItems(
                    memoryItem.path,
                    new Set([tag]),
                    memoryItem.updatedAt,
                    memoryItem.contentPreview ?? '',
                    layer,
                    normalizedTags
                );
                ctx.progress.indexItemsCreated++;
            } else if(isTagIndexStale(memoryItem, existingIndex, layer)) {
                // Refresh the stale row (count-neutral) with the memory's full tag set
                // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB write per tag
                await ctx.deps.tagIndex.refreshTagIndexItems(
                    memoryItem.path,
                    new Set([tag]),
                    memoryItem.updatedAt,
                    memoryItem.contentPreview ?? '',
                    layer,
                    normalizedTags
                );
                ctx.progress.indexItemsRefreshed++;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limiting delay between DynamoDB operations
            await delay(ctx.options.operationDelayMs, ctx.options.signal);
        } catch (error) {
            if(isAbortError(error)) {
                throw error;
            }
            logger.warn({ error, path: memoryItem.path, tag, msg: 'Failed to process tag index' });
            ctx.progress.errors++;
        }
    }
}

/**
 * Query all tag names from GSI2 TAG_COUNTS partition
 */
async function getAllTagNames(
    ctx: PhaseAContext | PhaseBContext
): Promise<string[] | undefined> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const allTags: string[] = [];

    const rate = rcuRateFor('gsi2', ctx.options);

    do {
        const currentKey = lastEvaluatedKey;
        // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop depends on prior response cursor
        await waitBeforeReconcilerRead(ctx.pacers.gsi2, ctx.options.signal);
        // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop depends on prior response cursor
        const result = await retryWithBackoff(

            async () => ctx.deps.docClient.send(new QueryCommand({
                TableName:                 ctx.deps.tableName,
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: {
                    ':gsi2pk': 'TAG_COUNTS',
                },
                ExclusiveStartKey:      currentKey,
                ReturnConsumedCapacity: 'TOTAL',
            })),
            ctx.options.backoff,
            'getAllTagNames',
            ctx.options.signal
        );

        if(!result) {
            return undefined;
        }

        // Stryker disable next-line llm: QueryCommandOutput.Items is an array or undefined, so nullish and falsy fallback select the same array.
        for(const item of result.Items ?? []) {
            // Extract tag name from GSI2SK = 'TAG#{tagname}'
            const gsi2sk = item.GSI2SK as string | undefined;
            if(gsi2sk?.startsWith('TAG#')) {
                allTags.push(gsi2sk.slice(4));
            }
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
        const paced = recordRcuPage(
            ctx.pacers.gsi2,
            result.ConsumedCapacity?.CapacityUnits,
            rate,
            Boolean(lastEvaluatedKey),
            () => logger.warn({ msg: 'getAllTagNames omitted ConsumedCapacity; stopping pagination without pacing' })
        );
        if(!paced) {
            return undefined;
        }
    } while(lastEvaluatedKey);

    return allTags;
}

/**
 * Check if old path's tag indices are cleaned up using known old tags (new format).
 * Runs GetItem for each old tag in parallel via Promise.all.
 */
async function checkOldPathIndicesCleanByTags(
    ctx: PhaseAContext,
    oldPath: string,
    oldTags: string[]
): Promise<boolean> {
    const results = await Promise.all(
        oldTags.map(tag =>
            retryWithBackoff(
                async () => ctx.deps.docClient.send(new GetCommand({
                    TableName: ctx.deps.tableName,
                    Key:       {
                        PK: `TAG#${tag}`,
                        SK: `PATH#${oldPath}`,
                    },
                })),
                ctx.options.backoff,
                `checkOldPathIndicesClean:${tag}:${oldPath}`,
                ctx.options.signal
            ))
    );

    // A failed probe is not evidence that an old-path index is gone.
    return results.every(result => result !== undefined && !result.Item);
}

/**
 * Check if old path's tag indices are cleaned up
 * Known legacy tombstone tags use GetItem per old tag in parallel.
 * Unknown tags require GSI2 TAG_COUNTS enumeration.
 */
async function checkOldPathIndicesClean(
    ctx: PhaseAContext,
    cleanup: PendingRenameIndexCleanup
): Promise<boolean> {
    const oldPath = cleanup.oldPath;
    if(cleanup.tags.kind === 'known') {
        return checkOldPathIndicesCleanByTags(ctx, oldPath, cleanup.tags.tags);
    }

    // Backward compat: enumerate all tags via GSI2 TAG_COUNTS
    const allTags = await getAllTagNames(ctx);

    if(!allTags) {
        // Failed to enumerate tags (including a page that omitted ConsumedCapacity mid-pagination)
        // - assume not clean (conservative) and count it, so a stalled cleanup is distinguishable
        // from a genuinely-not-clean result rather than silently looking like ordinary unfinished work.
        ctx.progress.errors++;
        return false;
    }

    for(const tag of allTags) {
        // eslint-disable-next-line no-await-in-loop -- sequential: stop querying when any tag still has an old-path index
        const result = await retryWithBackoff(
            async () => ctx.deps.docClient.send(new GetCommand({
                TableName: ctx.deps.tableName,
                Key:       {
                    PK: `TAG#${tag}`,
                    SK: `PATH#${oldPath}`,
                },
            })),
            ctx.options.backoff,
            `checkOldPathIndicesClean:${tag}:${oldPath}`,
            ctx.options.signal
        );

        if(!result || result.Item) {
            return false;
        }
    }

    return true;
}

/**
 * Clean previouslyKnownAs metadata if old path indices are gone
 */
async function cleanPreviouslyKnownAs(
    ctx: PhaseAContext,
    memoryItem: MemoryToolItem
): Promise<void> {
    const cleanup = decodePendingRenameIndexCleanup(memoryItem.metadata);
    if(!cleanup) {
        return;
    }

    try {
        const isClean = await checkOldPathIndicesClean(ctx, cleanup);

        if(isClean) {
            let cleanupError: unknown;
            const updateResult = await retryWithBackoff(
                async () => {
                    try {
                        return await ctx.deps.docClient.send(new UpdateCommand({
                            TableName: ctx.deps.tableName,

                            Key: { PK: memoryItem.PK, SK: memoryItem.SK },

                            UpdateExpression: 'REMOVE #metadata.#previouslyKnownAs, #metadata.#previouslyKnownAsTags',

                            ConditionExpression: 'attribute_exists(PK) AND attribute_type(#metadata, :map)',

                            ExpressionAttributeNames: {
                                '#metadata':              'metadata',
                                '#previouslyKnownAs':     'previouslyKnownAs',
                                '#previouslyKnownAsTags': 'previouslyKnownAsTags',
                            },
                            ExpressionAttributeValues: { ':map': 'M' },
                        }));
                    } catch (error) {
                        cleanupError = error;
                        throw error;
                    }
                },
                ctx.options.backoff,
                `cleanPreviouslyKnownAs:${cleanup.oldPath}`,
                ctx.options.signal
            );

            if(updateResult === undefined) {
                throw cleanupError;
            }

            ctx.progress.metadataCleaned++;
            logger.debug({ path: memoryItem.path, oldPath: cleanup.oldPath, msg: 'Cleaned previouslyKnownAs metadata' });
        }

        await delay(ctx.options.operationDelayMs, ctx.options.signal);
    } catch (error) {
        if(isAbortError(error)) {
            throw error;
        }
        logger.warn({ error, path: memoryItem.path, msg: 'Failed to clean previouslyKnownAs' });
        ctx.progress.errors++;
    }
}

/**
 * Process a single memory item (tags + metadata cleanup)
 */
async function processMemoryItem(
    ctx: PhaseAContext,
    memoryItem: MemoryToolItem
): Promise<void> {
    ctx.progress.itemsScanned++;

    // Process tags
    await processMemoryItemTags(ctx, memoryItem);

    // Clean previouslyKnownAs metadata if applicable
    await cleanPreviouslyKnownAs(ctx, memoryItem);
}

/**
 * Scan a single layer via GSI1
 */
async function scanLayer(
    ctx: PhaseAContext,
    layer: IndexLayer
): Promise<void> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const rate = rcuRateFor('gsi1', ctx.options);

    do {
        if(ctx.options.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // eslint-disable-next-line no-await-in-loop -- sequential: pacing wait depends on the previous page's reported capacity
        await waitBeforeReconcilerRead(ctx.pacers.gsi1, ctx.options.signal);

        const currentKey = lastEvaluatedKey;
        // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop depends on prior response cursor
        const result = await retryWithBackoff(

            async () => ctx.deps.docClient.send(new QueryCommand({
                // Stryker disable next-line llm: tableName is a required non-nullable string, so a nullish fallback is unreachable.
                TableName:                 ctx.deps.tableName,
                IndexName:                 'GSI1',
                KeyConditionExpression:    'GSI1PK = :gsi1pk',
                ExpressionAttributeValues: {
                    ':gsi1pk': `LAYER#${layer}`,
                },
                Limit:                  ctx.options.scanPageSize,
                ExclusiveStartKey:      currentKey,
                ReturnConsumedCapacity: 'TOTAL',
            })),
            // Stryker disable next-line llm: backoff is a required object and therefore cannot activate an || fallback.
            ctx.options.backoff,
            `scanLayer:${layer}`,
            ctx.options.signal
        );

        if(!result) {
            logger.warn({ layer, msg: 'Failed to scan layer' });
            ctx.progress.errors++;
            break;
        }

        const items = (result.Items ?? []) as MemoryToolItem[];

        // Process each memory item
        for(const item of items) {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB op per memory item
            await processMemoryItem(ctx, item);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
        const paced = recordRcuPage(
            ctx.pacers.gsi1,
            result.ConsumedCapacity?.CapacityUnits,
            rate,
            Boolean(lastEvaluatedKey),
            () => logger.warn({ layer, msg: 'scanLayer omitted ConsumedCapacity; stopping pagination without pacing' })
        );
        if(!paced) {
            ctx.progress.errors++;
            break;
        }
    } while(lastEvaluatedKey);
}

/**
 * Phase A: Scan all memory items and ensure tag indices are complete
 */
async function runPhaseA(
    deps: ResolvedReconcilerDeps,
    options: ReconcilerOptions,
    pacers: ReconcilerPacers
): Promise<PhaseAProgress> {
    const progress: PhaseAProgress = {
        phase:               'phaseA',
        itemsScanned:        0,
        indexItemsCreated:   0,
        indexItemsRefreshed: 0,
        metadataCleaned:     0,
        errors:              0,
        startTime:           new Date(),
    };

    const ctx: PhaseAContext = { deps, options, progress, pacers };

    // The three cognitive GSI1 partitions plus LAYER#users, so /users rows (whose legacy tag rows say 'unknown') are repaired too.
    for(const layer of SEARCHABLE_NAMESPACES) {
        // Stryker disable next-line llm: AbortSignal.aborted is boolean, so strict comparison with true has the same branch behavior.
        if(options.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB scan per layer
        await scanLayer(ctx, layer);
    }

    progress.endTime = new Date();
    return progress;
}

// ============================================================================
// Phase B: Scan Tag Index
// ============================================================================

interface PhaseBContext {
    deps:     ResolvedReconcilerDeps
    options:  ReconcilerOptions
    progress: PhaseBProgress
    pacers:   ReconcilerPacers
}

/**
 * Process a single tag index item
 */
async function processTagIndexItem(
    ctx: PhaseBContext,
    indexItem: TagIndexReadItem
): Promise<void> {
    ctx.progress.itemsScanned++;

    try {
        const memoryPath = MemoryToolKeyGenerator.parsePathFromTagSK(indexItem.SK);
        const tag = MemoryToolKeyGenerator.parseTagFromPK(indexItem.PK);

        const memory = await ctx.deps.getMemory(createMemoryPath(memoryPath));

        if(memory) {
            // Memory exists - check if tag is still present
            const normalizedTags = normalizeTags(memory.tags);

            if(!normalizedTags.has(tag)) {
                // Tag removed - delete stale index
                await ctx.deps.tagIndex.deleteTagIndexItems(memory.path, new Set([tag]));
                ctx.progress.indexItemsDeleted++;
                logger.debug({ path: memory.path, tag, msg: 'Deleted stale tag index' });
            }
        } else {
            // Memory doesn't exist - delete orphaned index
            await ctx.deps.tagIndex.deleteTagIndexItems(createMemoryPath(memoryPath), new Set([tag]));
            ctx.progress.indexItemsDeleted++;
            logger.debug({ path: memoryPath, tag, msg: 'Deleted orphaned tag index' });
        }

        await delay(ctx.options.operationDelayMs, ctx.options.signal);
    } catch (error) {
        if(isAbortError(error)) {
            throw error;
        }
        logger.warn({ error, indexItem, msg: 'Failed to process tag index item' });
        ctx.progress.errors++;
    }
}

/**
 * Scan all tag index items for a single tag via PK query
 */
async function scanTagItems(
    ctx: PhaseBContext,
    tag: string
): Promise<void> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const rate = rcuRateFor('base', ctx.options);

    do {
        if(ctx.options.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // eslint-disable-next-line no-await-in-loop -- sequential: pacing wait depends on the previous page's reported capacity
        await waitBeforeReconcilerRead(ctx.pacers.base, ctx.options.signal);

        const currentKey = lastEvaluatedKey;
        // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop depends on prior response cursor
        const result = await retryWithBackoff(

            async () => ctx.deps.docClient.send(new QueryCommand({
                TableName:                 ctx.deps.tableName,
                KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: {
                    ':pk':       `TAG#${tag}`,
                    ':skPrefix': 'PATH#',
                },
                Limit:                  ctx.options.scanPageSize,
                ExclusiveStartKey:      currentKey,
                ReturnConsumedCapacity: 'TOTAL',
            })),
            ctx.options.backoff,
            `scanTagItems:${tag}`,
            ctx.options.signal
        );

        if(!result) {
            logger.warn({ tag, msg: 'Failed to query tag index items' });
            ctx.progress.errors++;
            break;
        }

        const items = (result.Items ?? []) as TagIndexReadItem[];

        for(const item of items) {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB op per tag index item
            await processTagIndexItem(ctx, item);
        }

        // Stryker disable next-line llm: null and undefined both terminate this truthiness-controlled pagination loop.
        lastEvaluatedKey = result.LastEvaluatedKey;
        const paced = recordRcuPage(
            ctx.pacers.base,
            result.ConsumedCapacity?.CapacityUnits,
            rate,
            Boolean(lastEvaluatedKey),
            () => logger.warn({ tag, msg: 'scanTagItems omitted ConsumedCapacity; stopping pagination without pacing' })
        );
        if(!paced) {
            ctx.progress.errors++;
            break;
        }
    } while(lastEvaluatedKey);
}

/**
 * Phase B: Enumerate all tags via GSI2 TAG_COUNTS, then query each tag's index items and delete orphaned entries
 */
async function runPhaseB(
    deps: ResolvedReconcilerDeps,
    options: ReconcilerOptions,
    pacers: ReconcilerPacers
): Promise<PhaseBProgress> {
    const progress: PhaseBProgress = {
        phase:             'phaseB',
        itemsScanned:      0,
        indexItemsDeleted: 0,
        errors:            0,
        startTime:         new Date(),
    };

    const ctx: PhaseBContext = { deps, options, progress, pacers };

    // Enumerate all tags from GSI2 TAG_COUNTS partition
    const allTags = await getAllTagNames(ctx);

    if(!allTags) {
        logger.warn({ msg: 'Failed to enumerate tags for Phase B' });
        progress.errors++;
        progress.endTime = new Date();
        return progress;
    }

    for(const tag of allTags) {
        // scanTagItems checks the signal before issuing its first query and on each page.
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB scan per tag
        await scanTagItems(ctx, tag);
    }

    progress.endTime = new Date();
    return progress;
}

// ============================================================================
// Phase C: Verify META_COUNT Items
// ============================================================================

interface PhaseCContext {
    deps:     ResolvedReconcilerDeps
    options:  ReconcilerOptions
    progress: PhaseCProgress
    pacers:   ReconcilerPacers
}

/**
 * Get actual tag index item count for a given tag
 * Handles pagination to sum counts across all pages
 */
async function getActualTagCount(
    ctx: PhaseCContext,
    tag: string
): Promise<number | undefined> {
    let totalCount = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const rate = rcuRateFor('base', ctx.options);

    do {
        if(ctx.options.signal?.aborted) {
            return undefined;
        }

        // Note: unlike the abort check just above, an abort that fires during this sleep throws (delay()'s
        // AbortError), not a soft `undefined` -- processMetaCount's isAbortError check rethrows it as usual.
        // eslint-disable-next-line no-await-in-loop -- sequential: pacing wait depends on the previous page's reported capacity
        await waitBeforeReconcilerRead(ctx.pacers.base, ctx.options.signal);

        const currentKey = lastEvaluatedKey;
        // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop depends on prior response cursor
        const result = await retryWithBackoff(

            async () => ctx.deps.docClient.send(new QueryCommand({
                TableName:                 ctx.deps.tableName,
                KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                ExpressionAttributeValues: {
                    ':pk':       `TAG#${tag}`,
                    ':skPrefix': 'PATH#',
                },
                Select:                 'COUNT',
                ExclusiveStartKey:      currentKey,
                ReturnConsumedCapacity: 'TOTAL',
            })),
            ctx.options.backoff,
            `getActualTagCount:${tag}`,
            ctx.options.signal
        );

        if(!result) {
            return undefined;
        }

        totalCount += result.Count ?? 0;
        lastEvaluatedKey = result.LastEvaluatedKey;
        const paced = recordRcuPage(
            ctx.pacers.base,
            result.ConsumedCapacity?.CapacityUnits,
            rate,
            Boolean(lastEvaluatedKey),
            () => logger.warn({ tag, msg: 'getActualTagCount omitted ConsumedCapacity; stopping pagination without pacing' })
        );
        if(!paced) {
            return undefined;
        }
    } while(lastEvaluatedKey);

    return totalCount;
}

/**
 * Update META_COUNT item to correct value
 */
async function updateMetaCount(
    ctx: PhaseCContext,
    tag: string,
    correctCount: number
): Promise<boolean> {
    const result = await retryWithBackoff(
        async () => ctx.deps.docClient.send(new UpdateCommand({
            TableName: ctx.deps.tableName,
            Key:       {
                PK: `TAG#${tag}`,
                SK: 'META_COUNT',
            },
            UpdateExpression:          'SET #count = :count, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
            ExpressionAttributeNames:  { '#count': 'count' },
            ExpressionAttributeValues: {
                ':count':  correctCount,
                ':gsi2pk': 'TAG_COUNTS',
                ':gsi2sk': `TAG#${tag}`,
            },
        })),
        ctx.options.backoff,
        `updateMetaCount:${tag}`,
        ctx.options.signal
    );
    return result !== undefined;
}

/**
 * Delete META_COUNT item
 */
async function deleteMetaCount(
    ctx: PhaseCContext,
    tag: string
): Promise<boolean> {
    const result = await retryWithBackoff(
        async () => ctx.deps.docClient.send(new DeleteCommand({
            TableName: ctx.deps.tableName,
            Key:       {
                PK: `TAG#${tag}`,
                SK: 'META_COUNT',
            },
        })),
        ctx.options.backoff,
        `deleteMetaCount:${tag}`,
        ctx.options.signal
    );
    return result !== undefined;
}

/**
 * Process a single META_COUNT item
 */
async function processMetaCount(
    ctx: PhaseCContext,
    tag: string,
    storedCount: number
): Promise<void> {
    ctx.progress.countsVerified++;

    try {
        const actualCount = await getActualTagCount(ctx, tag);

        if(actualCount === undefined) {
            logger.warn({ tag, msg: 'Failed to get actual tag count' });
            ctx.progress.errors++;
            return;
        }

        // Stryker disable next-line llm: DynamoDB counts and their accumulated total are nonnegative, so zero and nonpositive are identical here.
        if(actualCount === 0) {
            // Delete META_COUNT item
            const deleted = await deleteMetaCount(ctx, tag);
            if(deleted) {
                ctx.progress.countsDeleted++;
                logger.debug({ tag, msg: 'Deleted META_COUNT with zero actual count' });
            } else {
                ctx.progress.errors++;
            }
        } else if(
            // Stryker disable next-line llm: this condition runs only after actualCount === 0 was false, so adding that disjunct is inert.
            actualCount !== storedCount
        ) {
            // Correct META_COUNT item
            const updated = await updateMetaCount(ctx, tag, actualCount);
            if(updated) {
                ctx.progress.countsCorrected++;
                logger.debug({ tag, storedCount, actualCount, msg: 'Corrected META_COUNT mismatch' });
            } else {
                ctx.progress.errors++;
            }
        }

        await delay(ctx.options.operationDelayMs, ctx.options.signal);
    } catch (error) {
        if(isAbortError(error)) {
            throw error;
        }
        logger.warn({ error, tag, msg: 'Failed to process META_COUNT item' });
        ctx.progress.errors++;
    }
}

/**
 * Phase C: Verify all META_COUNT items match actual tag index counts
 */
async function runPhaseC(
    deps: ResolvedReconcilerDeps,
    options: ReconcilerOptions,
    pacers: ReconcilerPacers
): Promise<PhaseCProgress> {
    const progress: PhaseCProgress = {
        phase:           'phaseC',
        countsVerified:  0,
        countsCorrected: 0,
        countsDeleted:   0,
        errors:          0,
        startTime:       new Date(),
    };

    const ctx: PhaseCContext = { deps, options, progress, pacers };

    try {
        // Shares the run's GSI2 pacer with Phase A's legacy rename-cleanup fallback and Phase B's
        // tag-name enumeration, so this enumeration's pacing debt carries across phase boundaries too.
        const tagCounts = await deps.tagIndex.listTagCounts({
            pacer:              pacers.gsi2,
            rateLimitRcuPerSec: rcuRateFor('gsi2', options),
            signal:             options.signal,
        });

        for(const { tag, count } of tagCounts) {
            if(options.signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB op per tag count
            await processMetaCount(ctx, tag, count);
        }
    } catch (error) {
        if(options.signal?.aborted) {
            throw error;
        }
        logger.warn({ error, msg: 'Failed to list tag counts' });
        progress.errors++;
    }

    progress.endTime = new Date();
    return progress;
}

// ============================================================================
// Main Reconciliation
// ============================================================================

/**
 * Run complete tag index reconciliation (Phase A + Phase B + Phase C)
 */
export async function runTagIndexReconciliation(
    deps: ReconcilerDeps,
    options: ReconcilerOptions
): Promise<ReconciliationResult> {
    const startTime = Date.now();

    // Resolve holder → raw docClient once at the start of each reconciliation run.
    // This ensures the reconciler uses the live client (after any swap) rather than
    // whatever docClient was captured at scheduler-construction time.
    const resolvedDeps: ResolvedReconcilerDeps = {
        ...deps,
        docClient: resolveDocClientGetter(deps.docClient)(),
    };

    logger.info({ msg: 'Starting tag index reconciliation' });

    // One set of pacers for the whole run, so RCU pacing debt carries across phases (Phase A's
    // legacy GSI2 fallback / Phase B share `gsi2`; Phase B / Phase C share `base`), not just within
    // a single pagination loop.
    const pacers = createReconcilerPacers();

    const phaseA = await runPhaseA(resolvedDeps, options, pacers);
    logger.info({
        phase:               'A',
        itemsScanned:        phaseA.itemsScanned,
        indexItemsCreated:   phaseA.indexItemsCreated,
        indexItemsRefreshed: phaseA.indexItemsRefreshed,
        metadataCleaned:     phaseA.metadataCleaned,
        errors:              phaseA.errors,
        msg:                 'Phase A complete',
    });

    const phaseB = await runPhaseB(resolvedDeps, options, pacers);
    logger.info({
        phase:             'B',
        itemsScanned:      phaseB.itemsScanned,
        indexItemsDeleted: phaseB.indexItemsDeleted,
        errors:            phaseB.errors,
        msg:               'Phase B complete',
    });

    const phaseC = await runPhaseC(resolvedDeps, options, pacers);
    logger.info({
        phase:           'C',
        countsVerified:  phaseC.countsVerified,
        countsCorrected: phaseC.countsCorrected,
        countsDeleted:   phaseC.countsDeleted,
        errors:          phaseC.errors,
        msg:             'Phase C complete',
    });

    const totalDurationMs = Date.now() - startTime;
    // Stryker disable next-line llm: errors is initialised to 0 and only ever incremented, so it is always a number and == 0 is the same comparison as === 0
    const success = phaseA.errors === 0 && phaseB.errors === 0 && phaseC.errors === 0;

    logger.info({
        success,
        totalDurationMs,
        msg: 'Tag index reconciliation complete',
    });

    return {
        success,
        phaseA,
        phaseB,
        phaseC,
        totalDurationMs,
    };
}
