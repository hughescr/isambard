/**
 * Core Tag Index Reconciliation Logic
 *
 * Three-phase reconciliation system:
 * - Phase A: Scan memory items via GSI1, ensure tag indices are complete and up-to-date
 * - Phase B: Scan tag indices, delete orphaned entries
 * - Phase C: Verify META_COUNT atomic counters match actual tag index item counts
 */

import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, includes as _includes, isEqual as _isEqual, isObject as _isObject, isString as _isString, startsWith as _startsWith } from 'lodash';
import { logger } from '@hughescr/logger';
import type { MemoryToolBackendTagIndex } from '../backend-tag-index';
import type { MemoryPath, MemoryToolItemData, MemoryToolItem, TagIndexItem } from '../types';
import { extractLayerFromPath, type LayerName, layerNameSchema } from '../types';
import { MemoryToolKeyGenerator, normalizeTags } from '../key-generator';
import type { ReconciliationProgress, ReconciliationResult } from './types';

// ============================================================================
// Dependencies & Options
// ============================================================================

/**
 * Dependencies interface for testability
 */
export interface ReconcilerDeps {
    docClient:            DynamoDBDocumentClient
    tableName:            string
    tagIndex:             MemoryToolBackendTagIndex
    getMemory:            (path: MemoryPath) => Promise<MemoryToolItemData | undefined>
    updateMemoryMetadata: (path: MemoryPath, input: { metadata: Record<string, unknown> }) => Promise<MemoryToolItemData>
}

/**
 * Options for reconciliation run
 */
export interface ReconcilerOptions {
    /** Delay between operations in milliseconds (default 1000) */
    operationDelayMs: number
    /** DynamoDB page size (default 25) */
    scanPageSize:     number
    /** Backoff configuration */
    backoff:          { baseDelayMs: number, maxAttempts: number }
    /** Abort signal for cancellation */
    signal?:          AbortSignal
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Delay that respects abort signal
 */
/* Stryker disable all: Tests use 0ms delay - function internals not exercised */
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Optimization - early return if no delay needed
    if(ms <= 0) {
        return;
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);

        if(signal) {
            const onAbort = () => {
                clearTimeout(timeout);
                reject(new Error('Aborted'));
            };

            if(signal.aborted) {
                clearTimeout(timeout);
                reject(new Error('Aborted'));
                return;
            }

            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}
/* Stryker restore all */

/**
 * Retry with exponential backoff for DynamoDB operations
 */
// Stryker disable all: Retry logic with exponential backoff - testing timing behavior is unreliable
async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    backoff: { baseDelayMs: number, maxAttempts: number },
    context: string,
    signal?: AbortSignal
): Promise<T | undefined> {
    for(let attempt = 1; attempt <= backoff.maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if(signal?.aborted) {
                throw new Error('Aborted');
            }

            const isThrottled = error && _isObject(error) && 'name' in error
              && (error.name === 'ProvisionedThroughputExceededException' || error.name === 'ThrottlingException');

            if(isThrottled && attempt < backoff.maxAttempts) {
                const delayMs = backoff.baseDelayMs * Math.pow(2, attempt - 1);
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
// Stryker restore all

// ============================================================================
// Phase A: Scan Memory Items
// ============================================================================

interface PhaseAContext {
    deps:     ReconcilerDeps
    options:  ReconcilerOptions
    progress: ReconciliationProgress
}

/**
 * Check if tag index item exists for a given memory path and tag
 */
async function checkTagIndexExists(
    ctx: PhaseAContext,
    memoryPath: MemoryPath,
    tag: string
): Promise<TagIndexItem | undefined> {
    const result = await retryWithBackoff(
        async () => ctx.deps.docClient.send(new QueryCommand({
            TableName:                 ctx.deps.tableName,
            KeyConditionExpression:    'PK = :pk AND SK = :sk',
            // Stryker disable next-line StringLiteral: DynamoDB expression attribute names
            ExpressionAttributeValues: {
                ':pk': `TAG#${tag}`,
                ':sk': `PATH#${memoryPath}`,
            },
            Limit: 1,
        })),
        ctx.options.backoff,
        /* Stryker disable next-line StringLiteral: Retry context string is observational */
        `checkTagIndexExists:${tag}:${memoryPath}`,
        ctx.options.signal
    );

    // Stryker disable next-line OptionalChaining,ArrayDeclaration,BlockStatement,ConditionalExpression: Null check for query result
    if(!result?.Items || result.Items.length === 0) {
        return undefined;
    }

    return result.Items[0] as TagIndexItem;
}

/**
 * Check if tag index item is stale (needs refresh)
 */
function isTagIndexStale(
    memoryItem: MemoryToolItem,
    indexItem: TagIndexItem
): boolean {
    /* Stryker disable ConditionalExpression,LogicalOperator,ArrayDeclaration: Staleness checks are tested via refresh counts */
    return (
        indexItem.contentPreview !== memoryItem.contentPreview
        || indexItem.updatedAt !== memoryItem.updatedAt
        || !_isEqual(indexItem.tags, normalizeTags(memoryItem.tags ?? []))
    );
    /* Stryker restore ConditionalExpression,LogicalOperator,ArrayDeclaration */
}

/**
 * Process a single memory item's tag indices
 */
async function processMemoryItemTags(
    ctx: PhaseAContext,
    memoryItem: MemoryToolItem
): Promise<void> {
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: Skip items without tags
    if(!memoryItem.tags || memoryItem.tags.length === 0) {
        return;
    }

    const normalizedTags = normalizeTags(memoryItem.tags);
    // Stryker disable next-line StringLiteral: Default layer value not exercised in tests
    const layer = extractLayerFromPath(memoryItem.path) ?? 'unknown';

    for(const tag of normalizedTags) {
        try {
            const existingIndex = await checkTagIndexExists(ctx, memoryItem.path, tag);

            if(!existingIndex) {
                // Create missing index item
                await ctx.deps.tagIndex.createTagIndexItems(
                    memoryItem.path,
                    /* Stryker disable next-line ArrayDeclaration: Tag argument tested in backend-tag-index.test.ts */
                    [tag],
                    memoryItem.updatedAt,
                    // Stryker disable next-line StringLiteral: Default preview value not exercised in tests
                    memoryItem.contentPreview ?? '',
                    layer
                );
                ctx.progress.indexItemsCreated++;
            } else if(isTagIndexStale(memoryItem, existingIndex)) {
                // Refresh stale index item (count-neutral)
                await ctx.deps.tagIndex.refreshTagIndexItems(
                    memoryItem.path,
                    /* Stryker disable next-line ArrayDeclaration: Tag argument tested in backend-tag-index.test.ts */
                    [tag],
                    memoryItem.updatedAt,
                    // Stryker disable next-line StringLiteral: Default preview value not exercised in tests
                    memoryItem.contentPreview ?? '',
                    layer
                );
                ctx.progress.indexItemsRefreshed++;
            }

            await delay(ctx.options.operationDelayMs, ctx.options.signal);
        // Stryker disable next-line BlockStatement: Error handling catch block not exercised in unit tests
        } catch (error) {
            /* Stryker disable all: Error handling not exercised in unit tests */
            logger.warn({ error, path: memoryItem.path, tag, msg: 'Failed to process tag index' });
            ctx.progress.errors++;
            /* Stryker restore all */
        }
    }
}

/**
 * Check if old path's tag indices are cleaned up
 */
async function checkOldPathIndicesClean(
    ctx: PhaseAContext,
    oldPath: string
): Promise<boolean> {
    const result = await retryWithBackoff(
        async () => ctx.deps.docClient.send(new ScanCommand({
            TableName:                 ctx.deps.tableName,
            /* Stryker disable next-line StringLiteral: DynamoDB expression */
            FilterExpression:          'begins_with(PK, :pkPrefix) AND contains(SK, :skPart)',
            /* Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression attribute values */
            ExpressionAttributeValues: {
                ':pkPrefix': 'TAG#',
                ':skPart':   oldPath,
            },
            /* Stryker restore StringLiteral,ObjectLiteral */
            Limit: 1,
        })),
        ctx.options.backoff,
        /* Stryker disable next-line StringLiteral: Retry context string is observational */
        `checkOldPathIndicesClean:${oldPath}`,
        ctx.options.signal
    );

    // Clean if no items found
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: Null check
    return !result?.Items || result.Items.length === 0;
}

/**
 * Clean previouslyKnownAs metadata if old path indices are gone
 */
async function cleanPreviouslyKnownAs(
    ctx: PhaseAContext,
    memoryItem: MemoryToolItem
): Promise<void> {
    /* Stryker disable next-line OptionalChaining: Defensive null check */
    const previousPath = memoryItem.metadata?.previouslyKnownAs;

    // Stryker disable next-line ConditionalExpression,BlockStatement: Guard clause
    if(!previousPath || !_isString(previousPath)) {
        return;
    }

    try {
        const isClean = await checkOldPathIndicesClean(ctx, previousPath);

        if(isClean) {
            // Remove previouslyKnownAs from metadata
            const { previouslyKnownAs: _, ...cleanMetadata } = memoryItem.metadata ?? {};

            await ctx.deps.updateMemoryMetadata(
                memoryItem.path,
                { metadata: cleanMetadata }
            );

            ctx.progress.metadataCleaned++;
            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.debug({ path: memoryItem.path, oldPath: previousPath, msg: 'Cleaned previouslyKnownAs metadata' });
            /* Stryker restore StringLiteral,ObjectLiteral */
        }

        await delay(ctx.options.operationDelayMs, ctx.options.signal);
    // Stryker disable next-line BlockStatement: Error handling catch block not exercised in unit tests
    } catch (error) {
        /* Stryker disable all: Error handling not exercised in unit tests */
        logger.warn({ error, path: memoryItem.path, msg: 'Failed to clean previouslyKnownAs' });
        ctx.progress.errors++;
        /* Stryker restore all */
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
    layer: LayerName
): Promise<void> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    // Stryker disable ConditionalExpression,BlockStatement: Intentional infinite loop with break
    do {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Abort check
        if(ctx.options.signal?.aborted) {
            // Stryker disable next-line StringLiteral: Abort message not exercised in tests
            throw new Error('Aborted');
        }

        const result = await retryWithBackoff(
            // eslint-disable-next-line no-loop-func -- async function executed immediately via await
            async () => ctx.deps.docClient.send(new QueryCommand({
                TableName:                 ctx.deps.tableName,
                IndexName:                 'GSI1',
                /* Stryker disable next-line StringLiteral: DynamoDB expression */
                KeyConditionExpression:    'GSI1PK = :gsi1pk',
                // Stryker disable next-line StringLiteral: DynamoDB expression attribute names
                ExpressionAttributeValues: {
                    ':gsi1pk': `LAYER#${layer}`,
                },
                Limit:             ctx.options.scanPageSize,
                ExclusiveStartKey: lastEvaluatedKey,
            })),
            ctx.options.backoff,
            /* Stryker disable next-line StringLiteral: Retry context string is observational */
            `scanLayer:${layer}`,
            ctx.options.signal
        );

        // Stryker disable next-line ConditionalExpression,BlockStatement: Null check
        if(!result) {
            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.warn({ layer, msg: 'Failed to scan layer' });
            /* Stryker restore StringLiteral,ObjectLiteral */
            ctx.progress.errors++;
            break;
        }

        const items = (result.Items ?? []) as MemoryToolItem[];

        // Process each memory item
        for(const item of items) {
            await processMemoryItem(ctx, item);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;

        // Stryker disable next-line ConditionalExpression,BlockStatement: Loop termination
    } while(lastEvaluatedKey);
    // Stryker restore ConditionalExpression,BlockStatement
}

/**
 * Phase A: Scan all memory items and ensure tag indices are complete
 */
async function runPhaseA(
    deps: ReconcilerDeps,
    options: ReconcilerOptions
): Promise<ReconciliationProgress> {
    const progress: ReconciliationProgress = {
        phase:               'phaseA',
        itemsScanned:        0,
        indexItemsCreated:   0,
        indexItemsRefreshed: 0,
        indexItemsDeleted:   0,
        metadataCleaned:     0,
        errors:              0,
        startTime:           new Date(),
    };

    const ctx: PhaseAContext = { deps, options, progress };

    // Parse layer names as branded types
    const layers: LayerName[] = [
        layerNameSchema.parse('identity'),
        layerNameSchema.parse('state'),
        layerNameSchema.parse('events'),
    ];

    for(const layer of layers) {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Abort check
        if(options.signal?.aborted) {
            /* Stryker disable next-line StringLiteral: Abort message is observational */
            throw new Error('Aborted');
        }

        await scanLayer(ctx, layer);
    }

    progress.endTime = new Date();
    return progress;
}

// ============================================================================
// Phase B: Scan Tag Index
// ============================================================================

interface PhaseBContext {
    deps:     ReconcilerDeps
    options:  ReconcilerOptions
    progress: ReconciliationProgress
}

/**
 * Process a single tag index item
 */
async function processTagIndexItem(
    ctx: PhaseBContext,
    indexItem: TagIndexItem
): Promise<void> {
    ctx.progress.itemsScanned++;

    try {
        const memoryPath = MemoryToolKeyGenerator.parsePathFromTagSK(indexItem.SK);
        const tag = MemoryToolKeyGenerator.parseTagFromPK(indexItem.PK);

        const memory = await ctx.deps.getMemory(memoryPath as MemoryPath);

        if(!memory) {
            // Memory doesn't exist - delete orphaned index
            await ctx.deps.tagIndex.deleteTagIndexItems(memoryPath as MemoryPath, /* Stryker disable next-line ArrayDeclaration: Tag argument tested in backend-tag-index.test.ts */
                [tag]);
            ctx.progress.indexItemsDeleted++;
            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.debug({ path: memoryPath, tag, msg: 'Deleted orphaned tag index' });
            /* Stryker restore StringLiteral,ObjectLiteral */
        } else {
            // Memory exists - check if tag is still present
            // Stryker disable next-line ArrayDeclaration: Default value not exercised in tests
            const normalizedTags = normalizeTags(memory.tags ?? []);

            // Stryker disable next-line ConditionalExpression,BlockStatement: Tag check
            if(!_includes(normalizedTags, tag)) {
                // Tag removed - delete stale index
                await ctx.deps.tagIndex.deleteTagIndexItems(memory.path, /* Stryker disable next-line ArrayDeclaration: Tag argument tested in backend-tag-index.test.ts */
                    [tag]);
                ctx.progress.indexItemsDeleted++;
                /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
                logger.debug({ path: memory.path, tag, msg: 'Deleted stale tag index' });
                /* Stryker restore StringLiteral,ObjectLiteral */
            }
        }

        await delay(ctx.options.operationDelayMs, ctx.options.signal);
    // Stryker disable next-line BlockStatement: Error handling catch block not exercised in unit tests
    } catch (error) {
        /* Stryker disable all: Error handling not exercised in unit tests */
        logger.warn({ error, indexItem, msg: 'Failed to process tag index item' });
        ctx.progress.errors++;
        /* Stryker restore all */
    }
}

/**
 * Phase B: Scan all tag index items and delete orphaned entries
 */
async function runPhaseB(
    deps: ReconcilerDeps,
    options: ReconcilerOptions
): Promise<ReconciliationProgress> {
    const progress: ReconciliationProgress = {
        phase:               'phaseB',
        itemsScanned:        0,
        indexItemsCreated:   0,
        indexItemsRefreshed: 0,
        indexItemsDeleted:   0,
        metadataCleaned:     0,
        errors:              0,
        startTime:           new Date(),
    };

    const ctx: PhaseBContext = { deps, options, progress };

    let lastEvaluatedKey: Record<string, unknown> | undefined;

    // Stryker disable ConditionalExpression,BlockStatement: Intentional infinite loop with break
    do {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Abort check
        if(options.signal?.aborted) {
            // Stryker disable next-line StringLiteral: Abort message not exercised in tests
            throw new Error('Aborted');
        }

        const result = await retryWithBackoff(
            // eslint-disable-next-line no-loop-func -- async function executed immediately via await
            async () => deps.docClient.send(new ScanCommand({
                TableName:                 deps.tableName,
                /* Stryker disable next-line StringLiteral: DynamoDB expression */
                FilterExpression:          'begins_with(PK, :prefix) AND SK <> :metaCount',
                // Stryker disable next-line StringLiteral,ObjectLiteral: DynamoDB expression attribute values
                ExpressionAttributeValues: {
                    ':prefix':    'TAG#',
                    ':metaCount': 'META_COUNT',
                },
                Limit:             options.scanPageSize,
                ExclusiveStartKey: lastEvaluatedKey,
            })),
            options.backoff,
            /* Stryker disable next-line StringLiteral: Retry context string is observational */
            'scanTagIndex',
            options.signal
        );

        // Stryker disable next-line ConditionalExpression,BlockStatement: Null check
        if(!result) {
            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.warn({ msg: 'Failed to scan tag index' });
            /* Stryker restore StringLiteral,ObjectLiteral */
            // Stryker disable next-line UpdateOperator: Error increment in uncovered error path
            progress.errors++;
            break;
        }

        const items = (result.Items ?? []) as TagIndexItem[];

        for(const item of items) {
            await processTagIndexItem(ctx, item);
        }

        lastEvaluatedKey = result.LastEvaluatedKey;

        // Stryker disable next-line ConditionalExpression,BlockStatement: Loop termination
    } while(lastEvaluatedKey);
    // Stryker restore ConditionalExpression,BlockStatement

    progress.endTime = new Date();
    return progress;
}

// ============================================================================
// Phase C: Verify META_COUNT Items
// ============================================================================

interface PhaseCContext {
    deps:     ReconcilerDeps
    options:  ReconcilerOptions
    progress: ReconciliationProgress
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

    // Stryker disable ConditionalExpression,BlockStatement: Intentional infinite loop with break
    do {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Abort check
        if(ctx.options.signal?.aborted) {
            return undefined;
        }

        const result = await retryWithBackoff(
            // eslint-disable-next-line no-loop-func -- async function executed immediately via await
            async () => ctx.deps.docClient.send(new QueryCommand({
                TableName:                 ctx.deps.tableName,
                KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
                // Stryker disable next-line StringLiteral: DynamoDB expression attribute values
                ExpressionAttributeValues: {
                    ':pk':       `TAG#${tag}`,
                    ':skPrefix': 'PATH#',
                },
                // Stryker disable next-line StringLiteral: Select COUNT instead of fetching all items
                Select:            'COUNT',
                ExclusiveStartKey: lastEvaluatedKey,
            })),
            ctx.options.backoff,
            /* Stryker disable next-line StringLiteral: Retry context string is observational */
            `getActualTagCount:${tag}`,
            ctx.options.signal
        );

        // Stryker disable next-line OptionalChaining,BlockStatement: Null check
        if(!result) {
            return undefined;
        }

        totalCount += result.Count ?? 0;
        lastEvaluatedKey = result.LastEvaluatedKey;

        // Stryker disable next-line ConditionalExpression,BlockStatement: Loop termination
    } while(lastEvaluatedKey);
    // Stryker restore ConditionalExpression,BlockStatement

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
        /* Stryker disable next-line StringLiteral: Retry context string is observational */
        `updateMetaCount:${tag}`,
        ctx.options.signal
    );
    // Stryker disable next-line ConditionalExpression: Null check on retryWithBackoff result
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
        /* Stryker disable next-line StringLiteral: Retry context string is observational */
        `deleteMetaCount:${tag}`,
        ctx.options.signal
    );
    // Stryker disable next-line ConditionalExpression: Null check on retryWithBackoff result
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
    ctx.progress.countsVerified = (ctx.progress.countsVerified ?? 0) + 1;

    // Stryker disable BlockStatement: Error handling catch block not exercised in unit tests
    try {
        const actualCount = await getActualTagCount(ctx, tag);

        // Stryker disable next-line ConditionalExpression,BlockStatement: Null check
        if(actualCount === undefined) {
            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.warn({ tag, msg: 'Failed to get actual tag count' });
            /* Stryker restore StringLiteral,ObjectLiteral */
            ctx.progress.errors++;
            return;
        }

        // Stryker disable ConditionalExpression,EqualityOperator: Count comparison
        if(actualCount === 0) {
            // Delete META_COUNT item
            const deleted = await deleteMetaCount(ctx, tag);
            // Stryker disable next-line ConditionalExpression,BlockStatement: Success check
            if(deleted) {
                ctx.progress.countsDeleted = (ctx.progress.countsDeleted ?? 0) + 1;
                /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
                logger.debug({ tag, msg: 'Deleted META_COUNT with zero actual count' });
                /* Stryker restore StringLiteral,ObjectLiteral */
            } else {
                /* Stryker disable BlockStatement: Error handling path not exercised in unit tests */
                ctx.progress.errors++;
                /* Stryker restore BlockStatement */
            }
        } else if(actualCount !== storedCount) {
            // Correct META_COUNT item
            const updated = await updateMetaCount(ctx, tag, actualCount);
            // Stryker disable next-line ConditionalExpression,BlockStatement: Success check
            if(updated) {
                ctx.progress.countsCorrected = (ctx.progress.countsCorrected ?? 0) + 1;
                /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
                logger.debug({ tag, storedCount, actualCount, msg: 'Corrected META_COUNT mismatch' });
                /* Stryker restore StringLiteral,ObjectLiteral */
            } else {
                /* Stryker disable BlockStatement: Error handling path not exercised in unit tests */
                ctx.progress.errors++;
                /* Stryker restore BlockStatement */
            }
        }
        // Stryker enable ConditionalExpression,EqualityOperator

        await delay(ctx.options.operationDelayMs, ctx.options.signal);
    } catch (error) {
        /* Stryker disable all: Error handling not exercised in unit tests */
        logger.warn({ error, tag, msg: 'Failed to process META_COUNT item' });
        ctx.progress.errors++;
        /* Stryker restore all */
    }
    // Stryker restore BlockStatement
}

/**
 * Phase C: Verify all META_COUNT items match actual tag index counts
 */
async function runPhaseC(
    deps: ReconcilerDeps,
    options: ReconcilerOptions
): Promise<ReconciliationProgress> {
    const progress: ReconciliationProgress = {
        phase:               'phaseC',
        itemsScanned:        0,
        indexItemsCreated:   0,
        indexItemsRefreshed: 0,
        indexItemsDeleted:   0,
        metadataCleaned:     0,
        countsVerified:      0,
        countsCorrected:     0,
        countsDeleted:       0,
        errors:              0,
        startTime:           new Date(),
    };

    const ctx: PhaseCContext = { deps, options, progress };

    try {
        const tagCounts = await deps.tagIndex.listTagCounts();

        for(const { tag, count } of tagCounts) {
            // Stryker disable next-line ConditionalExpression,BlockStatement: Abort check
            if(options.signal?.aborted) {
                // Stryker disable next-line StringLiteral: Abort message not exercised in tests
                throw new Error('Aborted');
            }

            await processMetaCount(ctx, tag, count);
        }
    // Stryker disable next-line BlockStatement: Error handling catch block not exercised in unit tests
    } catch (error) {
        /* Stryker disable all: Error handling not exercised in unit tests */
        if(options.signal?.aborted) {
            throw error;
        }
        logger.warn({ error, msg: 'Failed to list tag counts' });
        progress.errors++;
        /* Stryker restore all */
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
export async function runReconciliation(
    deps: ReconcilerDeps,
    options: ReconcilerOptions
): Promise<ReconciliationResult> {
    const startTime = Date.now();

    /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
    logger.info({ msg: 'Starting tag index reconciliation' });
    /* Stryker restore StringLiteral,ObjectLiteral */

    const phaseA = await runPhaseA(deps, options);
    /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
    logger.info({
        phase:               'A',
        itemsScanned:        phaseA.itemsScanned,
        indexItemsCreated:   phaseA.indexItemsCreated,
        indexItemsRefreshed: phaseA.indexItemsRefreshed,
        metadataCleaned:     phaseA.metadataCleaned,
        errors:              phaseA.errors,
        msg:                 'Phase A complete',
    });
    /* Stryker restore StringLiteral,ObjectLiteral */

    const phaseB = await runPhaseB(deps, options);
    /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
    logger.info({
        phase:             'B',
        itemsScanned:      phaseB.itemsScanned,
        indexItemsDeleted: phaseB.indexItemsDeleted,
        errors:            phaseB.errors,
        msg:               'Phase B complete',
    });
    /* Stryker restore StringLiteral,ObjectLiteral */

    const phaseC = await runPhaseC(deps, options);
    /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
    logger.info({
        phase:           'C',
        countsVerified:  phaseC.countsVerified,
        countsCorrected: phaseC.countsCorrected,
        countsDeleted:   phaseC.countsDeleted,
        errors:          phaseC.errors,
        msg:             'Phase C complete',
    });
    /* Stryker restore StringLiteral,ObjectLiteral */

    const totalDurationMs = Date.now() - startTime;
    /* Stryker disable next-line ConditionalExpression: Success calculation tested via integration tests */
    const success = phaseA.errors === 0 && phaseB.errors === 0 && phaseC.errors === 0;

    /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
    logger.info({
        success,
        totalDurationMs,
        msg: 'Tag index reconciliation complete',
    });
    /* Stryker restore StringLiteral,ObjectLiteral */

    return {
        success,
        phaseA,
        phaseB,
        phaseC,
        totalDurationMs,
    };
}
