import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BaseRepository } from '../repositories/base';
import { stripDynamoKeys } from '../utils/index.js';
import { logger } from '@hughescr/logger';
import {
    type MemoryPath,
    type MemoryToolItemData,
    type ContentType,
    type LayerName,
    type TagIndexItem,
    extractLayerFromPath
} from './types';
import { MemoryToolBackendCore, type CreateMemoryToolItemInput, type UpdateMemoryToolItemInput } from './backend-core';
import { MemoryToolBackendQuery, type ListOptions, type ListResult } from './backend-query';
import { MemoryToolBackendVersions, type VersionInfo } from './backend-versions';
import { MemoryToolBackendTagIndex } from './backend-tag-index';
import {
    TAG_REGISTRY_PATH,
    updateTagRegistry,
    decrementTagRegistry,
    computeTagChanges,
    type TagRegistryCallbacks
} from './backend-tag-registry';
import { getLayerConfig } from './layer-config';
import { normalizeTags, generateContentPreview } from './key-generator';

// Re-export types for public API
export type { CreateMemoryToolItemInput, UpdateMemoryToolItemInput } from './backend-core';
export type { ListOptions, ListResult } from './backend-query';
export type { VersionInfo } from './backend-versions';

/**
 * Memory tool backend facade that delegates to specialized modules.
 * Provides a unified API for all memory tool operations.
 */
export class MemoryToolBackend extends BaseRepository<MemoryToolItemData> {
    private readonly coreOps:     MemoryToolBackendCore;
    private readonly queryOps:    MemoryToolBackendQuery;
    private readonly versionOps:  MemoryToolBackendVersions;
    private readonly tagIndexOps: MemoryToolBackendTagIndex;

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

        this.tagIndexOps = new MemoryToolBackendTagIndex(
            docClient,
            tableName
        );

        this.queryOps = new MemoryToolBackendQuery(
            docClient,
            tableName,
            stripDynamoKeys,
            this.tagIndexOps
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
            updateDirect: (p: MemoryPath, existing: MemoryToolItemData, input: { content: string }) =>
                this.coreOps.updateWithoutVersioning(p, existing, input),
        };
    }

    // Core CRUD operations
    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const result = await this.coreOps.create(input);

        // Skip tag/registry update for the registry itself to prevent recursion
        // Stryker disable next-line ConditionalExpression,EqualityOperator: Guards against infinite recursion; optimization - registry functions short-circuit on empty arrays
        if(input.path !== TAG_REGISTRY_PATH && input.tags && input.tags.length > 0) {
            const normalizedTags = normalizeTags(input.tags);
            await updateTagRegistry(normalizedTags, this.createTagRegistryCallbacks());

            // Create tag index items (best-effort)
            const layer = extractLayerFromPath(input.path);
            // Stryker disable next-line StringLiteral: 'unknown' vs '' are equivalent fallback values for non-layer paths
            const layerStr = layer ?? 'unknown';
            const contentPreview = generateContentPreview(result.content);
            // Stryker disable BlockStatement: Tag index catch block has internal error handling
            try {
                await this.tagIndexOps.createTagIndexItems(
                    input.path,
                    normalizedTags,
                    result.updatedAt,
                    contentPreview,
                    layerStr
                );
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                logger.warn({ error, path: input.path, msg: 'Failed to create tag index items' });
                /* Stryker restore all */
            }
        }

        return result;
    }

    async get(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        return this.coreOps.get(path);
    }

    async update(path: MemoryPath, input: UpdateMemoryToolItemInput): Promise<MemoryToolItemData> {
        // Skip registry update for the registry itself to prevent recursion
        // Stryker disable next-line ConditionalExpression,BlockStatement: Prevents infinite recursion when updating tag registry itself
        if(path === TAG_REGISTRY_PATH) {
            return this.coreOps.update(path, input);
        }

        // Fetch existing item to compare tags
        const existing = await this.coreOps.get(path);
        const oldTags = existing?.tags;

        const result = await this.coreOps.update(path, input);

        // Prune old versions based on layer config
        const layer = extractLayerFromPath(path);
        if(layer) {
            const config = getLayerConfig(layer);
            await this.pruneVersions(path, config.maxVersions);
        }

        // Stryker disable next-line StringLiteral: 'unknown' vs '' are equivalent fallback values for non-layer paths
        const layerStr = layer ?? 'unknown';
        const contentPreview = generateContentPreview(result.content);
        const normalizedNewTags = normalizeTags(result.tags);

        // Update tag index items on any memory edit
        // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: Tag index updates are best-effort; condition is optimization guard
        if(normalizedNewTags.length > 0 || (oldTags && oldTags.length > 0)) {
            const normalizedOldTags = normalizeTags(oldTags);
            // Stryker disable BlockStatement: Tag index catch block has internal error handling
            try {
                await this.tagIndexOps.updateTagIndexItems(
                    path,
                    normalizedOldTags,
                    normalizedNewTags,
                    result.updatedAt,
                    contentPreview,
                    layerStr
                );
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                logger.warn({ error, path, msg: 'Failed to update tag index items' });
                /* Stryker restore all */
            }
        }

        // Only update registry if tags were explicitly changed
        // Stryker disable next-line ConditionalExpression: Optimization - skip tag processing when tags not in input
        if(input.tags !== undefined) {
            const { added, removed } = computeTagChanges(
                normalizeTags(oldTags),
                normalizedNewTags
            );
            const callbacks = this.createTagRegistryCallbacks();

            // Stryker disable next-line ConditionalExpression,EqualityOperator: Optimization - registry functions short-circuit on empty arrays
            if(added.length > 0) {
                await updateTagRegistry(added, callbacks);
            }
            // Stryker disable next-line ConditionalExpression,EqualityOperator: Optimization - registry functions short-circuit on empty arrays
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
        // Stryker disable next-line all: Tag length check is optimization - registry functions short-circuit on empty arrays
        if(existing?.tags && existing.tags.length > 0) {
            const normalizedTags = normalizeTags(existing.tags);
            await decrementTagRegistry(normalizedTags, this.createTagRegistryCallbacks());

            // Delete tag index items (best-effort)
            // Stryker disable BlockStatement: Tag index catch block has internal error handling
            try {
                await this.tagIndexOps.deleteTagIndexItems(path, normalizedTags);
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                logger.warn({ error, path, msg: 'Failed to delete tag index items' });
                /* Stryker restore all */
            }
        }
    }

    // Query operations
    async list(directoryPath: string, options?: ListOptions): Promise<ListResult<MemoryToolItemData>> {
        return this.queryOps.list(directoryPath, options);
    }

    async searchByTags(
        tags: string[],
        layer?: LayerName,
        options?: ListOptions
    ): Promise<ListResult<TagIndexItem>> {
        return this.queryOps.searchByTags(tags, layer, options);
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

    /**
     * Gets the tag index backend for reconciliation operations.
     * @internal
     */
    getTagIndexBackend(): MemoryToolBackendTagIndex {
        return this.tagIndexOps;
    }

    /**
     * Updates memory metadata without creating a version snapshot.
     * Used by reconciliation to clean up previouslyKnownAs metadata.
     * @internal
     */
    async updateMetadataOnly(
        path: MemoryPath,
        existing: MemoryToolItemData,
        input: { content?: string, metadata?: Record<string, unknown> }
    ): Promise<MemoryToolItemData> {
        return this.coreOps.updateWithoutVersioning(path, existing, input);
    }
}
