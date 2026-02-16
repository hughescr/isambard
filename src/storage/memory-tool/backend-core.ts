import { DateTime } from 'luxon';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type DynamoDBKey } from '../repositories/base';
import {
    memoryToolItemSchema,
    type MemoryPath,
    type ContentType,
    type MemoryToolItemData,
    type MemoryToolItem
} from './types';
import { MemoryToolKeyGenerator, generateContentPreview } from './key-generator';
import { ItemNotFoundError, ValidationError } from '@/errors';

export interface CreateMemoryToolItemInput {
    path:        MemoryPath
    content:     string
    contentType: ContentType
    metadata?:   Record<string, unknown>
    tags?:       Set<string>
}

export interface UpdateMemoryToolItemInput {
    content?:           string
    metadata?:          Record<string, unknown>
    tags?:              Set<string>
    preserveUpdatedAt?: boolean
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

    private buildUpdatedItem(updated: MemoryToolItemData): MemoryToolItem {
        const keys = MemoryToolKeyGenerator.createKeys(updated.path, updated.updatedAt);

        return {
            ...updated,
            ...keys,
        };
    }

    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const now = DateTime.utc().toISO();

        const itemData = {
            path:           input.path,
            content:        input.content,
            contentType:    input.contentType,
            // Stryker disable next-line LogicalOperator: ?? operator provides default empty object
            metadata:       input.metadata ?? {},
            tags:           input.tags && input.tags.size > 0 ? input.tags : undefined,
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

        const item: MemoryToolItem = {
            ...data,
            ...keys,
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

        // Build updated data with new content preview if content changed
        // Stryker disable next-line ConditionalExpression: Conditional prevents regenerating preview when content unchanged
        const newContentPreview = input.content !== undefined
            ? generateContentPreview(input.content)
            : existing.contentPreview;

        const updatedData = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.metadata !== undefined && { metadata: input.metadata }),
            ...(input.tags !== undefined && { tags: input.tags.size > 0 ? input.tags : undefined }),
            // Stryker disable next-line ConditionalExpression: Spread operator conditional - undefined values should not override existing contentPreview
            ...(newContentPreview !== undefined && { contentPreview: newContentPreview }),
            // updatedAt reflects "last touched" (content edit OR deliberate access via recordAccess),
            // not just content modification. This keeps accessed items visible in GSI1 time-ordered queries.
            // When preserveUpdatedAt is true (e.g. tag-only maintenance), the timestamp is not refreshed.
            updatedAt: input.preserveUpdatedAt ? existing.updatedAt : DateTime.utc().toISO(),
        };

        const result = memoryToolItemSchema.safeParse(updatedData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const updated = result.data;
        const item = this.buildUpdatedItem(updated);

        await this.putItem(item as unknown as Record<string, unknown>);

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
