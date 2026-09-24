/**
 * Backfill CLI for the vector index.
 *
 * Walks the GSI1 partitions of the indexed namespaces (identity, state, events
 * and users — nested paths included) and indexes every memory into SQLite.
 * Items whose content hash already matches are skipped unless --force.
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
import {
    MemoryToolKeyGenerator,
    classifyMemoryPath,
    isMemoryPath,
    SEARCHABLE_NAMESPACE_VALUES,
    SEARCHABLE_NAMESPACES,
    PACKED_EMBEDDING_BYTES,
    type SearchableNamespace,
    type MemoryToolBackend,
    type ModelQuant,
    type ModelSlug,
    type VectorIndex
} from '@/storage';
import type { MemoryPath } from '@/storage/memory-tool';
import { sha256Hex } from '@/storage/memory-vec-store';

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
    scanned: number
    skipped: number
    indexed: number
    errors:  number
}

interface BackfillItem {
    path:    MemoryPath
    content: string
}

interface PendingEmbedding {
    item:        BackfillItem
    keys:        { PK: string, SK: string }
    text:        string
    contentHash: string
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
            const parsed = Number(value);
            if(!value || !Number.isFinite(parsed) || parsed <= 0) {
                throw new Error(`Invalid --rate-limit-rcu-per-sec value: ${value ?? '(missing)'}. Must be a positive number.`);
            }
            options.rateLimitRcuPerSec = parsed;
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
            const vector = data.subarray(index * PACKED_EMBEDDING_BYTES, (index + 1) * PACKED_EMBEDDING_BYTES);
            vectorIndex.upsert({
                pk:          entry.keys.PK,
                sk:          entry.keys.SK,
                layer:       classifyMemoryPath(entry.item.path).namespace,
                contentHash: entry.contentHash,
                vector,
                updatedAt:   Date.now(),
            });
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

export async function processPage(
    items:       BackfillItem[],
    options:     BackfillOptions,
    vectorIndex: Pick<VectorIndex, 'getHash' | 'upsert'>,
    embedder:    BatchEmbedder,
    hashText:    (text: string) => Promise<string> = sha256Hex
): Promise<BackfillPageStats> {
    const stats: BackfillPageStats = { scanned: items.length, skipped: 0, indexed: 0, errors: 0 };
    const validItems = items.filter((item) => {
        if(isMemoryPath(item.path)) {
            return true;
        }
        logger.warn({ path: item.path, msg: 'Skipping malformed memory path' });
        stats.skipped++;
        return false;
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
        if(!options.force && vectorIndex.getHash(keys.PK, keys.SK) === contentHash) {
            stats.skipped++;
            continue;
        }
        if(options.dryRun) {
            const reason = options.force ? '[force]' : '[changed]';
            process.stdout.write(`[dry-run] Would index ${reason}: ${item.path}\n`);
            stats.indexed++;
            continue;
        }
        pending.push({ item, keys, text: `${item.path}\n${item.content}`, contentHash });
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
    openVectorIndex: (dbPath: string) => Promise<Pick<VectorIndex, 'getHash' | 'upsert' | 'close'>>
    loadModel:       (model: { slug: ModelSlug, quant: ModelQuant }) => Promise<BackfillModel>
    now:             () => number
    sleep:           (ms: number) => Promise<void>
    write:           (message: string) => void
    info:            (details: Record<string, unknown>) => void
}

/**
 * A GSI1 page's DynamoDB-reported read units. Without that figure the page's true cost (large
 * rows, rows dropped as malformed) is unknown, so the backfill fails closed rather than read unpaced.
 */
function requireConsumedReadUnits(consumedReadUnits: number | undefined, namespace: SearchableNamespace): number {
    if(consumedReadUnits === undefined) {
        throw new Error(`GSI1 query for ${namespace} reported no ConsumedCapacity; refusing to continue without RCU pacing`);
    }
    return consumedReadUnits;
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

    let vectorIndex: Pick<VectorIndex, 'getHash' | 'upsert' | 'close'> | undefined;
    let embedder: BackfillModel | undefined;

    let totalScanned = 0;
    let totalSkipped = 0;
    let totalIndexed = 0;
    let totalErrors = 0;

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
                const consumedReadUnits = requireConsumedReadUnits(page.consumedReadUnits, namespace);

                cursor = page.nextCursor;

                // eslint-disable-next-line no-await-in-loop -- finish bounded embedding work before fetching the next GSI page
                const pageStats = await processPage(page.items, opts, vectorIndex, embedder);
                totalScanned += pageStats.scanned;
                totalSkipped += pageStats.skipped;
                totalIndexed += pageStats.indexed;
                totalErrors += pageStats.errors;

                // Pace by the read units this page consumed, including across namespace transitions,
                // so no two queries run back-to-back; nothing follows the very last page.
                if(cursor || namespaceIndex < namespaces.length - 1) {
                    const elapsed = deps.now() - pageStartMs;
                    const pageBudgetMs = consumedReadUnits * msPerRcu;
                    // Stryker disable next-line NumberLiteralValue: any non-positive floor is skipped by the sleepMs > 0 guard below, so 0 and -1 are indistinguishable
                    const sleepMs = Math.max(0, pageBudgetMs - elapsed);
                    if(sleepMs > 0) {
                        // eslint-disable-next-line no-await-in-loop -- intentional sleep before the next GSI page
                        await deps.sleep(sleepMs);
                    }
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
  Indexed: ${totalIndexed}
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
