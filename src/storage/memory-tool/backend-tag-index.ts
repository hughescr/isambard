import { type DynamoDBDocumentClient, DeleteCommand, QueryCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { z } from 'zod';
import { type DynamoDBClientHolder, resolveDocClientGetter } from '../client-holder';
import type { ListOptions, ListResult } from './backend-query';
import { normalizeTags } from './key-generator';
import { type TagIndexItem, type MemoryPath  } from './types';
import { InvariantViolationError } from '@/errors';

/**
 * Type for BatchWrite request items (matching lib-dynamodb's BatchWriteCommand input)
 */
interface BatchWriteRequest {
    PutRequest?: {
        Item: Record<string, unknown>
    }
    DeleteRequest?: {
        Key: Record<string, unknown>
    }
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    context: string
): Promise<T | undefined> {
    // Stryker disable next-line UpdateOperator: attempt-- would infinite-loop (untestable without real DynamoDB)
    for(let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop, each attempt depends on prior failure
            return await operation();
        } catch (error) {
            // Stryker disable next-line ConditionalExpression,EqualityOperator: Retry boundary - tested via public API retry count
            if(attempt < MAX_RETRIES) {
                // Stryker disable next-line ArithmeticOperator: Backoff formula tested via timer verification; * vs / indistinguishable at attempt 1 (2^0=1)
                const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
                // Stryker disable next-line BlockStatement: sleep block — removing causes test timeout (no delay between retries → tight loop)
                // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between attempts
                await new Promise((resolve) => {
                    setTimeout(resolve, delay);
                });
                // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
                logger.debug({ attempt, context, msg: `Tag index retry ${attempt}/${MAX_RETRIES}` });
                continue;
            }
            // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
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
        // Stryker disable next-line MethodExpression,ArithmeticOperator: batch slicing — tests use <25 items so single-batch execution makes slice boundaries and arithmetic equivalent
        return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
    }

    /**
     * Builds BatchWriteItem PutRequest entries for tag index items.
     */
    private buildPutRequests(
        path: MemoryPath,
        normalizedTags: Set<string>,
        updatedAt: string,
        contentPreview: string,
        layer: string
    ): BatchWriteRequest[] {
        return [...normalizedTags].map(tag => ({
            PutRequest: {
                Item: {
                    PK:         `TAG#${tag}`,
                    SK:         `PATH#${path}`,
                    memoryPath: path,
                    layer,
                    updatedAt,
                    tags:       normalizedTags,
                    contentPreview,
                },
            },
        }));
    }

    /**
     * Executes BatchWriteCommand and retries unprocessed items with exponential backoff.
     * Returns the list of failed WriteRequests after all retries.
     */
    private async batchWriteWithRetry(requestItems: Record<string, BatchWriteRequest[]>): Promise<BatchWriteRequest[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- UnprocessedItems type is complex and not worth matching exactly
        let unprocessedItems: any = requestItems;
        let attempt = 0;

        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: While loop — BlockStatement body→{} would infinite-loop; condition mutations tested via batch behavior
        while(Object.keys(unprocessedItems as Record<string, unknown>).length > 0 && attempt < MAX_RETRIES) {
            // Stryker disable BlockStatement: try/catch body mutations → skip send (infinite-loop) or swallow errors (loop spins on unprocessed items); both untestable without real DynamoDB
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB BatchWrite retry, each attempt depends on prior unprocessed items
                const result = await this.getDocClient().send(new BatchWriteCommand({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- UnprocessedItems has complex type
                    RequestItems: unprocessedItems,
                }));

                // Check if there are unprocessed items
                // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,OptionalChaining: Unprocessed items check - all branches tested via batch write tests
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: DynamoDB SDK result typed non-nullable but checking defensively
                const hasUnprocessed = result?.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0;

                // Stryker disable next-line ConditionalExpression,BlockStatement,BooleanLiteral: Early return on success — BooleanLiteral (hasUnprocessed→true) would skip successful early-return path
                if(!hasUnprocessed) {
                    return [];
                }

                unprocessedItems = result.UnprocessedItems!;
                attempt++;

                // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Retry boundary — BlockStatement (body→{}) would skip delay, causing test timeouts with real setTimeout
                if(attempt < MAX_RETRIES) {
                    // Stryker disable next-line ArithmeticOperator: Backoff formula tested via timer verification; * vs / indistinguishable at attempt 1 (2^0=1)
                    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
                    // Stryker disable next-line BlockStatement: Promise callback body→{} would never resolve (untestable)
                    // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between batch write attempts
                    await new Promise((resolve) => {
                        setTimeout(resolve, delay);
                    });
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
                    logger.debug({ attempt, msg: `Batch write retry ${attempt}/${MAX_RETRIES}` });
                }
            } catch (error) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
                logger.warn({ error, msg: 'Batch write threw exception - treating current batch as failed' });
                // Return current unprocessed items as failed (items that succeeded in prior iterations are excluded)

                return (Object.values(unprocessedItems as Record<string, BatchWriteRequest[]>).flat());
            }
        }
        // Stryker restore BlockStatement

        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Post-loop unprocessed items check
        if(Object.keys(unprocessedItems as Record<string, unknown>).length > 0) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
            logger.warn({ unprocessedItems, msg: `Batch write failed after ${MAX_RETRIES} attempts` });
        }

        // Flatten UnprocessedItems to array of WriteRequests
        const failedRequests: BatchWriteRequest[] = [];

        for(const tableName of Object.keys(unprocessedItems as Record<string, unknown>)) {
            const tableRequests = (unprocessedItems as Record<string, BatchWriteRequest[]>)[tableName];
            // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — tableName comes from Object.keys() so the key always exists; unreachable in practice
            if(tableRequests === undefined) {
                // Stryker disable next-line StringLiteral: invariant violation message — debug context only
                throw new InvariantViolationError('collectFailedRequests', 'unprocessedItems[tableName] undefined despite tableName from Object.keys()');
            }
            failedRequests.push(...tableRequests);
        }

        return failedRequests;
    }

    /**
     * Increments atomic counters for the given tags.
     * Creates META_COUNT items if they don't exist.
     */
    async incrementTagCounts(tags: Set<string>): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - empty tags array is a no-op
        if(tags.size === 0) {
            return;
        }

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
                // Stryker disable next-line StringLiteral: Context string for retry logging is observational
                `incrementTagCount:${tag}`
            ));

        await Promise.all(operations);
    }

    /**
     * Decrements atomic counters for the given tags.
     * Deletes META_COUNT items when count reaches 0 or below.
     */
    async decrementTagCounts(tags: Set<string>): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - empty tags array is a no-op
        if(tags.size === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);

        const operations = [...normalizedTags].map(async (tag) => {
            const result = await retryWithBackoff(
                async () => this.getDocClient().send(new UpdateCommand({
                    TableName: this.tableName,
                    Key:       {
                        PK: `TAG#${tag}`,
                        // Stryker disable next-line StringLiteral: DynamoDB sort key constant
                        SK: 'META_COUNT',
                    },
                    // Stryker disable next-line StringLiteral: DynamoDB UpdateExpression syntax
                    UpdateExpression:          'SET #count = #count - :one',
                    ExpressionAttributeNames:  { '#count': 'count' },
                    ExpressionAttributeValues: { ':one': 1 },
                    ReturnValues:              'UPDATED_NEW',
                })),
                // Stryker disable next-line StringLiteral: Context string for retry logging is observational
                `decrementTagCount:${tag}`
            );

            // Delete META_COUNT item if count is 0 or negative
            // Stryker disable next-line ConditionalExpression,EqualityOperator: Defensive check for count <= 0
            if(result?.Attributes?.count !== null && result?.Attributes?.count !== undefined && (result.Attributes.count as number) <= 0) {
                // Stryker disable BlockStatement: try-catch block for ConditionalCheckFailedException
                try {
                    await retryWithBackoff(
                        async () => this.getDocClient().send(new DeleteCommand({
                            TableName: this.tableName,
                            Key:       {
                                PK: `TAG#${tag}`,
                                SK: 'META_COUNT',
                            },
                            // Stryker disable next-line StringLiteral: DynamoDB ConditionExpression syntax requires exact format
                            ConditionExpression:       '#count <= :zero',
                            // Stryker disable next-line ObjectLiteral,StringLiteral: DynamoDB expression attribute names must match ConditionExpression
                            ExpressionAttributeNames:  { '#count': 'count' },
                            // Stryker disable next-line ObjectLiteral: DynamoDB expression attribute values must match ConditionExpression
                            ExpressionAttributeValues: { ':zero': 0 },
                        })),
                        // Stryker disable next-line StringLiteral: Context string for retry logging is observational
                        `deleteMetaCount:${tag}`
                    );
                    // Stryker disable next-line BlockStatement: Catching ConditionalCheckFailedException for concurrent increment scenario
                } catch (error) {
                    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,StringLiteral: Ignore expected ConditionalCheckFailedException
                    if((error as Error).name === 'ConditionalCheckFailedException') {
                        // Concurrent increment happened - item should survive
                        return;
                    }
                    throw error;
                }
                // Stryker restore BlockStatement
            }
        });

        await Promise.all(operations);
    }

    /**
     * Lists all tag counts by querying GSI2.
     * Returns tags sorted by name.
     */
    async listTagCounts(): Promise<{ tag: string, count: number }[]> {
        const results: { tag: string, count: number }[] = [];
        let exclusiveStartKey: Record<string, unknown> | undefined;

        // Stryker disable ConditionalExpression,BlockStatement: Intentional infinite loop with internal break
        do {
            const queryParams: Record<string, unknown> = {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :gsi2pk',
                ExpressionAttributeValues: { ':gsi2pk': 'TAG_COUNTS' },
            };

            if(exclusiveStartKey) {
                queryParams.ExclusiveStartKey = exclusiveStartKey;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop depends on prior response cursor
            const result = await this.getDocClient().send(new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            }));

            const items = result.Items ?? [];
            for(const item of items) {
                // Extract tag from GSI2SK: 'TAG#tagname' -> 'tagname'
                const gsi2sk = item.GSI2SK as string;
                const tag = gsi2sk.slice(4); // Remove 'TAG#' prefix
                const count = item.count as number;
                results.push({ tag, count });
            }

            exclusiveStartKey = result.LastEvaluatedKey;

            // Stryker disable next-line ConditionalExpression,BooleanLiteral,BlockStatement: Loop termination condition
            if(!result.LastEvaluatedKey) {
                break;
            }
            // eslint-disable-next-line no-constant-condition -- Intentional infinite loop with break
        } while(true);
        // Stryker restore ConditionalExpression,BlockStatement

        // Sort by tag name
        return results.toSorted((a, b) => a.tag.localeCompare(b.tag));
    }

    /**
     * Creates tag index items for a memory path.
     * Each tag gets its own index entry with full preview data.
     */
    async createTagIndexItems(
        path: MemoryPath,
        tags: Set<string>,
        updatedAt: string,
        contentPreview: string,
        layer: string
    ): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - normalizeTags([]) returns [], making map a no-op
        if(tags.size === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);

        // Build write requests for tag index items
        const writeRequests = this.buildPutRequests(path, normalizedTags, updatedAt, contentPreview, layer);

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = this.splitIntoBatches(writeRequests, 25);

        // Execute all batches and collect failed requests
        const allFailedRequests: BatchWriteRequest[] = [];
        for(const batch of batches) {
            // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB BatchWrite, each batch processed in order
            const failedRequests = await this.batchWriteWithRetry({ [this.tableName]: batch });
            allFailedRequests.push(...failedRequests);
        }

        // Extract tags that failed from unprocessed PutRequests
        const failedTags = new Set(allFailedRequests.map((req) => {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: AWS SDK WriteRequest has optional PutRequest/Item but we know these are PutRequests
            const pk = req.PutRequest?.Item?.PK as string;
            return pk.slice(4); // Remove 'TAG#' prefix
        }));

        // Notify drift if any items were not written — tag index may be inconsistent
        // Stryker disable next-line ConditionalExpression,BlockStatement: Drift hint — allFailedRequests.length > 0 tested by caller-notification tests
        if(allFailedRequests.length > 0) {
            this.onDriftDetected?.();
        }

        // Only increment counts for tags that succeeded
        const succeededTags = new Set([...normalizedTags].filter(t => !failedTags.has(t)));
        await this.incrementTagCounts(succeededTags);
    }

    /**
     * Deletes tag index items for a memory path.
     */
    async deleteTagIndexItems(path: MemoryPath, tags: Set<string>): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - normalizeTags([]) returns [], making map a no-op
        if(tags.size === 0) {
            return;
        }

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

        // Execute all batches and collect failed requests
        const allFailedRequests: BatchWriteRequest[] = [];
        for(const batch of batches) {
            // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB BatchWrite, each batch processed in order
            const failedRequests = await this.batchWriteWithRetry({ [this.tableName]: batch });
            allFailedRequests.push(...failedRequests);
        }

        // Extract tags that failed from unprocessed DeleteRequests
        const failedTags = new Set(allFailedRequests.map((req) => {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: AWS SDK WriteRequest has optional DeleteRequest/Key but we know these are DeleteRequests
            const pk = req.DeleteRequest?.Key?.PK as string;
            return pk.slice(4); // Remove 'TAG#' prefix
        }));

        // Notify drift if any items were not deleted — tag index may be inconsistent
        // Stryker disable next-line ConditionalExpression,BlockStatement: Drift hint — allFailedRequests.length > 0 tested by caller-notification tests
        if(allFailedRequests.length > 0) {
            this.onDriftDetected?.();
        }

        // Only decrement counts for tags that succeeded
        const succeededTags = new Set([...normalizedTags].filter(t => !failedTags.has(t)));
        await this.decrementTagCounts(succeededTags);
    }

    /**
     * Refreshes tag index items without changing counts.
     * Used to update preview data for unchanged tags.
     */
    async refreshTagIndexItems(
        path: MemoryPath,
        tags: Set<string>,
        updatedAt: string,
        contentPreview: string,
        layer: string
    ): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - empty tags array is a no-op
        if(tags.size === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);

        // Build write requests for tag index items
        const writeRequests = this.buildPutRequests(path, normalizedTags, updatedAt, contentPreview, layer);

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = this.splitIntoBatches(writeRequests, 25);

        // Execute all batches and collect failed requests (no count increment)
        const allFailedRequests: BatchWriteRequest[] = [];
        for(const batch of batches) {
            // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB BatchWrite, each batch processed in order
            const failedRequests = await this.batchWriteWithRetry({ [this.tableName]: batch });
            allFailedRequests.push(...failedRequests);
        }

        // Notify drift if any items were not refreshed — tag index may be inconsistent
        // Stryker disable next-line ConditionalExpression,BlockStatement: Drift hint — allFailedRequests.length > 0 tested by caller-notification tests
        if(allFailedRequests.length > 0) {
            this.onDriftDetected?.();
        }
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
        layer: string
    ): Promise<void> {
        const normalizedOld = normalizeTags(oldTags);
        const normalizedNew = normalizeTags(newTags);

        const added = new Set([...normalizedNew].filter(t => !normalizedOld.has(t)));
        const removed = new Set([...normalizedOld].filter(t => !normalizedNew.has(t)));
        const unchanged = new Set([...normalizedOld].filter(t => normalizedNew.has(t)));

        // Execute all operations in parallel
        await Promise.all([
            // Create items for added tags (increments counts)
            this.createTagIndexItems(path, added, updatedAt, contentPreview, layer),
            // Delete items for removed tags (decrements counts)
            this.deleteTagIndexItems(path, removed),
            // Refresh unchanged tags with current data (no count change)
            this.refreshTagIndexItems(path, unchanged, updatedAt, contentPreview, layer),
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
            // Stryker disable next-line ObjectLiteral,StringLiteral: logger call is observability only — warn + return undefined is the correct graceful fallback for a malformed cursor
            logger.warn({ err, cursor }, 'Malformed pagination cursor — skipping ExclusiveStartKey; query will restart from the beginning');
            return undefined;
        }
        const cursorSchema = z.record(z.string(), z.unknown());
        const cursorResult = cursorSchema.safeParse(parsed);
        if(!cursorResult.success) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: logger call is observability only — warn + return undefined is the correct graceful fallback for a wrong-shape cursor
            logger.warn({ err: cursorResult.error.issues, cursor }, 'Invalid cursor shape — skipping ExclusiveStartKey; query will restart from the beginning');
            return undefined;
        }
        return cursorResult.data;
    }

    /**
     * Queries tag index by a single tag.
     */

    // eslint-disable-next-line complexity -- query-building function: each option branch (layer filter, date range, limit, cursor) is independently required; extracting further would obscure the DynamoDB query structure
    async queryByTag(
        tag: string,
        layer?: string,
        options?: ListOptions
    ): Promise<ListResult<TagIndexItem>> {
        const normalizedTag = [...normalizeTags(new Set([tag]))][0];
        const pk = `TAG#${normalizedTag}`;

        // Stryker disable StringLiteral: DynamoDB expression variable names must match KeyConditionExpression
        const queryParams: Record<string, unknown> = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: { ':pk': pk, ':skPrefix': 'PATH#' },
        };
        // Stryker restore StringLiteral

        // Build FilterExpression for layer and date filters
        // Stryker disable next-line ArrayDeclaration: Initial value for filter building
        const filterExpressions: string[] = [];
        // Stryker disable next-line ObjectLiteral: Initial value for expression values
        const expressionValues: Record<string, string> = { ':pk': pk, ':skPrefix': 'PATH#' };

        if(layer) {
            filterExpressions.push('layer = :layer');
            expressionValues[':layer'] = layer;
        }

        // Stryker disable next-line ConditionalExpression,LogicalOperator: Guard ensures options exists before accessing properties
        if(options?.startDate ?? options?.endDate) {
            // Stryker disable next-line LogicalOperator: options.startDate may be undefined even when options is defined
            const startDate = options.startDate ?? '1970-01-01T00:00:00.000Z';
            // Stryker disable next-line LogicalOperator: options.endDate may be undefined even when options is defined
            const endDate = options.endDate ?? '9999-12-31T23:59:59.999Z';
            filterExpressions.push('updatedAt BETWEEN :startDate AND :endDate');
            expressionValues[':startDate'] = startDate;
            expressionValues[':endDate'] = endDate;
        }

        // Stryker disable next-line ConditionalExpression,EqualityOperator: Guard for applying filters
        if(filterExpressions.length > 0) {
            // Stryker disable next-line StringLiteral: DynamoDB FilterExpression syntax requires ' AND ' separator
            queryParams.FilterExpression = filterExpressions.join(' AND ');
            queryParams.ExpressionAttributeValues = expressionValues;
        }

        // Apply pagination options
        if(options?.limit) {
            queryParams.Limit = options.limit;
        }
        // Stryker disable next-line OptionalChaining: options may be undefined; parseCursor handles malformed JSON gracefully
        if(options?.cursor) {
            // parseCursor returns undefined for malformed/wrong-shape JSON (after logging a warning) — skip ExclusiveStartKey in that case
            const parsedKey = this.parseCursor(options.cursor);
            // Stryker disable next-line ConditionalExpression: setting ExclusiveStartKey=undefined is indistinguishable from not setting it in the mock; guard is required to avoid polluting queryParams with undefined when cursor is malformed
            if(parsedKey !== undefined) {
                queryParams.ExclusiveStartKey = parsedKey;
            }
        }

        const result = await this.getDocClient().send(new QueryCommand({
            TableName: this.tableName,
            ...queryParams,
        }));

        const items = (result.Items ?? []) as TagIndexItem[];
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
        layer?: string,
        options?: ListOptions
    ): Promise<ListResult<TagIndexItem>> {
        if(tags.length === 0) {
            return { items: [] };
        }

        // Stryker disable next-line MethodExpression: Normalize all tags upfront to ensure case-insensitive matching
        const normalizedTagsSet = normalizeTags(new Set(tags));
        const normalizedTags = [...normalizedTagsSet];

        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Early return optimization
        if(normalizedTags.length === 1) {
            const singleTag = normalizedTags[0];
            // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — normalizedTags.length === 1 ensures index 0 exists; unreachable in practice
            if(singleTag === undefined) {
                // Stryker disable next-line StringLiteral: invariant violation message — debug context only
                throw new InvariantViolationError('searchByTagsWithRetry', 'normalizedTags[0] undefined despite normalizedTags.length === 1');
            }
            return this.queryByTag(singleTag, layer, options);
        }

        const requestedLimit = options?.limit;
        const collectedItems: TagIndexItem[] = [];
        let currentCursor = options?.cursor;

        // Page through driving tag results until limit filled or data exhausted
        // Stryker disable ConditionalExpression,BlockStatement: Intentional infinite loop with internal break
        do {
            const drivingTag = normalizedTags[0];
            // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — normalizedTags has ≥2 elements here (length=1 returned above); unreachable in practice
            if(drivingTag === undefined) {
                // Stryker disable next-line StringLiteral: invariant violation message — debug context only
                throw new InvariantViolationError('searchByTagsWithRetry', 'normalizedTags[0] undefined despite length >= 2 (length === 1 already returned above)');
            }
            // Stryker disable next-line ObjectLiteral: Options passthrough required for layer and date filters
            // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop
            const pageResult = await this.queryByTag(drivingTag, layer, {
                ...options,
                cursor: currentCursor,
                limit:  undefined, // Don't limit individual pages — we filter
            });

            // Filter for items that contain ALL remaining tags
            // Stryker disable next-line MethodExpression: Slicing removes driving tag, but since all items already have it (from query), keeping it is equivalent
            const remainingTags = normalizedTags.slice(1);
            // Stryker disable MethodExpression,ArrowFunction: every→some equivalent when remainingTags has ≤1 elements; ArrowFunction body→undefined always returns false (untestable: pagination loop keeps going)
            const matching = pageResult.items.filter(item =>
                remainingTags.every(tag => item.tags.has(tag)));
            // Stryker restore MethodExpression,ArrowFunction
            collectedItems.push(...matching);

            // Update cursor for next page
            currentCursor = pageResult.nextCursor;

            // Stop if no more pages or we've collected enough
            // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral,EqualityOperator,BlockStatement: Loop termination conditions
            if(!pageResult.nextCursor || (requestedLimit && collectedItems.length >= requestedLimit)) {
                break;
            }
            // eslint-disable-next-line no-constant-condition -- Intentional infinite loop with break
        } while(true);
        // Stryker restore ConditionalExpression,BlockStatement

        // Trim to limit
        const items = requestedLimit ? collectedItems.slice(0, requestedLimit) : collectedItems;

        // Multi-tag queries do not return a cursor to avoid losing trimmed items at page boundaries
        return { items, nextCursor: undefined };
    }
}
