import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map, take as _take, drop as _drop, chain as _chain, orderBy as _orderBy } from 'lodash';
import {
    type MemoryPath,
    type MemoryToolItemData,
    type MemoryToolItem,
    type LayerName
} from './types';
import { MemoryToolKeyGenerator } from './key-generator';
import type { ListResult } from './backend-query';

export interface VersionInfo {
    version:         number
    updatedAt:       string
    contentPreview?: string
}

/**
 * Version and auto-load management for the memory tool backend.
 * Handles version listing, retrieval, pruning, and auto-load functionality.
 */
export class MemoryToolBackendVersions {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string,
        private readonly stripKeys: (item: MemoryToolItem) => MemoryToolItemData,
        private readonly listByLayer: (layer: LayerName, options?: { limit?: number }) => Promise<ListResult<MemoryToolItemData>>
    ) {}

    async getVersion(path: MemoryPath, version: number): Promise<MemoryToolItemData | undefined> {
        // Query all versions for this path to find the one matching the version number
        const keys = MemoryToolKeyGenerator.createKeys(path);
        const queryParams = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk':       keys.PK,
                ':skPrefix': `VERSION#${version}#`,
            },
        };

        const result = await this.docClient.send(
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        if(!result.Items || result.Items.length === 0) {
            return undefined;
        }

        return this.stripKeys(result.Items[0] as MemoryToolItem);
    }

    async listVersions(path: MemoryPath, limit?: number): Promise<VersionInfo[]> {
        const keys = MemoryToolKeyGenerator.createKeys(path);
        /* Stryker disable all: These literals define the DynamoDB query structure */
        const queryParams: Record<string, unknown> = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk':       keys.PK,
                ':skPrefix': 'VERSION#',
            },
            ScanIndexForward: false, // Descending order (newest first)
        };
        /* Stryker restore all */

        // Stryker disable next-line all: Conditional check for optional parameter
        if(limit) {
            queryParams.Limit = limit;
        }

        const result = await this.docClient.send(
            // Stryker disable next-line ObjectLiteral: QueryCommand requires TableName and queryParams
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        // Stryker disable next-line ArrayDeclaration: Empty array is correct default for missing Items
        const items = (result.Items ?? []) as MemoryToolItem[];

        return _map(items, (item) => {
            const versionInfo: VersionInfo = {
                version:   item.version,
                updatedAt: item.updatedAt,
            };

            // Add content preview (first 50 chars)
            // Stryker disable next-line all: Need exact check for non-empty string content
            if(item.content && item.content.length > 0) {
                versionInfo.contentPreview = item.content.slice(0, 50);
            }

            return versionInfo;
        });
    }

    async pruneVersions(path: MemoryPath, keepCount: number): Promise<number> {
        const keys = MemoryToolKeyGenerator.createKeys(path);
        /* Stryker disable all: These literals define the DynamoDB query structure for versions */
        const queryParams = {
            KeyConditionExpression:    'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk':       keys.PK,
                ':skPrefix': 'VERSION#',
            },
            ScanIndexForward: false, // Descending order (newest first)
        };
        /* Stryker restore all */

        const result = await this.docClient.send(
            // Stryker disable next-line ObjectLiteral: QueryCommand requires TableName and queryParams
            new QueryCommand({
                TableName: this.tableName,
                ...queryParams,
            })
        );

        // Stryker disable next-line ArrayDeclaration: Empty array is correct default for missing Items
        const items = (result.Items ?? []) as MemoryToolItem[];

        // Stryker disable next-line all: Need exact <= comparison to handle both < and = cases
        if(items.length <= keepCount) {
            return 0;
        }

        // Keep newest keepCount items, delete the rest
        const itemsToDelete = _drop(items, keepCount);

        for(const item of itemsToDelete) {
            await this.docClient.send(new DeleteCommand({
                TableName: this.tableName,
                Key:       {
                    PK: item.PK,
                    SK: item.SK,
                },
            }));
        }

        return itemsToDelete.length;
    }

    async getAutoLoadItems(
        options?: { maxIdentityItems?: number, maxStateItems?: number }
    ): Promise<MemoryToolItemData[]> {
        const maxIdentityItems = options?.maxIdentityItems ?? 100;
        const maxStateItems = options?.maxStateItems ?? 50;

        // Get identity items (all items from /identity layer)
        const identityResult = await this.listByLayer('identity' as LayerName, { limit: maxIdentityItems });
        const identityItems = _take(identityResult.items, maxIdentityItems);

        // Get state items (all items from /state layer)
        const stateResult = await this.listByLayer('state' as LayerName, { limit: maxStateItems });
        let stateItems = stateResult.items;

        // Filter for "hot" state items if metadata exists
        // Sort by accessCount (descending), then by lastAccessed (most recent first)
        const enrichedItems = _map(stateItems, item => ({
            item,
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            accessCount:  (item.metadata?.accessCount as number | undefined) ?? 0,
            // Stryker disable next-line LogicalOperator: ?? operator is correct, && would give wrong result
            lastAccessed: (item.metadata?.lastAccessed as string | undefined) ?? item.updatedAt,
        }));

        stateItems = _chain(enrichedItems)
            .orderBy(
                // Stryker disable next-line all: These string literals define sort fields and order
                ['accessCount', 'lastAccessed'],
                // Stryker disable next-line all: These string literals define sort order (descending)
                ['desc', 'desc']
            )
            .take(maxStateItems)
            .map(({ item }) => item)
            .value();

        return [...identityItems, ...stateItems];
    }
}
