import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, isObject as _isObject } from 'lodash';
import { BaseRepository, type DynamoDBKey } from '../repositories/base';
import {
    memoryToolItemSchema,
    type MemoryPath,
    type ContentType,
    type MemoryToolItemData,
    type MemoryToolItem
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
        const item: MemoryToolItem = { ...data, ...keys };

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
        const item: MemoryToolItem = { ...updated, ...keys };

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

    private stripKeys(item: MemoryToolItem): MemoryToolItemData {
        const { PK: _PK, SK: _SK, GSI1PK: _GSI1PK, GSI1SK: _GSI1SK, ...data } = item;
        return data;
    }
}
