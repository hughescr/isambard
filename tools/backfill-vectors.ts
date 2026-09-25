/**
 * Backfill CLI for the vector index.
 *
 * Walks the GSI1 partitions of the indexed namespaces (identity, state, events
 * and users — nested paths included) and indexes every memory into SQLite.
 * Items whose content hash already matches are skipped unless --force; their
 * DynamoDB TTL is still stamped onto the index row (one batched write per page,
 * no extra reads: GSI1 projects ALL attributes). Items already past their TTL
 * are not hashed or embedded — the local expiry prune would delete them at once —
 * but their TTL is stamped onto any existing row, so the prune removes it (#129).
 *
 * Every write carries the item's DynamoDB updatedAt as its source version, and the
 * index never lets it replace a row a newer live write produced: a page read before
 * Izzy refreshed or rewrote a memory cannot roll the vector or its TTL back.
 *
 * Usage:
 *   bun tools/backfill-vectors.ts [options]
 *
 * Options:
 *   --layer <identity|state|events|users>  Only backfill one namespace (default: all four)
 *   --db-path <path>                 SQLite database path (default: <repo-root>/scratch/memory-vec.sqlite)
 *   --model-slug <0.6b|4b>           Embedder model size (default: 0.6b)
 *   --model-quant <Q8_0|Q4_K_M>      Embedder quantization (default: Q8_0)
 *   --dry-run                        Show what would be indexed without writing
 *   --force                          Re-embed every item even if content hash matches
 *   --rate-limit-rcu-per-sec <N>     GSI1 read budget in RCU/s, paced by consumed capacity (default: 2)
 *   --help                           Show this help message
 *
 * Requires SST shell for DynamoDB credentials:
 *   sst shell -- bun tools/backfill-vectors.ts
 */

import path from 'node:path';
import { logger } from '@hughescr/logger';
import { createDefaultBackfillDependencies } from './backfill-vectors-runtime';
import { paceAfterRead, parseRcuRate, requireConsumedReadUnits } from './rcu-pacing';
import {
    MemoryToolKeyGenerator,
    classifyMemoryPath,
    isMemoryPath,
    SEARCHABLE_NAMESPACE_VALUES,
    SEARCHABLE_NAMESPACES,
    PACKED_EMBEDDING_BYTES,
    type EpochSeconds,
    type SearchableNamespace,
    type MemoryToolBackend,
    type ModelQuant,
    type ModelSlug,
    type VectorIndex,
    type VectorTtlUpdate
} from '@/storage';
import type { MemoryPath } from '@/storage/memory-tool';
import { storedTtl } from '@/storage/memory-tool/decode-stored-item';
import { sha256Hex, type PackedBinaryEmbedding1024 } from '@/storage/memory-vec-store';

// ── CLI options ───────────────────────────────────────────────────────────────

// Default db path: <repo-root>/scratch/memory-vec.sqlite
// import.meta.dir is tools/, so go up one level to repo root
const DEFAULT_DB_PATH = path.resolve(import.meta.dir, '..', 'scratch', 'memory-vec.sqlite');

const HELP_TEXT = `
Usage: bun tools/backfill-vectors.ts [options]

Options:
  --layer <identity|state|events|users>  Only backfill one namespace (default: all four)
  --db-path <path>                 SQLite database path (default: ${DEFAULT_DB_PATH})
  --model-slug <0.6b|4b>           Embedder model size (default: 0.6b)
  --model-quant <Q8_0|Q4_K_M>      Embedder quantization (default: Q8_0)
  --dry-run                        Show what would be indexed without writing
  --force                          Re-embed every item even if content hash matches
  --rate-limit-rcu-per-sec <N>     GSI1 read budget in RCU/s, paced by consumed capacity (default: 2)
  --help                           Show this help message

Without --layer, walks identity, state, events and users (nested paths included).
Each GSI1 query reads at most 4 items and asks DynamoDB for its ConsumedCapacity;
before the next query the tool pauses (consumed RCU / N) seconds less the time
already spent, so large items and rows skipped as malformed are paid for in full
and the average read rate stays at or below N. A single page can momentarily
exceed N (up to 4 items' worth, absorbed by DynamoDB burst capacity) and is paid
back before the next read. The run stops if DynamoDB omits ConsumedCapacity.
GSI1 is provisioned at 2 RCU, so keep the rate at or below 2.
Run once with --force --layer users after deploying #58 so /users vectors written
before it (labelled 'unknown') are rewritten as 'users'.

TTL (#129): every row written carries the item's DynamoDB TTL. An unchanged item
is not re-embedded, but its TTL is stamped onto the existing row (one batched
local write per page, reported as "TTL updated"). Items already past their TTL
are not embedded ("Skipped (expired)"), but their TTL is stamped onto any existing
row so the local prune removes it. Every write carries the item's updatedAt, and a
row that a newer live write already produced is left alone ("Skipped (index
already newer)", or no TTL change). --dry-run writes no TTLs either.
The vector database is opened with busy_timeout and WAL, so this tool can run
while Izzy is live; pass --db-path pointing at the file Izzy uses.

Requires SST shell for DynamoDB credentials:
  sst shell -- bun tools/backfill-vectors.ts
`;

interface BackfillOptions {
    layer?:             SearchableNamespace
    dbPath:             string
    modelSlug:          ModelSlug
    modelQuant:         ModelQuant
    dryRun:             boolean
    force:              boolean
    showHelp:           boolean
    rateLimitRcuPerSec: number
}

interface BackfillPageStats {
    scanned:    number
    skipped:    number
    indexed:    number
    errors:     number
    /** Unchanged rows whose stored TTL changed. */
    ttlUpdated: number
    /** Items already past their DynamoDB TTL: not hashed or embedded, only their TTL stamped. */
    expired:    number
    /** Embedded items the index already held at a newer source version, so left as they were. */
    superseded: number
}

interface BackfillItem {
    path:      MemoryPath
    content:   string
    /** The item's DynamoDB `updatedAt` (ISO 8601): its source version for the index's write guard. */
    updatedAt: string
    /** DynamoDB TTL (epoch seconds), carried at runtime on decoded items; read via storedTtl. */
    TTL?:      number
}

interface PendingEmbedding {
    item:            BackfillItem
    keys:            { PK: string, SK: string }
    text:            string
    contentHash:     string
    ttl:             EpochSeconds | null
    sourceUpdatedAt: number
}

interface BatchEmbedder {
    encode(texts: readonly string[]): Promise<{ data: Uint8Array }>
}

interface BackfillModel extends BatchEmbedder {
    close(): Promise<void>
}

const EMBED_BATCH_SIZE = 8;

function isModelSlug(val: string): val is ModelSlug {
    return val === '0.6b' || val === '4b';
}

function isModelQuant(val: string): val is ModelQuant {
    return val === 'Q8_0' || val === 'Q4_K_M';
}

export function parseArgs(argv: string[]): BackfillOptions {
    const options: BackfillOptions = {
        dbPath:             DEFAULT_DB_PATH,
        modelSlug:          '0.6b',
        modelQuant:         'Q8_0',
        dryRun:             false,
        force:              false,
        showHelp:           false,
        rateLimitRcuPerSec: 2,
    };

    const handlers: Partial<Record<string, (value: string | undefined) => void>> = {
        '--layer': (value) => {
            if(!value) {
                throw new Error(`--layer requires a value (typically identity, state, events; or 'users' for /users/* memories).`);
            }
            const layer = SEARCHABLE_NAMESPACES.find(namespace => namespace === value);
            if(!layer) {
                throw new Error(`Invalid --layer value: ${value}. Must be one of ${SEARCHABLE_NAMESPACE_VALUES.join(', ')}.`);
            }
            options.layer = layer;
        },
        '--db-path': (value) => {
            if(!value) {
                throw new Error('--db-path requires a value');
            }
            options.dbPath = path.resolve(value);
        },
        '--model-slug': (value) => {
            if(!value || !isModelSlug(value)) {
                throw new Error(`Invalid --model-slug value: ${value ?? '(missing)'}. Must be 0.6b or 4b.`);
            }
            options.modelSlug = value;
        },
        '--model-quant': (value) => {
            if(!value || !isModelQuant(value)) {
                throw new Error(`Invalid --model-quant value: ${value ?? '(missing)'}. Must be Q8_0 or Q4_K_M.`);
            }
            options.modelQuant = value;
        },
        '--rate-limit-rcu-per-sec': (value) => {
            options.rateLimitRcuPerSec = parseRcuRate(value);
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
            case '--dry-run': {
                options.dryRun = true;
                break;
            }
            case '--force': {
                options.force = true;
                break;
            }
            default: {
                const handler = handlers[arg];
                if(handler) {
                    handler(iterator.next().value);
                } else if(arg.startsWith('--')) {
                    throw new Error(`Unknown option: ${arg}`);
                }
            }
        }
    }
    return options;
}

function errorInfo(err: unknown): Record<string, unknown> {
    return err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
        : { value: String(err) };
}

/** Returns one packed embedding after the batch output length has been validated. */
function packedEmbeddingAt(data: Uint8Array, index: number): PackedBinaryEmbedding1024 {
    return data.subarray(index * PACKED_EMBEDDING_BYTES, (index + 1) * PACKED_EMBEDDING_BYTES) as PackedBinaryEmbedding1024;
}

async function writeEmbeddingBatch(
    batch:       PendingEmbedding[],
    embedder:    BatchEmbedder,
    vectorIndex: Pick<VectorIndex, 'upsert'>,
    stats:       BackfillPageStats
): Promise<void> {
    let data: Uint8Array;
    try {
        const result = await embedder.encode(batch.map(entry => entry.text));
        data = result.data;
        if(data.length !== batch.length * PACKED_EMBEDDING_BYTES) {
            throw new Error(`Embedder returned ${data.length} bytes for ${batch.length} items`);
        }
    } catch (err) {
        if(batch.length === 1) {
            logger.warn({ err: errorInfo(err), path: batch[0].item.path, msg: 'Failed to embed item' });
            stats.errors++;
            return;
        }
        const midpoint = Math.ceil(batch.length / 2);
        await writeEmbeddingBatch(batch.slice(0, midpoint), embedder, vectorIndex, stats);
        await writeEmbeddingBatch(batch.slice(midpoint), embedder, vectorIndex, stats);
        return;
    }

    for(const [index, entry] of batch.entries()) {
        try {
            const vector = packedEmbeddingAt(data, index);
            const written = vectorIndex.upsert({
                pk:              entry.keys.PK,
                sk:              entry.keys.SK,
                layer:           classifyMemoryPath(entry.item.path).namespace,
                contentHash:     entry.contentHash,
                vector,
                updatedAt:       Date.now(),
                ttl:             entry.ttl,
                sourceUpdatedAt: entry.sourceUpdatedAt,
            });
            if(!written) {
                // A live write newer than this page already reached the index.
                stats.superseded++;
                continue;
            }
            stats.indexed++;
            if(stats.indexed % 10 === 0) {
                process.stdout.write(`  Indexed ${stats.indexed} items in this page...\n`);
            }
        } catch (err) {
            logger.warn({ err: errorInfo(err), path: entry.item.path, msg: 'Failed to upsert item' });
            stats.errors++;
        }
    }
}

async function writePendingEmbeddings(
    pending:     PendingEmbedding[],
    embedder:    BatchEmbedder,
    vectorIndex: Pick<VectorIndex, 'upsert'>,
    stats:       BackfillPageStats,
    offset = 0
): Promise<void> {
    if(offset >= pending.length) {
        return;
    }
    await writeEmbeddingBatch(pending.slice(offset, offset + EMBED_BATCH_SIZE), embedder, vectorIndex, stats);
    await writePendingEmbeddings(pending, embedder, vectorIndex, stats, offset + EMBED_BATCH_SIZE);
}

/** Stamps one page's TTLs onto unchanged and expired items' rows in a single batched write; a failure counts one error. */
function stampTtls(ttlUpdates: VectorTtlUpdate[], vectorIndex: Pick<VectorIndex, 'setTtls'>, stats: BackfillPageStats): void {
    if(ttlUpdates.length === 0) {
        return;
    }
    try {
        stats.ttlUpdated += vectorIndex.setTtls(ttlUpdates);
    } catch (err) {
        logger.warn({ err: errorInfo(err), count: ttlUpdates.length, msg: 'Failed to update TTLs for unchanged or expired items' });
        stats.errors++;
    }
}

export async function processPage(
    items:       BackfillItem[],
    options:     BackfillOptions,
    vectorIndex: Pick<VectorIndex, 'getHash' | 'upsert' | 'setTtls'>,
    embedder:    BatchEmbedder,
    hashText:    (text: string) => Promise<string> = sha256Hex,
    now:         () => number = Date.now
): Promise<BackfillPageStats> {
    const stats: BackfillPageStats = { scanned: items.length, skipped: 0, indexed: 0, errors: 0, ttlUpdated: 0, expired: 0, superseded: 0 };
    const nowSeconds = Math.floor(now() / 1000);
    const ttlUpdates: VectorTtlUpdate[] = [];
    const validItems = items.filter((item) => {
        if(!isMemoryPath(item.path)) {
            logger.warn({ path: item.path, msg: 'Skipping malformed memory path' });
            stats.skipped++;
            return false;
        }
        const ttl = storedTtl(item);
        if(ttl !== undefined && ttl <= nowSeconds) {
            // Not embedded (the local prune would delete it at once), but an existing row — say a
            // pre-#129 row migrated with a NULL TTL — gets the TTL, so query() hides it and
            // pruneExpired() removes it even if DynamoDB sweeps the item before the next backfill.
            // setTtls ignores a missing row and one a newer live write already stamped.
            stats.expired++;
            const keys = MemoryToolKeyGenerator.createKeys(item.path);
            ttlUpdates.push({ pk: keys.PK, sk: keys.SK, ttl, sourceUpdatedAt: Date.parse(item.updatedAt) });
            return false;
        }
        return true;
    });
    const hashes = await Promise.allSettled(validItems.map(item => hashText(`${item.path}\n${item.content}`)));
    const pending: PendingEmbedding[] = [];

    for(const [index, item] of validItems.entries()) {
        const hashResult = hashes.at(index);
        if(hashResult?.status !== 'fulfilled') {
            logger.warn({ err: errorInfo(hashResult?.reason), path: item.path, msg: 'Failed to compute hash, skipping' });
            stats.errors++;
            continue;
        }
        const keys = MemoryToolKeyGenerator.createKeys(item.path);
        const contentHash = hashResult.value;
        const ttl = storedTtl(item) ?? null;
        // The page may be older than a live write that already reached the index; the index's
        // source-version guard (updatedAt) then keeps the newer row, whatever the content hash says.
        const sourceUpdatedAt = Date.parse(item.updatedAt);
        if(!options.force && vectorIndex.getHash(keys.PK, keys.SK) === contentHash) {
            stats.skipped++;
            ttlUpdates.push({ pk: keys.PK, sk: keys.SK, ttl, sourceUpdatedAt });
            continue;
        }
        if(options.dryRun) {
            const reason = options.force ? '[force]' : '[changed]';
            process.stdout.write(`[dry-run] Would index ${reason}: ${item.path}\n`);
            stats.indexed++;
            continue;
        }
        pending.push({ item, keys, text: `${item.path}\n${item.content}`, contentHash, ttl, sourceUpdatedAt });
    }

    if(!options.dryRun) {
        stampTtls(ttlUpdates, vectorIndex, stats);
    }
    await writePendingEmbeddings(pending, embedder, vectorIndex, stats);
    return stats;
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface BackfillStorage {
    backend: Pick<MemoryToolBackend, 'listByIndexNamespace'>
    destroy: () => void
}

export interface BackfillDependencies {
    openStorage:     () => BackfillStorage
    openVectorIndex: (dbPath: string) => Promise<Pick<VectorIndex, 'getHash' | 'upsert' | 'setTtls' | 'close'>>
    loadModel:       (model: { slug: ModelSlug, quant: ModelQuant }) => Promise<BackfillModel>
    now:             () => number
    sleep:           (ms: number) => Promise<void>
    write:           (message: string) => void
    info:            (details: Record<string, unknown>) => void
}

export async function main(argv: string[] = process.argv, deps: BackfillDependencies = createDefaultBackfillDependencies()): Promise<void> {
    const opts = parseArgs(argv);

    if(opts.showHelp) {
        deps.write(HELP_TEXT);
        return;
    }

    // GSI1 is provisioned at 2 RCU. Each query's Limit bounds how much one page can read before
    // pacing applies; the page's DynamoDB-reported ConsumedCapacity (which counts every row read,
    // including large rows and rows later dropped as malformed) then earns msPerRcu per read unit
    // of pause before the next query, so the average read rate stays at or below the budget.
    const pageSize = 4;
    const msPerRcu = 1000 / opts.rateLimitRcuPerSec;

    deps.info({
        dbPath:             opts.dbPath,
        modelSlug:          opts.modelSlug,
        modelQuant:         opts.modelQuant,
        dryRun:             opts.dryRun,
        force:              opts.force,
        layer:              opts.layer ?? 'all',
        rateLimitRcuPerSec: opts.rateLimitRcuPerSec,
        msPerRcu,
        pageSize,
        msg:                'Vector backfill starting',
    });
    deps.write(`Opening vector index: ${opts.dbPath}\n`);
    deps.write(`Rate limit: ${opts.rateLimitRcuPerSec} RCU/sec → ${msPerRcu}ms per consumed RCU (GSI1 pages of up to ${pageSize} items, paced by DynamoDB's reported ConsumedCapacity)\n`);

    // Initialize DynamoDB + memory backend
    const { backend, destroy } = deps.openStorage();

    let vectorIndex: Pick<VectorIndex, 'getHash' | 'upsert' | 'setTtls' | 'close'> | undefined;
    let embedder: BackfillModel | undefined;

    let totalScanned = 0;
    let totalSkipped = 0;
    let totalIndexed = 0;
    let totalErrors = 0;
    let totalTtlUpdated = 0;
    let totalExpired = 0;
    let totalSuperseded = 0;

    try {
        vectorIndex = await deps.openVectorIndex(opts.dbPath);
        embedder = await deps.loadModel({ slug: opts.modelSlug, quant: opts.modelQuant });
        // A bare run walks every indexed namespace; `list('/')` would only read the root directory's direct children.
        const namespaces: readonly SearchableNamespace[] = opts.layer ? [opts.layer] : SEARCHABLE_NAMESPACES;
        for(const [namespaceIndex, namespace] of namespaces.entries()) {
            let cursor: string | undefined;
            do {
                const pageStartMs = deps.now();

                // eslint-disable-next-line no-await-in-loop -- each GSI1 page depends on the previous cursor
                const page = await backend.listByIndexNamespace(namespace, { limit: pageSize, cursor });
                // Without the page's reported read units its true cost (large rows, rows dropped as
                // malformed) is unknown, so the backfill fails closed rather than read unpaced.
                const consumedReadUnits = requireConsumedReadUnits(page.consumedReadUnits, `GSI1 query for ${namespace}`);

                cursor = page.nextCursor;

                // Expiry is judged at the time the page was read.
                // eslint-disable-next-line no-await-in-loop -- finish bounded embedding work before fetching the next GSI page
                const pageStats = await processPage(page.items, opts, vectorIndex, embedder, sha256Hex, () => pageStartMs);
                totalScanned += pageStats.scanned;
                totalSkipped += pageStats.skipped;
                totalIndexed += pageStats.indexed;
                totalErrors += pageStats.errors;
                totalTtlUpdated += pageStats.ttlUpdated;
                totalExpired += pageStats.expired;
                totalSuperseded += pageStats.superseded;

                // Pace by the read units this page consumed, including across namespace transitions,
                // so no two queries run back-to-back; nothing follows the very last page.
                if(cursor || namespaceIndex < namespaces.length - 1) {
                    // eslint-disable-next-line no-await-in-loop -- intentional sleep before the next GSI page
                    await paceAfterRead({
                        consumedReadUnits,
                        rateLimitRcuPerSec: opts.rateLimitRcuPerSec,
                        startedAtMs:        pageStartMs,
                        now:                deps.now,
                        sleep:              deps.sleep,
                    });
                }
            } while(cursor);
        }
    } finally {
        try {
            await embedder?.close();
        } finally {
            try {
                vectorIndex?.close();
            } finally {
                destroy();
            }
        }
    }

    deps.write(`
Backfill complete:
  Scanned: ${totalScanned}
  Skipped (unchanged or malformed): ${totalSkipped}
  Skipped (expired): ${totalExpired}
  Skipped (index already newer): ${totalSuperseded}
  Indexed: ${totalIndexed}
  TTL updated: ${totalTtlUpdated}
  Errors: ${totalErrors}
`);

    if(totalErrors > 0) {
        throw new Error(`Backfill completed with ${totalErrors} error(s)`);
    }
}

export async function runBackfillCli(isMain: boolean, run: () => Promise<void>): Promise<void> {
    if(isMain) {
        await run();
    }
}

// Stryker disable next-line AwaitDrop: only observable when run as the real CLI against production DynamoDB, which tests cannot safely exercise
await runBackfillCli(import.meta.main, main);
