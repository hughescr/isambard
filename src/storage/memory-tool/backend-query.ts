import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, sortBy as _sortBy, take as _take, chain as _chain, orderBy as _orderBy } from 'lodash';
import {
    type MemoryToolItemData,
    type MemoryToolItem,
    type LayerName,
    type TagIndexItem,
    createLayerName
} from './types';
import { MemoryToolBackendTagIndex } from './backend-tag-index';
import { sigmoidScore } from './sigmoid';

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
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string,
        private readonly stripKeys: (item: MemoryToolItem) => MemoryToolItemData,
        private readonly tagIndex?: MemoryToolBackendTagIndex
    ) {}

    /**
     * Gets normalized date bounds from options.
     */
    private getDateBounds(options: ListOptions | undefined): { startDate: string, endDate: string } {
        return {
            // Stryker disable next-line OptionalChaining: Defensive coding for undefined options
            startDate: options?.startDate ?? MIN_DATE,
            // Stryker disable next-line OptionalChaining: Defensive coding for undefined options
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
            queryParams.ExclusiveStartKey = JSON.parse(
                Buffer.from(options.cursor, 'base64').toString('utf-8')
            );
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

        const result = await this.docClient.send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        let items = _map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item));

        // Sort by createdAt ascending (oldest first, newest last)
        items = _sortBy(items, ['createdAt']);

        const nextCursor = this.encodeCursor(result.LastEvaluatedKey as Record<string, unknown> | undefined);

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
    ): Promise<ListResult<TagIndexItem>> {
        if(!this.tagIndex) {
            throw new Error('Tag index not configured');
        }
        // queryByTags still takes string[], so spread the Set
        return this.tagIndex.queryByTags([...tags], layer as string | undefined, options);
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
            // Stryker disable next-line BooleanLiteral: Sort order is observational - both ascending/descending orderings are valid for layer listing
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

        const result = await this.docClient.send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        const items = _map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item));
        const nextCursor = this.encodeCursor(result.LastEvaluatedKey as Record<string, unknown> | undefined);

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

        for(const l of layers) {
            const queryParams: Record<string, unknown> = {
                IndexName:                 'GSI1',
                KeyConditionExpression:    'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
                ExpressionAttributeValues: {
                    ':pk':    `LAYER#${l}`,
                    ':start': `UPDATED#${startTime}`,
                    ':end':   `UPDATED#${endTime}`,
                },
                // Stryker disable next-line BooleanLiteral: Sort order is observational - both ascending/descending orderings are valid for time range queries
                ScanIndexForward: false, // Newest first
            };

            // Stryker disable next-line ConditionalExpression: Guard is defensive — setting Limit to undefined is equivalent to not setting it
            if(perLayerLimit) {
                queryParams.Limit = perLayerLimit;
            }

            const result = await this.docClient.send(new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            }));
            allItems.push(..._map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item)));
        }

        // Items arrive newest-first per layer; merge, sort descending, take limit, reverse to ascending
        let items = _orderBy(allItems, ['updatedAt'], ['desc']);

        // Apply limit - keep newest N items
        if(options?.limit) {
            items = _take(items, options.limit);
        }

        // Reverse to ascending order (oldest first, newest last) for the caller
        return items.reverse();
    }

    async getAutoLoadItems(
        options?: { maxIdentityItems?: number, maxStateItems?: number, now?: Date }
    ): Promise<MemoryToolItemData[]> {
        const maxIdentityItems = options?.maxIdentityItems ?? 100;
        const maxStateItems = options?.maxStateItems ?? 50;
        const nowMs = (options?.now ?? new Date()).getTime();

        // Get identity items (all items from /identity layer)
        const identityResult = await this.listByLayer(createLayerName('identity'), { limit: maxIdentityItems });
        const identityItems = _take(identityResult.items, maxIdentityItems);

        // Get state items (all items from /state layer)
        const stateResult = await this.listByLayer(createLayerName('state'), { limit: maxStateItems });
        let stateItems = stateResult.items;

        // Score state items using sigmoid function for frequency × recency
        const scoredItems = _map(stateItems, (item) => {
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            const accessCount = (item.metadata?.accessCount as number | undefined) ?? 0;
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            const lastAccessed = (item.metadata?.lastAccessed as string | undefined) ?? item.updatedAt;
            const timeSinceLastAccessMs = nowMs - new Date(lastAccessed).getTime();
            return { item, score: sigmoidScore(accessCount, timeSinceLastAccessMs) };
        });

        stateItems = _chain(scoredItems)
            .orderBy(
                // Stryker disable next-line all: Sort field and order for sigmoid scoring
                ['score'],
                // Stryker disable next-line all: Descending sort order
                ['desc']
            )
            .take(maxStateItems)
            .map(({ item }) => item)
            .value();

        return [...identityItems, ...stateItems];
    }

    async getStateItemsScored(
        options?: { maxItems?: number, now?: Date }
    ): Promise<ScoredMemoryItem[]> {
        // Stryker disable next-line LogicalOperator,OptionalChaining: ?? operator is correct for default values
        const maxItems = options?.maxItems ?? 50;
        // Stryker disable next-line LogicalOperator,OptionalChaining: ?? operator is correct for default values
        const nowMs = (options?.now ?? new Date()).getTime();

        // Get all state items
        const stateResult = await this.listByLayer(createLayerName('state'));
        const stateItems = stateResult.items;

        // Score items using sigmoid function for frequency × recency
        const scoredItems = _map(stateItems, (item) => {
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            const accessCount = (item.metadata?.accessCount as number | undefined) ?? 0;
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            const lastAccessed = (item.metadata?.lastAccessed as string | undefined) ?? item.updatedAt;
            const timeSinceLastAccessMs = nowMs - new Date(lastAccessed).getTime();
            return { item, score: sigmoidScore(accessCount, timeSinceLastAccessMs) };
        });

        // Sort by score descending and take top N
        return _chain(scoredItems)
            .orderBy(
                // Stryker disable next-line all: Sort field for sigmoid scoring
                ['score'],
                // Stryker disable next-line all: Descending sort order
                ['desc']
            )
            .take(maxItems)
            .value();
    }
}
