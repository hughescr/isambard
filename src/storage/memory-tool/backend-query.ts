import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, sortBy as _sortBy, takeRight as _takeRight } from 'lodash';
import {
    type MemoryToolItemData,
    type MemoryToolItem,
    type LayerName
} from './types';

export interface ListOptions {
    limit?:  number
    cursor?: string
}

export interface ListResult<T> {
    items:       T[]
    nextCursor?: string
}

/**
 * Query operations for the memory tool backend.
 * Handles list, search, and time-range queries.
 */
export class MemoryToolBackendQuery {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string,
        private readonly stripKeys: (item: MemoryToolItem) => MemoryToolItemData
    ) {}

    async list(directoryPath: string, options?: ListOptions): Promise<ListResult<MemoryToolItemData>> {
        const queryParams: Record<string, unknown> = {
            KeyConditionExpression:    'PK = :pk',
            ExpressionAttributeValues: {
                ':pk': `DIR#${directoryPath}`,
            },
            ScanIndexForward: true, // Alphabetical order
        };

        if(options?.limit) {
            queryParams.Limit = options.limit;
        }

        if(options?.cursor) {
            queryParams.ExclusiveStartKey = JSON.parse(
                Buffer.from(options.cursor, 'base64').toString('utf-8')
            );
        }

        const result = await this.docClient.send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        let items = _map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item));

        // Sort by createdAt ascending (oldest first, newest last)
        items = _sortBy(items, ['createdAt']);

        let nextCursor: string | undefined;
        if(result.LastEvaluatedKey) {
            nextCursor = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
        }

        return { items, nextCursor };
    }

    async searchByTag(
        tag: string,
        layer?: LayerName,
        options?: ListOptions
    ): Promise<ListResult<MemoryToolItemData>> {
        const queryParams: Record<string, unknown> = {
            IndexName:                 'GSI2',
            ExpressionAttributeValues: {
                ':gsi2pk': `TAG#${tag}`,
            },
        };

        // Build KeyConditionExpression based on whether layer filter is provided
        if(layer) {
            queryParams.KeyConditionExpression = 'GSI2PK = :gsi2pk AND begins_with(GSI2SK, :layerPrefix)';
            (queryParams.ExpressionAttributeValues as Record<string, string>)[':layerPrefix'] = `LAYER#${layer}#`;
        } else {
            queryParams.KeyConditionExpression = 'GSI2PK = :gsi2pk';
        }

        if(options?.limit) {
            queryParams.Limit = options.limit;
        }

        if(options?.cursor) {
            queryParams.ExclusiveStartKey = JSON.parse(
                Buffer.from(options.cursor, 'base64').toString('utf-8')
            );
        }

        const result = await this.docClient.send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        const items = _map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item));

        let nextCursor: string | undefined;
        if(result.LastEvaluatedKey) {
            nextCursor = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
        }

        return { items, nextCursor };
    }

    async listByLayer(
        layer: LayerName,
        options?: ListOptions
    ): Promise<ListResult<MemoryToolItemData>> {
        // Query GSI1 to get all items in the layer, including nested paths
        // GSI1PK = LAYER#{layer}, GSI1SK = UPDATED#{timestamp}
        const queryParams: Record<string, unknown> = {
            IndexName:                 'GSI1',
            KeyConditionExpression:    'GSI1PK = :pk',
            ExpressionAttributeValues: {
                ':pk': `LAYER#${layer}`,
            },
            ScanIndexForward: false, // Newest first (descending by GSI1SK)
        };

        if(options?.limit) {
            queryParams.Limit = options.limit;
        }

        if(options?.cursor) {
            queryParams.ExclusiveStartKey = JSON.parse(
                Buffer.from(options.cursor, 'base64').toString('utf-8')
            );
        }

        const result = await this.docClient.send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        const items = _map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item));

        let nextCursor: string | undefined;
        if(result.LastEvaluatedKey) {
            nextCursor = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
        }

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
        // Stryker disable next-line all: Need exact > comparison and both conditions checked
        if(options?.limit && items.length > options.limit) {
            items = _takeRight(items, options.limit);
        }

        return items;
    }
}
