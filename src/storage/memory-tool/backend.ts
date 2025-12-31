import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BaseRepository } from '../repositories/base';
import {
    type MemoryPath,
    type MemoryToolItemData,
    type MemoryToolItem,
    type LayerName
} from './types';
import { MemoryToolBackendCore, type CreateMemoryToolItemInput, type UpdateMemoryToolItemInput } from './backend-core';
import { MemoryToolBackendQuery, type ListOptions, type ListResult } from './backend-query';
import { MemoryToolBackendVersions, type VersionInfo } from './backend-versions';

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

        const stripKeys = this.stripKeys.bind(this);

        this.coreOps = new MemoryToolBackendCore(
            docClient,
            tableName,
            this.putItem.bind(this),
            this.getItem.bind(this),
            this.deleteItem.bind(this),
            stripKeys
        );

        this.queryOps = new MemoryToolBackendQuery(
            docClient,
            tableName,
            stripKeys
        );

        this.versionOps = new MemoryToolBackendVersions(
            docClient,
            tableName,
            stripKeys,
            this.listByLayer.bind(this)
        );
    }

    // Core CRUD operations
    async create(input: CreateMemoryToolItemInput): Promise<MemoryToolItemData> {
        return this.coreOps.create(input);
    }

    async get(path: MemoryPath): Promise<MemoryToolItemData | undefined> {
        return this.coreOps.get(path);
    }

    async update(path: MemoryPath, input: UpdateMemoryToolItemInput): Promise<MemoryToolItemData> {
        return this.coreOps.update(path, input);
    }

    async delete(path: MemoryPath): Promise<void> {
        return this.coreOps.delete(path);
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

    private stripKeys(item: MemoryToolItem): MemoryToolItemData {
        const { PK: _PK, SK: _SK, GSI1PK: _GSI1PK, GSI1SK: _GSI1SK, GSI2PK: _GSI2PK, GSI2SK: _GSI2SK, ...data } = item;
        return data;
    }
}
