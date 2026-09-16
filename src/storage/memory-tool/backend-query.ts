import { type DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { z } from 'zod';
import { type DynamoDBClientHolder, resolveDocClientGetter } from '../client-holder';
import { type MemoryToolBackendTagIndex } from './backend-tag-index';
import { sigmoidScore } from './sigmoid';
import {
    type MemoryToolItemData,
    type MemoryToolItem,
    type StoredMemoryToolItem,
    type LayerName,
    type TagIndexReadItem,
    createLayerName,
    normalizeStoredMemoryToolItem
} from './types';
import { InvariantViolationError } from '@/errors';

export interface ListOptions {
    limit?:     number
    cursor?:    string
    startDate?: string  // ISO8601 datetime, inclusive
    endDate?:   string  // ISO8601 datetime, inclusive
}

export interface ListResult<T> {
    items:       T[]
    nextCursor?: string
}

export interface ScoredMemoryItem {
    item:  MemoryToolItemData
    score: number
}

// Default date bounds for open-ended queries
const MIN_DATE = '1970-01-01T00:00:00.000Z';
const MAX_DATE = '9999-12-31T23:59:59.999Z';

/**
 * Query operations for the memory tool backend.
 * Handles list, search, and time-range queries.
 */
export class MemoryToolBackendQuery {
    private readonly getDocClient: () => DynamoDBDocumentClient;

    constructor(
        docClientOrHolder: DynamoDBDocumentClient | DynamoDBClientHolder,
        private readonly tableName: string,
        private readonly stripKeys: (item: MemoryToolItem) => MemoryToolItemData,
        private readonly tagIndex?: MemoryToolBackendTagIndex
    ) {
        this.getDocClient = resolveDocClientGetter(docClientOrHolder);
    }

    /**
     * Gets normalized date bounds from options.
     */
    private getDateBounds(options: ListOptions | undefined): { startDate: string, endDate: string } {
        return {
            startDate: options?.startDate ?? MIN_DATE,
            endDate:   options?.endDate ?? MAX_DATE,
        };
    }

    /**
     * Applies pagination options to query parameters.
     */
    private applyPaginationOptions(
        queryParams: Record<string, unknown>,
        options: ListOptions | undefined
    ): void {
        if(options?.limit) {
            queryParams.Limit = options.limit;
        }

        if(options?.cursor) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(
                    Buffer.from(options.cursor, 'base64').toString('utf8')
                );
            } catch (err) {
                logger.warn({ err, cursor: options.cursor }, 'Malformed pagination cursor — skipping ExclusiveStartKey; query will restart from the beginning');
                return;
            }
            const cursorSchema = z.record(z.string(), z.unknown());
            const cursorResult = cursorSchema.safeParse(parsed);
            if(!cursorResult.success) {
                logger.warn({ err: cursorResult.error.issues, cursor: options.cursor }, 'Invalid cursor shape — skipping ExclusiveStartKey; query will restart from the beginning');
                return;
            }
            queryParams.ExclusiveStartKey = cursorResult.data;
        }
    }

    /**
     * Encodes LastEvaluatedKey as a base64 cursor.
     */

    private encodeCursor(lastEvaluatedKey: Record<string, unknown> | undefined): string | undefined {
        if(lastEvaluatedKey) {
            return Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
        }
        return undefined;
    }

    async list(directoryPath: string, options?: ListOptions): Promise<ListResult<MemoryToolItemData>> {
        const queryParams: Record<string, unknown> = {
            KeyConditionExpression:    'PK = :pk',
            ExpressionAttributeValues: {
                ':pk': `DIR#${directoryPath}`,
            },
            ScanIndexForward: true, // Alphabetical order
        };

        this.applyPaginationOptions(queryParams, options);

        const result = await this.getDocClient().send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        let items = ((result.Items ?? []) as StoredMemoryToolItem[]).map(item => this.stripKeys(normalizeStoredMemoryToolItem(item)));

        // Sort by createdAt ascending (oldest first, newest last)
        items = items.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

        const nextCursor = this.encodeCursor(result.LastEvaluatedKey);

        return { items, nextCursor };
    }

    /**
     * Searches by multiple tags using the tag index.
     * Delegates to MemoryToolBackendTagIndex for efficient multi-tag queries.
     * @param tags - Set of tags to search for (AND semantics - items must have all tags)
     * @param layer - Optional layer filter
     * @param options - Pagination and filtering options
     * @returns ListResult with TagIndexItem preview data (not full MemoryToolItemData)
     */
    async searchByTags(
        tags: Set<string>,
        layer?: LayerName,
        options?: ListOptions
    ): Promise<ListResult<TagIndexReadItem>> {
        if(!this.tagIndex) {
            throw new InvariantViolationError('MemoryToolBackendQuery.searchByTags', 'Tag index not configured');
        }
        // queryByTags still takes string[], so spread the Set
        return this.tagIndex.queryByTags([...tags], layer, options);
    }

    async listByLayer(
        layer: LayerName,
        options?: ListOptions
    ): Promise<ListResult<MemoryToolItemData>> {
        // Query GSI1 to get all items in the layer, including nested paths
        // GSI1PK = LAYER#{layer}, GSI1SK = UPDATED#{timestamp}
        const hasDateFilter = options?.startDate ?? options?.endDate;
        const queryParams: Record<string, unknown> = {
            IndexName:                 'GSI1',
            ExpressionAttributeValues: {
                ':pk': `LAYER#${layer}`,
            },
            ScanIndexForward: false, // Newest first (descending by GSI1SK)
        };

        // Build KeyConditionExpression based on whether date filters are provided
        if(hasDateFilter) {
            const { startDate, endDate } = this.getDateBounds(options);
            queryParams.KeyConditionExpression = 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end';
            (queryParams.ExpressionAttributeValues as Record<string, string>)[':start'] = `UPDATED#${startDate}`;
            (queryParams.ExpressionAttributeValues as Record<string, string>)[':end'] = `UPDATED#${endDate}`;
        } else {
            queryParams.KeyConditionExpression = 'GSI1PK = :pk';
        }

        this.applyPaginationOptions(queryParams, options);

        const result = await this.getDocClient().send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        const items = ((result.Items ?? []) as StoredMemoryToolItem[]).map(item => this.stripKeys(normalizeStoredMemoryToolItem(item)));
        const nextCursor = this.encodeCursor(result.LastEvaluatedKey);

        return { items, nextCursor };
    }

    async searchByTimeRange(
        startTime: string,
        endTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        // Query GSI1 by layer with time range
        // GSI1PK = LAYER#{layer} AND GSI1SK BETWEEN UPDATED#{start} AND UPDATED#{end}
        const layers = layer ? [layer] : ['identity', 'state', 'events'] as const;
        const allItems: MemoryToolItemData[] = [];

        // Calculate per-layer limit to distribute evenly
        const perLayerLimit = options?.limit ? Math.ceil(options.limit / layers.length) : undefined;

        const layerResults = await Promise.all(layers.map((l) => {
            const queryParams: Record<string, unknown> = {
                IndexName:                 'GSI1',
                KeyConditionExpression:    'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
                ExpressionAttributeValues: {
                    ':pk':    `LAYER#${l}`,
                    ':start': `UPDATED#${startTime}`,
                    ':end':   `UPDATED#${endTime}`,
                },
                ScanIndexForward: false, // Newest first
            };

            if(perLayerLimit) {
                queryParams.Limit = perLayerLimit;
            }

            return this.getDocClient().send(new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            }));
        }));

        for(const result of layerResults) {
            allItems.push(...((result.Items ?? []) as StoredMemoryToolItem[]).map(item => this.stripKeys(normalizeStoredMemoryToolItem(item))));
        }

        // Items arrive newest-first per layer; merge, sort descending, take limit, reverse to ascending
        let items = allItems.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

        // Apply limit - keep newest N items
        if(options?.limit) {
            items = items.slice(0, options.limit);
        }

        // Reverse to ascending order (oldest first, newest last) for the caller
        return items.toReversed();
    }

    async searchSince(
        startTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        // Query GSI1 by layer with open-ended time range (>= startTime, no upper bound)
        // GSI1PK = LAYER#{layer} AND GSI1SK >= UPDATED#{start}
        const layers = layer ? [layer] : ['identity', 'state', 'events'] as const;
        const allItems: MemoryToolItemData[] = [];

        // Calculate per-layer limit to distribute evenly
        const perLayerLimit = options?.limit ? Math.ceil(options.limit / layers.length) : undefined;

        const layerResults = await Promise.all(layers.map((l) => {
            const queryParams: Record<string, unknown> = {
                IndexName:                 'GSI1',
                KeyConditionExpression:    'GSI1PK = :pk AND GSI1SK >= :start',
                ExpressionAttributeValues: {
                    ':pk':    `LAYER#${l}`,
                    ':start': `UPDATED#${startTime}`,
                },
                ScanIndexForward: false, // Newest first
            };

            if(perLayerLimit) {
                queryParams.Limit = perLayerLimit;
            }

            return this.getDocClient().send(new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            }));
        }));

        for(const result of layerResults) {
            allItems.push(...((result.Items ?? []) as StoredMemoryToolItem[]).map(item => this.stripKeys(normalizeStoredMemoryToolItem(item))));
        }

        // Items arrive newest-first per layer; merge, sort descending, take limit, reverse to ascending
        let items = allItems.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

        // Apply limit - keep newest N items
        if(options?.limit) {
            items = items.slice(0, options.limit);
        }

        // Reverse to ascending order (oldest first, newest last) for the caller
        return items.toReversed();
    }

    async getAutoLoadItems(
        options?: { maxIdentityItems?: number, maxStateItems?: number, now?: Date }
    ): Promise<MemoryToolItemData[]> {
        const maxIdentityItems = options?.maxIdentityItems ?? 100;
        const maxStateItems = options?.maxStateItems ?? 50;
        const nowMs = (options?.now ?? new Date()).getTime();

        // Get the newest identity items from the bounded layer query.
        const identityResult = await this.listByLayer(createLayerName('identity'), { limit: maxIdentityItems });
        const identityItems = identityResult.items;

        // Get state items (all items from /state layer)
        const stateResult = await this.listByLayer(createLayerName('state'), { limit: maxStateItems });
        let stateItems = stateResult.items;

        // Score state items using sigmoid function for frequency × recency
        const scoredItems = stateItems.map((item) => {
            const accessCount = (item.metadata.accessCount as number | undefined) ?? 0;
            const lastAccessed = (item.metadata.lastAccessed as string | undefined) ?? item.updatedAt;
            const timeSinceLastAccessMs = nowMs - new Date(lastAccessed).getTime();
            return { item, score: sigmoidScore(accessCount, timeSinceLastAccessMs) };
        });

        stateItems = scoredItems.toSorted((a, b) => b.score - a.score).slice(0, maxStateItems).map(({ item }) => item);

        return [...identityItems, ...stateItems];
    }

    async getStateItemsScored(
        options?: { maxItems?: number, now?: Date }
    ): Promise<ScoredMemoryItem[]> {
        const maxItems = options?.maxItems ?? 50;
        const nowMs = (options?.now ?? new Date()).getTime();

        // Invariant: GSI1SK is UPDATED#{updatedAt}, descending, so this query returns the
        // most-recently-touched items first. Since recencyDecay → 0 for stale items (7-day
        // half-life) regardless of accessCount, the top-scoring maxItems are provably contained
        // within the maxItems*2 most-recently-touched candidates. The ×2 headroom keeps this
        // bound safe across future sigmoid parameter tuning.
        const stateResult = await this.listByLayer(createLayerName('state'), { limit: maxItems * 2 });
        const stateItems = stateResult.items;

        // Score items using sigmoid function for frequency × recency
        const scoredItems = stateItems.map((item) => {
            const accessCount = (item.metadata.accessCount as number | undefined) ?? 0;
            const lastAccessed = (item.metadata.lastAccessed as string | undefined) ?? item.updatedAt;
            const timeSinceLastAccessMs = nowMs - new Date(lastAccessed).getTime();
            return { item, score: sigmoidScore(accessCount, timeSinceLastAccessMs) };
        });

        // Sort by score descending and take top N
        return scoredItems.toSorted((a, b) => b.score - a.score).slice(0, maxItems);
    }
}
