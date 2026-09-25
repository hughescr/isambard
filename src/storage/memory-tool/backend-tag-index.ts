import { type BatchWriteCommandInput, type BatchWriteCommandOutput, type DynamoDBDocumentClient, DeleteCommand, QueryCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import pLimit from 'p-limit';
import { z } from 'zod';
import { type DynamoDBClientHolder, resolveDocClientGetter } from '../client-holder';
import { type RcuPacer, waitForRcuPacer, recordRcuPage, sleepRespectingSignal } from '../utils/rcu-pacing';
import type { ListOptions, ListResult } from './backend-query';
import { normalizeTags } from './key-generator';
import { type IndexLayer, type TagIndexItem, type TagIndexReadItem, type MemoryPath  } from './types';
import { InvariantViolationError } from '@/errors';

/** Native SDK request and retry response shapes. */
type BatchWriteRequest = NonNullable<NonNullable<BatchWriteCommandInput['RequestItems']>[string]>[number];
type BatchWriteItems = NonNullable<BatchWriteCommandOutput['UnprocessedItems']>;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;
const TAG_INDEX_WRITE_CONCURRENCY = 4;

/** Validate a retry response before handing it back to DynamoDB. */
function failedTagFromRequest(request: BatchWriteRequest, operation: 'put' | 'delete'): string {
    const rawPk: unknown = operation === 'put' ? request.PutRequest?.Item?.PK : request.DeleteRequest?.Key?.PK;
    // Stryker disable next-line llm: An empty string already fails the following TAG# prefix check.
    if(typeof rawPk !== 'string' || !rawPk.startsWith('TAG#')) {
        throw new InvariantViolationError('failedTagFromRequest', 'BatchWrite returned a failed request without a TAG# key');
    }
    return rawPk.slice(4);
}

function retryRequestItems(items: BatchWriteItems): NonNullable<BatchWriteCommandInput['RequestItems']> {
    const pending: NonNullable<BatchWriteCommandInput['RequestItems']> = {};
    // Stryker disable next-line llm: Callers pass either a request-map literal or UnprocessedItems with a nullish object fallback.
    for(const table of Object.keys(items)) {
        const requests = items[table];
        // Stryker disable next-line llm: BatchWriteItems values are arrays or undefined, never null.
        if(requests === undefined) {
            throw new InvariantViolationError('collectFailedRequests', 'unprocessedItems[tableName] undefined despite tableName from Object.keys()');
        }
        // Stryker disable next-line llm: The guard above narrows requests to an array, which is always truthy and already passes Array.isArray.
        pending[table] = requests;
    }
    return pending;
}

async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    context: string
): Promise<T | undefined> {
    for(let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop, each attempt depends on prior failure
            return await operation();
        } catch (error) {
            if(attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
                // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between attempts
                await new Promise((resolve) => {
                    setTimeout(resolve, delay);
                });
                logger.debug({ attempt, context, msg: `Tag index retry ${attempt}/${MAX_RETRIES}` });
                continue;
            }
            logger.warn({ error, context, msg: `Tag index operation failed after ${MAX_RETRIES} attempts` });
            return undefined;
        }
    }
    return undefined;
}

/**
 * Tag index operations for the memory tool backend.
 * Manages the tag index table with fat pointers carrying preview data.
 */
export class MemoryToolBackendTagIndex {
    private readonly getDocClient:    () => DynamoDBDocumentClient;
    private readonly onDriftDetected: (() => void) | undefined;

    constructor(
        docClientOrHolder: DynamoDBDocumentClient | DynamoDBClientHolder,
        private readonly tableName: string,
        onDriftDetected?: () => void
    ) {
        this.getDocClient = resolveDocClientGetter(docClientOrHolder);
        this.onDriftDetected = onDriftDetected;
    }

    /**
     * Splits an array into chunks of the given size.
     */
    private splitIntoBatches<T>(items: T[], size: number): T[][] {
        // Stryker disable next-line llm: items.slice.bind(items) invokes slice with the same receiver as the direct call; i is an Array.from index and size is 25 at every call site (slice truncates its bounds regardless), so Math.floor(i * size) is the identity; and multiplication is commutative, so size * i equals i * size
        return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
    }

    /**
     * Builds BatchWriteItem PutRequest entries for tag index items: one row per tag in
     * `normalizedTags`, each carrying `normalizedRowTags` (the memory's full tag set) as its
     * `tags` attribute, which multi-tag AND search and staleness checks both read.
     */
    private buildPutRequests(
        path: MemoryPath,
        normalizedTags: Set<string>,
        normalizedRowTags: Set<string>,
        updatedAt: string,
        contentPreview: string,
        layer: IndexLayer
    ): BatchWriteRequest[] {
        return [...normalizedTags].map(tag => ({
            PutRequest: {
                Item: {
                    PK:         `TAG#${tag}`,
                    SK:         `PATH#${path}`,
                    memoryPath: path,
                    layer,
                    updatedAt,
                    tags:       normalizedRowTags,
                    contentPreview,
                } satisfies TagIndexItem,
            },
        }));
    }

    /**
     * Executes BatchWriteCommand and retries unprocessed items with exponential backoff.
     * Returns the list of failed WriteRequests after all retries.
     */
    private async batchWriteWithRetry(requestItems: Record<string, BatchWriteRequest[]>): Promise<BatchWriteRequest[]> {
        let unprocessedItems: BatchWriteItems = requestItems;
        let attempt = 0;

        while(attempt < MAX_RETRIES) {
            const requestsToSend = retryRequestItems(unprocessedItems);
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB BatchWrite retry, each attempt depends on prior unprocessed items
                const result: BatchWriteCommandOutput = await this.getDocClient().send(new BatchWriteCommand({
                    RequestItems: requestsToSend,
                }));

                // Check if there are unprocessed items
                const hasUnprocessed = result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0;

                if(!hasUnprocessed) {
                    return [];
                }

                unprocessedItems = result.UnprocessedItems ?? {};
                attempt++;

                if(attempt < MAX_RETRIES) {
                    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
                    // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between batch write attempts
                    await new Promise((resolve) => {
                        setTimeout(resolve, delay);
                    });
                    logger.debug({ attempt, msg: `Batch write retry ${attempt}/${MAX_RETRIES}` });
                }
            } catch (error) {
                logger.warn({ error, msg: 'Batch write threw exception - treating current batch as failed' });
                // Return current unprocessed items as failed (items that succeeded in prior iterations are excluded)
                // Stryker disable next-line llm: BatchWriteItems values are WriteRequest[] whose elements are objects, so flat() and flat(2) produce the same list
                return (Object.values(unprocessedItems).flat());
            }
        }

        logger.warn({ unprocessedItems, msg: `Batch write failed after ${MAX_RETRIES} attempts` });

        // Flatten UnprocessedItems to array of WriteRequests
        const failedRequests: BatchWriteRequest[] = [];

        for(const tableName of Object.keys(unprocessedItems)) {
            const tableRequests = unprocessedItems[tableName];
            if(tableRequests === undefined) {
                throw new InvariantViolationError('collectFailedRequests', 'unprocessedItems[tableName] undefined despite tableName from Object.keys()');
            }
            // Stryker disable next-line ArrayMethodSwap: Downstream logic observes only length and set membership, not request order.
            failedRequests.push(...tableRequests);
        }

        return failedRequests;
    }

    /** Settle every in-flight batch, then report drift once for partial or malformed results. */
    private async writeBatchesAndCollectFailures(
        batches: BatchWriteRequest[][],
        path: MemoryPath,
        operation: 'createTagIndexItems' | 'deleteTagIndexItems' | 'refreshTagIndexItems'
    ): Promise<Set<string>> {
        const limit = pLimit(TAG_INDEX_WRITE_CONCURRENCY);
        const outcomes = await Promise.allSettled(batches.map(batch =>
            limit(async () => this.batchWriteWithRetry({ [this.tableName]: batch }))
        ));

        let failedRequests: BatchWriteRequest[];
        let failedTags: Set<string>;
        try {
            failedRequests = outcomes.flatMap((outcome) => {
                if(outcome.status === 'rejected') {
                    throw outcome.reason;
                }
                return outcome.value;
            });
            // Stryker disable next-line llm: failedTagFromRequest returns a scalar string, so flatMap and map are equivalent.
            failedTags = new Set(failedRequests.map(req => failedTagFromRequest(
                req, operation === 'deleteTagIndexItems' ? 'delete' : 'put'
            )));
        } catch (error) {
            logger.warn({ error, path, operation, msg: 'Invalid tag index BatchWrite response; scheduling reconciliation' });
            this.onDriftDetected?.();
            throw error;
        }

        if(failedRequests.length > 0) {
            this.onDriftDetected?.();
        }
        return failedTags;
    }

    /**
     * Increments atomic counters for the given tags.
     * Creates META_COUNT items if they don't exist.
     */
    async incrementTagCounts(tags: Set<string>): Promise<void> {
        const normalizedTags = normalizeTags(tags);
        const operations = [...normalizedTags].map(tag =>
            retryWithBackoff(
                async () => this.getDocClient().send(new UpdateCommand({
                    TableName: this.tableName,
                    Key:       {
                        PK: `TAG#${tag}`,
                        SK: 'META_COUNT',
                    },
                    UpdateExpression:          'SET #count = if_not_exists(#count, :zero) + :one, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
                    ExpressionAttributeNames:  { '#count': 'count' },
                    ExpressionAttributeValues: {
                        ':zero':   0,
                        ':one':    1,
                        ':gsi2pk': 'TAG_COUNTS',
                        ':gsi2sk': `TAG#${tag}`,
                    },
                })),
                `incrementTagCount:${tag}`
            ));

        // Stryker disable next-line PromiseCombinatorSwap: retryWithBackoff catches every rejection, so these operations cannot reject.
        await Promise.all(operations);
    }

    /**
     * Decrements atomic counters for the given tags.
     * Deletes META_COUNT items when count reaches 0 or below.
     */
    async decrementTagCounts(tags: Set<string>): Promise<void> {
        const normalizedTags = normalizeTags(tags);

        const operations = [...normalizedTags].map(async (tag) => {
            const result = await retryWithBackoff(
                async () => this.getDocClient().send(new UpdateCommand({
                    TableName: this.tableName,
                    Key:       {
                        PK: `TAG#${tag}`,
                        SK: 'META_COUNT',
                    },
                    UpdateExpression:          'SET #count = #count - :one',
                    ExpressionAttributeNames:  { '#count': 'count' },
                    ExpressionAttributeValues: { ':one': 1 },
                    ReturnValues:              'UPDATED_NEW',
                })),
                `decrementTagCount:${tag}`
            );

            // Delete META_COUNT item if count is 0 or negative
            if(result?.Attributes?.count !== null && result?.Attributes?.count !== undefined && (result.Attributes.count as number) <= 0) {
                await retryWithBackoff(
                    async () => this.getDocClient().send(new DeleteCommand({
                        TableName: this.tableName,
                        Key:       {
                            PK: `TAG#${tag}`,
                            SK: 'META_COUNT',
                        },
                        ConditionExpression:       '#count <= :zero',
                        ExpressionAttributeNames:  { '#count': 'count' },
                        ExpressionAttributeValues: { ':zero': 0 },
                    })),
                    `deleteMetaCount:${tag}`
                );
            }
        });

        // Stryker disable next-line PromiseCombinatorSwap: retryWithBackoff catches every rejection, so these operations cannot reject.
        await Promise.all(operations);
    }

    /**
     * Lists all tag counts by querying GSI2.
     * Returns tags sorted by name.
     *
     * `pacing`, when given, requests `ReturnConsumedCapacity` and paces a continuing page against
     * the shared `pacer` at `rateLimitRcuPerSec` (the memory-tool reconciler's Phase C uses this to
     * share its GSI2 pacing debt with Phase A/B's own GSI2 reads). Omitted (the default, used by
     * the live list-tags MCP tool), behaviour is unchanged: no ConsumedCapacity requested, no pacing.
     * `pacing.signal`, when given, cancels promptly: it aborts the pacing sleep itself (rather than
     * waiting out the full owed delay) and is also checked immediately before every page's query,
     * including the first, so cancellation during a page with no debt owed still takes effect.
     * @throws {Error} When `pacing` is given and a continuing page omits ConsumedCapacity.
     * @throws {DOMException} Named `AbortError`, when `pacing.signal` aborts before or during a page.
     */
    async listTagCounts(pacing?: { pacer: RcuPacer, rateLimitRcuPerSec: number, signal?: AbortSignal }): Promise<{ tag: string, count: number }[]> {
        const results: { tag: string, count: number }[] = [];
        let exclusiveStartKey: Record<string, unknown> | undefined;

        do {
            if(pacing) {
                // eslint-disable-next-line no-await-in-loop -- sequential: pacing wait depends on the previous page's reported capacity
                await waitForRcuPacer(pacing.pacer, () => Date.now(), ms => sleepRespectingSignal(ms, pacing.signal));
                if(pacing.signal?.aborted) {
                    throw new DOMException('Aborted', 'AbortError');
                }
            }

            const queryParams: Record<string, unknown> = {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
                ExclusiveStartKey:         exclusiveStartKey,
                ...(pacing ? { ReturnConsumedCapacity: 'TOTAL' as const } : {}),
            };

            // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop depends on prior response cursor
            const result = await this.getDocClient().send(new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            }));

            // Stryker disable next-line llm: Query Items is array-or-undefined, so nullish and falsy fallbacks are equivalent.
            const items = result.Items ?? [];
            for(const item of items) {
                // Extract tag from GSI2SK: 'TAG#tagname' -> 'tagname'
                const gsi2sk = item.GSI2SK as string;
                const tag = gsi2sk.slice(4); // Remove 'TAG#' prefix
                const count = item.count as number;
                // Stryker disable next-line ArrayMethodSwap: The returned array is freshly sorted, so construction order is unobservable.
                results.push({ tag, count });
            }

            exclusiveStartKey = result.LastEvaluatedKey;

            if(pacing) {
                recordRcuPage(
                    pacing.pacer,
                    result.ConsumedCapacity?.CapacityUnits,
                    pacing.rateLimitRcuPerSec,
                    Boolean(exclusiveStartKey),
                    () => {
                        throw new Error('listTagCounts reported no ConsumedCapacity on a continuing page; refusing to continue without RCU pacing');
                    }
                );
            }
        } while(exclusiveStartKey);

        // Sort by tag name
        return results.toSorted((a, b) => a.tag.localeCompare(b.tag));
    }

    /**
     * Creates tag index items for a memory path.
     * Each tag in `tags` gets its own index entry with full preview data; `allTags` is the
     * memory's full tag set stored on every row (defaults to `tags`, i.e. writing every row).
     */
    async createTagIndexItems(
        path: MemoryPath,
        tags: Set<string>,
        updatedAt: string,
        contentPreview: string,
        layer: IndexLayer,
        allTags: Set<string> = tags
    ): Promise<void> {
        const normalizedTags = normalizeTags(tags);

        // Build write requests for tag index items
        const writeRequests = this.buildPutRequests(path, normalizedTags, normalizeTags(allTags), updatedAt, contentPreview, layer);

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = this.splitIntoBatches(writeRequests, 25);

        // A malformed retry response may follow partial writes, so validate before updating counts.
        const failedTags = await this.writeBatchesAndCollectFailures(batches, path, 'createTagIndexItems');

        // Only increment counts for tags that succeeded
        const succeededTags = new Set([...normalizedTags].filter(t => !failedTags.has(t)));
        await this.incrementTagCounts(succeededTags);
    }

    /**
     * Deletes tag index items for a memory path.
     */
    async deleteTagIndexItems(path: MemoryPath, tags: Set<string>): Promise<void> {
        const normalizedTags = normalizeTags(tags);

        // Build delete requests for tag index items
        const writeRequests: BatchWriteRequest[] = [...normalizedTags].map(tag => ({
            DeleteRequest: {
                Key: {
                    PK: `TAG#${tag}`,
                    SK: `PATH#${path}`,
                },
            },
        }));

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = this.splitIntoBatches(writeRequests, 25);

        // A malformed retry response may follow partial deletes, so validate before updating counts.
        const failedTags = await this.writeBatchesAndCollectFailures(batches, path, 'deleteTagIndexItems');

        // Only decrement counts for tags that succeeded
        const succeededTags = new Set([...normalizedTags].filter(t => !failedTags.has(t)));
        await this.decrementTagCounts(succeededTags);
    }

    /**
     * Refreshes tag index items without changing counts.
     * Used to update preview data for unchanged tags. Only the rows for `tags` are rewritten;
     * each carries `allTags`, the memory's full tag set (defaults to `tags`).
     */
    async refreshTagIndexItems(
        path: MemoryPath,
        tags: Set<string>,
        updatedAt: string,
        contentPreview: string,
        layer: IndexLayer,
        allTags: Set<string> = tags
    ): Promise<void> {
        const normalizedTags = normalizeTags(tags);

        // Build write requests for tag index items
        const writeRequests = this.buildPutRequests(path, normalizedTags, normalizeTags(allTags), updatedAt, contentPreview, layer);

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = this.splitIntoBatches(writeRequests, 25);

        // Refresh does not change counts, but a partial or malformed write still needs repair.
        await this.writeBatchesAndCollectFailures(batches, path, 'refreshTagIndexItems');
    }

    /**
     * Updates tag index items when tags change.
     * Computes diff and creates/deletes/refreshes as needed.
     */
    async updateTagIndexItems(
        path: MemoryPath,
        oldTags: Set<string>,
        newTags: Set<string>,
        updatedAt: string,
        contentPreview: string,
        layer: IndexLayer
    ): Promise<void> {
        const normalizedOld = normalizeTags(oldTags);
        const normalizedNew = normalizeTags(newTags);

        const added = new Set([...normalizedNew].filter(t => !normalizedOld.has(t)));
        const removed = new Set([...normalizedOld].filter(t => !normalizedNew.has(t)));
        const unchanged = new Set([...normalizedOld].filter(t => normalizedNew.has(t)));

        // Execute all operations in parallel
        await Promise.all([
            // Create items for added tags (increments counts); every row carries the full new tag set
            this.createTagIndexItems(path, added, updatedAt, contentPreview, layer, normalizedNew),
            // Delete items for removed tags (decrements counts)
            this.deleteTagIndexItems(path, removed),
            // Refresh unchanged tags with current data (no count change)
            this.refreshTagIndexItems(path, unchanged, updatedAt, contentPreview, layer, normalizedNew),
        ]);
    }

    /**
     * Decodes a base64-encoded pagination cursor to a DynamoDB ExclusiveStartKey.
     * Returns undefined and logs a warning if the cursor is malformed or has an unexpected shape.
     */
    private parseCursor(cursor: string): Record<string, unknown> | undefined {
        let parsed: unknown;
        try {
            parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        } catch (err) {
            logger.warn({ err, cursor }, 'Malformed pagination cursor — skipping ExclusiveStartKey; query will restart from the beginning');
            return undefined;
        }
        const cursorSchema = z.record(z.string(), z.unknown());
        const cursorResult = cursorSchema.safeParse(parsed);
        if(!cursorResult.success) {
            // Stryker disable next-line llm: err is only the logger.warn diagnostic payload; error.issues and the ZodError itself carry the same information and the skip-ExclusiveStartKey behaviour is identical
            logger.warn({ err: cursorResult.error.issues, cursor }, 'Invalid cursor shape — skipping ExclusiveStartKey; query will restart from the beginning');
            return undefined;
        }
        return cursorResult.data;
    }

    /**
     * Queries tag index by a single tag.
     */

    async queryByTag(
        tag: string,
        layer?: IndexLayer,
        options?: ListOptions
    ): Promise<ListResult<TagIndexReadItem>> {
        const normalizedTag = [...normalizeTags(new Set([tag]))][0];
        const pk = `TAG#${normalizedTag}`;

        const queryParams: Record<string, unknown> = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: { ':pk': pk, ':skPrefix': 'PATH#' },
        };

        // Build FilterExpression for layer and date filters
        const filterExpressions: string[] = [];
        const expressionValues: Record<string, string> = { ':pk': pk, ':skPrefix': 'PATH#' };

        if(layer) {
            // Stryker disable next-line ArrayMethodSwap: This is the first write to a freshly empty array, making push and unshift identical.
            filterExpressions.push('layer = :layer');
            expressionValues[':layer'] = layer;
        }

        if(options?.startDate ?? options?.endDate) {
            const startDate = options.startDate ?? '1970-01-01T00:00:00.000Z';
            const endDate = options.endDate ?? '9999-12-31T23:59:59.999Z';
            filterExpressions.push('updatedAt BETWEEN :startDate AND :endDate');
            expressionValues[':startDate'] = startDate;
            expressionValues[':endDate'] = endDate;
        }

        if(filterExpressions.length > 0) {
            queryParams.FilterExpression = filterExpressions.join(' AND ');
            queryParams.ExpressionAttributeValues = expressionValues;
        }

        // Apply pagination options
        if(options?.limit) {
            queryParams.Limit = options.limit;
        }
        if(options?.cursor) {
            // parseCursor returns undefined for malformed/wrong-shape JSON (after logging a warning) — skip ExclusiveStartKey in that case
            // Stryker disable next-line llm: The enclosing truthiness guard guarantees a non-nullish cursor.
            const parsedKey = this.parseCursor(options.cursor);
            queryParams.ExclusiveStartKey = parsedKey;
        }

        const result = await this.getDocClient().send(new QueryCommand({
            TableName: this.tableName,
            ...queryParams,
        }));

        const items = (result.Items ?? []) as TagIndexReadItem[];
        const nextCursor = result.LastEvaluatedKey
            ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
            : undefined;

        return { items, nextCursor };
    }

    /**
     * Queries tag index by multiple tags (AND semantics).
     * Pages through results until limit is filled or data is exhausted.
     * Note: Multi-tag queries do not support cursors to avoid losing trimmed items at page boundaries.
     */
    async queryByTags(
        tags: string[],
        layer?: IndexLayer,
        options?: ListOptions
    ): Promise<ListResult<TagIndexReadItem>> {
        if(tags.length === 0) {
            return { items: [] };
        }

        const normalizedTagsSet = normalizeTags(new Set(tags));
        const normalizedTags = [...normalizedTagsSet];

        // Stryker disable next-line llm: A non-empty input stays non-empty after lowercase normalization and deduplication.
        if(normalizedTags.length === 1) {
            const singleTag = normalizedTags[0]!;
            return this.queryByTag(singleTag, layer, options);
        }

        const requestedLimit = options?.limit;
        const collectedItems: TagIndexReadItem[] = [];
        let currentCursor = options?.cursor;

        // Page through driving tag results until limit filled or data exhausted
        do {
            const drivingTag = normalizedTags[0]!;
            // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop
            const pageResult = await this.queryByTag(drivingTag, layer, {
                ...options,
                cursor: currentCursor,
                limit:  undefined, // Don't limit individual pages — we filter
            });

            // Guard against stale index rows by verifying every requested tag.
            const matching = pageResult.items.filter(item =>
                normalizedTags.every(tag => item.tags.has(tag)));
            collectedItems.push(...matching);

            // Update cursor for next page
            // Stryker disable next-line llm: A falsy next cursor immediately breaks before currentCursor can be read again.
            currentCursor = pageResult.nextCursor;

            // Stop if no more pages or we've collected enough
            if(!pageResult.nextCursor || (requestedLimit && collectedItems.length >= requestedLimit)) {
                break;
            }
            // eslint-disable-next-line no-constant-condition -- Intentional infinite loop with break
        } while(true);

        // Trim to limit
        const items = requestedLimit ? collectedItems.slice(0, requestedLimit) : collectedItems;

        // Multi-tag queries do not return a cursor to avoid losing trimmed items at page boundaries
        return { items, nextCursor: undefined };
    }
}
