/**
 * One-shot migration of the legacy `/state/services/...` checkpoint memory rows into the
 * operational-state store (#57, second half). The logic is in tools/migrate-checkpoints-core.ts;
 * this file wires it to DynamoDB, the vector index and the terminal.
 *
 * Usage:
 *   bun run migrate:checkpoints [--execute] [--vector-index <db>]
 *   (package.json runs `sst shell -- bun tools/migrate-checkpoints.ts` and appends the flags)
 *
 * Dry run is the default: it reads the table (GSI1 `LAYER#state`, then one strongly consistent
 * read per recognised checkpoint) and writes nothing, not even to the vector index, which it opens
 * read-only. `--execute` copies each recognised checkpoint into
 * `OPERATIONAL_STATE#<owner>`/<name> with a put that only creates an absent key, then deletes the
 * legacy memory row (and any tag rows) through a MemoryToolBackend that has no indexer. Unrecognised
 * paths under /state/services/ are reported and left alone. `--vector-index <db>` also deletes the
 * recognised checkpoint rows from Izzy's local SQLite vector index.
 *
 * Izzy can keep running (#57 clarification, 2026-09-25). The put only creates an absent key, so a
 * checkpoint Izzy writes during the run wins, and since #129 the vector index takes concurrent
 * writers (WAL, busy_timeout 5 s, IMMEDIATE write transactions): the execute pass's deletes wait
 * for Izzy's writer rather than fail, and the dry run reads committed WAL contents.
 *
 * Runbook (DB is the file Izzy uses: `<repo>/scratch/memory-vec.sqlite`, see
 * docs/vector-index-operations.md; confirm against Izzy's `Vector index initialized at …` log):
 *   1. Leave Izzy running.
 *   2. Dry run, keeping the listing:
 *        bun run migrate:checkpoints --vector-index "$DB" | tee migrate-checkpoints-dry-run.txt
 *      Check the `Table:` line names the production table (sst shell uses the active stage) and
 *      that the rows are the expected ones: Bluesky notifications and DM, one per Bluesky feed and
 *      one per Discord channel.
 *   3. Execute:
 *        bun run migrate:checkpoints --execute --vector-index "$DB" | tee migrate-checkpoints-execute.txt
 *   4. Verify with a second dry run: 0 legacy rows (or only the unrecognised ones reported before)
 *      and 0 vector rows to delete.
 *   5. Watch Izzy's log: no further legacy-fallback reads, and at the next restart no catch-up
 *      replay of already-handled Discord messages and no re-notified Bluesky items.
 *
 * Capacity: the table and GSI1 have 2 WCU and GSI1 2 RCU. Every write and delete is charged by
 * item size (1 WCU per KB) against a 1 WCU/s budget before it is issued, and reads by size against
 * a 1 RCU/s budget, so a full 500-URI Bluesky checkpoint (~38 KB) waits ~38 s rather than 1 s.
 *
 * ROLLBACK:
 * - The tool is idempotent. A new key is written only when absent, and a legacy row is deleted
 *   only after its put succeeded or its key already existed, so a failed run is simply re-run.
 *   The vector pass covers every recognised checkpoint row still in the index, so a re-run also
 *   finishes a vector pass an earlier run never reached.
 * - Reverting to any build from #57's first half onward is safe: those builds read the
 *   operational-state rows first.
 * - Reverting to code from before #57 is NOT safe once legacy rows are deleted, unless the rows
 *   are copied back first: that code reads only `/state/services/<owner>/<name>`, so Discord
 *   catch-up would re-read (and may re-answer) old messages and Bluesky would re-notify. Each
 *   operational-state row's `content` is the legacy JSON verbatim; the dry-run listing records
 *   which legacy paths existed.
 * - Vector rows are derived data. `tools/backfill-vectors.ts` rebuilds them if ever needed
 *   (checkpoints should not be in the index at all).
 */

import { existsSync } from 'node:fs';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Database } from 'bun:sqlite';
import { Resource } from 'sst';
import { clientDestroyer, sleepForRateLimit } from './backfill-vectors-runtime-builder';
import {
    parseArgs,
    runMigration,
    STATE_PAGE_SIZE,
    type MigrationDeps,
    type QueryStatePage,
    type VectorRowKey
} from './migrate-checkpoints-core';
import { loadDynamoDBConfig } from '@/config';
import { createDynamoDBClient, MemoryToolBackend, OperationalStateBackend, VectorIndex } from '@/storage';
import { VECTOR_DB_BUSY_TIMEOUT_MS } from '@/storage/memory-vec-store';

export const HELP_TEXT = `
Usage: bun run migrate:checkpoints [--execute] [--vector-index <db>]
       (sst shell -- bun tools/migrate-checkpoints.ts [options])

Moves the legacy /state/services/... checkpoint memory rows into the operational-state
store, then deletes them. Dry run is the default: it lists every row and what would
happen to it, and writes nothing.

Options:
  --execute            Copy each checkpoint (only where the new key is absent) and delete
                       the legacy row. Unrecognised rows are always left alone.
  --vector-index <db>  Also delete the checkpoint rows from Izzy's SQLite vector index
                       (the dry run opens it read-only)
  --help               Show this help message

Izzy can keep running: a checkpoint it writes meanwhile wins, and the vector
index takes concurrent writers.
Writes are paced at 1 WCU/s by item size and reads at 1 RCU/s.

ROLLBACK: the tool is idempotent, so a failed run can be re-run. Reverting to code
from before #57 is NOT safe once legacy rows are deleted; see the header of
tools/migrate-checkpoints.ts.
`;

// ── DynamoDB ──────────────────────────────────────────────────────────────────

/**
 * One raw GSI1 `LAYER#state` page (the index projects ALL attributes). Raw rather than decoded
 * memories, so a row with a malformed memory envelope is still visible to the migration.
 */
export function createStatePageQuery(docClient: Pick<DynamoDBDocumentClient, 'send'>, tableName: string): QueryStatePage {
    return async (cursor) => {
        const output = await docClient.send(new QueryCommand({
            TableName:                 tableName,
            IndexName:                 'GSI1',
            KeyConditionExpression:    'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': 'LAYER#state' },
            Limit:                     STATE_PAGE_SIZE,
            ExclusiveStartKey:         cursor,
            ReturnConsumedCapacity:    'TOTAL',
        }));
        return {
            items:             output.Items ?? [],
            lastEvaluatedKey:  output.LastEvaluatedKey,
            consumedReadUnits: output.ConsumedCapacity?.CapacityUnits,
        };
    };
}

// ── Vector index, read-only ───────────────────────────────────────────────────

/**
 * Lists the vector-index rows under `prefix` (the directory itself and everything below it, as
 * VectorIndex.listRowsByPathPrefix does) without writing to the database. A plain read-only
 * connection is a WAL reader: it sees every transaction a running Izzy has committed, including
 * those still in `<db>-wal`, and never blocks Izzy's writer. busy_timeout covers the brief locks
 * a reader can still meet (WAL recovery, a closing connection's checkpoint). VectorIndex.open is
 * not used: it switches the journal mode and migrates the schema.
 *
 * @throws {Error} When the file has no `memory_vectors(pk, sk)` table, or cannot be opened.
 */
export function readVectorRowsReadOnly(
    dbPath: string,
    prefix: string,
    openDatabase: (filename: string, options: { readonly: true }) => Database = (filename, options) => new Database(filename, options)
): VectorRowKey[] {
    const db = openDatabase(dbPath, { readonly: true });
    try {
        db.run(`PRAGMA busy_timeout = ${VECTOR_DB_BUSY_TIMEOUT_MS}`);
        const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_vectors')").all().map(column => column.name));
        if(!columns.has('pk') || !columns.has('sk')) {
            throw new Error(`${dbPath} is not a vector index: it has no memory_vectors(pk, sk) table`);
        }
        return db
            .query<VectorRowKey, [string, string]>('SELECT pk, sk FROM memory_vectors WHERE pk = ?1 OR substr(pk, 1, length(?2)) = ?2 ORDER BY rowid')
            .all(`DIR#${prefix.slice(0, -1)}`, `DIR#${prefix}`);
    } finally {
        db.close();
    }
}

// ── Native dependencies ───────────────────────────────────────────────────────

export interface MigrateNativeServices {
    resource:       typeof Resource
    loadConfig:     typeof loadDynamoDBConfig
    createClient:   typeof createDynamoDBClient
    Index:          Pick<typeof VectorIndex, 'open'>
    readVectorRows: (dbPath: string, prefix: string) => VectorRowKey[]
    exists:         (filePath: string) => boolean
    now:            () => number
    sleep:          (ms: number) => Promise<void>
    write:          (message: string) => void
}

export const productionMigrateServices: MigrateNativeServices = {
    resource:       Resource,
    loadConfig:     loadDynamoDBConfig,
    createClient:   createDynamoDBClient,
    Index:          VectorIndex,
    readVectorRows: readVectorRowsReadOnly,
    exists:         existsSync,
    now:            Date.now,
    sleep:          sleepForRateLimit,
    write:          (message) => { process.stdout.write(message); },
};

export function createNativeMigrationDeps(services: MigrateNativeServices = productionMigrateServices): MigrationDeps {
    return {
        openStorage: () => {
            const { client, docClient, tableName } = services.createClient(services.loadConfig(services.resource));
            return {
                tableName,
                queryStatePage: createStatePageQuery(docClient, tableName),
                // No indexer: this process has no embedder; --vector-index removes the vector rows instead.
                legacy:         new MemoryToolBackend(docClient, tableName),
                target:         new OperationalStateBackend(docClient, tableName),
                destroy:        clientDestroyer(client),
            };
        },
        openVectorIndex: dbPath => services.Index.open(dbPath),
        readVectorRows:  (dbPath, prefix) => services.readVectorRows(dbPath, prefix),
        exists:          filePath => services.exists(filePath),
        now:             () => services.now(),
        sleep:           ms => services.sleep(ms),
        write:           (message) => { services.write(message); },
    };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv, deps: MigrationDeps = createNativeMigrationDeps()): Promise<void> {
    const opts = parseArgs(argv);
    if(opts.showHelp) {
        deps.write(HELP_TEXT);
        return;
    }
    await runMigration(opts, deps);
}

export async function runMigrateCli(isMain: boolean, run: () => Promise<void>): Promise<void> {
    if(isMain) {
        await run();
    }
}

// As the CLI, a rejection here is unhandled, and Bun prints it and exits 1. It is not awaited:
// under test import.meta.main is false, so a top-level await could never be observed and would
// leave an unkillable await-drop mutant behind.
// eslint-disable-next-line unicorn/prefer-top-level-await -- see above: exit status is preserved by Bun's unhandled-rejection handling
void runMigrateCli(import.meta.main, main);
