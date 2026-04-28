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
import { Resource } from 'sst';
import { loadDynamoDBConfig } from '@/config';
import {
    createDynamoDBClient,
    createLayerName,
    DynamoDBClientHolder,
    loadEmbedder,
    MemoryToolBackend,
    MemoryToolKeyGenerator,
    VectorIndex,
    type ModelQuant,
    type ModelSlug
} from '@/storage';
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
    layer?:             'identity' | 'state' | 'events'
    dbPath:             string
    modelSlug:          ModelSlug
    modelQuant:         ModelQuant
    dryRun:             boolean
    force:              boolean
    showHelp:           boolean
    rateLimitRcuPerSec: number
}

function isLayerValue(val: string): val is 'identity' | 'state' | 'events' {
    return val === 'identity' || val === 'state' || val === 'events';
}

function isModelSlug(val: string): val is ModelSlug {
    return val === '0.6b' || val === '4b';
}

function isModelQuant(val: string): val is ModelQuant {
    return val === 'Q8_0' || val === 'Q4_K_M';
}

// eslint-disable-next-line sonarjs/cognitive-complexity, complexity -- CLI arg parser is inherently complex; each branch handles one flag's required value
function parseArgs(argv: string[]): BackfillOptions {
    let layer: 'identity' | 'state' | 'events' | undefined;
    let dbPath = DEFAULT_DB_PATH;
    let modelSlug: ModelSlug = '0.6b';
    let modelQuant: ModelQuant = 'Q8_0';
    let dryRun = false;
    let force = false;
    let showHelp = false;
    let rateLimitRcuPerSec = 10;

    const args = argv.slice(2); // strip 'bun' + script path
    for(let i = 0; i < args.length; i++) {
        const arg = args[i];
        // eslint-disable-next-line unicorn/prefer-switch -- complexity is in the value-consuming branches, not the discriminant alone; switch doesn't help here
        if(arg === '--help' || arg === '-h') {
            showHelp = true;
        } else if(arg === '--dry-run') {
            dryRun = true;
        } else if(arg === '--force') {
            force = true;
        } else if(arg === '--layer') {
            const val = args[++i];
            if(!val || !isLayerValue(val)) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- val may be undefined when --layer is the last arg; we check both to provide a clear error message
                throw new Error(`Invalid --layer value: ${val ?? '(missing)'}. Must be identity, state, or events.`);
            }
            layer = val;
        } else if(arg === '--db-path') {
            const val = args[++i];
            if(!val) {
                throw new Error('--db-path requires a value');
            }
            dbPath = path.resolve(val);
        } else if(arg === '--model-slug') {
            const val = args[++i];
            if(!val || !isModelSlug(val)) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- val may be undefined when --model-slug is the last arg; we check both to provide a clear error message
                throw new Error(`Invalid --model-slug value: ${val ?? '(missing)'}. Must be 0.6b or 4b.`);
            }
            modelSlug = val;
        } else if(arg === '--model-quant') {
            const val = args[++i];
            if(!val || !isModelQuant(val)) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- val may be undefined when --model-quant is the last arg; we check both to provide a clear error message
                throw new Error(`Invalid --model-quant value: ${val ?? '(missing)'}. Must be Q8_0 or Q4_K_M.`);
            }
            modelQuant = val;
        } else if(arg === '--rate-limit-rcu-per-sec') {
            const val = args[++i];
            const parsed = Number(val);
            if(!val || !Number.isFinite(parsed) || parsed <= 0) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- val may be undefined when --rate-limit-rcu-per-sec is the last arg; we check both to provide a clear error message
                throw new Error(`Invalid --rate-limit-rcu-per-sec value: ${val ?? '(missing)'}. Must be a positive number.`);
            }
            rateLimitRcuPerSec = parsed;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- arg is 'string | undefined' under noUncheckedIndexedAccess (tsconfig.src.json); ESLint uses tsconfig.json without that flag so it sees arg as always 'string'; optional chain is required for runtime correctness
        } else if(arg?.startsWith('--')) {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    return { layer, dbPath, modelSlug, modelQuant, dryRun, force, showHelp, rateLimitRcuPerSec };
}

// ── Main ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line sonarjs/cognitive-complexity, complexity -- sequential batch processing loop with rate limiting and force/dry-run branches is inherently complex for a CLI tool
async function main(): Promise<void> {
    const opts = parseArgs(process.argv);

    if(opts.showHelp) {
        process.stdout.write(HELP_TEXT);
        return;
    }

    // Rate limiter state: track when the last page started to throttle Scan requests
    const pageSize = 100;
    const minPageIntervalMs = (pageSize / opts.rateLimitRcuPerSec) * 1000;

    logger.info({
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
    process.stdout.write(`Opening vector index: ${opts.dbPath}\n`);
    process.stdout.write(`Rate limit: ${opts.rateLimitRcuPerSec} RCU/sec → ${minPageIntervalMs}ms between pages of ${pageSize} items\n`);

    // Initialize DynamoDB + memory backend
    const dynamoDBConfig = loadDynamoDBConfig(Resource);
    const { client, docClient, tableName } = createDynamoDBClient(dynamoDBConfig);
    const holder = new DynamoDBClientHolder(client, docClient);
    const backend = new MemoryToolBackend(holder, tableName);

    // Initialize vector index + embedder
    const vectorIndex = await VectorIndex.open(opts.dbPath);
    const embedder = await loadEmbedder({ slug: opts.modelSlug, quant: opts.modelQuant });

    let totalScanned = 0;
    let totalSkipped = 0;
    let totalIndexed = 0;
    let totalErrors = 0;

    try {
        const scanPath = opts.layer ? `/${opts.layer}` : '/';

        let cursor: string | undefined;
        do {
            const pageStartMs = Date.now();

            // eslint-disable-next-line no-await-in-loop -- sequential pagination is intentional: each page must complete before fetching the next
            const page = await (opts.layer
                ? backend.listByLayer(createLayerName(opts.layer), { limit: pageSize, cursor })
                : backend.list(scanPath, { limit: pageSize, cursor }));

            cursor = page.nextCursor;

            for(const item of page.items) {
                totalScanned++;

                const keys = MemoryToolKeyGenerator.createKeys(item.path);
                const text = `${item.path}\n${item.content}`;

                let contentHash: string;
                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential hash-check per item is intentional
                    contentHash = await sha256Hex(text);
                } catch (err) {
                    logger.warn({ err, path: item.path, msg: 'Failed to compute hash, skipping' });
                    totalErrors++;
                    continue;
                }

                // Skip if content unchanged — unless --force is set
                const existingHash = opts.force ? undefined : vectorIndex.getHash(keys.PK, keys.SK);
                if(existingHash === contentHash) {
                    totalSkipped++;
                    continue;
                }

                if(opts.dryRun) {
                    const reason = opts.force ? '[force]' : '[changed]';
                    process.stdout.write(`[dry-run] Would index ${reason}: ${item.path}\n`);
                    totalIndexed++;
                    continue;
                }

                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential embedding is intentional to avoid OOM from parallel model inference
                    const result = await embedder.encode([text]);
                    const vector = result.data.slice(0, 128);
                    const layerVal = item.path.split('/')[1] ?? 'unknown';

                    vectorIndex.upsert({
                        pk:        keys.PK,
                        sk:        keys.SK,
                        layer:     layerVal,
                        contentHash,
                        vector,
                        updatedAt: Date.now(),
                    });
                    totalIndexed++;

                    if(totalIndexed % 10 === 0) {
                        process.stdout.write(`  Indexed ${totalIndexed} items so far...\n`);
                    }
                } catch (err) {
                    logger.warn({ err, path: item.path, msg: 'Failed to embed/upsert item' });
                    totalErrors++;
                }
            }

            // Rate limiting: sleep between pages to honor the RPS budget.
            // Budget: each page of pageSize items represents pageSize DynamoDB reads.
            // At --rate-limit-rcu-per-sec reads/sec, one page should take at least minPageIntervalMs.
            if(cursor) {
                const elapsed = Date.now() - pageStartMs;
                const sleepMs = Math.max(0, minPageIntervalMs - elapsed);
                if(sleepMs > 0) {
                    // eslint-disable-next-line no-await-in-loop -- intentional sleep for rate limiting between pages
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, sleepMs);
                    });
                }
            }
        } while(cursor);
    } finally {
        await embedder.close();
        vectorIndex.close();
    }

    process.stdout.write(`
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

await main();
