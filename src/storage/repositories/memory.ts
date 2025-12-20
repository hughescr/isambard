import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { map as _map, isObject as _isObject } from 'lodash';
import { BaseRepository, type DynamoDBKey } from './base';
import {
    memorySchema,
    createMemoryKeys,
    type Memory,
    type MemoryType,
    type MemoryItem
} from '../models/memory';
import { ItemNotFoundError, ValidationError, ConflictError } from '../errors';

export interface CreateMemoryInput {
    id?:         string
    memory_type: MemoryType
    content:     string
    metadata?:   Record<string, unknown>
    TTL?:        number
}

export interface UpdateMemoryInput {
    content?:  string
    metadata?: Record<string, unknown>
    TTL?:      number
}

export interface QueryOptions {
    limit?:  number
    cursor?: string
}

export interface QueryResult<T> {
    items:       T[]
    nextCursor?: string
}

export class MemoryRepository extends BaseRepository<Memory> {
    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        super(docClient, tableName);
    }

    async create(input: CreateMemoryInput): Promise<Memory> {
        const now = new Date().toISOString();
        const id = input.id ?? randomUUID();

        const memoryData = {
            id,
            memory_type: input.memory_type,
            content:     input.content,
            metadata:    input.metadata ?? {},
            version:     0,
            createdAt:   now,
            updatedAt:   now,
            TTL:         input.TTL,
        };

        const result = memorySchema.safeParse(memoryData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const memory = result.data;
        const keys = createMemoryKeys(memory);
        const item: MemoryItem = { ...memory, ...keys };

        await this.putItem(item as unknown as Record<string, unknown>);
        return memory;
    }

    async getById(id: string, memoryType: MemoryType): Promise<Memory | undefined> {
        const key: DynamoDBKey = {
            PK: `MEMORY#${id}`,
            SK: `TYPE#${memoryType}`,
        };

        const item = await this.getItem<MemoryItem>(key);
        if(!item) {
            return undefined;
        }

        return this.stripKeys(item);
    }

    async update(id: string, memoryType: MemoryType, input: UpdateMemoryInput): Promise<Memory> {
        const existing = await this.getById(id, memoryType);
        if(!existing) {
            throw new ItemNotFoundError(id);
        }

        const updatedData = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.metadata !== undefined && { metadata: input.metadata }),
            ...(input.TTL !== undefined && { TTL: input.TTL }),
            version:   existing.version + 1,
            updatedAt: new Date().toISOString(),
        };

        const result = memorySchema.safeParse(updatedData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const updated = result.data;
        const keys = createMemoryKeys(updated);
        const item: MemoryItem = { ...updated, ...keys };

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
                const current = await this.getById(id, memoryType);
                throw new ConflictError(
                    id,
                    existing.version,
                    current?.version ?? -1
                );
            }
            throw error;
        }

        return updated;
    }

    async delete(id: string, memoryType: MemoryType): Promise<void> {
        const key: DynamoDBKey = {
            PK: `MEMORY#${id}`,
            SK: `TYPE#${memoryType}`,
        };
        await this.deleteItem(key);
    }

    async queryByType(memoryType: MemoryType, options?: QueryOptions): Promise<QueryResult<Memory>> {
        const queryParams: Record<string, unknown> = {
            IndexName:                 'GSI1',
            KeyConditionExpression:    'GSI1PK = :pk',
            ExpressionAttributeValues: {
                ':pk': `TYPE#${memoryType}`,
            },
            ScanIndexForward: false, // Newest first
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

        const items = _map((result.Items ?? []) as MemoryItem[], item => this.stripKeys(item));

        let nextCursor: string | undefined;
        if(result.LastEvaluatedKey) {
            nextCursor = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
        }

        return { items, nextCursor };
    }

    private stripKeys(item: MemoryItem): Memory {
        const { PK: _PK, SK: _SK, GSI1PK: _GSI1PK, GSI1SK: _GSI1SK, ...memory } = item;
        return memory;
    }
}
