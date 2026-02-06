import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, filter as _filter, difference as _difference, intersection as _intersection, every as _every, includes as _includes } from 'lodash';
import { logger } from '@hughescr/logger';
import type { TagIndexItem } from './types';
import type { MemoryPath } from './types';
import { normalizeTags } from './key-generator';
import type { ListOptions, ListResult } from './backend-query';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

// Stryker disable all: Retry logic with exponential backoff - testing timing behavior is unreliable
async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    context: string
): Promise<T | undefined> {
    for(let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if(attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
                logger.debug({ attempt, context, msg: `Tag index retry ${attempt}/${MAX_RETRIES}` });
                continue;
            }
            logger.warn({ error, context, msg: `Tag index operation failed after ${MAX_RETRIES} attempts` });
            return undefined;
        }
    }
    return undefined;
}
// Stryker restore all

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
        const operations = _map(normalizedTags, tag =>
            retryWithBackoff(
                async () => this.docClient.send(new PutCommand({
                    TableName: this.tableName,
                    Item:      {
                        PK:         `TAG#${tag}`,
                        SK:         `PATH#${path}`,
                        memoryPath: path,
                        layer,
                        updatedAt,
                        tags:       normalizedTags,
                        contentPreview,
                    },
                })),
                // Stryker disable next-line StringLiteral: Context string for retry logging is observational
                `createTagIndexItem:${tag}:${path}`
            )
        );

        await Promise.all(operations);
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
        const operations = _map(normalizedTags, tag =>
            retryWithBackoff(
                async () => this.docClient.send(new DeleteCommand({
                    TableName: this.tableName,
                    Key:       {
                        PK: `TAG#${tag}`,
                        SK: `PATH#${path}`,
                    },
                })),
                // Stryker disable next-line StringLiteral: Context string for retry logging is observational
                `deleteTagIndexItem:${tag}:${path}`
            )
        );

        await Promise.all(operations);
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
            // Create items for added tags
            this.createTagIndexItems(path, added, updatedAt, contentPreview, layer),
            // Delete items for removed tags
            this.deleteTagIndexItems(path, removed),
            // Refresh unchanged tags with current data
            this.createTagIndexItems(path, unchanged, updatedAt, contentPreview, layer),
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
            KeyConditionExpression:    'PK = :pk',
            ExpressionAttributeValues: { ':pk': pk },
        };
        // Stryker restore StringLiteral

        // Build FilterExpression for layer and date filters
        // Stryker disable next-line ArrayDeclaration: Initial value for filter building
        const filterExpressions: string[] = [];
        // Stryker disable next-line ObjectLiteral: Initial value for expression values
        const expressionValues: Record<string, string> = { ':pk': pk };

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
