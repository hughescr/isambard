import { type DynamoDBDocumentClient, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type DynamoDBClientHolder } from '../client-holder';
import type { IndexerJob } from '../memory-vec-store/types.js';
import { DynamoTableAccess } from '../repositories/base';
import { MemoryToolBackendCore, type CreateMemoryToolItemInput, type UpdateMemoryToolItemInput } from './backend-core';
import { MemoryToolBackendQuery, type IndexNamespacePage, type ListOptions, type ListResult, type ScoredMemoryItem } from './backend-query';
import { MemoryToolBackendTagIndex } from './backend-tag-index';
import { normalizeTags, generateContentPreview, MemoryToolKeyGenerator } from './key-generator';
import type { TagIndexReconciliationOps } from './reconciliation/reconciler';
import {
    type MemoryPath,
    type MemoryToolItemData,
    type LayerName,
    type IndexLayer,
    type TagIndexReadItem,
    classifyMemoryPath
} from './types';

type FailedMemoryItem = Record<string, { M?: Record<string, unknown> }>;

/** Conditional failures include the previous row as raw DynamoDB AttributeValues. */
function conditionalFailureItem(error: unknown): FailedMemoryItem | undefined {
    if(!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
        throw error;
    }
    return (error as Error & { Item?: FailedMemoryItem }).Item;
}

function accessRepair(key: { PK: string, SK: string }, timestamp: string, gsi: string, replaceMap: boolean): Omit<UpdateCommandInput, 'TableName'> {
    return {
        Key:                                 key,
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',

        UpdateExpression: replaceMap
            ? 'SET #metadata = :fresh, updatedAt = :now, GSI1SK = :gsi'
            : 'SET #metadata.accessCount = :one, #metadata.lastAccessed = :now, updatedAt = :now, GSI1SK = :gsi',
        ConditionExpression: replaceMap
            ? 'attribute_exists(PK) AND (attribute_not_exists(#metadata) OR NOT attribute_type(#metadata, :map))'
            : 'attribute_exists(PK) AND attribute_type(#metadata, :map) AND attribute_exists(#metadata.accessCount) AND NOT attribute_type(#metadata.accessCount, :number)',
        ExpressionAttributeValues: replaceMap
            ? { ':now': timestamp, ':gsi': gsi, ':map': 'M', ':fresh': { accessCount: 1, lastAccessed: timestamp } }
            : { ':one': 1, ':now': timestamp, ':gsi': gsi, ':map': 'M', ':number': 'N' },
        ExpressionAttributeNames: { '#metadata': 'metadata' },
    };
}

/** Module-only key for binding reconciliation without exposing named facade methods. */
export const reconciliationAccess = Symbol('memory-tool-reconciliation-access');

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
export class MemoryToolBackend extends DynamoTableAccess {
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
        onIdentityWrite?:  () => void,
        timeoutMs?:        number
    ) {
        super(docClientOrHolder, tableName, timeoutMs);

        this.indexer         = indexer;
        this.onIdentityWrite = onIdentityWrite;

        this.coreOps = new MemoryToolBackendCore(
            tableName,
            this.putItem.bind(this),
            this.getItem.bind(this),
            this.deleteItem.bind(this)
        );

        this.tagIndexOps = new MemoryToolBackendTagIndex(
            docClientOrHolder,
            tableName,
            onDriftDetected
        );

        this.queryOps = new MemoryToolBackendQuery(
            docClientOrHolder,
            tableName,
            this.tagIndexOps
        );
    }

    /**
     * Enqueues an indexer job if an indexer is configured.
     * Errors from enqueue are swallowed — never propagate to callers.
     */
    private enqueueIndex(job: IndexerJob): void {
        if(!this.indexer) {
            return;
        }
        try {
            // Stryker disable next-line llm: MemoryIndexer.enqueue is typed (job) => void, so prefixing the call with void preserves the invocation, its throw path and the undefined result
            this.indexer.enqueue(job);
        } catch (error) {
            logger.warn({ error, msg: 'MemoryToolBackend: indexer.enqueue failed, ignoring' });
        }
    }

    // Core CRUD operations
    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        const result = await this.coreOps.create(input);

        // Create tag index items (best-effort) - counts handled internally by createTagIndexItems
        const normalizedTags = normalizeTags(input.tags);
        const layerStr = classifyMemoryPath(input.path).namespace;
        const contentPreview = generateContentPreview(result.content);
        try {
            await this.tagIndexOps.createTagIndexItems(
                input.path,
                normalizedTags,
                result.updatedAt,
                contentPreview,
                layerStr
            );
        } catch (error) {
            logger.warn({ error, path: input.path, msg: 'Failed to create tag index items' });
        }

        // Enqueue vector index upsert job (fire-and-forget), carrying the TTL and updatedAt written
        // to DynamoDB; the updatedAt is the source version that guards the row against stale writes
        this.enqueueIndex({ kind: 'upsert', layer: layerStr, path: result.path, content: result.content, ttl: input.ttl, sourceUpdatedAt: Date.parse(result.updatedAt) });

        if(layerStr === 'identity') {
            this.onIdentityWrite?.();
        }

        return result;
    }

    async get(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        return this.coreOps.get(path);
    }

    /** Atomically record each access; stale paths are skipped and independent failures do not starve later paths. */
    async recordMemoryAccess(paths: MemoryPath[], now: Date): Promise<void> {
        const timestamp = now.toISOString();
        let firstError: Error | undefined;
        for(const path of paths) {
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential writes respect the provisioned 2-WCU table
                await this.recordSingleMemoryAccess(path, timestamp);
            } catch (error) {
                firstError ??= error instanceof Error ? error : new Error(String(error));
            }
        }
        if(firstError !== undefined) {
            throw firstError;
        }
    }

    private async recordSingleMemoryAccess(path: MemoryPath, timestamp: string): Promise<void> {
        const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);
        const common = {
            Key:                                 { PK: keys.PK, SK: keys.SK },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const,
        };
        const values = {
            ':zero':   0,
            ':one':    1,
            ':now':    timestamp,
            ':gsi':    keys.GSI1SK,
            ':map':    'M',
            ':number': 'N',
        };
        const healthy: Omit<UpdateCommandInput, 'TableName'> = {
            ...common,
            UpdateExpression:          'SET #metadata.accessCount = if_not_exists(#metadata.accessCount, :zero) + :one, #metadata.lastAccessed = :now, updatedAt = :now, GSI1SK = :gsi',
            ConditionExpression:       'attribute_exists(PK) AND attribute_type(#metadata, :map) AND (attribute_not_exists(#metadata.accessCount) OR attribute_type(#metadata.accessCount, :number))',
            ExpressionAttributeValues: values,
            ExpressionAttributeNames:  { '#metadata': 'metadata' },
        };

        // A conditional failure carries ALL_OLD: no read on the normal or legacy path.
        // A racing repair retries the atomic increment, never a read-then-put overwrite.
        for(let attempt = 0; attempt < 3; attempt++) {
            let replaceMap: boolean;
            try {
                // eslint-disable-next-line no-await-in-loop -- conditional repair must finish before retrying the same row
                await this.updateItem(healthy, 'recordMemoryAccess');
                return;
            } catch (error) {
                const failedItem = conditionalFailureItem(error);
                if(!failedItem) {
                    logger.debug({ path, msg: 'Memory access skipped: item no longer exists' });
                    return;
                }
                // DynamoDB returns ALL_OLD on an exception in raw AttributeValue form; the
                // document-client's success-output unmarshalling does not run for errors.
                const metadataMap = failedItem.metadata?.M;
                replaceMap = metadataMap === undefined;
                if(metadataMap !== undefined && metadataMap.accessCount === undefined) {
                    continue;
                }
            }
            const repair = accessRepair(common.Key, timestamp, keys.GSI1SK, replaceMap);
            // eslint-disable-next-line no-await-in-loop -- repair is conditional on the failed update's row shape
            if(await this.tryMemoryAccessRepair(repair, path)) {
                return;
            }
        }
        throw new Error(`Memory access repair conflicts exceeded for ${path}`);
    }

    private async tryMemoryAccessRepair(repair: Omit<UpdateCommandInput, 'TableName'>, path: MemoryPath): Promise<boolean> {
        try {
            await this.updateItem(repair, 'recordMemoryAccessRepair');
            return true;
        } catch (error) {
            if(!conditionalFailureItem(error)) {
                logger.debug({ path, msg: 'Memory access skipped: item no longer exists' });
                return true;
            }
            return false;
        }
    }

    async update(path: MemoryPath, input: UpdateMemoryToolItemInput): Promise<MemoryToolItemData> {
        // Skip tag index updates for metadata-only changes (e.g. reconciliation).
        // The reconciler handles eventual consistency of tag index updatedAt/contentPreview.
        const contentOrTagsChanged = input.content !== undefined || input.tags !== undefined;

        // Only fetch existing item for tag comparison when content/tags are changing
        const existingItem = contentOrTagsChanged ? await this.coreOps.get(path) : undefined;
        const oldTags = existingItem?.tags;

        // The TTL comes from the core write itself, so the index gets exactly what was persisted.
        const { item: result, ttl } = await this.coreOps.updateWithTtl(path, input);
        const layerStr = classifyMemoryPath(path).namespace;

        if(contentOrTagsChanged) {
            const contentPreview = generateContentPreview(result.content);
            const normalizedNewTags = normalizeTags(result.tags);

            // Update tag index items when content or tags change (counts handled internally)
            const normalizedOldTags = normalizeTags(oldTags);
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
                logger.warn({ error, path, msg: 'Failed to update tag index items' });
            }
        }

        // Enqueue vector index upsert job (fire-and-forget). A TTL-only refresh re-enqueues too:
        // the indexer's hash check skips the embed and just updates the row's TTL.
        if(contentOrTagsChanged || input.ttl !== undefined) {
            this.enqueueIndex({ kind: 'upsert', layer: layerStr, path, content: result.content, ttl, sourceUpdatedAt: Date.parse(result.updatedAt) });
        }

        // Metadata-only updates (content === undefined && tags === undefined) intentionally
        // skip this callback because metadata fields are not part of the rendered identity
        // string returned by loadCoreIdentity — only content and tags affect the output.
        if(contentOrTagsChanged && layerStr === 'identity') {
            this.onIdentityWrite?.();
        }

        return result;
    }

    async delete(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        // Fetch item first to get its tags
        const existing = await this.coreOps.get(path);

        await this.coreOps.delete(path);
        // Captured immediately after the DynamoDB delete completes (#134), not after the
        // best-effort tag-index cleanup below: enqueueIndex() carries this as the delete job's own
        // version marker, so a delayed enqueue never understates how fresh the delete was.
        const sourceUpdatedAt = Date.now();

        // Delete tag index items if item had tags (counts handled internally)
        const normalizedTags = normalizeTags(existing?.tags);

        // Delete tag index items (best-effort)
        try {
            await this.tagIndexOps.deleteTagIndexItems(path, normalizedTags);
        } catch (error) {
            logger.warn({ error, path, msg: 'Failed to delete tag index items' });
        }

        // Enqueue vector index delete job (fire-and-forget)
        this.enqueueIndex({ kind: 'delete', path, sourceUpdatedAt });

        if(classifyMemoryPath(path).namespace === 'identity') {
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
        layer?: IndexLayer,
        options?: ListOptions
    ): Promise<ListResult<TagIndexReadItem>> {
        return this.queryOps.searchByTags(tags, layer, options);
    }

    async listByLayer(
        layer: LayerName,
        options?: ListOptions
    ): Promise<ListResult<MemoryToolItemData>> {
        return this.queryOps.listByLayer(layer, options);
    }

    /** Enumerate one indexed path namespace, including nested paths, with the page's consumed read units. */
    async listByIndexNamespace(namespace: IndexLayer, options?: ListOptions): Promise<IndexNamespacePage> {
        return this.queryOps.listByIndexNamespace(namespace, options);
    }

    async searchByTimeRange(
        startTime: string,
        endTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        return this.queryOps.searchByTimeRange(startTime, endTime, layer, options);
    }

    async searchSince(
        startTime: string,
        layer?: LayerName,
        options?: { limit?: number }
    ): Promise<MemoryToolItemData[]> {
        return this.queryOps.searchSince(startTime, layer, options);
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

    [reconciliationAccess](): { tagIndex: TagIndexReconciliationOps } {
        return { tagIndex: this.tagIndexOps };
    }

    /**
     * Lists all tag counts by querying META_COUNT items.
     * Returns tags sorted by name.
     */
    async listTagCounts(): Promise<{ tag: string, count: number }[]> {
        return this.tagIndexOps.listTagCounts();
    }
}
