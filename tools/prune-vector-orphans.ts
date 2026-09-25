/**
 * One-off cleanup of orphaned vector-index rows (#129).
 *
 * DynamoDB deletes auto-logged /events/activity/* memories silently when their 30-day TTL passes;
 * before #129 the vector index never learned of it, leaving orphan rows. This tool finds the rows
 * under a prefix of /events/activity/ whose DynamoDB item is gone and deletes them locally through
 * VectorIndex.delete. It never writes to DynamoDB.
 *
 * Usage:
 *   sst shell -- bun tools/prune-vector-orphans.ts --db-path <live db> [--execute]
 *
 * Algorithm:
 *   1. Snapshot the rows under the prefix. A row whose keys are not the canonical keys of a valid
 *      memory path under the prefix is reported as malformed and never touched.
 *   2. Check every row's key with strongly consistent, keys-only BatchGetItem, paced by the
 *      reported ConsumedCapacity. UnprocessedKeys are retried, never treated as absent.
 *   3. Dry run (default): list the absent paths and stop.
 *   4. --execute: refuse if every key is absent (wrong stage/table/credentials?) unless
 *      --allow-all-absent. Otherwise re-check the absent keys, one paced BatchGetItem at a time,
 *      and delete the keys each request found absent as soon as it returns — before the pacing
 *      pause, never after it — and only if the row is still the generation snapshotted in step 1
 *      (same content hash, updated_at, ttl and source_updated_at), so a memory re-created and
 *      re-indexed meanwhile keeps its vector.
 *
 * Remaining race, documented rather than coordinated: a memory re-created at the same path between
 * a request's strongly consistent read and the synchronous deletes that follow it (the network
 * return of that one request, no sleep or retry in between), and not yet re-indexed, loses its
 * vector until the next write or backfill. Activity paths embed a millisecond timestamp, so this
 * needs a same-path write inside that window; the runbook's follow-up backfill repairs it anyway.
 */

import path from 'node:path';
import { createDefaultPruneDependencies } from './prune-vector-orphans-runtime';
import { paceAfterRead, parseRcuRate, requireConsumedReadUnits } from './rcu-pacing';
import { MemoryToolKeyGenerator, isMemoryPath, type VectorIndex, type VectorRowSnapshot } from '@/storage';

// ── Constants ─────────────────────────────────────────────────────────────────

/** The approved namespace: auto-logged activity with a 30-day DynamoDB TTL. */
export const DEFAULT_PREFIX = '/events/activity/';

/** The base table is provisioned at 5 RCU; Izzy needs the rest. */
export const MAX_RATE_LIMIT_RCU_PER_SEC = 5;

/** BatchGetItem accepts at most 100 keys per request. */
export const MAX_BATCH_SIZE = 100;

/** Consecutive all-unprocessed BatchGetItem rounds before the run aborts. */
export const MAX_STALLED_ROUNDS = 8;

/** Extra wait per consecutive stalled round (linear backoff while DynamoDB throttles). */
export const STALL_BACKOFF_MS = 1000;

// Default db path: <repo-root>/scratch/memory-vec.sqlite (import.meta.dir is tools/)
const DEFAULT_DB_PATH = path.resolve(import.meta.dir, '..', 'scratch', 'memory-vec.sqlite');

const HELP_TEXT = `
Usage: bun tools/prune-vector-orphans.ts [options]

Deletes vector-index rows under ${DEFAULT_PREFIX} whose DynamoDB item no longer exists.
Dry run by default; writes only the local SQLite file, never DynamoDB.

Options:
  --db-path <path>                 SQLite database path (default: ${DEFAULT_DB_PATH});
                                   always pass the file Izzy uses
  --prefix <path/>                 Path prefix to check (default: ${DEFAULT_PREFIX}); must be
                                   ${DEFAULT_PREFIX} or a directory below it, ending in '/'
  --rate-limit-rcu-per-sec <N>     Base-table read budget, paced by consumed capacity
                                   (default: 2, max: ${MAX_RATE_LIMIT_RCU_PER_SEC})
  --batch-size <N>                 Keys per BatchGetItem request (default: 4, max: ${MAX_BATCH_SIZE})
  --execute                        Delete the orphans (default: dry run, list them only)
  --allow-all-absent               With --execute, delete even when no key under the prefix
                                   exists in DynamoDB (normally a sign of the wrong stage/table)
  --help                           Show this help message

Existence checks are strongly consistent, keys-only BatchGetItem reads (1 RCU per key).
--execute re-checks the orphans and deletes those each request finds absent as soon as
it returns, before pausing for the next request; it keeps any row that was re-indexed
after the snapshot. The vector database is opened with busy_timeout and
WAL, so this can run while Izzy is live.

Requires SST shell for DynamoDB credentials:
  sst shell -- bun tools/prune-vector-orphans.ts --db-path <db>
`;

// ── Options ───────────────────────────────────────────────────────────────────

export interface PruneOptions {
    prefix:             string
    dbPath:             string
    rateLimitRcuPerSec: number
    batchSize:          number
    execute:            boolean
    allowAllAbsent:     boolean
    showHelp:           boolean
}

function parsePrefix(value: string | undefined): string {
    if(value === undefined || !value.startsWith(DEFAULT_PREFIX) || !value.endsWith('/') || value.includes('//')) {
        throw new Error(`Invalid --prefix value: ${value ?? '(missing)'}. Must be ${DEFAULT_PREFIX} or a directory below it, ending in '/'.`);
    }
    return value;
}

function parseBatchSize(value: string | undefined): number {
    const parsed = Number(value);
    if(!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
        throw new Error(`Invalid --batch-size value: ${value ?? '(missing)'}. Must be an integer from 1 to ${MAX_BATCH_SIZE}.`);
    }
    return parsed;
}

export function parseArgs(argv: string[]): PruneOptions {
    const options: PruneOptions = {
        prefix:             DEFAULT_PREFIX,
        dbPath:             DEFAULT_DB_PATH,
        rateLimitRcuPerSec: 2,
        batchSize:          4,
        execute:            false,
        allowAllAbsent:     false,
        showHelp:           false,
    };

    const handlers: Partial<Record<string, (value: string | undefined) => void>> = {
        '--prefix': (value) => {
            options.prefix = parsePrefix(value);
        },
        '--db-path': (value) => {
            if(!value) {
                throw new Error('--db-path requires a value');
            }
            options.dbPath = path.resolve(value);
        },
        '--rate-limit-rcu-per-sec': (value) => {
            options.rateLimitRcuPerSec = parseRcuRate(value, MAX_RATE_LIMIT_RCU_PER_SEC);
        },
        '--batch-size': (value) => {
            options.batchSize = parseBatchSize(value);
        },
    };

    // Expand `--flag=value` into ['--flag', 'value'] so the loop below handles both forms.
    const args = argv.slice(2).flatMap((a) => {
        const eq = a.startsWith('--') ? a.indexOf('=') : -1;
        return eq === -1 ? [a] : [a.slice(0, eq), a.slice(eq + 1)];
    });
    const iterator = args.values();
    for(const arg of iterator) {
        switch(arg) {
            case '--help':
            case '-h': {
                options.showHelp = true;
                break;
            }
            case '--execute': {
                options.execute = true;
                break;
            }
            case '--allow-all-absent': {
                options.allowAllAbsent = true;
                break;
            }
            default: {
                const handler = handlers[arg];
                if(!handler) {
                    throw new Error(`Unknown option: ${arg}`);
                }
                handler(iterator.next().value);
            }
        }
    }
    return options;
}

// ── Row validation ────────────────────────────────────────────────────────────

/** One vector-index row that is a valid memory under the prefix. */
export interface CandidateRow {
    path:     string
    snapshot: VectorRowSnapshot
}

/**
 * The row's memory path when its keys are exactly the canonical keys of a valid memory path under
 * `prefix`; undefined otherwise (legacy or hand-made keys, empty filenames, `//`, a split that
 * does not round-trip).
 */
export function canonicalPathUnderPrefix(row: Pick<VectorRowSnapshot, 'pk' | 'sk'>, prefix: string): string | undefined {
    let candidate: string;
    try {
        candidate = MemoryToolKeyGenerator.parsePath(row.pk, row.sk);
    } catch{
        return undefined; // Not DIR#/FILE# keys at all
    }
    if(!isMemoryPath(candidate) || !candidate.startsWith(prefix)) {
        return undefined;
    }
    // The path is parent + '/' + filename, so when the canonical PK (parent) matches, the
    // canonical SK (filename) necessarily matches too; comparing PK is the whole round-trip check.
    return MemoryToolKeyGenerator.createKeys(candidate).PK === row.pk ? candidate : undefined;
}

// ── DynamoDB existence checks ─────────────────────────────────────────────────

export interface ItemKey {
    PK: string
    SK: string
}

export interface BatchGetKeysResult {
    /** Keys DynamoDB returned (the item exists). */
    found:             ItemKey[]
    /** Keys DynamoDB did not process this round; retried, never treated as absent. */
    unprocessed:       ItemKey[]
    /** The request's ConsumedCapacity for the table, or undefined when DynamoDB omitted it. */
    consumedReadUnits: number | undefined
}

export interface PruneStorage {
    tableName:    string
    batchGetKeys: (keys: ItemKey[]) => Promise<BatchGetKeysResult>
    destroy:      () => void
}

export interface PruneDependencies {
    openStorage:     () => PruneStorage
    openVectorIndex: (dbPath: string) => Promise<Pick<VectorIndex, 'listRowsByPathPrefix' | 'delete' | 'close'>>
    now:             () => number
    sleep:           (ms: number) => Promise<void>
    write:           (message: string) => void
}

interface ExistenceContext {
    batchGetKeys:       PruneStorage['batchGetKeys']
    batchSize:          number
    rateLimitRcuPerSec: number
    now:                () => number
    sleep:              (ms: number) => Promise<void>
}

interface ExistenceResult {
    present:           ItemKey[]
    absent:            ItemKey[]
    consumedReadUnits: number
}

/** One request's classified keys (its unprocessed keys are retried, so they are never listed). */
export interface CheckedKeys {
    present: ItemKey[]
    absent:  ItemKey[]
}

function keyId(key: ItemKey): string {
    return `${key.PK}\u0000${key.SK}`;
}

/**
 * Classifies each key as present or absent in DynamoDB. A key is absent only when it was
 * requested, processed, and not returned. Every request is paced by its reported read units.
 *
 * `onChecked` receives each request's classification synchronously, as soon as the request
 * returns and before its pacing pause, so a caller acting on an absent key (the prune's delete)
 * does so with no await between the authoritative read and the action.
 *
 * @throws {Error} When DynamoDB omits ConsumedCapacity, or returns every key of a request
 *   unprocessed {@link MAX_STALLED_ROUNDS} times in a row.
 */
export async function checkExistence(
    keys:       readonly ItemKey[],
    ctx:        ExistenceContext,
    onChecked?: (checked: CheckedKeys) => void
): Promise<ExistenceResult> {
    const queue = [...keys];
    const present: ItemKey[] = [];
    const absent: ItemKey[] = [];
    let consumedReadUnits = 0;
    let stalledRounds = 0;
    while(queue.length > 0) {
        const batch = queue.splice(0, ctx.batchSize);
        const startedAtMs = ctx.now();
        // eslint-disable-next-line no-await-in-loop -- requests are deliberately sequential and paced
        const result = await ctx.batchGetKeys(batch);
        const units = requireConsumedReadUnits(result.consumedReadUnits, 'BatchGetItem');
        consumedReadUnits += units;

        const found = new Set(result.found.map(key => keyId(key)));
        const unprocessed = new Set(result.unprocessed.map(key => keyId(key)));
        const checked: CheckedKeys = { present: [], absent: [] };
        const retry: ItemKey[] = [];
        for(const key of batch) {
            if(found.has(keyId(key))) {
                checked.present.push(key);
            } else if(unprocessed.has(keyId(key))) {
                retry.push(key);
            } else {
                checked.absent.push(key);
            }
        }
        present.push(...checked.present);
        absent.push(...checked.absent);
        onChecked?.(checked);
        queue.unshift(...retry);

        stalledRounds = retry.length === batch.length ? stalledRounds + 1 : 0;
        if(stalledRounds === MAX_STALLED_ROUNDS) {
            throw new Error(`BatchGetItem returned every key unprocessed ${MAX_STALLED_ROUNDS} times in a row; aborting (DynamoDB is throttling: retry later or lower --rate-limit-rcu-per-sec)`);
        }

        // eslint-disable-next-line no-await-in-loop -- intentional pause before the next request
        await paceAfterRead({ consumedReadUnits: units, rateLimitRcuPerSec: ctx.rateLimitRcuPerSec, startedAtMs, now: ctx.now, sleep: ctx.sleep });
        if(stalledRounds > 0) {
            // eslint-disable-next-line no-await-in-loop -- back off while DynamoDB throttles
            await ctx.sleep(stalledRounds * STALL_BACKOFF_MS);
        }
    }
    return { present, absent, consumedReadUnits };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function rowKey(row: CandidateRow): ItemKey {
    return { PK: row.snapshot.pk, SK: row.snapshot.sk };
}

interface DeleteOutcome {
    deleted:    number
    reappeared: number
    changed:    number
    errors:     number
    rcu:        number
}

/** Deletes one orphan the re-check just found absent, if it is unchanged, recording what happened. */
function deleteOrphan(
    row:         CandidateRow,
    vectorIndex: Pick<VectorIndex, 'delete'>,
    write:       (message: string) => void,
    outcome:     Pick<DeleteOutcome, 'deleted' | 'changed' | 'errors'>
): void {
    const { pk, sk, ...generation } = row.snapshot;
    try {
        if(vectorIndex.delete(pk, sk, generation)) {
            outcome.deleted++;
        } else {
            outcome.changed++;
            write(`kept (re-indexed since the snapshot): ${row.path}\n`);
        }
    } catch (error) {
        outcome.errors++;
        write(`delete failed: ${row.path}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
}

/**
 * Re-checks the orphans and deletes each still-absent row if it is unchanged. The deletes for a
 * request run synchronously as soon as it returns, before its pacing pause, so the gap between
 * the authoritative read and the delete never includes a sleep or a retry.
 */
async function deleteOrphans(
    orphans:     CandidateRow[],
    ctx:         ExistenceContext,
    vectorIndex: Pick<VectorIndex, 'delete'>,
    write:       (message: string) => void
): Promise<DeleteOutcome> {
    // `rcu` has no meaningful initial value: it is always overwritten below from the recheck's
    // consumed read units before this function returns (and never read on an error path), so it
    // is left out of this object entirely rather than initialized to a dead placeholder.
    const outcome: Omit<DeleteOutcome, 'rcu'> = { deleted: 0, reappeared: 0, changed: 0, errors: 0 };
    const rowsById = new Map(orphans.map(row => [keyId(rowKey(row)), row]));
    const recheck = await checkExistence(orphans.map(row => rowKey(row)), ctx, (checked) => {
        for(const key of checked.present) {
            outcome.reappeared++;
            write(`kept (reappeared in DynamoDB): ${rowsById.get(keyId(key))!.path}\n`);
        }
        for(const key of checked.absent) {
            deleteOrphan(rowsById.get(keyId(key))!, vectorIndex, write, outcome);
        }
    });
    return { ...outcome, rcu: recheck.consumedReadUnits };
}

/** Splits the snapshot into canonical rows under the prefix and malformed rows (reported, never touched). */
function partitionRows(rows: readonly VectorRowSnapshot[], prefix: string, write: (message: string) => void): { candidates: CandidateRow[], malformed: number } {
    const candidates: CandidateRow[] = [];
    let malformed = 0;
    for(const snapshot of rows) {
        const memoryPath = canonicalPathUnderPrefix(snapshot, prefix);
        if(memoryPath === undefined) {
            malformed++;
            write(`malformed (left untouched): pk=${snapshot.pk} sk=${snapshot.sk}\n`);
        } else {
            candidates.push({ path: memoryPath, snapshot });
        }
    }
    return { candidates, malformed };
}

function elapsedSeconds(deps: Pick<PruneDependencies, 'now'>, startedAtMs: number): string {
    return ((deps.now() - startedAtMs) / 1000).toFixed(1);
}

export async function main(argv: string[] = process.argv, deps: PruneDependencies = createDefaultPruneDependencies()): Promise<void> {
    const opts = parseArgs(argv);
    if(opts.showHelp) {
        deps.write(HELP_TEXT);
        return;
    }

    const startedAtMs = deps.now();
    const storage = deps.openStorage();
    let vectorIndex: Pick<VectorIndex, 'listRowsByPathPrefix' | 'delete' | 'close'> | undefined;
    try {
        deps.write(`Vector orphan prune (${opts.execute ? 'EXECUTE' : 'dry run'})
  Table: ${storage.tableName}
  Database: ${opts.dbPath}
  Prefix: ${opts.prefix}
  Rate limit: ${opts.rateLimitRcuPerSec} RCU/sec, strongly consistent BatchGetItem batches of ${opts.batchSize}
`);
        if(opts.prefix !== DEFAULT_PREFIX) {
            deps.write(`Warning: checking only ${opts.prefix}, not all of ${DEFAULT_PREFIX}\n`);
        }

        vectorIndex = await deps.openVectorIndex(opts.dbPath);
        const rows = vectorIndex.listRowsByPathPrefix(opts.prefix);
        const { candidates, malformed } = partitionRows(rows, opts.prefix, deps.write);

        const ctx: ExistenceContext = {
            batchGetKeys:       storage.batchGetKeys,
            batchSize:          opts.batchSize,
            rateLimitRcuPerSec: opts.rateLimitRcuPerSec,
            now:                deps.now,
            sleep:              deps.sleep,
        };
        const existence = await checkExistence(candidates.map(row => rowKey(row)), ctx);
        const absentIds = new Set(existence.absent.map(key => keyId(key)));
        const orphans = candidates.filter(row => absentIds.has(keyId(rowKey(row))));
        const marker = opts.execute ? '' : '[dry-run] ';
        for(const orphan of orphans) {
            deps.write(`${marker}orphan: ${orphan.path}\n`);
        }
        deps.write(`
Existence check complete:
  Rows under prefix: ${rows.length}
  Malformed (untouched): ${malformed}
  Present in DynamoDB: ${existence.present.length}
  Absent (orphans): ${orphans.length}
  RCU consumed: ${existence.consumedReadUnits}
  Elapsed: ${elapsedSeconds(deps, startedAtMs)}s
`);

        if(!opts.execute) {
            deps.write(`Dry run: nothing deleted. Re-run with --execute to delete the ${orphans.length} orphan(s).\n`);
            return;
        }
        if(orphans.length > 0 && existence.present.length === 0 && !opts.allowAllAbsent) {
            throw new Error(
                `Refusing to delete: every one of the ${orphans.length} key(s) under ${opts.prefix} is absent from ${storage.tableName}. `
                + 'Check the stage, table and credentials; pass --allow-all-absent only if this is really intended.'
            );
        }

        const outcome = await deleteOrphans(orphans, ctx, vectorIndex, deps.write);
        deps.write(`
Prune complete:
  Deleted: ${outcome.deleted}
  Kept, reappeared in DynamoDB: ${outcome.reappeared}
  Kept, re-indexed since the snapshot: ${outcome.changed}
  Delete errors: ${outcome.errors}
  RCU consumed (total): ${existence.consumedReadUnits + outcome.rcu}
  Elapsed: ${elapsedSeconds(deps, startedAtMs)}s
`);
        if(outcome.errors > 0) {
            throw new Error(`Prune completed with ${outcome.errors} delete error(s)`);
        }
    } finally {
        try {
            vectorIndex?.close();
        } finally {
            storage.destroy();
        }
    }
}

export async function runPruneCli(isMain: boolean, run: () => Promise<void>): Promise<void> {
    if(isMain) {
        await run();
    }
}

// As the CLI, a rejection here is unhandled, and Bun prints it and exits 1. It is not awaited:
// under test import.meta.main is false, so a top-level await could never be observed and would
// leave an unkillable await-drop mutant behind.
// eslint-disable-next-line unicorn/prefer-top-level-await -- see above: exit status is preserved by Bun's unhandled-rejection handling
void runPruneCli(import.meta.main, main);
