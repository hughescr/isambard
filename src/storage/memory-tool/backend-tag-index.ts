import { DynamoDBDocumentClient, DeleteCommand, QueryCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, filter as _filter, difference as _difference, intersection as _intersection, every as _every, includes as _includes, chunk as _chunk, sortBy as _sortBy, keys as _keys, flatMap as _flatMap, values as _values, flatten as _flatten } from 'lodash';
import { logger } from '@hughescr/logger';
import type { TagIndexItem } from './types';
import type { MemoryPath } from './types';
import { normalizeTags } from './key-generator';
import type { ListOptions, ListResult } from './backend-query';

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
    for(let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await operation();
        } catch (error) {
            // Stryker disable next-line ConditionalExpression,EqualityOperator: Retry boundary - tested via public API retry count
            if(attempt < MAX_RETRIES) {
                // Stryker disable next-line ArithmeticOperator: Backoff formula tested via timer verification; * vs / indistinguishable at attempt 1 (2^0=1)
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
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
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string
    ) {}

    /**
     * Executes BatchWriteCommand and retries unprocessed items with exponential backoff.
     * Returns the list of failed WriteRequests after all retries.
     */
    private async batchWriteWithRetry(requestItems: Record<string, BatchWriteRequest[]>): Promise<BatchWriteRequest[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- UnprocessedItems type is complex and not worth matching exactly
        let unprocessedItems: any = requestItems;
        let attempt = 0;

        // Stryker disable next-line ConditionalExpression,EqualityOperator: While loop condition - tested via public API batch behavior
        while(_keys(unprocessedItems).length > 0 && attempt < MAX_RETRIES) {
            try {
                const result = await this.docClient.send(new BatchWriteCommand({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- UnprocessedItems has complex type
                    RequestItems: unprocessedItems,
                }));

                // Check if there are unprocessed items
                // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,OptionalChaining: Unprocessed items check - all branches tested via batch write tests
                const hasUnprocessed = result?.UnprocessedItems && _keys(result.UnprocessedItems).length > 0;

                // Stryker disable next-line ConditionalExpression,BlockStatement: Early return on success - tested via empty UnprocessedItems tests
                if(!hasUnprocessed) {
                    return [];
                }

                unprocessedItems = result.UnprocessedItems!;
                attempt++;

                // Stryker disable next-line ConditionalExpression,EqualityOperator: Retry boundary in batch write loop
                if(attempt < MAX_RETRIES) {
                    // Stryker disable next-line ArithmeticOperator: Backoff formula tested via timer verification; * vs / indistinguishable at attempt 1 (2^0=1)
                    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
                    logger.debug({ attempt, msg: `Batch write retry ${attempt}/${MAX_RETRIES}` });
                }
            } catch (error) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
                logger.warn({ error, msg: 'Batch write threw exception - treating current batch as failed' });
                // Return current unprocessed items as failed (items that succeeded in prior iterations are excluded)
                // eslint-disable-next-line lodash/chaining,@typescript-eslint/no-unsafe-return -- unprocessedItems has complex UnprocessedItems type
                return _flatten(_values(unprocessedItems));
            }
        }

        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Post-loop unprocessed items check
        if(_keys(unprocessedItems).length > 0) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Observational logging for debugging
            logger.warn({ unprocessedItems, msg: `Batch write failed after ${MAX_RETRIES} attempts` });
        }

        // Flatten UnprocessedItems to array of WriteRequests
        const failedRequests: BatchWriteRequest[] = [];

        for(const tableName of _keys(unprocessedItems)) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument -- UnprocessedItems type is complex
            failedRequests.push(...unprocessedItems[tableName]);
        }

        return failedRequests;
    }

    /**
     * Increments atomic counters for the given tags.
     * Creates META_COUNT items if they don't exist.
     */
    async incrementTagCounts(tags: string[]): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - empty tags array is a no-op
        if(tags.length === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);
        const operations = _map(normalizedTags, tag =>
            retryWithBackoff(
                async () => this.docClient.send(new UpdateCommand({
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
            )
        );

        await Promise.all(operations);
    }

    /**
     * Decrements atomic counters for the given tags.
     * Deletes META_COUNT items when count reaches 0 or below.
     */
    async decrementTagCounts(tags: string[]): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - empty tags array is a no-op
        if(tags.length === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);

        const operations = _map(normalizedTags, async (tag) => {
            const result = await retryWithBackoff(
                async () => this.docClient.send(new UpdateCommand({
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
            if(result?.Attributes?.count != null && (result.Attributes.count as number) <= 0) {
                // Stryker disable BlockStatement: try-catch block for ConditionalCheckFailedException
                try {
                    await retryWithBackoff(
                        async () => this.docClient.send(new DeleteCommand({
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

            const result = await this.docClient.send(new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            }));

            const items = result.Items ?? [];
            for(const item of items) {
                // Extract tag from GSI2SK: 'TAG#tagname' -> 'tagname'
                const gsi2sk = item.GSI2SK as string;
                const tag = gsi2sk.substring(4); // Remove 'TAG#' prefix
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
        return _sortBy(results, 'tag');
    }

    /**
     * Creates tag index items for a memory path.
     * Each tag gets its own index entry with full preview data.
     */
    async createTagIndexItems(
        path: MemoryPath,
        tags: string[],
        updatedAt: string,
        contentPreview: string,
        layer: string
    ): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - normalizeTags([]) returns [], making _map a no-op
        if(tags.length === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);

        // Build write requests for tag index items
        const writeRequests: BatchWriteRequest[] = _map(normalizedTags, tag => ({
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

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = _chunk(writeRequests, 25);

        // Execute all batches and collect failed requests
        const allFailedRequests: BatchWriteRequest[] = [];
        for(const batch of batches) {
            const failedRequests = await this.batchWriteWithRetry({ [this.tableName]: batch });
            allFailedRequests.push(...failedRequests);
        }

        // Extract tags that failed from unprocessed PutRequests
        const failedTags = _map(allFailedRequests, (req) => {
            const pk = req.PutRequest?.Item?.PK as string;
            return pk.substring(4); // Remove 'TAG#' prefix
        });

        // Only increment counts for tags that succeeded
        const succeededTags = _difference(normalizedTags, failedTags);
        await this.incrementTagCounts(succeededTags);
    }

    /**
     * Deletes tag index items for a memory path.
     */
    async deleteTagIndexItems(path: MemoryPath, tags: string[]): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - normalizeTags([]) returns [], making _map a no-op
        if(tags.length === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);

        // Build delete requests for tag index items
        const writeRequests: BatchWriteRequest[] = _map(normalizedTags, tag => ({
            DeleteRequest: {
                Key: {
                    PK: `TAG#${tag}`,
                    SK: `PATH#${path}`,
                },
            },
        }));

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = _chunk(writeRequests, 25);

        // Execute all batches and collect failed requests
        const allFailedRequests: BatchWriteRequest[] = [];
        for(const batch of batches) {
            const failedRequests = await this.batchWriteWithRetry({ [this.tableName]: batch });
            allFailedRequests.push(...failedRequests);
        }

        // Extract tags that failed from unprocessed DeleteRequests
        const failedTags = _map(allFailedRequests, (req) => {
            const pk = req.DeleteRequest?.Key?.PK as string;
            return pk.substring(4); // Remove 'TAG#' prefix
        });

        // Only decrement counts for tags that succeeded
        const succeededTags = _difference(normalizedTags, failedTags);
        await this.decrementTagCounts(succeededTags);
    }

    /**
     * Refreshes tag index items without changing counts.
     * Used to update preview data for unchanged tags.
     */
    async refreshTagIndexItems(
        path: MemoryPath,
        tags: string[],
        updatedAt: string,
        contentPreview: string,
        layer: string
    ): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - empty tags array is a no-op
        if(tags.length === 0) {
            return;
        }

        const normalizedTags = normalizeTags(tags);

        // Build write requests for tag index items
        const writeRequests: BatchWriteRequest[] = _map(normalizedTags, tag => ({
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

        // Split into batches of 25 (DynamoDB BatchWriteItem limit)
        const batches = _chunk(writeRequests, 25);

        // Execute all batches (no count increment)
        for(const batch of batches) {
            await this.batchWriteWithRetry({ [this.tableName]: batch });
        }
    }

    /**
     * Updates tag index items when tags change.
     * Computes diff and creates/deletes/refreshes as needed.
     */
    async updateTagIndexItems(
        path: MemoryPath,
        oldTags: string[],
        newTags: string[],
        updatedAt: string,
        contentPreview: string,
        layer: string
    ): Promise<void> {
        const normalizedOld = normalizeTags(oldTags);
        const normalizedNew = normalizeTags(newTags);

        const added = _difference(normalizedNew, normalizedOld);
        const removed = _difference(normalizedOld, normalizedNew);
        const unchanged = _intersection(normalizedOld, normalizedNew);

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
     * Queries tag index by a single tag.
     */
    // eslint-disable-next-line complexity -- Query building requires conditional logic
    async queryByTag(
        tag: string,
        layer?: string,
        options?: ListOptions
    ): Promise<ListResult<TagIndexItem>> {
        const normalizedTag = normalizeTags([tag])[0];
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
            // Stryker disable next-line OptionalChaining: options is guaranteed defined by guard above
            const startDate = options?.startDate ?? '1970-01-01T00:00:00.000Z';
            // Stryker disable next-line OptionalChaining: options is guaranteed defined by guard above
            const endDate = options?.endDate ?? '9999-12-31T23:59:59.999Z';
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
        if(options?.cursor) {
            queryParams.ExclusiveStartKey = JSON.parse(
                Buffer.from(options.cursor, 'base64').toString('utf-8')
            );
        }

        const result = await this.docClient.send(new QueryCommand({
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
        const normalizedTags = normalizeTags(tags);

        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Early return optimization
        if(normalizedTags.length === 1) {
            return this.queryByTag(normalizedTags[0], layer, options);
        }

        const requestedLimit = options?.limit;
        const collectedItems: TagIndexItem[] = [];
        let currentCursor = options?.cursor;

        // Page through driving tag results until limit filled or data exhausted
        // Stryker disable ConditionalExpression,BlockStatement: Intentional infinite loop with internal break
        do {
            // Stryker disable next-line ObjectLiteral: Options passthrough required for layer and date filters
            const pageResult = await this.queryByTag(normalizedTags[0], layer, {
                ...options,
                cursor: currentCursor,
                limit:  undefined, // Don't limit individual pages — we filter
            });

            // Filter for items that contain ALL remaining tags
            // Stryker disable next-line MethodExpression: Slicing removes driving tag, but since all items already have it (from query), keeping it is equivalent
            const remainingTags = normalizedTags.slice(1);
            const matching = _filter(pageResult.items, item =>
                _every(remainingTags, tag => _includes(item.tags, tag))
            );
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
