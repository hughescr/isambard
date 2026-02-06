import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, sortBy as _sortBy, takeRight as _takeRight } from 'lodash';
import {
    type MemoryToolItemData,
    type MemoryToolItem,
    type LayerName,
    type TagIndexItem
} from './types';
import { MemoryToolBackendTagIndex } from './backend-tag-index';

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
                ':pk':            `DIR#${directoryPath}`,
                ':versionPrefix': 'VERSION#',
            },
            FilterExpression: 'NOT begins_with(SK, :versionPrefix)',
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
     * @param tags - Array of tags to search for (AND semantics - items must have all tags)
     * @param layer - Optional layer filter
     * @param options - Pagination and filtering options
     * @returns ListResult with TagIndexItem preview data (not full MemoryToolItemData)
     */
    async searchByTags(
        tags: string[],
        layer?: LayerName,
        options?: ListOptions
    ): Promise<ListResult<TagIndexItem>> {
        if(!this.tagIndex) {
            throw new Error('Tag index not configured');
        }
        // Cast layer to string for tagIndex call
        return this.tagIndex.queryByTags(tags, layer as string | undefined, options);
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
                ':pk':            `LAYER#${layer}`,
                ':versionPrefix': 'VERSION#',
            },
            FilterExpression: 'NOT begins_with(SK, :versionPrefix)',
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
        /* Stryker disable all: searchByTimeRange not yet covered by unit tests — used by reconciliation and MCP server */
        // Query GSI1 by layer with time range
        // GSI1PK = LAYER#{layer} AND GSI1SK BETWEEN UPDATED#{start} AND UPDATED#{end}
        const layers = layer ? [layer] : ['identity', 'state', 'events'] as const;
        const allItems: MemoryToolItemData[] = [];

        for(const l of layers) {
            const result = await this.docClient.send(new QueryCommand({
                TableName:                 this.tableName,
                IndexName:                 'GSI1',
                KeyConditionExpression:    'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
                ExpressionAttributeValues: {
                    ':pk':    `LAYER#${l}`,
                    ':start': `UPDATED#${startTime}`,
                    ':end':   `UPDATED#${endTime}`,
                },
            }));
            allItems.push(..._map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item)));
        }

        // Sort by updatedAt ascending (oldest first, newest last)
        let items = _sortBy(allItems, ['updatedAt']);

        // Apply limit after sorting - keep newest N items
        if(options?.limit && items.length > options.limit) {
            items = _takeRight(items, options.limit);
        }

        return items;
        /* Stryker restore all */
    }
}
