// Stryker disable all: CLI entry-point with external dependencies (DynamoDB, SST, process.argv); not unit-testable in isolation
/**
 * Backfill CLI for CONTACT_LOOKUP GSI2 keys.
 *
 * Queries the CONTACTS GSI2 partition to enumerate all contact profile rows,
 * then for each contact iterates its identifiers and writes GSI2 keys to the
 * corresponding CONTACT_LOOKUP row (if not already present).
 *
 * This replaces the previous full-table ScanCommand approach:
 * - Old: Scanned all rows in the table, filtering server-side for CONTACT_LOOKUP# PK prefix
 *   (billed RCU for every row in the table — memory, channel registry, tag index, etc.)
 * - New: Queries only the CONTACTS GSI2 partition (only contact profile rows)
 *   then writes only to lookup rows that need updating. Far fewer read RCUs.
 *
 * Background: `createLookupKeys()` was updated to write GSI2 keys on all new/updated lookup rows.
 * This tool backfills the attribute on rows written before that change.
 *
 * Usage:
 *   sst shell -- bun tools/backfill-contact-lookup-gsi2.ts [options]
 *
 * Options:
 *   --dry-run    Show what would be updated without writing
 *   --help       Show this help message
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Resource } from 'sst';
import {
    type BackfillStats,
    type ContactProfileItem,
    type QueryPageFn,
    type ProcessContactsFn,
    parseArgs,
    processContacts,
    runBackfillLoop
} from './backfill-contact-lookup-gsi2-core';
import { loadDynamoDBConfig } from '@/config';
import { createDynamoDBClient, DynamoDBClientHolder } from '@/storage';
import { retryAsync } from '@/utils/retry/retry-async';

export type { BackfillOptions, ContactProfileItem, BackfillStats, PageStats, QueryPageFn, ProcessContactsFn } from './backfill-contact-lookup-gsi2-core';
export { parseArgs, processContacts, runBackfillLoop } from './backfill-contact-lookup-gsi2-core';

const HELP_TEXT = `
Usage: sst shell -- bun tools/backfill-contact-lookup-gsi2.ts [options]

Options:
  --dry-run    Show what would be updated without writing
  --help       Show this help message

Requires SST shell for DynamoDB credentials:
  sst shell -- bun tools/backfill-contact-lookup-gsi2.ts
`;

/** GSI2 index name for the shared GSI2 partition */
const GSI2_INDEX_NAME = 'GSI2';

/** GSI2PK value for the CONTACTS partition — all contact profile items */
const GSI2PK_CONTACTS = 'CONTACTS';

/** Number of contact profiles to fetch per Query page (each may have several identifiers) */
const CONTACTS_PAGE_LIMIT = 50;

async function main(): Promise<void> {
    const opts = parseArgs(process.argv);

    if(opts.showHelp) {
        process.stdout.write(HELP_TEXT);
        return;
    }

    const dynamoDBConfig = loadDynamoDBConfig(Resource);
    const { client, docClient, tableName } = createDynamoDBClient(dynamoDBConfig);
    // DynamoDBClientHolder keeps client references alive; suppress unused-expression lint via assignment
    const _holder = new DynamoDBClientHolder(client, docClient);

    process.stdout.write(`Querying CONTACTS GSI2 partition in table: ${tableName}\n`);
    if(opts.dryRun) {
        process.stdout.write('[DRY RUN] No writes will be performed.\n');
    }

    const MAX_CONSECUTIVE_FAILURES = 5;
    const CONSECUTIVE_FAILURE_BASE_BACKOFF_MS = 5000;

    const queryPage: QueryPageFn = async (exclusiveStartKey) => {
        const result = await retryAsync(() => docClient.send(new QueryCommand({
            TableName:                 tableName,
            IndexName:                 GSI2_INDEX_NAME,
            KeyConditionExpression:    'GSI2PK = :pk',
            ExpressionAttributeValues: { ':pk': GSI2PK_CONTACTS },
            ExclusiveStartKey:         exclusiveStartKey,
            Limit:                     CONTACTS_PAGE_LIMIT,
        })));
        return {
            items:            (result.Items ?? []) as ContactProfileItem[],
            lastEvaluatedKey: result.LastEvaluatedKey,
        };
    };

    const doProcessContacts: ProcessContactsFn = items =>
        processContacts(items, tableName, docClient, opts.dryRun);

    const onSummary = (stats: BackfillStats, _lastCursor: Record<string, unknown> | undefined): void => {
        process.stdout.write(`
Backfill complete:
  Contacts scanned: ${stats.totalScanned}
  Lookup rows updated: ${stats.totalUpdated}
  Lookup rows skipped (already had GSI2 keys or stale): ${stats.totalSkipped}
  Errors: ${stats.totalErrors}
`);
    };

    const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

    const finalStats = await runBackfillLoop(
        queryPage,
        doProcessContacts,
        onSummary,
        sleep,
        MAX_CONSECUTIVE_FAILURES,
        CONSECUTIVE_FAILURE_BASE_BACKOFF_MS
    );

    if(finalStats.totalErrors > 0) {
        throw new Error(`Backfill completed with ${finalStats.totalErrors} error(s)`);
    }
}

await main();
