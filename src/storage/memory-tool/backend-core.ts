import { DateTime } from 'luxon';
import { type DynamoDBKey } from '../repositories/base';
import { MemoryToolKeyGenerator, generateContentPreview } from './key-generator';
import {
    memoryToolItemSchema,
    type MemoryPath,
    type ContentType,
    type MemoryToolItemData,
    type MemoryToolItem
} from './types';
import { ItemNotFoundError, ValidationError } from '@/errors';

export interface CreateMemoryToolItemInput {
    path:        MemoryPath
    content:     string
    contentType: ContentType
    metadata?:   Record<string, unknown>
    tags?:       Set<string>
    ttl?:        number   // DynamoDB TTL attribute (epoch seconds). When set, the item will be expired by DDB.
}

export interface UpdateMemoryToolItemInput {
    content?:           string
    metadata?:          Record<string, unknown>
    tags?:              Set<string>
    preserveUpdatedAt?: boolean
    ttl?:               number   // DynamoDB TTL attribute (epoch seconds). When set, overrides the existing TTL (or adds one if absent). When omitted, existing TTL is preserved.
}

/**
 * Core CRUD operations for the memory tool backend.
 * Handles create, get, update, and delete operations.
 */
export class MemoryToolBackendCore {
    constructor(
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

        // boundary cast: spreading a branded MemoryToolItem into a plain DynamoDB Record for putItem; branded MemoryPath/ContentType are runtime-compatible strings
        const ddbItem: Record<string, unknown> = { ...(item as unknown as Record<string, unknown>) };
        // Stryker disable next-line ConditionalExpression: TTL is an optional DDB attribute; absence is intentional when ttl is undefined
        if(input.ttl !== undefined) {
            ddbItem.TTL = input.ttl;
        }

        // boundary cast: constructor-injected putItem requires Record<string,unknown> but MemoryToolItem carries branded MemoryPath/ContentType; runtime shapes are compatible
        await this.putItem(ddbItem);

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
        const newContentPreview = input.content === undefined
            ? existing.contentPreview
            : generateContentPreview(input.content);

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

        // Preserve TTL across update — TTL is a DDB-level attribute (uppercase key), not part of
        // memoryToolItemSchema. stripDynamoKeys does not strip TTL, so it survives on the runtime
        // value of `existing` even though MemoryToolItemData has no TTL field. Without explicit
        // re-attachment, the Zod schema parse strips it and PutItem silently clears the expiration.
        // input.ttl takes priority (caller is refreshing the TTL); otherwise carry forward existing.
        const ttlToWrite = input.ttl ?? (existing as { TTL?: number }).TTL;

        const result = memoryToolItemSchema.safeParse(updatedData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const updated = result.data;
        // boundary cast: spreading a branded MemoryToolItem into a plain DynamoDB Record for putItem; branded MemoryPath/ContentType are runtime-compatible strings
        const ddbItem: Record<string, unknown> = { ...(this.buildUpdatedItem(updated) as unknown as Record<string, unknown>) };
        // Stryker disable next-line ConditionalExpression: TTL is an optional DDB attribute; absence is intentional when no TTL is set
        if(ttlToWrite !== undefined) {
            ddbItem.TTL = ttlToWrite;
        }

        // boundary cast: constructor-injected putItem requires Record<string,unknown> but MemoryToolItem carries branded MemoryPath/ContentType; runtime shapes are compatible
        await this.putItem(ddbItem);

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
