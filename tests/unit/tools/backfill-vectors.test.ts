import { describe, expect, test, mock, spyOn, afterEach, jest } from 'bun:test';
import path from 'node:path';
import { logger } from '@hughescr/logger';
import { main, parseArgs, processPage, runBackfillCli, type BackfillDependencies } from '../../../tools/backfill-vectors';
import { createNativeBackfillDependencies, productionBackfillServices, type BackfillNativeServices } from '../../../tools/backfill-vectors-native-runtime';
import { clientDestroyer, createBackfillDependencies, sleepForRateLimit } from '../../../tools/backfill-vectors-runtime-builder';
import { mockBackfillRuntime } from '../../setup';
import { createMemoryPath } from '@/storage/memory-tool';
import { sha256Hex, type VectorIndexEntry } from '@/storage/memory-vec-store';

const safeClient = { destroy: mock(() => undefined) };
const safeList = mock(async () => ({ items: [], nextCursor: undefined, consumedReadUnits: 0.5 }));
const safeIndexClose = mock(() => undefined);
const safeModelClose = mock(async () => undefined);
const safeCreateClient = mock(() => ({ client: safeClient, docClient: {}, tableName: 'test-memory' }));
const safeOpenIndex = mock(async () => ({ getHash: () => undefined, upsert: () => undefined, close: safeIndexClose }));
const safeLoadModel = mock(async () => ({ encode: async (texts: readonly string[]) => ({ data: new Uint8Array(texts.length * 128) }), close: safeModelClose }));
const safeWrite = mock((_message: string) => undefined);
const opensAtImport = mockBackfillRuntime.opens;

const DEFAULT_OPTIONS = parseArgs(['bun', 'backfill-vectors.ts']);

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

function makeItem(index: number) {
    return { path: createMemoryPath(`/identity/item-${index}`), content: `content ${index}` };
}

function makeIndex(existingHash?: string) {
    const entries: VectorIndexEntry[] = [];
    return {
        entries,
        getHash: mock((_pk: string, _sk: string) => existingHash),
        upsert:  mock((entry: VectorIndexEntry) => {
            entries.push(entry);
        }),
    };
}

interface FakePage {
    items:              ReturnType<typeof makeItem>[]
    nextCursor?:        string
    /** DynamoDB's reported ConsumedCapacity; a page that does not set it reports 1 RCU. */
    consumedReadUnits?: number
    /** Simulate DynamoDB omitting ConsumedCapacity from the response. */
    omitCapacity?:      true
}

function makeRuntime(pages: FakePage[] = [{ items: [] }]) {
    const queue = pages.map(({ consumedReadUnits = 1, omitCapacity, ...page }) => ({
        ...page,
        consumedReadUnits: omitCapacity ? undefined : consumedReadUnits,
    }));
    const nextPage = mock(async () => queue.shift() ?? { items: [], nextCursor: undefined, consumedReadUnits: 1 });
    const listByIndexNamespace = mock(async () => nextPage());
    const destroy = mock(() => undefined);
    const index = { ...makeIndex(), close: mock(() => undefined) };
    const embedder = {
        encode: mock(async (texts: readonly string[]) => ({ data: new Uint8Array(texts.length * 128) })),
        close:  mock(async (): Promise<void> => undefined),
    };
    const now = mock(() => 0);
    const sleep = mock(async (_ms: number) => undefined);
    const write = mock((_text: string) => undefined);
    const info = mock((_details: Record<string, unknown>) => undefined);
    const openStorage = mock(() => ({
        backend: { listByIndexNamespace } as unknown as ReturnType<BackfillDependencies['openStorage']>['backend'],
        destroy,
    }));
    const openVectorIndex = mock(async () => index);
    const loadModel = mock(async () => embedder);
    const deps = { openStorage, openVectorIndex, loadModel, now, sleep, write, info } satisfies BackfillDependencies;
    return { deps, listByIndexNamespace, destroy, index, embedder, now, sleep, write, info, openStorage, openVectorIndex, loadModel };
}

describe('vector backfill options', () => {
    test('importing the CLI does not open default storage', () => {
        expect(opensAtImport).toBe(0);
    });

    test('parses named values and equals syntax while retaining defaults', () => {
        const options = parseArgs(['bun', 'script', '--layer=identity', '--model-slug', '4b', '--model-quant=Q4_K_M', '--dry-run', '--force']);
        expect(options).toMatchObject({
            layer:      'identity',
            modelSlug:  '4b',
            modelQuant: 'Q4_K_M',
            dryRun:     true,
            force:      true,
            showHelp:   false,
        });
        // GSI1 is provisioned at 2 RCU, so the default must not exceed it.
        expect(DEFAULT_OPTIONS.rateLimitRcuPerSec).toBe(2);
        expect(DEFAULT_OPTIONS.layer).toBeUndefined();
    });

    test.each(['identity', 'state', 'events', 'users'])('accepts --layer %s', (layer) => {
        expect(parseArgs(['bun', 'script', '--layer', layer]).layer as string | undefined).toBe(layer);
    });

    test.each(['identiy', 'user', 'unknown', 'foo', 'identity/core'])('rejects --layer typo or non-indexed namespace %s', (layer) => {
        expect(() => parseArgs(['bun', 'script', `--layer=${layer}`])).toThrow(`Invalid --layer value: ${layer}. Must be one of identity, state, events, users.`);
    });

    test.each([
        ['--layer', '--layer requires a value'],
        ['--db-path', '--db-path requires a value'],
        ['--model-slug', 'Invalid --model-slug value: (missing)'],
        ['--model-quant', 'Invalid --model-quant value: (missing)'],
        ['--rate-limit-rcu-per-sec', 'Invalid --rate-limit-rcu-per-sec value: (missing)'],
    ])('reports missing %s value', (flag, message) => {
        expect(() => parseArgs(['bun', 'script', flag])).toThrow(message);
    });

    test('rejects unknown options and nonpositive rate limits', () => {
        expect(() => parseArgs(['bun', 'script', '--unexpected'])).toThrow('Unknown option: --unexpected');
        expect(() => parseArgs(['bun', 'script', '--rate-limit-rcu-per-sec', '0'])).toThrow('positive number');
    });

    test('uses the repository scratch database and shows its path in help without opening storage', async () => {
        const expectedPath = path.resolve(import.meta.dir, '../../../scratch/memory-vec.sqlite');
        expect(DEFAULT_OPTIONS.dbPath).toBe(expectedPath);
        const runtime = makeRuntime();
        await main(['bun', 'script', '--help'], runtime.deps);
        expect(runtime.write).toHaveBeenCalledTimes(1);
        expect(runtime.write.mock.calls[0]?.[0]).toContain(`default: ${expectedPath}`);
        expect(runtime.write.mock.calls[0]?.[0]).toContain('Usage: bun tools/backfill-vectors.ts [options]');
        expect(runtime.write.mock.calls[0]?.[0]).toContain('Without --layer, walks identity, state, events and users');
        expect(runtime.write.mock.calls[0]?.[0]).toContain('Run once with --force --layer users after deploying #58');
        expect(runtime.openStorage).not.toHaveBeenCalled();
    });

    test('CLI entry calls its runner only when the module is main', async () => {
        const run = mock(async () => undefined);
        await runBackfillCli(false, run);
        expect(run).not.toHaveBeenCalled();
        await runBackfillCli(true, run);
        expect(run).toHaveBeenCalledTimes(1);
    });

    test('CLI entry waits for its main runner to complete', async () => {
        const releaseRun = Promise.withResolvers<void>();
        const run = mock(() => releaseRun.promise);
        const pending = runBackfillCli(true, run);
        let completed = false;
        void pending.then(() => {
            completed = true;
            return undefined;
        });

        try {
            expect(run).toHaveBeenCalledTimes(1);
            await Promise.resolve();
            expect(completed).toBe(false);
        } finally {
            releaseRun.resolve();
            await pending;
        }
    });

    test('accepts each documented model variant, custom layers, and a positive fractional rate', () => {
        const options = parseArgs(['bun', 'script', '--layer', 'users', '--db-path=./custom.sqlite', '--model-slug', '0.6b', '--model-quant', 'Q8_0', '--rate-limit-rcu-per-sec=2.5']);
        expect(options).toMatchObject({
            layer: 'users', dbPath: path.resolve('./custom.sqlite'), modelSlug: '0.6b', modelQuant: 'Q8_0', rateLimitRcuPerSec: 2.5,
        });
        expect(parseArgs(['bun', 'script', '--model-slug=4b', '--model-quant=Q4_K_M'])).toMatchObject({ modelSlug: '4b', modelQuant: 'Q4_K_M' });
        expect(parseArgs(['bun', 'script', '--rate-limit-rcu-per-sec=1'])).toMatchObject({ rateLimitRcuPerSec: 1 });
    });

    test.each([
        ['--layer=', '--layer requires a value'],
        ['--model-slug=other', 'Invalid --model-slug value: other'],
        ['--model-quant=other', 'Invalid --model-quant value: other'],
        ['--rate-limit-rcu-per-sec=NaN', 'positive number'],
        ['--rate-limit-rcu-per-sec=Infinity', 'positive number'],
        ['--rate-limit-rcu-per-sec=-1', 'positive number'],
    ])('rejects invalid value in %s', (argument, message) => {
        expect(() => parseArgs(['bun', 'script', argument])).toThrow(message);
    });

    test('ignores the executable and script positions even if their names resemble flags', () => {
        expect(parseArgs(['--force', '--dry-run', '--help'])).toMatchObject({ showHelp: true, force: false, dryRun: false });
    });

    test('keeps help, dry-run, and force independent and rejects unknown equals options', () => {
        expect(parseArgs(['bun', 'script', '-h'])).toMatchObject({ showHelp: true, dryRun: false, force: false });
        expect(parseArgs(['bun', 'script', '--dry-run'])).toMatchObject({ showHelp: false, dryRun: true, force: false });
        expect(parseArgs(['bun', 'script', '--force'])).toMatchObject({ showHelp: false, dryRun: false, force: true });
        expect(() => parseArgs(['bun', 'script', '--unrecognized=value'])).toThrow('Unknown option: --unrecognized');
        expect(parseArgs(['bun', 'script', 'notes.txt'])).toMatchObject({ showHelp: false, dryRun: false, force: false });
        expect(parseArgs(['bun', 'script', 'metadata=--force'])).toMatchObject({ showHelp: false, dryRun: false, force: false });
    });
});

describe('vector backfill page', () => {
    test('hashes a page, encodes bounded batches, and scatters distinct vectors in order', async () => {
        const index = makeIndex();
        const calls: string[][] = [];
        const embedder = {
            encode: mock(async (texts: readonly string[]) => {
                calls.push([...texts]);
                return { data: Uint8Array.from({ length: texts.length * 128 }, (_, byte) => Math.floor(byte / 128) + 1) };
            }),
        };
        const stats = await processPage(Array.from({ length: 10 }, (_, i) => makeItem(i)), DEFAULT_OPTIONS, index, embedder);
        expect(stats).toEqual({ scanned: 10, skipped: 0, indexed: 10, errors: 0 });
        expect(calls.map(call => call.length)).toEqual([8, 2]);
        expect(index.entries.map(entry => entry.vector.length)).toEqual(Array.from({ length: 10 }, () => 128));
        expect(index.entries[0]?.vector[0]).toBe(1);
        expect(index.entries[1]?.vector[0]).toBe(2);
        expect(index.entries[8]?.vector[0]).toBe(1);
    });

    test('skips unchanged content and performs dry run without embedding', async () => {
        const item = makeItem(1);
        const hash = await sha256Hex(`${item.path}\n${item.content}`);
        const index = makeIndex(hash);
        const embedder = { encode: mock(async () => ({ data: new Uint8Array(128) })) };
        expect(await processPage([item], DEFAULT_OPTIONS, index, embedder)).toEqual({ scanned: 1, skipped: 1, indexed: 0, errors: 0 });
        expect(await processPage([item], { ...DEFAULT_OPTIONS, dryRun: true, force: true }, index, embedder)).toEqual({ scanned: 1, skipped: 0, indexed: 1, errors: 0 });
        expect(embedder.encode).not.toHaveBeenCalled();
    });

    test('isolates one failed embedding and retains successful neighbors', async () => {
        const index = makeIndex();
        const embedder = {
            encode: mock(async (texts: readonly string[]) => {
                if(texts.some(text => text.includes('item-1'))) {
                    throw new Error('bad embedding');
                }
                return { data: new Uint8Array(texts.length * 128) };
            }),
        };
        const stats = await processPage([makeItem(0), makeItem(1), makeItem(2)], DEFAULT_OPTIONS, index, embedder);
        expect(stats).toEqual({ scanned: 3, skipped: 0, indexed: 2, errors: 1 });
        expect(index.entries.map(entry => entry.layer as string)).toEqual(['identity', 'identity']);
        expect(index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-2']);
    });

    test('retries an odd failed batch with its larger half first', async () => {
        const calls: string[][] = [];
        const items = [makeItem(0), makeItem(1), makeItem(2)];
        const texts = items.map(item => `${item.path}\n${item.content}`);
        const index = makeIndex();
        const embedder = {
            encode: mock(async (batch: readonly string[]) => {
                calls.push([...batch]);
                if(batch.length === 3) {
                    throw new Error('batch rejected');
                }
                return { data: new Uint8Array(batch.length * 128) };
            }),
        };

        const stats = await processPage(items, DEFAULT_OPTIONS, index, embedder);

        expect(stats).toEqual({ scanned: 3, skipped: 0, indexed: 3, errors: 0 });
        expect(calls).toEqual([texts, texts.slice(0, 2), texts.slice(2)]);
    });

    test('bisects a malformed embedding result, records its exact failure, and keeps healthy items', async () => {
        const warn = spyOn(logger, 'warn');
        const index = makeIndex();
        const embedder = {
            encode: mock(async (texts: readonly string[]) => ({
                data: new Uint8Array(texts.some(text => text.includes('item-1')) ? 1 : texts.length * 128),
            })),
        };
        const stats = await processPage([makeItem(0), makeItem(1), makeItem(2)], DEFAULT_OPTIONS, index, embedder);
        expect(stats).toEqual({ scanned: 3, skipped: 0, indexed: 2, errors: 1 });
        expect(index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-2']);
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({
            path: makeItem(1).path,
            msg:  'Failed to embed item',
            err:  expect.objectContaining({ name: 'Error', message: 'Embedder returned 1 bytes for 1 items' }) as unknown,
        }));
    });

    test('does not complete the page until the second half of a bisected embedding batch finishes', async () => {
        const index = makeIndex();
        const secondHalfStarted = Promise.withResolvers<void>();
        const secondHalf = Promise.withResolvers<{ data: Uint8Array }>();
        const secondHalfWritten = Promise.withResolvers<void>();
        index.upsert.mockImplementation((entry) => {
            index.entries.push(entry);
            if(entry.sk === 'FILE#item-1') {
                secondHalfWritten.resolve();
            }
        });
        const embedder = {
            encode: mock((texts: readonly string[]) => {
                if(texts.length === 2) {
                    return Promise.resolve({ data: new Uint8Array(1) });
                }
                if(texts[0]?.includes('item-0')) {
                    return Promise.resolve({ data: new Uint8Array(128) });
                }
                secondHalfStarted.resolve();
                return secondHalf.promise;
            }),
        };

        const operation = processPage([makeItem(0), makeItem(1)], DEFAULT_OPTIONS, index, embedder);
        let stats: Awaited<typeof operation>;
        let entriesWhilePending!: string[];
        let statusWhilePending!: ReturnType<typeof Bun.peek.status>;
        try {
            await secondHalfStarted.promise;
            await new Promise<void>((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- a full event-loop checkpoint proves the public operation stays pending without relying on a fixed microtask count
                setImmediate(resolve);
            });
            entriesWhilePending = index.entries.map(entry => entry.sk);
            statusWhilePending = Bun.peek.status(operation);
        } finally {
            secondHalf.resolve({ data: new Uint8Array(128) });
            try {
                await secondHalfWritten.promise;
            } finally {
                stats = await operation;
            }
        }

        expect(stats).toEqual({ scanned: 2, skipped: 0, indexed: 2, errors: 0 });
        expect(index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-1']);
        expect(entriesWhilePending).toEqual(['FILE#item-0']);
        expect(statusWhilePending).toBe('pending');
    });

    test('does not complete the page until the next bounded embedding batch finishes', async () => {
        const index = makeIndex();
        const nextBatchStarted = Promise.withResolvers<void>();
        const nextBatch = Promise.withResolvers<{ data: Uint8Array }>();
        const nextBatchWritten = Promise.withResolvers<void>();
        index.upsert.mockImplementation((entry) => {
            index.entries.push(entry);
            if(entry.sk === 'FILE#item-8') {
                nextBatchWritten.resolve();
            }
        });
        const embedder = {
            encode: mock((texts: readonly string[]) => {
                if(texts.length === 8) {
                    return Promise.resolve({ data: new Uint8Array(8 * 128) });
                }
                nextBatchStarted.resolve();
                return nextBatch.promise;
            }),
        };

        const operation = processPage(Array.from({ length: 9 }, (_, itemIndex) => makeItem(itemIndex)), DEFAULT_OPTIONS, index, embedder);
        let stats: Awaited<typeof operation>;
        let entriesWhilePending!: number;
        let statusWhilePending!: ReturnType<typeof Bun.peek.status>;
        try {
            await nextBatchStarted.promise;
            await new Promise<void>((resolve) => {
                // eslint-disable-next-line no-restricted-syntax -- a full event-loop checkpoint proves the public operation stays pending without relying on a fixed microtask count
                setImmediate(resolve);
            });
            entriesWhilePending = index.entries.length;
            statusWhilePending = Bun.peek.status(operation);
        } finally {
            nextBatch.resolve({ data: new Uint8Array(128) });
            try {
                await nextBatchWritten.promise;
            } finally {
                stats = await operation;
            }
        }

        expect(stats).toEqual({ scanned: 9, skipped: 0, indexed: 9, errors: 0 });
        expect(index.entries).toHaveLength(9);
        expect(entriesWhilePending).toBe(8);
        expect(statusWhilePending).toBe('pending');
    });

    test('continues after an upsert failure and reports the failed item without counting it as indexed', async () => {
        const warn = spyOn(logger, 'warn');
        const index = makeIndex();
        index.upsert.mockImplementation((entry) => {
            if(entry.sk === 'FILE#item-1') {
                throw new Error('disk full');
            }
            index.entries.push(entry);
        });
        const embedder = { encode: mock(async (texts: readonly string[]) => ({ data: new Uint8Array(texts.length * 128) })) };
        const stats = await processPage([makeItem(0), makeItem(1), makeItem(2)], DEFAULT_OPTIONS, index, embedder);
        expect(stats).toEqual({ scanned: 3, skipped: 0, indexed: 2, errors: 1 });
        expect(index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-2']);
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({
            path: makeItem(1).path,
            msg:  'Failed to upsert item',
            err:  expect.objectContaining({ message: 'disk full' }) as unknown,
        }));
    });

    test('settles page hashes together, isolates one rejected hash, and reports a non-Error reason', async () => {
        const warn = spyOn(logger, 'warn');
        const index = makeIndex();
        const embedder = { encode: mock(async (texts: readonly string[]) => ({ data: new Uint8Array(texts.length * 128) })) };
        const hashText = mock((text: string): Promise<string> => {
            if(text.includes('item-1')) {
                const failed = Promise.withResolvers<string>();
                failed.reject('hash unavailable');
                return failed.promise;
            }
            return sha256Hex(text);
        });
        const stats = await processPage([makeItem(0), makeItem(1), makeItem(2)], DEFAULT_OPTIONS, index, embedder, hashText);
        expect(stats).toEqual({ scanned: 3, skipped: 0, indexed: 2, errors: 1 });
        expect(hashText).toHaveBeenCalledTimes(3);
        expect(index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-2']);
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({
            path: makeItem(1).path,
            msg:  'Failed to compute hash, skipping',
            err:  { value: 'hash unavailable' },
        }));
    });

    test('dry-run names changed and forced items without embedding or writing vectors', async () => {
        const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
        const index = makeIndex();
        const embedder = { encode: mock(async () => ({ data: new Uint8Array(128) })) };
        const changed = await processPage([makeItem(0)], { ...DEFAULT_OPTIONS, dryRun: true }, index, embedder);
        const forced = await processPage([makeItem(1)], { ...DEFAULT_OPTIONS, dryRun: true, force: true }, index, embedder);
        expect(changed.indexed).toBe(1);
        expect(forced.indexed).toBe(1);
        expect(write.mock.calls.map(call => call[0])).toEqual([
            `[dry-run] Would index [changed]: ${makeItem(0).path}\n`,
            `[dry-run] Would index [force]: ${makeItem(1).path}\n`,
        ]);
        expect(embedder.encode).not.toHaveBeenCalled();
        expect(index.upsert).not.toHaveBeenCalled();
    });

    test('reports progress at the tenth indexed item only', async () => {
        const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
        const index = makeIndex();
        const embedder = { encode: mock(async (texts: readonly string[]) => ({ data: new Uint8Array(texts.length * 128) })) };
        const stats = await processPage(Array.from({ length: 11 }, (_, i) => makeItem(i)), DEFAULT_OPTIONS, index, embedder);
        expect(stats.indexed).toBe(11);
        expect(write.mock.calls.map(call => call[0])).toEqual(['  Indexed 10 items in this page...\n']);
    });

    test('logs and skips malformed legacy paths before hashing or indexing', async () => {
        const warn = spyOn(logger, 'warn');
        const index = makeIndex();
        const embedder = { encode: mock(async () => ({ data: new Uint8Array(128) })) };
        const hash = mock(async () => 'hash');
        const malformed = { path: 'noslash' as ReturnType<typeof createMemoryPath>, content: 'legacy row' };
        const root = { path: '/' as ReturnType<typeof createMemoryPath>, content: 'legacy root' };
        const stats = await processPage([malformed, root, { path: createMemoryPath('/users/alice/name'), content: 'Alice' }], DEFAULT_OPTIONS, index, embedder, hash);
        expect(stats).toEqual({ scanned: 3, skipped: 2, indexed: 1, errors: 0 });
        expect(hash).toHaveBeenCalledTimes(1);
        expect(index.entries.map(entry => entry.layer as string)).toEqual(['users']);
        expect(warn.mock.calls.map(call => call[0]).filter(call => (call as Record<string, unknown>).msg === 'Skipping malformed memory path')).toEqual([
            expect.objectContaining({ path: 'noslash', msg: 'Skipping malformed memory path' }),
            expect.objectContaining({ path: '/', msg: 'Skipping malformed memory path' }),
        ]);
    });
});

describe('vector backfill runner with injected services', () => {
    test('native adapter wires every low-level service through fake owners', async () => {
        const config = { test: 'config' };
        const resource = { test: 'resource' };
        const loadConfig = mock((seenResource: unknown) => {
            expect(seenResource).toBe(resource);
            return config;
        });
        const createClient = mock((seenConfig: unknown) => {
            expect(seenConfig).toBe(config);
            return { client: safeClient, docClient: {}, tableName: 'test-memory' };
        });
        const holderArgs: unknown[][] = [];
        const backendArgs: unknown[][] = [];
        class FakeHolder {
            constructor(...args: unknown[]) {
                holderArgs.push(args);
            }
        }
        class FakeBackend {
            listByIndexNamespace = safeList;
            constructor(...args: unknown[]) { backendArgs.push(args); }
        }
        const open = mock(async () => ({ getHash: () => undefined, upsert: () => undefined, close: safeIndexClose }));
        const loadModel = mock(async () => ({ encode: async () => ({ data: new Uint8Array() }), close: safeModelClose }));
        const now = mock(() => 123);
        const sleep = mock(async (_ms: number) => undefined);
        const write = mock((_message: string) => undefined);
        const info = mock((_details: Record<string, unknown>) => undefined);
        const services = {
            resource, loadConfig, createClient, Holder:  FakeHolder, Backend: FakeBackend,
            Index:   { open }, loadModel, now, sleep, write, info,
        } as unknown as BackfillNativeServices;
        const deps = createNativeBackfillDependencies(services);
        const acquired = deps.openStorage();
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(createClient).toHaveBeenCalledTimes(1);
        expect(holderArgs).toEqual([[safeClient, {}]]);
        expect(backendArgs).toEqual([[expect.any(FakeHolder), 'test-memory']]);
        acquired.destroy();
        expect(safeClient.destroy).toHaveBeenCalled();
        await deps.openVectorIndex('safe.sqlite');
        await deps.loadModel({ slug: '4b', quant: 'Q4_K_M' });
        expect(open).toHaveBeenCalledWith('safe.sqlite');
        expect(loadModel).toHaveBeenCalledWith({ slug: '4b', quant: 'Q4_K_M' });
        expect(deps.now()).toBe(123);
        await deps.sleep(250);
        deps.write('safe output');
        deps.info({ msg: 'safe info' });
        expect(now).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(250);
        expect(write).toHaveBeenCalledWith('safe output');
        expect(info).toHaveBeenCalledWith({ msg: 'safe info' });
    });

    test('production native service bindings expose safe clock and output without opening resources', () => {
        const keys = Object.keys(productionBackfillServices).toSorted((a, b) => a.localeCompare(b));
        expect(keys).toEqual(['Backend', 'createClient', 'Holder', 'Index', 'info', 'loadConfig', 'loadModel', 'now', 'resource', 'sleep', 'write']);
        const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
        const info = spyOn(logger, 'info');
        const deps = createNativeBackfillDependencies();
        expect(typeof deps.now()).toBe('number');
        deps.write('production output');
        deps.info({ msg: 'production info' });
        expect(output).toHaveBeenCalledWith('production output');
        expect(info).toHaveBeenCalledWith({ msg: 'production info' });
    });

    test('the default runtime uses the preloaded in-memory owners', async () => {
        const before = mockBackfillRuntime.writes.length;
        await main(['bun', 'script', '--help']);
        expect(mockBackfillRuntime.writes.slice(before)).toContainEqual(expect.stringContaining('Usage: bun tools/backfill-vectors.ts [options]'));
        await main(['bun', 'script']);
        expect(mockBackfillRuntime.writes.slice(before)).toContainEqual(expect.stringContaining('Backfill complete:'));
    });

    test('runtime factory composes fake owners and releases all of them', async () => {
        safeCreateClient.mockClear();
        safeOpenIndex.mockClear();
        safeLoadModel.mockClear();
        safeClient.destroy.mockClear();
        safeIndexClose.mockClear();
        safeModelClose.mockClear();
        const createHolder = mock(() => ({}));
        const createBackend = mock(() => ({ listByIndexNamespace: safeList }));
        const platform = {
            createClient:    safeCreateClient,
            createHolder,
            createBackend,
            openVectorIndex: safeOpenIndex,
            loadModel:       safeLoadModel,
            now:             () => 0,
            sleep:           async () => undefined,
            write:           safeWrite,
            info:            () => undefined,
        } as unknown as Parameters<typeof createBackfillDependencies>[0];
        const deps = createBackfillDependencies(platform);
        await main(['bun', 'script'], deps);
        expect(safeCreateClient).toHaveBeenCalledTimes(1);
        expect(createHolder).toHaveBeenCalledWith(safeClient, {});
        expect(createBackend).toHaveBeenCalledWith({}, 'test-memory');
        expect(safeOpenIndex).toHaveBeenCalledWith(DEFAULT_OPTIONS.dbPath);
        expect(safeLoadModel).toHaveBeenCalledWith({ slug: '0.6b', quant: 'Q8_0' });
        expect(safeModelClose).toHaveBeenCalledTimes(1);
        expect(safeIndexClose).toHaveBeenCalledTimes(1);
        expect(safeClient.destroy).toHaveBeenCalledTimes(1);
    });

    test('the storage destroy callback invokes its acquired client', () => {
        const client = { destroy: mock(() => undefined) };
        const destroy = clientDestroyer(client);
        destroy();
        expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    test('the default rate-limit sleep waits for its requested delay', async () => {
        jest.useFakeTimers();
        const pending = sleepForRateLimit(250);
        let settled = false;
        void pending.then(() => {
            settled = true;
            return undefined;
        });
        jest.advanceTimersByTime(249);
        await Promise.resolve();
        expect(settled).toBe(false);
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(settled).toBe(true);
    });

    test('scans two layer pages, paces the next read, forwards model settings, and reports totals', async () => {
        const runtime = makeRuntime([
            { items: [makeItem(0)], nextCursor: 'page-two' },
            { items: [makeItem(1)] },
        ]);
        runtime.now.mockReturnValueOnce(1000).mockReturnValueOnce(1750).mockReturnValue(2000);

        await main(['bun', 'script', '--layer=identity', '--db-path=./vectors.sqlite', '--model-slug=4b', '--model-quant=Q4_K_M', '--rate-limit-rcu-per-sec=20'], runtime.deps);

        expect(runtime.openStorage).toHaveBeenCalledTimes(1);
        expect(runtime.openVectorIndex).toHaveBeenCalledWith(path.resolve('./vectors.sqlite'));
        expect(runtime.write.mock.calls.map(call => call[0])).toContain(`Opening vector index: ${path.resolve('./vectors.sqlite')}\n`);
        expect(runtime.loadModel).toHaveBeenCalledWith({ slug: '4b', quant: 'Q4_K_M' });
        expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(2);
        expect(runtime.listByIndexNamespace).toHaveBeenNthCalledWith(1, 'identity', { limit: 4, cursor: undefined });
        expect(runtime.listByIndexNamespace).toHaveBeenNthCalledWith(2, 'identity', { limit: 4, cursor: 'page-two' });
        expect(runtime.sleep).not.toHaveBeenCalled();
        expect(runtime.index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-1']);
        expect(runtime.info).toHaveBeenCalledWith(expect.objectContaining({
            dbPath: path.resolve('./vectors.sqlite'), modelSlug: '4b', modelQuant: 'Q4_K_M', layer: 'identity', rateLimitRcuPerSec: 20, msPerRcu: 50, pageSize: 4, msg: 'Vector backfill starting',
        }));
        expect(runtime.write.mock.calls.map(call => call[0]).join('')).toContain('Scanned: 2\n  Skipped (unchanged or malformed): 0\n  Indexed: 2\n  Errors: 0');
        expect(runtime.embedder.close).toHaveBeenCalledTimes(1);
        expect(runtime.index.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('does not fetch the next page until the rate-limit sleep completes', async () => {
        const runtime = makeRuntime([
            { items: [], nextCursor: 'page-two' },
            { items: [] },
        ]);
        const sleepStarted = Promise.withResolvers<void>();
        const releaseSleep = Promise.withResolvers<undefined>();
        runtime.sleep.mockImplementation((_ms: number) => {
            sleepStarted.resolve();
            return releaseSleep.promise;
        });
        const pending = main(['bun', 'script', '--layer=identity'], runtime.deps);

        try {
            await sleepStarted.promise;
            // The empty page reported 1 consumed RCU, paced at the default 2 RCU/s.
            expect(runtime.sleep).toHaveBeenCalledWith(500);
            expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(1);
        } finally {
            releaseSleep.resolve(undefined);
            await pending;
        }

        expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(2);
        expect(runtime.listByIndexNamespace).toHaveBeenNthCalledWith(2, 'identity', { limit: 4, cursor: 'page-two' });
    });

    test('unfiltered forced rebuild enumerates nested cognitive and users paths', async () => {
        const person = { path: createMemoryPath('/users/alice/name'), content: 'Alice' };
        const runtime = makeRuntime([
            { items: [makeItem(0)] }, { items: [] }, { items: [] }, { items: [person] },
        ]);
        await main(['bun', 'script', '--force'], runtime.deps);
        expect(runtime.listByIndexNamespace.mock.calls as unknown).toEqual([
            ['identity', { limit: 4, cursor: undefined }],
            ['state', { limit: 4, cursor: undefined }],
            ['events', { limit: 4, cursor: undefined }],
            ['users', { limit: 4, cursor: undefined }],
        ]);
        expect(runtime.index.entries.map(entry => entry.layer as string)).toEqual(['identity', 'users']);
        expect(runtime.index.getHash).not.toHaveBeenCalled();
        // Paced between namespaces too, but not after the very last page.
        expect(runtime.sleep.mock.calls).toEqual([[500], [500], [500]]);
        expect(runtime.info).toHaveBeenCalledWith(expect.objectContaining({ layer: 'all', rateLimitRcuPerSec: 2, msPerRcu: 500, pageSize: 4 }));
        expect(runtime.write.mock.calls.map(call => call[0])).toContainEqual('Rate limit: 2 RCU/sec → 500ms per consumed RCU (GSI1 pages of up to 4 items, paced by DynamoDB\'s reported ConsumedCapacity)\n');
    });

    test('paces each page by the read units DynamoDB reports, so large items wait proportionally longer', async () => {
        const runtime = makeRuntime([
            // Three ~300 KB items: 112.5 RCU, far more than one unit per item.
            { items: [makeItem(0), makeItem(1), makeItem(2)], nextCursor: 'next', consumedReadUnits: 112.5 },
            { items: [makeItem(3)], nextCursor: 'last', consumedReadUnits: 0.5 },
            { items: [] },
        ]);
        await main(['bun', 'script', '--layer=identity'], runtime.deps);
        expect(runtime.sleep.mock.calls).toEqual([[56_250], [250]]);
    });

    test('still pays for rows the storage layer dropped as malformed', async () => {
        // The query read (and was charged for) a large row that listByIndexNamespace then dropped.
        const runtime = makeRuntime([
            { items: [], nextCursor: 'next', consumedReadUnits: 37.5 },
            { items: [] },
        ]);
        await main(['bun', 'script', '--layer=identity'], runtime.deps);
        expect(runtime.sleep.mock.calls).toEqual([[18_750]]);
        expect(runtime.write.mock.calls.map(call => call[0]).join('')).toContain('Scanned: 0');
    });

    test('bounds every page and paces each one before the next query, not in aggregate', async () => {
        const runtime = makeRuntime([
            { items: [makeItem(0)], nextCursor: 'a', consumedReadUnits: 3 },
            { items: [makeItem(1)], nextCursor: 'b', consumedReadUnits: 40 },
            { items: [makeItem(2)], consumedReadUnits: 1 },
        ]);
        runtime.now.mockReturnValueOnce(0).mockReturnValueOnce(1000).mockReturnValueOnce(2000).mockReturnValueOnce(3000);
        await main(['bun', 'script', '--layer=identity'], runtime.deps);
        expect(runtime.listByIndexNamespace.mock.calls as unknown).toEqual([
            ['identity', { limit: 4, cursor: undefined }],
            ['identity', { limit: 4, cursor: 'a' }],
            ['identity', { limit: 4, cursor: 'b' }],
        ]);
        // Page one: 3 RCU = 1500 ms, 1000 ms already spent processing; page two: 40 RCU = 20 s, 1000 ms spent.
        expect(runtime.sleep.mock.calls).toEqual([[500], [19_000]]);
    });

    test('with real timer pacing, the next query waits for the whole consumed-RCU budget', async () => {
        jest.useFakeTimers();
        const runtime = makeRuntime([
            { items: [], nextCursor: 'next', consumedReadUnits: 37.5 },
            { items: [] },
        ]);
        const sleeping = Promise.withResolvers<void>();
        const deps = {
            ...runtime.deps,
            sleep: async (ms: number) => {
                const timer = sleepForRateLimit(ms);
                sleeping.resolve();
                return timer;
            },
        };
        const pending = main(['bun', 'script', '--layer=identity', '--rate-limit-rcu-per-sec=2'], deps);
        await sleeping.promise;
        expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(18_749);
        // The pacing timer is still pending one millisecond short of 37.5 RCU at 2 RCU/s.
        expect(jest.getTimerCount()).toBe(1);
        expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        expect(jest.getTimerCount()).toBe(0);
        await pending;
        expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(2);
    });

    test('refuses to continue unpaced when DynamoDB reports no consumed capacity, and still cleans up', async () => {
        const runtime = makeRuntime([
            { items: [makeItem(0)], nextCursor: 'next', omitCapacity: true },
            { items: [] },
        ]);
        await expect(main(['bun', 'script', '--layer=identity'], runtime.deps)).rejects.toThrow(
            'GSI1 query for identity reported no ConsumedCapacity; refusing to continue without RCU pacing'
        );
        expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(1);
        expect(runtime.embedder.encode).not.toHaveBeenCalled();
        expect(runtime.sleep).not.toHaveBeenCalled();
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('includes skipped matches in the final totals without embedding them', async () => {
        const unchanged = makeItem(0);
        const runtime = makeRuntime([{ items: [unchanged, makeItem(1)] }]);
        runtime.index.getHash.mockReturnValueOnce(await sha256Hex(`${unchanged.path}\n${unchanged.content}`));
        await main(['bun', 'script'], runtime.deps);
        expect(runtime.embedder.encode).toHaveBeenCalledTimes(1);
        expect(runtime.index.entries.map(entry => entry.sk)).toEqual(['FILE#item-1']);
        expect(runtime.write.mock.calls.map(call => call[0]).join('')).toContain('Scanned: 2\n  Skipped (unchanged or malformed): 1\n  Indexed: 1\n  Errors: 0');
    });

    test('sleeps for the final millisecond needed to meet the page budget', async () => {
        const runtime = makeRuntime([{ items: [], nextCursor: 'next' }, { items: [] }]);
        runtime.now.mockReturnValueOnce(0).mockReturnValueOnce(499).mockReturnValue(500);

        await main(['bun', 'script', '--layer=identity'], runtime.deps);

        expect(runtime.sleep).toHaveBeenCalledTimes(1);
        expect(runtime.sleep).toHaveBeenCalledWith(1);
    });

    test('continues pagination without sleeping when page processing already spent the budget', async () => {
        const runtime = makeRuntime([{ items: [], nextCursor: 'next' }, { items: [] }]);
        runtime.now.mockReturnValueOnce(0).mockReturnValueOnce(600).mockReturnValue(600);
        await main(['bun', 'script', '--layer=identity'], runtime.deps);
        expect(runtime.listByIndexNamespace).toHaveBeenCalledTimes(2);
        expect(runtime.sleep).not.toHaveBeenCalled();
        expect(runtime.write.mock.calls.map(call => call[0]).join('')).toContain('Scanned: 0');
    });

    test('reports item failures only after cleanup and rejects with the final error count', async () => {
        const runtime = makeRuntime([{ items: [makeItem(0)] }]);
        runtime.embedder.encode.mockImplementation(async () => {
            throw new Error('model failed');
        });
        await expect(main(['bun', 'script'], runtime.deps)).rejects.toThrow('Backfill completed with 1 error(s)');
        expect(runtime.write.mock.calls.map(call => call[0]).join('')).toContain('Errors: 1');
        expect(runtime.embedder.close).toHaveBeenCalledTimes(1);
        expect(runtime.index.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('releases the storage client if opening the vector index fails', async () => {
        const runtime = makeRuntime();
        runtime.openVectorIndex.mockRejectedValueOnce(new Error('index cannot open'));
        await expect(main(['bun', 'script'], runtime.deps)).rejects.toThrow('index cannot open');
        expect(runtime.loadModel).not.toHaveBeenCalled();
        expect(runtime.index.close).not.toHaveBeenCalled();
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('releases the opened index and client if loading the model fails', async () => {
        const runtime = makeRuntime();
        runtime.loadModel.mockRejectedValueOnce(new Error('model cannot load'));
        await expect(main(['bun', 'script'], runtime.deps)).rejects.toThrow('model cannot load');
        expect(runtime.index.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('awaits model release and still closes the index and client after a release failure', async () => {
        const runtime = makeRuntime();
        const closeGate = Promise.withResolvers<void>();
        const closing = Promise.withResolvers<void>();
        runtime.embedder.close.mockImplementation(() => {
            closing.resolve();
            return closeGate.promise;
        });
        const pending = main(['bun', 'script', '--layer=identity'], runtime.deps);
        await closing.promise;
        expect(runtime.index.close).not.toHaveBeenCalled();
        expect(runtime.destroy).not.toHaveBeenCalled();
        closeGate.reject(new Error('model close failed'));
        await expect(pending).rejects.toThrow('model close failed');
        expect(runtime.index.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('destroys the storage client even when the vector index close throws', async () => {
        const runtime = makeRuntime();
        runtime.index.close.mockImplementation(() => {
            throw new Error('index close failed');
        });
        await expect(main(['bun', 'script'], runtime.deps)).rejects.toThrow('index close failed');
        expect(runtime.embedder.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });
});
