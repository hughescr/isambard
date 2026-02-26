import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { BaseRepository } from '../repositories/base';
import { stripDynamoKeys } from '../utils/index.js';
import { MemoryToolBackendCore, type CreateMemoryToolItemInput, type UpdateMemoryToolItemInput } from './backend-core';
import { MemoryToolBackendQuery, type ListOptions, type ListResult } from './backend-query';
import { MemoryToolBackendTagIndex } from './backend-tag-index';
import { normalizeTags, generateContentPreview } from './key-generator';
import {
    type MemoryPath,
    type MemoryToolItemData,
    type LayerName,
    type TagIndexItem,
    extractLayerFromPath
} from './types';

// Re-export types for public API
export type { CreateMemoryToolItemInput, UpdateMemoryToolItemInput } from './backend-core';
export type { ListOptions, ListResult, ScoredMemoryItem } from './backend-query';

/**
 * Memory tool backend facade that delegates to specialized modules.
 * Provides a unified API for all memory tool operations.
 */
export class MemoryToolBackend extends BaseRepository<MemoryToolItemData> {
    private readonly coreOps:     MemoryToolBackendCore;
    private readonly queryOps:    MemoryToolBackendQuery;
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
    }

    // Core CRUD operations
    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const result = await this.coreOps.create(input);

        // Create tag index items (best-effort) - counts handled internally by createTagIndexItems
        // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: Optimization - tag index operations are best-effort and short-circuit on empty arrays
        if(input.tags && input.tags.size > 0) {
            const normalizedTags = normalizeTags(input.tags);
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
        // Skip tag index updates for metadata-only changes (e.g. recordAccess).
        // The reconciler handles eventual consistency of tag index updatedAt/contentPreview.
        // Stryker disable next-line ConditionalExpression: contentOrTagsChanged guard is optimization; false-positive on removal
        const contentOrTagsChanged = input.content !== undefined || input.tags !== undefined;

        // Only fetch existing item for tag comparison when content/tags are changing
        const oldTags = contentOrTagsChanged
            ? (await this.coreOps.get(path))?.tags
            : undefined;

        const result = await this.coreOps.update(path, input);

        if(contentOrTagsChanged) {
            const layer = extractLayerFromPath(path);
            // Stryker disable next-line StringLiteral: 'unknown' vs '' are equivalent fallback values for non-layer paths
            const layerStr = layer ?? 'unknown';
            const contentPreview = generateContentPreview(result.content);
            const normalizedNewTags = normalizeTags(result.tags);

            // Update tag index items when content or tags change (counts handled internally)
            // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: Tag index updates are best-effort; condition is optimization guard
            if(normalizedNewTags.size > 0 || (oldTags && oldTags.size > 0)) {
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
        }

        return result;
    }

    async delete(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        // Fetch item first to get its tags
        const existing = await this.coreOps.get(path);

        await this.coreOps.delete(path);

        // Delete tag index items if item had tags (counts handled internally)
        // Stryker disable next-line all: Tag length check is optimization - tag index functions short-circuit on empty arrays
        if(existing?.tags && existing.tags.size > 0) {
            const normalizedTags = normalizeTags(existing.tags);

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

        return existing;
    }

    // Query operations
    async list(directoryPath: string, options?: ListOptions): Promise<ListResult<MemoryToolItemData>> {
        return this.queryOps.list(directoryPath, options);
    }

    async searchByTags(
        tags: Set<string>,
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

    async getAutoLoadItems(
        options?: { maxIdentityItems?: number, maxStateItems?: number, now?: Date }
    ): Promise<MemoryToolItemData[]> {
        return this.queryOps.getAutoLoadItems(options);
    }

    async getStateItemsScored(
        options?: { maxItems?: number, now?: Date }
    ): Promise<import('./backend-query').ScoredMemoryItem[]> {
        return this.queryOps.getStateItemsScored(options);
    }

    /**
     * Gets the tag index backend for reconciliation operations.
     * @internal
     */
    getTagIndexBackend(): MemoryToolBackendTagIndex {
        return this.tagIndexOps;
    }

    /**
     * Updates memory metadata directly without refreshing updatedAt.
     * Used by reconciliation to clean up previouslyKnownAs metadata.
     * Preserves updatedAt to avoid affecting sigmoid recency scoring.
     * @internal
     */
    async updateMetadataOnly(
        path: MemoryPath,
        input: { content?: string, metadata?: Record<string, unknown> }
    ): Promise<MemoryToolItemData> {
        return this.coreOps.update(path, { ...input, preserveUpdatedAt: true });
    }

    /**
     * Lists all tag counts by querying META_COUNT items.
     * Returns tags sorted by name.
     */
    async listTagCounts(): Promise<{ tag: string, count: number }[]> {
        return this.tagIndexOps.listTagCounts();
    }
}
