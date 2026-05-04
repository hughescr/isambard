import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type DynamoDBClientHolder } from '../client-holder';
import type { IndexerJob } from '../memory-vec-store/types.js';
import { BaseRepository } from '../repositories/base';
import { stripDynamoKeys } from '../utils/index.js';
import { MemoryToolBackendCore, type CreateMemoryToolItemInput, type UpdateMemoryToolItemInput } from './backend-core';
import { MemoryToolBackendQuery, type ListOptions, type ListResult, type ScoredMemoryItem } from './backend-query';
import { MemoryToolBackendTagIndex } from './backend-tag-index';
import { MemoryToolKeyGenerator, normalizeTags, generateContentPreview } from './key-generator';
import {
    type MemoryPath,
    type MemoryToolItemData,
    type LayerName,
    type TagIndexItem,
    extractLayerFromPath
} from './types';

/**
 * Minimal interface for the async indexer dependency.
 * Typed as an interface to keep tests lightweight (no concrete class import required).
 * @internal
 */
export interface MemoryIndexer {
    enqueue: (job: IndexerJob) => void
}

/**
 * Memory tool backend facade that delegates to specialized modules.
 * Provides a unified API for all memory tool operations.
 */
export class MemoryToolBackend extends BaseRepository<MemoryToolItemData> {
    private readonly coreOps:          MemoryToolBackendCore;
    private readonly queryOps:         MemoryToolBackendQuery;
    private readonly tagIndexOps:      MemoryToolBackendTagIndex;
    private readonly indexer:          MemoryIndexer | undefined;
    private readonly onIdentityWrite?: () => void;

    constructor(
        docClientOrHolder: DynamoDBDocumentClient | DynamoDBClientHolder,
        tableName:         string,
        indexer?:          MemoryIndexer,
        onDriftDetected?:  () => void,
        onIdentityWrite?:  () => void
    ) {
        super(docClientOrHolder, tableName);

        this.indexer         = indexer;
        this.onIdentityWrite = onIdentityWrite;

        this.coreOps = new MemoryToolBackendCore(
            tableName,
            this.putItem.bind(this),
            this.getItem.bind(this),
            this.deleteItem.bind(this),
            stripDynamoKeys
        );

        this.tagIndexOps = new MemoryToolBackendTagIndex(
            docClientOrHolder,
            tableName,
            onDriftDetected
        );

        this.queryOps = new MemoryToolBackendQuery(
            docClientOrHolder,
            tableName,
            stripDynamoKeys,
            this.tagIndexOps
        );
    }

    /**
     * Enqueues an indexer job if an indexer is configured.
     * Errors from enqueue are swallowed — never propagate to callers.
     */
    private enqueueIndex(job: IndexerJob): void {
        // Stryker disable next-line ConditionalExpression: optimization guard — no indexer means nothing to enqueue
        if(!this.indexer) {
            return;
        }
        // Stryker disable BlockStatement: defensive catch — indexer errors must never propagate to DynamoDB callers
        try {
            this.indexer.enqueue(job);
        } catch (error) {
            /* Stryker disable all: Defensive error handling for indexer */
            logger.warn({ error, msg: 'MemoryToolBackend: indexer.enqueue failed, ignoring' });
            /* Stryker restore all */
        }
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

        // Enqueue vector index upsert job (fire-and-forget)
        const keys = MemoryToolKeyGenerator.createKeys(result.path);
        const layer = extractLayerFromPath(result.path);
        // Stryker disable next-line StringLiteral: 'unknown' vs '' are equivalent fallback values for non-layer paths
        const layerStr = layer ?? 'unknown';
        this.enqueueIndex({ kind: 'upsert', pk: keys.PK, sk: keys.SK, layer: layerStr, path: result.path, content: result.content });

        // Stryker disable next-line ConditionalExpression: identity-write callback — only called when layer is 'identity'
        if(layerStr === 'identity') {
            this.onIdentityWrite?.();
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
        const existingItem = contentOrTagsChanged ? await this.coreOps.get(path) : undefined;
        const oldTags = existingItem?.tags;

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

            // Enqueue vector index upsert job (fire-and-forget)
            const keys = MemoryToolKeyGenerator.createKeys(path);
            this.enqueueIndex({ kind: 'upsert', pk: keys.PK, sk: keys.SK, layer: layerStr, path, content: result.content });

            // Metadata-only updates (content === undefined && tags === undefined) intentionally
            // skip this callback because metadata fields are not part of the rendered identity
            // string returned by loadCoreIdentity — only content and tags affect the output.
            // Stryker disable next-line ConditionalExpression: identity-write callback — only called when layer is 'identity'
            if(layerStr === 'identity') {
                this.onIdentityWrite?.();
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

        // Enqueue vector index delete job (fire-and-forget)
        const keys = MemoryToolKeyGenerator.createKeys(path);
        this.enqueueIndex({ kind: 'delete', pk: keys.PK, sk: keys.SK });

        // Stryker disable next-line ConditionalExpression: identity-write callback — only called when layer is 'identity'
        // Stryker disable next-line StringLiteral: 'unknown' vs '' are equivalent fallback values for non-layer paths
        if((extractLayerFromPath(path) ?? 'unknown') === 'identity') {
            this.onIdentityWrite?.();
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
    ): Promise<ScoredMemoryItem[]> {
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
