/**
 * Backfill CLI for the vector index.
 *
 * Scans all memory items from DynamoDB and indexes them into the SQLite
 * vector store. Items whose content hash already matches are skipped.
 *
 * Usage:
 *   bun tools/backfill-vectors.ts [options]
 *
 * Options:
 *   --layer <identity|state|events>  Only backfill a specific layer
 *   --db-path <path>                 SQLite database path (default: <repo-root>/scratch/memory-vec.sqlite)
 *   --model-slug <0.6b|4b>           Embedder model size (default: 0.6b)
 *   --model-quant <Q8_0|Q4_K_M>      Embedder quantization (default: Q8_0)
 *   --dry-run                        Show what would be indexed without writing
 *   --force                          Re-embed every item even if content hash matches
 *   --rate-limit-rcu-per-sec <N>     RCU budget per second — controls sleep between pages (default: 10)
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
    type LayerName,
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
  --layer <identity|state|events>  Only backfill a specific layer
  --db-path <path>                 SQLite database path (default: ${DEFAULT_DB_PATH})
  --model-slug <0.6b|4b>           Embedder model size (default: 0.6b)
  --model-quant <Q8_0|Q4_K_M>      Embedder quantization (default: Q8_0)
  --dry-run                        Show what would be indexed without writing
  --force                          Re-embed every item even if content hash matches
  --rate-limit-rcu-per-sec <N>     RCU budget per second — controls sleep between pages (default: 10)
  --help                           Show this help message

Requires SST shell for DynamoDB credentials:
  sst shell -- bun tools/backfill-vectors.ts
`;

interface BackfillOptions {
    layer?:             string
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
        rateLimitRcuPerSec: 10,
    };

    const handlers: Partial<Record<string, (value: string | undefined) => void>> = {
        '--layer': (value) => {
            if(!value) {
                throw new Error(`--layer requires a value (typically identity, state, events; or 'users' for /users/* memories).`);
            }
            options.layer = value;
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
        if(data.length !== batch.length * 128) {
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
            const vector = data.subarray(index * 128, (index + 1) * 128);
            vectorIndex.upsert({
                pk:          entry.keys.PK,
                sk:          entry.keys.SK,
                layer:       entry.item.path.split('/')[1] ?? 'unknown',
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
    const texts = items.map(item => `${item.path}\n${item.content}`);
    const hashes = await Promise.allSettled(texts.map(text => hashText(text)));
    const pending: PendingEmbedding[] = [];

    for(const [index, item] of items.entries()) {
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
    backend: Pick<MemoryToolBackend, 'list' | 'listByLayer'>
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

export async function main(argv: string[] = process.argv, deps: BackfillDependencies = createDefaultBackfillDependencies()): Promise<void> {
    const opts = parseArgs(argv);

    if(opts.showHelp) {
        deps.write(HELP_TEXT);
        return;
    }

    // Rate limiter state: track when the last page started to throttle Scan requests
    const pageSize = 100;
    const minPageIntervalMs = (pageSize / opts.rateLimitRcuPerSec) * 1000;

    deps.info({
        dbPath:             opts.dbPath,
        modelSlug:          opts.modelSlug,
        modelQuant:         opts.modelQuant,
        dryRun:             opts.dryRun,
        force:              opts.force,
        layer:              opts.layer ?? 'all',
        rateLimitRcuPerSec: opts.rateLimitRcuPerSec,
        sleepIntervalMs:    minPageIntervalMs,
        msg:                'Vector backfill starting',
    });
    deps.write(`Opening vector index: ${opts.dbPath}\n`);
    deps.write(`Rate limit: ${opts.rateLimitRcuPerSec} RCU/sec → ${minPageIntervalMs}ms between pages of ${pageSize} items\n`);

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
        let cursor: string | undefined;
        do {
            const pageStartMs = deps.now();

            // eslint-disable-next-line no-await-in-loop -- sequential pagination is intentional: each page must complete before fetching the next
            const page = await (opts.layer
                ? backend.listByLayer(opts.layer as LayerName, { limit: pageSize, cursor })
                : backend.list('/', { limit: pageSize, cursor }));

            cursor = page.nextCursor;

            // eslint-disable-next-line no-await-in-loop -- finish bounded embedding work before the next page and preserve page pacing
            const pageStats = await processPage(page.items, opts, vectorIndex, embedder);
            totalScanned += pageStats.scanned;
            totalSkipped += pageStats.skipped;
            totalIndexed += pageStats.indexed;
            totalErrors += pageStats.errors;

            // Rate limiting: sleep between pages to honor the RPS budget.
            // Budget: each page of pageSize items represents pageSize DynamoDB reads.
            // At --rate-limit-rcu-per-sec reads/sec, one page should take at least minPageIntervalMs.
            if(cursor) {
                const elapsed = deps.now() - pageStartMs;
                const sleepMs = Math.max(0, minPageIntervalMs - elapsed);
                if(sleepMs > 0) {
                    // eslint-disable-next-line no-await-in-loop -- intentional sleep for rate limiting between pages
                    await deps.sleep(sleepMs);
                }
            }
        } while(cursor);
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
  Skipped (up-to-date): ${totalSkipped}
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

await runBackfillCli(import.meta.main, main);
