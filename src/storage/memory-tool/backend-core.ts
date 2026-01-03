import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { isObject as _isObject } from 'lodash';
import { type DynamoDBKey } from '../repositories/base';
import {
    memoryToolItemSchema,
    type MemoryPath,
    type ContentType,
    type MemoryToolItemData,
    type MemoryToolItem
} from './types';
import { MemoryToolKeyGenerator, generateContentPreview } from './key-generator';
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

/**
 * Core CRUD operations for the memory tool backend.
 * Handles create, get, update, and delete operations.
 */
export class MemoryToolBackendCore {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string,
        private readonly putItem: (item: Record<string, unknown>) => Promise<void>,
        private readonly getItem: <R>(key: DynamoDBKey) => Promise<R | undefined>,
        private readonly deleteItem: (key: DynamoDBKey) => Promise<void>,
        private readonly stripKeys: (item: MemoryToolItem) => MemoryToolItemData
    ) {}

    private createVersionSnapshot(existing: MemoryToolItemData): MemoryToolItem {
        const versionKeys = MemoryToolKeyGenerator.createVersionKeys(existing.path, existing.version, existing.updatedAt);
        const existingKeys = MemoryToolKeyGenerator.createKeys(existing.path, existing.createdAt);
        const existingTagKeys = MemoryToolKeyGenerator.createTagKeys(existing.path, existing.tags, existing.updatedAt);

        return {
            ...existing,
            ...versionKeys,
            GSI1PK: existingKeys.GSI1PK,
            GSI1SK: existingKeys.GSI1SK,
            ...(existingTagKeys && { GSI2PK: existingTagKeys.GSI2PK, GSI2SK: existingTagKeys.GSI2SK }),
        };
    }

    private buildUpdatedItem(updated: MemoryToolItemData): MemoryToolItem {
        const keys = MemoryToolKeyGenerator.createKeys(updated.path, updated.updatedAt);
        const tagKeys = MemoryToolKeyGenerator.createTagKeys(updated.path, updated.tags, updated.updatedAt);

        return {
            ...updated,
            ...keys,
            ...(tagKeys && { GSI2PK: tagKeys.GSI2PK, GSI2SK: tagKeys.GSI2SK }),
        };
    }

    private isConditionalCheckFailed(error: unknown): boolean {
        return Boolean(error && _isObject(error) && 'name' in error && error.name === 'ConditionalCheckFailedException');
    }

    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const now = new Date().toISOString();

        const itemData = {
            path:           input.path,
            content:        input.content,
            contentType:    input.contentType,
            metadata:       input.metadata ?? {},
            tags:           input.tags,
            version:        1,
            createdAt:      now,
            updatedAt:      now,
            contentPreview: generateContentPreview(input.content),
        };

        const result = memoryToolItemSchema.safeParse(itemData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const data = result.data;
        const keys = MemoryToolKeyGenerator.createKeys(data.path, data.updatedAt);

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
        const versionSnapshot = this.createVersionSnapshot(existing);
        await this.putItem(versionSnapshot as unknown as Record<string, unknown>);

        // Build updated data with new content preview if content changed
        const newContentPreview = input.content !== undefined
            ? generateContentPreview(input.content)
            : existing.contentPreview;

        const updatedData = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.metadata !== undefined && { metadata: input.metadata }),
            ...(input.tags !== undefined && { tags: input.tags }),
            ...(newContentPreview !== undefined && { contentPreview: newContentPreview }),
            version:   existing.version + 1,
            updatedAt: new Date().toISOString(),
        };

        const result = memoryToolItemSchema.safeParse(updatedData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const updated = result.data;
        const item = this.buildUpdatedItem(updated);

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
            if(this.isConditionalCheckFailed(error)) {
                const current = await this.get(path);
                throw new ConflictError(path, existing.version, current?.version ?? -1);
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
}
