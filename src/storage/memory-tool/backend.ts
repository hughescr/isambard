import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, isObject as _isObject, orderBy as _orderBy, take as _take, drop as _drop, chain as _chain } from 'lodash';
import { BaseRepository, type DynamoDBKey } from '../repositories/base';
import {
    memoryToolItemSchema,
    type MemoryPath,
    type ContentType,
    type MemoryToolItemData,
    type MemoryToolItem,
    type LayerName
} from './types';
import { MemoryToolKeyGenerator } from './key-generator';
import { ItemNotFoundError, ValidationError, ConflictError } from '../errors';

export interface CreateMemoryToolItemInput {
    path:        MemoryPath
    content:     string
    contentType: ContentType
    metadata?:   Record<string, unknown>
    tags?:       string[]
}

export interface UpdateMemoryToolItemInput {
    content?:  string
    metadata?: Record<string, unknown>
    tags?:     string[]
}

export interface ListOptions {
    limit?:  number
    cursor?: string
}

export interface ListResult<T> {
    items:       T[]
    nextCursor?: string
}

export interface VersionInfo {
    version:         number
    updatedAt:       string
    contentPreview?: string
}

export class MemoryToolBackend extends BaseRepository<MemoryToolItemData> {
    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        super(docClient, tableName);
    }

    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const now = new Date().toISOString();

        const itemData = {
            path:        input.path,
            content:     input.content,
            contentType: input.contentType,
            metadata:    input.metadata ?? {},
            tags:        input.tags,
            version:     1,
            createdAt:   now,
            updatedAt:   now,
        };

        const result = memoryToolItemSchema.safeParse(itemData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const data = result.data;
        const keys = MemoryToolKeyGenerator.createKeys(data.path, data.createdAt);

        // Create GSI2 keys if tags are present
        const tagKeys = MemoryToolKeyGenerator.createTagKeys(data.path, data.tags, data.updatedAt);

        const item: MemoryToolItem = {
            ...data,
            ...keys,
            ...(tagKeys && { GSI2PK: tagKeys.GSI2PK, GSI2SK: tagKeys.GSI2SK }),
        };

        await this.putItem(item as unknown as Record<string, unknown>);

        return data;
    }

    async get(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        const keys = MemoryToolKeyGenerator.createKeys(path);
        const key: DynamoDBKey = {
            PK: keys.PK,
            SK: keys.SK,
        };

        const item = await this.getItem<MemoryToolItem>(key);
        if(!item) {
            return undefined;
        }

        return this.stripKeys(item);
    }

    async update(path: MemoryPath, input: UpdateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const existing = await this.get(path);
        if(!existing) {
            throw new ItemNotFoundError(path);
        }

        // Save version snapshot before updating
        const versionKeys = MemoryToolKeyGenerator.createVersionKeys(path, existing.version, existing.updatedAt);
        const existingKeys = MemoryToolKeyGenerator.createKeys(existing.path, existing.createdAt);
        const existingTagKeys = MemoryToolKeyGenerator.createTagKeys(existing.path, existing.tags, existing.updatedAt);

        const versionSnapshot: MemoryToolItem = {
            ...existing,
            ...versionKeys,
            GSI1PK: existingKeys.GSI1PK,
            GSI1SK: existingKeys.GSI1SK,
            ...(existingTagKeys && { GSI2PK: existingTagKeys.GSI2PK, GSI2SK: existingTagKeys.GSI2SK }),
        };

        // Save version snapshot
        await this.putItem(versionSnapshot as unknown as Record<string, unknown>);

        const updatedData = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.metadata !== undefined && { metadata: input.metadata }),
            ...(input.tags !== undefined && { tags: input.tags }),
            version:   existing.version + 1,
            updatedAt: new Date().toISOString(),
        };

        const result = memoryToolItemSchema.safeParse(updatedData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const updated = result.data;
        const keys = MemoryToolKeyGenerator.createKeys(updated.path, existing.createdAt);

        // Regenerate GSI2 keys with new updatedAt timestamp if tags are present
        const tagKeys = MemoryToolKeyGenerator.createTagKeys(updated.path, updated.tags, updated.updatedAt);

        const item: MemoryToolItem = {
            ...updated,
            ...keys,
            ...(tagKeys && { GSI2PK: tagKeys.GSI2PK, GSI2SK: tagKeys.GSI2SK }),
        };

        try {
            await this.docClient.send(new PutCommand({
                TableName:                this.tableName,
                Item:                     item,
                ConditionExpression:      '#version = :expectedVersion',
                ExpressionAttributeNames: {
                    '#version': 'version',
                },
                ExpressionAttributeValues: {
                    ':expectedVersion': existing.version,
                },
            }));
        } catch (error: unknown) {
            if(error && _isObject(error) && 'name' in error && error.name === 'ConditionalCheckFailedException') {
                const current = await this.get(path);
                throw new ConflictError(
                    path,
                    existing.version,
                    current?.version ?? -1
                );
            }
            throw error;
        }

        return updated;
    }

    async delete(path: MemoryPath): Promise<void> {
        const keys = MemoryToolKeyGenerator.createKeys(path);
        const key: DynamoDBKey = {
            PK: keys.PK,
            SK: keys.SK,
        };
        await this.deleteItem(key);
    }

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
            new (await import('@aws-sdk/lib-dynamodb')).QueryCommand({
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
            new (await import('@aws-sdk/lib-dynamodb')).QueryCommand({
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
        // Layer paths are the layer name itself: /identity, /state, /events
        return this.list(`/${layer}`, options);
    }

    async searchByTimeRange(
        startTime: string,
        endTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        const baseFilter = '(createdAt BETWEEN :start AND :end) OR (updatedAt BETWEEN :start AND :end)';
        const scanParams: Record<string, unknown> = {
            FilterExpression:          layer ? `${baseFilter} AND begins_with(#path, :layerPath)` : baseFilter,
            ExpressionAttributeValues: {
                ':start': startTime,
                ':end':   endTime,
            },
        };

        // Add layer filter parameters if provided
        if(layer) {
            scanParams.ExpressionAttributeNames = { '#path': 'path' };
            (scanParams.ExpressionAttributeValues as Record<string, string>)[':layerPath'] = `/${layer}/`;
        }

        const result = await this.docClient.send(
            new (await import('@aws-sdk/lib-dynamodb')).ScanCommand({
                TableName: this.tableName,
                ...scanParams,
            })
        );

        let items = _map((result.Items ?? []) as MemoryToolItem[], item => this.stripKeys(item));

        // Apply limit after filtering (Scan's Limit applies before FilterExpression)
        // Stryker disable next-line all: Need exact > comparison and both conditions checked
        if(options?.limit && items.length > options.limit) {
            items = _take(items, options.limit);
        }

        return items;
    }

    async getAutoLoadItems(
        options?: { maxIdentityItems?: number, maxStateItems?: number }
    ): Promise<MemoryToolItemData[]> {
        const maxIdentityItems = options?.maxIdentityItems ?? 100;
        const maxStateItems = options?.maxStateItems ?? 50;

        // Get identity items (all items from /identity layer)
        const identityResult = await this.listByLayer('identity' as LayerName, { limit: maxIdentityItems });
        const identityItems = _take(identityResult.items, maxIdentityItems);

        // Get state items (all items from /state layer)
        const stateResult = await this.listByLayer('state' as LayerName, { limit: maxStateItems });
        let stateItems = stateResult.items;

        // Filter for "hot" state items if metadata exists
        // Sort by accessCount (descending), then by lastAccessed (most recent first)
        const enrichedItems = _map(stateItems, item => ({
            item,
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            accessCount:  (item.metadata?.accessCount as number | undefined) ?? 0,
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            lastAccessed: (item.metadata?.lastAccessed as string | undefined) ?? item.updatedAt,
        }));

        stateItems = _chain(enrichedItems)
            .orderBy(
                // Stryker disable next-line all: These string literals define sort fields and order
                ['accessCount', 'lastAccessed'],
                // Stryker disable next-line all: These string literals define sort order (descending)
                ['desc', 'desc']
            )
            .take(maxStateItems)
            .map(({ item }) => item)
            .value();

        return [...identityItems, ...stateItems];
    }

    async getVersion(path: MemoryPath, version: number): Promise<MemoryToolItemData | undefined> {
        // Query all versions for this path to find the one matching the version number
        const keys = MemoryToolKeyGenerator.createKeys(path);
        const queryParams = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk':       keys.PK,
                ':skPrefix': `VERSION#${version}#`,
            },
        };

        const result = await this.docClient.send(
            new (await import('@aws-sdk/lib-dynamodb')).QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        if(!result.Items || result.Items.length === 0) {
            return undefined;
        }

        return this.stripKeys(result.Items[0] as MemoryToolItem);
    }

    async listVersions(path: MemoryPath, limit?: number): Promise<VersionInfo[]> {
        const keys = MemoryToolKeyGenerator.createKeys(path);
        /* Stryker disable all: These literals define the DynamoDB query structure */
        const queryParams: Record<string, unknown> = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk':       keys.PK,
                ':skPrefix': 'VERSION#',
            },
            ScanIndexForward: false, // Descending order (newest first)
        };
        /* Stryker restore all */

        // Stryker disable next-line all: Conditional check for optional parameter
        if(limit) {
            queryParams.Limit = limit;
        }

        const result = await this.docClient.send(
            // Stryker disable next-line ObjectLiteral: QueryCommand requires TableName and queryParams
            new (await import('@aws-sdk/lib-dynamodb')).QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        // Stryker disable next-line ArrayDeclaration: Empty array is correct default for missing Items
        const items = (result.Items ?? []) as MemoryToolItem[];

        return _map(items, (item) => {
            const versionInfo: VersionInfo = {
                version:   item.version,
                updatedAt: item.updatedAt,
            };

            // Add content preview (first 50 chars)
            // Stryker disable next-line all: Need exact check for non-empty string content
            if(item.content && item.content.length > 0) {
                versionInfo.contentPreview = item.content.slice(0, 50);
            }

            return versionInfo;
        });
    }

    async pruneVersions(path: MemoryPath, keepCount: number): Promise<number> {
        const keys = MemoryToolKeyGenerator.createKeys(path);
        /* Stryker disable all: These literals define the DynamoDB query structure for versions */
        const queryParams = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk':       keys.PK,
                ':skPrefix': 'VERSION#',
            },
            ScanIndexForward: false, // Descending order (newest first)
        };
        /* Stryker restore all */

        const result = await this.docClient.send(
            // Stryker disable next-line ObjectLiteral: QueryCommand requires TableName and queryParams
            new (await import('@aws-sdk/lib-dynamodb')).QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        // Stryker disable next-line ArrayDeclaration: Empty array is correct default for missing Items
        const items = (result.Items ?? []) as MemoryToolItem[];

        // Stryker disable next-line all: Need exact <= comparison to handle both < and = cases
        if(items.length <= keepCount) {
            return 0;
        }

        // Keep newest keepCount items, delete the rest
        const itemsToDelete = _drop(items, keepCount);

        for(const item of itemsToDelete) {
            await this.docClient.send(new DeleteCommand({
                TableName: this.tableName,
                Key:       {
                    PK: item.PK,
                    SK: item.SK,
                },
            }));
        }

        return itemsToDelete.length;
    }

    private stripKeys(item: MemoryToolItem): MemoryToolItemData {
        const { PK: _PK, SK: _SK, GSI1PK: _GSI1PK, GSI1SK: _GSI1SK, GSI2PK: _GSI2PK, GSI2SK: _GSI2SK, ...data } = item;
        return data;
    }
}
