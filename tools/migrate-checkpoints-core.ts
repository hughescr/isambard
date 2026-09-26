/**
 * Testable core of the one-shot checkpoint migration (#57): legacy `/state/services/...` memory
 * rows move into the operational-state store (`OPERATIONAL_STATE#<owner>` partitions). The runner,
 * tools/migrate-checkpoints.ts, documents usage and rollback; this module takes all I/O injected.
 *
 * It is self-contained on purpose: it knows the legacy layout itself rather than importing it from
 * src/storage/operational-state/legacy-fallback.ts, so deleting that fallback after the live run
 * does not break the tool.
 *
 * Phases:
 *   1. Enumerate every raw GSI1 `LAYER#state` item, paced by the consumed RCU each page reports,
 *      and keep the rows whose keys put them under /state/services/. Raw items, not decoded
 *      memories: a row whose memory envelope is malformed (empty content, a bad date) is still
 *      seen, counted and cleaned up rather than silently skipped.
 *   2. Per row: an unrecognised path is reported and left alone. A recognised checkpoint whose
 *      content is not valid JSON for its schema is reported as unparseable and deleted. Otherwise
 *      the verbatim legacy JSON is written with a conditional put that only creates an absent key
 *      (a row the bot wrote since the deploy is newer and always wins), and only then is the
 *      legacy row deleted. Dry run (the default) reads the new key instead and writes nothing.
 *   3. With a vector index: delete every recognised-checkpoint row under /state/services/ there,
 *      whether or not this run deleted its DynamoDB row, so a re-run repairs an interrupted run.
 *
 * Every per-row DynamoDB operation is charged, before it is issued, against a capacity pacer
 * sized from the item: 1 WCU per KB written or deleted (plus each tag's registry writes, see
 * legacyDeleteWriteUnits), 1 RCU per 4 KB read. Reads and writes each have their own budget. The
 * legacy delete also removes the row's ALL-projected GSI1 entry, which costs the same WCU on the
 * index, and a tag's META_COUNT writes touch GSI2; every index write is also a table write, so
 * pacing the table at WRITE_UNITS_PER_SEC holds each index to it too.
 *
 * Izzy can keep running (#57, 2026-09-25): the copy only creates an absent key, so a checkpoint
 * Izzy writes meanwhile wins, and the vector index takes concurrent writers since #129.
 */

import path from 'node:path';
import { requireConsumedReadUnits } from './rcu-pacing';
import {
    bskyDmCheckpointSchema,
    bskyFeedCheckpointSchema,
    bskyNotificationCheckpointSchema
} from '@/integrations/bsky/checkpoint/types';
import { discordChannelCheckpointSchema } from '@/integrations/discord/inbox/types';
import {
    createMemoryPath,
    MemoryToolKeyGenerator,
    type MemoryToolBackend,
    type OperationalStateBackend,
    type OperationalStateKey,
    type OperationalStateSchema,
    type VectorIndex
} from '@/storage';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Every legacy checkpoint lived under this memory directory. */
export const LEGACY_PREFIX = '/state/services/';

/** GSI1 `LAYER#state` page size; one page of large state memories stays a small read burst. */
export const STATE_PAGE_SIZE = 10;

/** Read budget shared by GSI1 pages and table reads: half of GSI1's 2 RCU. */
export const READ_UNITS_PER_SEC = 1;

/** Write budget: half of the table's (and GSI1's) 2 WCU. */
export const WRITE_UNITS_PER_SEC = 1;

// ── Legacy layout ─────────────────────────────────────────────────────────────

export interface LegacyCheckpointTarget {
    key:    OperationalStateKey
    schema: OperationalStateSchema<unknown>
}

const LEGACY_CHECKPOINTS: readonly { pattern: RegExp, owner: OperationalStateKey['owner'], schema: OperationalStateSchema<unknown> }[] = [
    { pattern: /^\/state\/services\/discord\/(channels\/[^/]+\/checkpoint)$/, owner: 'discord', schema: discordChannelCheckpointSchema },
    { pattern: /^\/state\/services\/bsky\/(feeds\/[^/]+\/checkpoint)$/, owner: 'bsky', schema: bskyFeedCheckpointSchema },
    { pattern: /^\/state\/services\/bsky\/(notifications\/checkpoint)$/, owner: 'bsky', schema: bskyNotificationCheckpointSchema },
    { pattern: /^\/state\/services\/bsky\/(dm\/checkpoint)$/, owner: 'bsky', schema: bskyDmCheckpointSchema },
];

/**
 * The operational-state key and schema for a legacy checkpoint path, or undefined for any other
 * path. Stripping `/state/services/<owner>/` gives exactly the name the managers use now.
 */
export function legacyCheckpointTarget(memoryPath: string): LegacyCheckpointTarget | undefined {
    for(const entry of LEGACY_CHECKPOINTS) {
        const match = entry.pattern.exec(memoryPath);
        if(match) {
            return { key: { owner: entry.owner, name: match[1] }, schema: entry.schema };
        }
    }
    return undefined;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface MigrateOptions {
    execute:         boolean
    vectorIndexPath: string | undefined
    showHelp:        boolean
}

/** Parses `process.argv`. Dry run is the default; only `--execute` writes. */
export function parseArgs(argv: string[]): MigrateOptions {
    const options: MigrateOptions = { execute: false, vectorIndexPath: undefined, showHelp: false };
    // Expand `--flag=value` into ['--flag', 'value'] so the loop below handles both forms.
    const args = argv.slice(2).flatMap((arg) => {
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        return eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)];
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
            case '--vector-index': {
                const value = iterator.next().value;
                if(!value) {
                    throw new Error('--vector-index requires a path');
                }
                options.vectorIndexPath = path.resolve(value);
                break;
            }
            default: {
                throw new Error(`Unknown option: ${arg}`);
            }
        }
    }
    return options;
}

// ── Capacity pacing ───────────────────────────────────────────────────────────

/**
 * Capacity debt for one budget. `record` adds units' worth of time to the debt, counted from now
 * or from the end of the debt already owed, whichever is later (idle time is not banked); `wait`
 * sleeps out the debt; `charge` does both, for an operation whose cost is known before it runs.
 */
export interface CapacityPacer {
    wait:   () => Promise<void>
    record: (units: number) => void
    charge: (units: number) => Promise<void>
}

export function createCapacityPacer(unitsPerSec: number, now: () => number, sleep: (ms: number) => Promise<void>): CapacityPacer {
    let nextAllowedAtMs = Number.NEGATIVE_INFINITY;
    const wait = async (): Promise<void> => {
        const waitMs = nextAllowedAtMs - now();
        if(waitMs > 0) {
            await sleep(waitMs);
        }
    };
    const record = (units: number): void => {
        nextAllowedAtMs = Math.max(now(), nextAllowedAtMs) + (units * 1000 / unitsPerSec);
    };
    return {
        wait,
        record,
        charge: async (units) => {
            await wait();
            record(units);
        },
    };
}

/**
 * An upper bound on a DynamoDB item's billed size: the UTF-8 length of its JSON encoding, which
 * spends at least as many bytes on every attribute name and value as DynamoDB does.
 */
export function estimateItemBytes(item: Record<string, unknown>): number {
    return Buffer.byteLength(JSON.stringify(item, (_key, value: unknown) => (value instanceof Set ? [...value] : value)));
}

/** Write units for writing or deleting an item of `bytes` (1 WCU per KB). */
export function writeUnits(bytes: number): number {
    return Math.ceil(bytes / 1024);
}

/** Read units for a strongly consistent read of an item of `bytes` (1 RCU per 4 KB). */
export function readUnits(bytes: number): number {
    return Math.ceil(bytes / 4096);
}

/**
 * Write units for MemoryToolBackend.delete of a legacy row: the row itself, then per tag its tag
 * pointer, the META_COUNT decrement and, when the count reaches zero, the META_COUNT delete. A
 * pointer holds the row's path and tags and a 100-character content preview, so the row's size
 * bounds it. The tag writes fan out concurrently inside the delete, so the whole cost is charged
 * up front and the budget holds on average, as it does for any multi-KB single write.
 */
export function legacyDeleteWriteUnits(row: Pick<LegacyRow, 'bytes' | 'tagCount'>): number {
    return (writeUnits(row.bytes) * (1 + row.tagCount)) + (2 * row.tagCount);
}

// ── Enumeration ───────────────────────────────────────────────────────────────

/** One raw GSI1 page. */
export interface StatePage {
    items:             Record<string, unknown>[]
    lastEvaluatedKey:  Record<string, unknown> | undefined
    consumedReadUnits: number | undefined
}

/** Reads one GSI1 `LAYER#state` page starting at `cursor` (undefined for the first page). */
export type QueryStatePage = (cursor: Record<string, unknown> | undefined) => Promise<StatePage>;

/** A legacy memory row under /state/services/, taken from its keys and raw attributes. */
export interface LegacyRow {
    path:     string
    content:  unknown
    bytes:    number
    tagCount: number
}

/**
 * The legacy row for a raw GSI1 item under /state/services/, or undefined for any other item. The
 * path comes from the item's keys, not its (possibly malformed) `path` attribute.
 */
export function toLegacyRow(raw: Record<string, unknown>): LegacyRow | undefined {
    let memoryPath: string;
    try {
        memoryPath = MemoryToolKeyGenerator.parsePath(String(raw.PK), String(raw.SK));
    } catch{
        return undefined; // Not DIR#/FILE# memory keys
    }
    if(!memoryPath.startsWith(LEGACY_PREFIX)) {
        return undefined;
    }
    return {
        path:     memoryPath,
        content:  raw.content,
        bytes:    estimateItemBytes(raw),
        tagCount: raw.tags instanceof Set ? raw.tags.size : 0,
    };
}

/**
 * Every legacy row, in GSI1 order. All of it is read before anything is written, so a delete
 * never disturbs the pagination and the whole list is printed before the first write.
 */
export async function listLegacyRows(query: QueryStatePage, pacer: Pick<CapacityPacer, 'wait' | 'record'>): Promise<LegacyRow[]> {
    const rows: LegacyRow[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
        // eslint-disable-next-line no-await-in-loop -- sequential, paced pagination
        await pacer.wait();
        // eslint-disable-next-line no-await-in-loop -- sequential, paced pagination
        const page = await query(cursor);
        pacer.record(requireConsumedReadUnits(page.consumedReadUnits, 'GSI1 LAYER#state query'));
        for(const raw of page.items) {
            const row = toLegacyRow(raw);
            if(row) {
                rows.push(row);
            }
        }
        cursor = page.lastEvaluatedKey;
    } while(cursor);
    return rows;
}

// ── Migration ─────────────────────────────────────────────────────────────────

export interface MigrationCounts {
    copied:             number
    skippedNewerExists: number
    unparseable:        number
    unrecognised:       number
    deleted:            number
}

export interface MigrationContext {
    legacy:     Pick<MemoryToolBackend, 'delete'>
    target:     Pick<OperationalStateBackend, 'read' | 'putIfAbsent'>
    readPacer:  Pick<CapacityPacer, 'charge'>
    writePacer: Pick<CapacityPacer, 'charge'>
    write:      (message: string) => void
    execute:    boolean
}

type DecodedLegacy = { value: unknown } | { reason: 'json' | 'schema' };

/** The legacy JSON, validated by `schema` but kept verbatim (not the schema's output). */
function decodeLegacyContent(content: unknown, schema: OperationalStateSchema<unknown>): DecodedLegacy {
    let value: unknown;
    try {
        value = JSON.parse(String(content));
    } catch{
        return { reason: 'json' };
    }
    try {
        schema.parse(value);
    } catch{
        return { reason: 'schema' };
    }
    return { value };
}

/** Copies (execute) or predicts the copy of (dry run) one decoded checkpoint. */
async function copyCheckpoint(row: LegacyRow, target: LegacyCheckpointTarget, value: unknown, ctx: MigrationContext): Promise<'copied' | 'skippedNewerExists'> {
    if(ctx.execute) {
        await ctx.writePacer.charge(writeUnits(row.bytes));
        return await ctx.target.putIfAbsent(target.key, value) === 'created' ? 'copied' : 'skippedNewerExists';
    }
    await ctx.readPacer.charge(readUnits(row.bytes));
    const current = await ctx.target.read(target.key, target.schema);
    return current.status === 'absent' ? 'copied' : 'skippedNewerExists';
}

/** Deletes the legacy row (execute only): MemoryToolBackend.delete reads it for its tags, then deletes it and its tag rows. */
async function deleteLegacyRow(row: LegacyRow, ctx: MigrationContext): Promise<void> {
    if(!ctx.execute) {
        return;
    }
    await ctx.readPacer.charge(readUnits(row.bytes));
    await ctx.writePacer.charge(legacyDeleteWriteUnits(row));
    await ctx.legacy.delete(createMemoryPath(row.path));
}

/**
 * Migrates the rows in order and fails fast on the first DynamoDB error. A legacy row is deleted
 * only after its put succeeded or its key already existed, so an interrupted run can be re-run.
 */
export async function migrateLegacyRows(rows: readonly LegacyRow[], ctx: MigrationContext): Promise<MigrationCounts> {
    const counts: MigrationCounts = { copied: 0, skippedNewerExists: 0, unparseable: 0, unrecognised: 0, deleted: 0 };
    const marker = ctx.execute ? '' : '[dry-run] ';
    for(const row of rows) {
        const target = legacyCheckpointTarget(row.path);
        if(target === undefined) {
            counts.unrecognised++;
            ctx.write(`${marker}unrecognised (left untouched): ${row.path}\n`);
            continue;
        }
        const decoded = decodeLegacyContent(row.content, target.schema);
        if('reason' in decoded) {
            counts.unparseable++;
            ctx.write(`${marker}unparseable (${decoded.reason}): ${row.path}\n`);
        } else {
            // eslint-disable-next-line no-await-in-loop -- rows are migrated one at a time, paced
            const outcome = await copyCheckpoint(row, target, decoded.value, ctx);
            counts[outcome]++;
            const verb = outcome === 'copied' ? 'copy' : 'skip, newer row exists';
            ctx.write(`${marker}${verb}: ${row.path} -> ${target.key.owner}:${target.key.name}\n`);
        }
        // eslint-disable-next-line no-await-in-loop -- rows are migrated one at a time, paced
        await deleteLegacyRow(row, ctx);
        counts.deleted++;
        ctx.write(`${marker}delete legacy row: ${row.path}\n`);
    }
    return counts;
}

// ── Vector index ──────────────────────────────────────────────────────────────

export interface VectorRowKey {
    pk: string
    sk: string
}

export interface VectorCounts {
    vectorRowsDeleted: number
    vectorRowsKept:    number
}

function recognisedCheckpointPath(row: VectorRowKey): string | undefined {
    let memoryPath: string;
    try {
        memoryPath = MemoryToolKeyGenerator.parsePath(row.pk, row.sk);
    } catch{
        return undefined; // Not DIR#/FILE# memory keys
    }
    return legacyCheckpointTarget(memoryPath) === undefined ? undefined : memoryPath;
}

/**
 * Deletes (through `remove`) every recognised-checkpoint row and keeps the rest. Without `remove`
 * it is a dry run that only counts and reports.
 */
export function cleanVectorRows(rows: readonly VectorRowKey[], remove: ((pk: string, sk: string) => unknown) | undefined, write: (message: string) => void): VectorCounts {
    const marker = remove === undefined ? '[dry-run] ' : '';
    const counts: VectorCounts = { vectorRowsDeleted: 0, vectorRowsKept: 0 };
    for(const row of rows) {
        const memoryPath = recognisedCheckpointPath(row);
        if(memoryPath === undefined) {
            counts.vectorRowsKept++;
            write(`${marker}keep vector row: pk=${row.pk} sk=${row.sk}\n`);
        } else {
            remove?.(row.pk, row.sk);
            counts.vectorRowsDeleted++;
            write(`${marker}delete vector row: ${memoryPath}\n`);
        }
    }
    return counts;
}

/**
 * Refuses a vector index that is missing: a wrong path would otherwise create an empty one. An
 * index a running Izzy holds open is fine (#129: WAL, busy_timeout and IMMEDIATE writes).
 */
export function preflightVectorIndex(dbPath: string, exists: (filePath: string) => boolean): void {
    if(!exists(dbPath)) {
        throw new Error(`Vector index not found: ${dbPath}. Pass the SQLite file Izzy uses.`);
    }
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export interface MigrationStorage {
    tableName:      string
    queryStatePage: QueryStatePage
    /** A MemoryToolBackend with NO indexer, so deletes enqueue nothing. */
    legacy:         Pick<MemoryToolBackend, 'delete'>
    /** The raw operational-state backend: the fallback-wrapped store would report legacy hits. */
    target:         Pick<OperationalStateBackend, 'read' | 'putIfAbsent'>
    destroy:        () => void
}

export type MigrationVectorIndex = Pick<VectorIndex, 'listRowsByPathPrefix' | 'delete' | 'close'>;

export interface MigrationDeps {
    openStorage:     () => MigrationStorage
    /** Opens the index for writing (execute only). */
    openVectorIndex: (dbPath: string) => Promise<MigrationVectorIndex>
    /** Lists the rows under `prefix` without writing anything to the file (dry run). */
    readVectorRows:  (dbPath: string, prefix: string) => VectorRowKey[]
    exists:          (filePath: string) => boolean
    now:             () => number
    sleep:           (ms: number) => Promise<void>
    write:           (message: string) => void
}

export interface MigrationSummary extends MigrationCounts {
    legacyRows: number
    vector:     VectorCounts | undefined
}

export function formatSummary(summary: MigrationSummary, execute: boolean, elapsedSeconds: string): string {
    const vector = summary.vector === undefined
        ? ''
        : `  Vector rows deleted: ${summary.vector.vectorRowsDeleted}\n  Vector rows kept: ${summary.vector.vectorRowsKept}\n`;
    return `
Checkpoint migration ${execute ? 'complete' : 'dry run (nothing written)'}:
  Legacy rows under ${LEGACY_PREFIX}: ${summary.legacyRows}
  Copied: ${summary.copied}
  Skipped, newer row exists: ${summary.skippedNewerExists}
  Unparseable: ${summary.unparseable}
  Unrecognised (left untouched): ${summary.unrecognised}
  Legacy rows deleted: ${summary.deleted}
${vector}  Elapsed: ${elapsedSeconds}s
${execute ? '' : 'Dry run: nothing written. Re-run with --execute.\n'}`;
}

function vectorPass(dbPath: string, index: MigrationVectorIndex | undefined, deps: MigrationDeps): VectorCounts {
    if(index === undefined) {
        return cleanVectorRows(deps.readVectorRows(dbPath, LEGACY_PREFIX), undefined, deps.write);
    }
    return cleanVectorRows(index.listRowsByPathPrefix(LEGACY_PREFIX), (pk, sk) => index.delete(pk, sk), deps.write);
}

/**
 * Runs the whole migration. The vector-index checks run first, before any DynamoDB call, and an
 * execute run opens the index before its first write so an unopenable index stops it early.
 */
export async function runMigration(opts: MigrateOptions, deps: MigrationDeps): Promise<MigrationSummary> {
    const { vectorIndexPath } = opts;
    if(vectorIndexPath !== undefined) {
        preflightVectorIndex(vectorIndexPath, deps.exists);
    }

    const startedAtMs = deps.now();
    const storage = deps.openStorage();
    let vectorIndex: MigrationVectorIndex | undefined;
    try {
        deps.write(`Checkpoint migration (${opts.execute ? 'EXECUTE' : 'dry run'})
  Table: ${storage.tableName}
  Vector index: ${vectorIndexPath ?? 'not cleaned (no --vector-index)'}
  Pacing: reads ${READ_UNITS_PER_SEC} RCU/s, writes ${WRITE_UNITS_PER_SEC} WCU/s
`);
        if(vectorIndexPath !== undefined && opts.execute) {
            vectorIndex = await deps.openVectorIndex(vectorIndexPath);
        }

        const readPacer = createCapacityPacer(READ_UNITS_PER_SEC, deps.now, deps.sleep);
        const writePacer = createCapacityPacer(WRITE_UNITS_PER_SEC, deps.now, deps.sleep);
        const rows = await listLegacyRows(storage.queryStatePage, readPacer);
        deps.write(`${rows.length} legacy row(s) under ${LEGACY_PREFIX}\n`);

        const counts = await migrateLegacyRows(rows, {
            legacy:  storage.legacy,
            target:  storage.target,
            readPacer,
            writePacer,
            write:   deps.write,
            execute: opts.execute,
        });
        const vector = vectorIndexPath === undefined ? undefined : vectorPass(vectorIndexPath, vectorIndex, deps);

        const summary: MigrationSummary = { legacyRows: rows.length, ...counts, vector };
        deps.write(formatSummary(summary, opts.execute, ((deps.now() - startedAtMs) / 1000).toFixed(1)));
        return summary;
    } finally {
        try {
            vectorIndex?.close();
        } finally {
            storage.destroy();
        }
    }
}
