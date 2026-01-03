/**
 * Migration script to backfill existing DynamoDB items with:
 * - GSI1PK: LAYER#{layer} - allows lookup by layer
 * - GSI1SK: UPDATED#{timestamp} - time-based sorting within layer
 * - contentPreview: first 100 chars of content for GSI2 projection
 *
 * Usage:
 *   bunx sst shell -- bun run scripts/migrate-schema.ts
 *
 * The script is idempotent - safe to run multiple times.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Resource } from 'sst';
import { split as _split, startsWith as _startsWith } from 'lodash';
import { extractLayerFromPath, createMemoryPath } from '../src/storage/memory-tool/types';
import { generateContentPreview, MemoryToolKeyGenerator } from '../src/storage/memory-tool/key-generator';

interface MigrationStats {
    totalScanned:        number
    memoryUpdated:       number
    messageCacheSkipped: number
    versionSkipped:      number
    errors:              number
}

interface DynamoItem {
    PK:         string
    SK:         string
    path?:      string
    content?:   string
    updatedAt?: string
    GSI1PK?:    string
    GSI1SK?:    string
}

// SST Resource type for DynamoDB table name access
interface SSTResource {
    DynamoDBTableName: { value: string }
}

/**
 * Gets the DynamoDB table name from SST Resource or environment variable.
 */
function getTableName(): string {
    try {
        // Primary: SST Resource binding (DynamoDBTableName linkable)
        const tableName = (Resource as unknown as SSTResource).DynamoDBTableName.value;
        if(tableName) {
            return tableName;
        }
    } catch (_) {
        // Resource not available, fall through to env var
    }

    // Fallback: environment variable
    // eslint-disable-next-line @typescript-eslint/dot-notation -- env vars use bracket notation
    const envTableName = process.env['DYNAMODB_TABLE_NAME'];
    if(envTableName) {
        return envTableName;
    }
    throw new Error('Could not determine table name. Set DYNAMODB_TABLE_NAME or run with SST shell.');
}

/**
 * Creates a DynamoDB Document Client with default configuration.
 */
function createDocClient(): DynamoDBDocumentClient {
    const client = new DynamoDBClient({});
    return DynamoDBDocumentClient.from(client);
}

/**
 * Determines if an item should be skipped during migration.
 */
function shouldSkipItem(item: DynamoItem): { skip: boolean, reason?: 'message_cache' | 'version' } {
    // Skip message cache items (PK starts with CHANNEL#)
    if(_startsWith(item.PK, 'CHANNEL#')) {
        return { skip: true, reason: 'message_cache' };
    }

    // Skip version history items (SK starts with VERSION#)
    if(_startsWith(item.SK, 'VERSION#')) {
        return { skip: true, reason: 'version' };
    }

    return { skip: false };
}

/**
 * Reconstructs the path from PK and SK.
 * PK format: DIR#{parentPath}
 * SK format: FILE#{filename}
 */
function reconstructPath(pk: string, sk: string): string {
    return MemoryToolKeyGenerator.parsePath(pk, sk);
}

/**
 * Extracts the layer string from a path for GSI1PK.
 * Falls back to first path segment or 'unknown' for root paths.
 */
function getLayerString(path: string): string {
    try {
        const memoryPath = createMemoryPath(path);
        const layer = extractLayerFromPath(memoryPath);
        if(layer) {
            return layer;
        }
        // Fallback to first path segment
        const segments = _split(path, '/');
        return segments[1] ?? 'unknown';
    } catch (_) {
        // If path validation fails, extract manually
        const segments = _split(path, '/');
        return segments[1] ?? 'unknown';
    }
}

/**
 * Updates a single item with new GSI1 keys and contentPreview.
 */
async function updateItem(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    item: DynamoItem
): Promise<void> {
    const path = item.path ?? reconstructPath(item.PK, item.SK);
    const layerStr = getLayerString(path);
    const updatedAt = item.updatedAt ?? new Date().toISOString();
    const contentPreview = item.content ? generateContentPreview(item.content) : '';

    await docClient.send(new UpdateCommand({
        TableName: tableName,
        Key:       {
            PK: item.PK,
            SK: item.SK,
        },
        UpdateExpression:          'SET GSI1PK = :gsi1pk, GSI1SK = :gsi1sk, contentPreview = :preview',
        ExpressionAttributeValues: {
            ':gsi1pk':  `LAYER#${layerStr}`,
            ':gsi1sk':  `UPDATED#${updatedAt}`,
            ':preview': contentPreview,
        },
    }));
}

/**
 * Processes a batch of items from the scan.
 */
async function processBatch(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    items: DynamoItem[],
    batchNumber: number,
    stats: MigrationStats
): Promise<void> {
    console.log(`Processing batch ${batchNumber}...`);

    for(const item of items) {
        const skipResult = shouldSkipItem(item);

        if(skipResult.skip) {
            if(skipResult.reason === 'message_cache') {
                console.log(`  Skipped (message cache): ${item.PK}`);
                stats.messageCacheSkipped++;
            } else if(skipResult.reason === 'version') {
                console.log(`  Skipped (version): ${item.PK} ${item.SK}`);
                stats.versionSkipped++;
            }
            continue;
        }

        try {
            const path = item.path ?? reconstructPath(item.PK, item.SK);
            await updateItem(docClient, tableName, item);
            console.log(`  Updated: ${path}`);
            stats.memoryUpdated++;
        } catch (error) {
            console.error(`  Error updating ${item.PK}/${item.SK}:`, error);
            stats.errors++;
        }
    }
}

/**
 * Main migration function.
 * Scans all items and updates them with new GSI1 keys and contentPreview.
 */
async function migrate(): Promise<void> {
    console.log('Starting migration...');

    const tableName = getTableName();
    console.log(`Table: ${tableName}\n`);

    const docClient = createDocClient();

    const stats: MigrationStats = {
        totalScanned:        0,
        memoryUpdated:       0,
        messageCacheSkipped: 0,
        versionSkipped:      0,
        errors:              0,
    };

    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let batchNumber = 0;

    do {
        batchNumber++;

        const scanResult = await docClient.send(new ScanCommand({
            TableName:         tableName,
            ExclusiveStartKey: lastEvaluatedKey,
        }));

        const items = (scanResult.Items ?? []) as DynamoItem[];
        stats.totalScanned += items.length;

        await processBatch(docClient, tableName, items, batchNumber, stats);

        lastEvaluatedKey = scanResult.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while(lastEvaluatedKey);

    console.log('\nMigration complete!');
    console.log(`  Total items scanned: ${stats.totalScanned}`);
    console.log(`  Memory items updated: ${stats.memoryUpdated}`);
    console.log(`  Message cache items skipped: ${stats.messageCacheSkipped}`);
    console.log(`  Version items skipped: ${stats.versionSkipped}`);
    console.log(`  Errors: ${stats.errors}`);
}

migrate().catch((error: unknown) => {
    console.error('Migration failed:', error);
    throw error;
});
