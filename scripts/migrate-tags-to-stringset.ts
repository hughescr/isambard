/**
 * Migration script to convert tags attribute from List (string[]) to StringSet (Set<string>).
 *
 * This script performs a full table scan to convert all tags attributes from DynamoDB List (L)
 * to StringSet (SS). It handles both memory items and tag index items.
 *
 * Usage:
 *   sst shell -- bun run scripts/migrate-tags-to-stringset.ts [--execute]
 *
 * Default mode is dry-run (shows what would change without writing).
 * Pass --execute to perform actual database updates.
 *
 * Examples:
 *   # Dry-run mode (safe, shows what would change)
 *   sst shell -- bun run scripts/migrate-tags-to-stringset.ts
 *
 *   # Execute mode (performs actual updates)
 *   sst shell -- bun run scripts/migrate-tags-to-stringset.ts --execute
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { Resource } from 'sst';
import { loadDynamoDBConfig, type DynamoDBResourceProvider } from '../src/config/loader';
import _ from 'lodash';

interface MigrationStats {
    totalScanned:   number
    alreadySet:     number
    convertedToSet: number
    removedEmpty:   number
    errors:         number
}

interface ErrorRecord {
    pk:    string
    sk:    string
    error: string
}

async function main() {
    const args = process.argv.slice(2);
    const executeMode = args.includes('--execute');

    if(!executeMode) {
        logger.info({ msg: 'DRY RUN MODE — no changes will be written' });
        logger.info({ msg: 'Pass --execute to perform actual database updates' });
    }

    // Load DynamoDB config from SST resources
    const dynamoConfig = loadDynamoDBConfig(Resource as unknown as DynamoDBResourceProvider);

    logger.info({ tableName: dynamoConfig.tableName, msg: 'Connecting to DynamoDB' });

    // Create DynamoDB client with default configuration
    const client = new DynamoDBClient({
        maxAttempts: 3,
    });
    const docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: {
            removeUndefinedValues:     true,
            convertClassInstanceToMap: true,
        },
        unmarshallOptions: {
            wrapNumbers: false,
        },
    });

    await migrateTable(docClient, dynamoConfig.tableName, executeMode);
}

async function migrateTable(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    executeMode: boolean
): Promise<void> {
    const stats: MigrationStats = {
        totalScanned:   0,
        alreadySet:     0,
        convertedToSet: 0,
        removedEmpty:   0,
        errors:         0,
    };
    const errors: ErrorRecord[] = [];

    logger.info({ msg: 'Starting table scan...' });

    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const scanCommand = new ScanCommand({
            TableName:            tableName,
            ExclusiveStartKey:    lastEvaluatedKey,
            FilterExpression:     'attribute_exists(tags)',
            ProjectionExpression: 'PK, SK, tags',
        });

        const response: ScanCommandOutput = await docClient.send(scanCommand);

        if(response.Items) {
            for(const item of response.Items) {
                stats.totalScanned++;
                await processItem(docClient, tableName, item, executeMode, stats, errors);

                // Rate limiting: small delay between updates to avoid throttling
                if(executeMode) {
                    await sleep(50);
                }
            }
        }

        lastEvaluatedKey = response.LastEvaluatedKey;

        logger.info({
            scanned:   stats.totalScanned,
            remaining: lastEvaluatedKey ? 'yes' : 'no',
            msg:       'Scan progress',
        });
    } while(lastEvaluatedKey);

    // Print summary
    printSummary(stats, errors, executeMode);
}

async function processItem(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    item: Record<string, unknown>,
    executeMode: boolean,
    stats: MigrationStats,
    errors: ErrorRecord[]
): Promise<void> {
    const pk = item.PK as string;
    const sk = item.SK as string;
    const tags = item.tags;

    // Skip if tags is already a Set (already migrated)
    if(tags instanceof Set) {
        stats.alreadySet++;
        logger.debug({ pk, sk, msg: 'Already Set, skipping' });
        return;
    }

    // Handle array tags (needs migration)
    if(_.isArray(tags)) {
        if(tags.length > 0) {
            // Convert to Set
            await convertToSet(docClient, tableName, pk, sk, tags as string[], executeMode, stats, errors);
        } else {
            // Remove empty array (SS cannot be empty)
            await removeEmptyTags(docClient, tableName, pk, sk, executeMode, stats, errors);
        }
        return;
    }

    // Unexpected type (should not happen after FilterExpression)
    logger.warn({ pk, sk, tagsType: typeof tags, msg: 'Unexpected tags type, skipping' });
}

async function convertToSet(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    pk: string,
    sk: string,
    tags: string[],
    executeMode: boolean,
    stats: MigrationStats,
    errors: ErrorRecord[]
): Promise<void> {
    const tagCount = tags.length;

    if(!executeMode) {
        logger.info({ pk, sk, tagCount, msg: '[DRY RUN] Would convert to Set' });
        stats.convertedToSet++;
        return;
    }

    try {
        const updateCommand = new UpdateCommand({
            TableName:                 tableName,
            Key:                       { PK: pk, SK: sk },
            UpdateExpression:          'SET tags = :tags',
            ExpressionAttributeValues: {
                ':tags': new Set(tags),
            },
        });

        await docClient.send(updateCommand);
        logger.info({ pk, sk, tagCount, msg: 'Converted to Set' });
        stats.convertedToSet++;
    } catch (error) {
        const errorMsg = _.isError(error) ? error.message : String(error);
        logger.error({ pk, sk, error: errorMsg, msg: 'Failed to convert to Set' });
        errors.push({ pk, sk, error: errorMsg });
        stats.errors++;
    }
}

async function removeEmptyTags(
    docClient: DynamoDBDocumentClient,
    tableName: string,
    pk: string,
    sk: string,
    executeMode: boolean,
    stats: MigrationStats,
    errors: ErrorRecord[]
): Promise<void> {
    if(!executeMode) {
        logger.info({ pk, sk, msg: '[DRY RUN] Would remove empty tags' });
        stats.removedEmpty++;
        return;
    }

    try {
        const updateCommand = new UpdateCommand({
            TableName:        tableName,
            Key:              { PK: pk, SK: sk },
            UpdateExpression: 'REMOVE tags',
        });

        await docClient.send(updateCommand);
        logger.info({ pk, sk, msg: 'Removed empty tags' });
        stats.removedEmpty++;
    } catch (error) {
        const errorMsg = _.isError(error) ? error.message : String(error);
        logger.error({ pk, sk, error: errorMsg, msg: 'Failed to remove empty tags' });
        errors.push({ pk, sk, error: errorMsg });
        stats.errors++;
    }
}

function printSummary(stats: MigrationStats, errors: ErrorRecord[], executeMode: boolean): void {
    logger.info({ msg: '\n=== Migration Summary ===' });
    logger.info({ count: stats.totalScanned, msg: 'Total items scanned' });
    logger.info({ count: stats.alreadySet, msg: 'Already Set (skipped)' });

    if(executeMode) {
        logger.info({ count: stats.convertedToSet, msg: 'Converted to Set' });
        logger.info({ count: stats.removedEmpty, msg: 'Removed empty tags' });
    } else {
        logger.info({ count: stats.convertedToSet, msg: 'Would convert to Set' });
        logger.info({ count: stats.removedEmpty, msg: 'Would remove empty tags' });
    }

    logger.info({ count: stats.errors, msg: 'Errors' });

    if(errors.length > 0) {
        logger.error({ msg: '\n=== Errors ===' });
        for(const err of errors) {
            logger.error({ pk: err.pk, sk: err.sk, error: err.error, msg: 'Failed item' });
        }
    }

    if(!executeMode && (stats.convertedToSet > 0 || stats.removedEmpty > 0)) {
        logger.info({ msg: '\nRun with --execute to perform actual updates' });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
    logger.error({ error, msg: 'Unexpected error' });
    throw error;
});
