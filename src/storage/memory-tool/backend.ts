import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BaseRepository } from '../repositories/base';
import { stripDynamoKeys } from '../utils/index.js';
import {
    type MemoryPath,
    type MemoryToolItemData,
    type ContentType,
    type LayerName
} from './types';
import { MemoryToolBackendCore, type CreateMemoryToolItemInput, type UpdateMemoryToolItemInput } from './backend-core';
import { MemoryToolBackendQuery, type ListOptions, type ListResult } from './backend-query';
import { MemoryToolBackendVersions, type VersionInfo } from './backend-versions';
import {
    TAG_REGISTRY_PATH,
    updateTagRegistry,
    decrementTagRegistry,
    computeTagChanges,
    type TagRegistryCallbacks
} from './backend-tag-registry';

// Re-export types for public API
export type { CreateMemoryToolItemInput, UpdateMemoryToolItemInput } from './backend-core';
export type { ListOptions, ListResult } from './backend-query';
export type { VersionInfo } from './backend-versions';

/**
 * Memory tool backend facade that delegates to specialized modules.
 * Provides a unified API for all memory tool operations.
 */
export class MemoryToolBackend extends BaseRepository<MemoryToolItemData> {
    private readonly coreOps:    MemoryToolBackendCore;
    private readonly queryOps:   MemoryToolBackendQuery;
    private readonly versionOps: MemoryToolBackendVersions;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        super(docClient, tableName);

        this.coreOps = new MemoryToolBackendCore(
            docClient,
            tableName,
            this.putItem.bind(this),
            this.getItem.bind(this),
            this.deleteItem.bind(this),
            stripDynamoKeys
        );

        this.queryOps = new MemoryToolBackendQuery(
            docClient,
            tableName,
            stripDynamoKeys
        );

        this.versionOps = new MemoryToolBackendVersions(
            docClient,
            tableName,
            stripDynamoKeys,
            this.listByLayer.bind(this)
        );
    }

    /**
     * Creates tag registry callbacks that use core operations directly.
     * This avoids infinite recursion when updating the registry itself.
     */
    private createTagRegistryCallbacks(): TagRegistryCallbacks {
        return {
            get:    (p: MemoryPath) => this.coreOps.get(p),
            create: (input: { path: MemoryPath, content: string, contentType: ContentType, metadata?: Record<string, unknown> }) =>
                this.coreOps.create(input),
            update: (p: MemoryPath, input: { content: string }) =>
                this.coreOps.update(p, input),
        };
    }

    // Core CRUD operations
    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const result = await this.coreOps.create(input);

        // Skip registry update for the registry itself to prevent recursion
        // Stryker disable next-line ConditionalExpression,EqualityOperator: Guards against infinite recursion; optimization - registry functions short-circuit on empty arrays
        if(input.path !== TAG_REGISTRY_PATH && input.tags && input.tags.length > 0) {
            await updateTagRegistry(input.tags, this.createTagRegistryCallbacks());
        }

        return result;
    }

    async get(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        return this.coreOps.get(path);
    }

    async update(path: MemoryPath, input: UpdateMemoryToolItemInput): Promise<MemoryToolItemData> {
        // Skip registry update for the registry itself to prevent recursion
        // Stryker disable next-line ConditionalExpression: Prevents infinite recursion when updating tag registry itself
        if(path === TAG_REGISTRY_PATH) {
            return this.coreOps.update(path, input);
        }

        // Fetch existing item to compare tags
        const existing = await this.coreOps.get(path);
        const oldTags = existing?.tags;

        const result = await this.coreOps.update(path, input);

        // Only update registry if tags were explicitly changed
        // Stryker disable next-line ConditionalExpression: Optimization - skip tag processing when tags not in input
        if(input.tags !== undefined) {
            const { added, removed } = computeTagChanges(oldTags, input.tags);
            const callbacks = this.createTagRegistryCallbacks();

            // Stryker disable next-line ConditionalExpression,EqualityOperator: Optimization - registry functions short-circuit on empty arrays
            if(added.length > 0) {
                await updateTagRegistry(added, callbacks);
            }
            // Stryker disable next-line EqualityOperator: Optimization - registry functions short-circuit on empty arrays
            if(removed.length > 0) {
                await decrementTagRegistry(removed, callbacks);
            }
        }

        return result;
    }

    async delete(path: MemoryPath): Promise<void> {
        // Skip registry update for the registry itself to prevent recursion
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - skips unnecessary item fetch; behavior identical either way
        if(path === TAG_REGISTRY_PATH) {
            return this.coreOps.delete(path);
        }

        // Fetch item first to get its tags for decrementing
        const existing = await this.coreOps.get(path);

        await this.coreOps.delete(path);

        // Decrement tag counts if item had tags
        // Stryker disable next-line EqualityOperator: Optimization - registry functions short-circuit on empty arrays
        if(existing?.tags && existing.tags.length > 0) {
            await decrementTagRegistry(existing.tags, this.createTagRegistryCallbacks());
        }
    }

    // Query operations
    async list(directoryPath: string, options?: ListOptions): Promise<ListResult<MemoryToolItemData>> {
        return this.queryOps.list(directoryPath, options);
    }

    async searchByTag(
        tag: string,
        layer?: LayerName,
        options?: ListOptions
    ): Promise<ListResult<MemoryToolItemData>> {
        return this.queryOps.searchByTag(tag, layer, options);
    }

    async listByLayer(
        layer: LayerName,
        options?: ListOptions
    ): Promise<ListResult<MemoryToolItemData>> {
        return this.queryOps.listByLayer(layer, options);
    }

    async searchByTimeRange(
        startTime: string,
        endTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        return this.queryOps.searchByTimeRange(startTime, endTime, layer, options);
    }

    // Version operations
    async getVersion(path: MemoryPath, version: number): Promise<MemoryToolItemData | undefined> {
        return this.versionOps.getVersion(path, version);
    }

    async listVersions(path: MemoryPath, limit?: number): Promise<VersionInfo[]> {
        return this.versionOps.listVersions(path, limit);
    }

    async pruneVersions(path: MemoryPath, keepCount: number): Promise<number> {
        return this.versionOps.pruneVersions(path, keepCount);
    }

    async getAutoLoadItems(
        options?: { maxIdentityItems?: number, maxStateItems?: number }
    ): Promise<MemoryToolItemData[]> {
        return this.versionOps.getAutoLoadItems(options);
    }
}
