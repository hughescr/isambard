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
const safeList = mock(async () => ({ items: [], nextCursor: undefined }));
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

function makeRuntime(pages: { items: ReturnType<typeof makeItem>[], nextCursor?: string }[] = [{ items: [] }]) {
    const queue = [...pages];
    const nextPage = mock(async () => queue.shift() ?? { items: [], nextCursor: undefined });
    const list = mock(async () => nextPage());
    const listByLayer = mock(async () => nextPage());
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
        backend: { list, listByLayer } as unknown as ReturnType<BackfillDependencies['openStorage']>['backend'],
        destroy,
    }));
    const openVectorIndex = mock(async () => index);
    const loadModel = mock(async () => embedder);
    const deps = { openStorage, openVectorIndex, loadModel, now, sleep, write, info } satisfies BackfillDependencies;
    return { deps, list, listByLayer, destroy, index, embedder, now, sleep, write, info, openStorage, openVectorIndex, loadModel };
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
        expect(DEFAULT_OPTIONS.rateLimitRcuPerSec).toBe(10);
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
        expect(index.entries.map(entry => entry.layer)).toEqual(['identity', 'identity']);
        expect(index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-2']);
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

    test('preserves an unknown layer for malformed paths returned by storage', async () => {
        const index = makeIndex();
        const embedder = { encode: mock(async () => ({ data: new Uint8Array(128) })) };
        const malformed = { path: 'noslash' as ReturnType<typeof createMemoryPath>, content: 'legacy row' };
        const stats = await processPage([malformed], DEFAULT_OPTIONS, index, embedder);
        expect(stats).toEqual({ scanned: 1, skipped: 0, indexed: 1, errors: 0 });
        expect(index.entries[0]?.layer).toBe('unknown');
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
            list = safeList;
            listByLayer = safeList;
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
        const createBackend = mock(() => ({ list: safeList, listByLayer: safeList }));
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
        expect(runtime.list).not.toHaveBeenCalled();
        expect(runtime.listByLayer).toHaveBeenNthCalledWith(1, 'identity', { limit: 100, cursor: undefined });
        expect(runtime.listByLayer).toHaveBeenNthCalledWith(2, 'identity', { limit: 100, cursor: 'page-two' });
        expect(runtime.sleep).toHaveBeenCalledTimes(1);
        expect(runtime.sleep).toHaveBeenCalledWith(4250);
        expect(runtime.index.entries.map(entry => entry.sk)).toEqual(['FILE#item-0', 'FILE#item-1']);
        expect(runtime.info).toHaveBeenCalledWith(expect.objectContaining({
            dbPath: path.resolve('./vectors.sqlite'), modelSlug: '4b', modelQuant: 'Q4_K_M', layer: 'identity', rateLimitRcuPerSec: 20, sleepIntervalMs: 5000, msg: 'Vector backfill starting',
        }));
        expect(runtime.write.mock.calls.map(call => call[0]).join('')).toContain('Scanned: 2\n  Skipped (up-to-date): 0\n  Indexed: 2\n  Errors: 0');
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
        const pending = main(['bun', 'script'], runtime.deps);

        try {
            await sleepStarted.promise;
            expect(runtime.sleep).toHaveBeenCalledWith(10_000);
            expect(runtime.list).toHaveBeenCalledTimes(1);
        } finally {
            releaseSleep.resolve(undefined);
            await pending;
        }

        expect(runtime.list).toHaveBeenCalledTimes(2);
        expect(runtime.list).toHaveBeenNthCalledWith(2, '/', { limit: 100, cursor: 'page-two' });
    });

    test('uses the full-memory listing and skips sleep when there is no next page', async () => {
        const runtime = makeRuntime([{ items: [makeItem(0)] }]);
        await main(['bun', 'script'], runtime.deps);
        expect(runtime.list).toHaveBeenCalledTimes(1);
        expect(runtime.list).toHaveBeenCalledWith('/', { limit: 100, cursor: undefined });
        expect(runtime.listByLayer).not.toHaveBeenCalled();
        expect(runtime.sleep).not.toHaveBeenCalled();
        expect(runtime.info).toHaveBeenCalledWith(expect.objectContaining({ layer: 'all', rateLimitRcuPerSec: 10, sleepIntervalMs: 10_000 }));
        expect(runtime.write.mock.calls.map(call => call[0])).toContainEqual(expect.stringContaining('Rate limit: 10 RCU/sec → 10000ms between pages of 100 items'));
    });

    test('includes skipped matches in the final totals without embedding them', async () => {
        const unchanged = makeItem(0);
        const runtime = makeRuntime([{ items: [unchanged, makeItem(1)] }]);
        runtime.index.getHash.mockReturnValueOnce(await sha256Hex(`${unchanged.path}\n${unchanged.content}`));
        await main(['bun', 'script'], runtime.deps);
        expect(runtime.embedder.encode).toHaveBeenCalledTimes(1);
        expect(runtime.index.entries.map(entry => entry.sk)).toEqual(['FILE#item-1']);
        expect(runtime.write.mock.calls.map(call => call[0]).join('')).toContain('Scanned: 2\n  Skipped (up-to-date): 1\n  Indexed: 1\n  Errors: 0');
    });

    test('continues pagination without sleeping when page processing already spent the budget', async () => {
        const runtime = makeRuntime([{ items: [], nextCursor: 'next' }, { items: [] }]);
        runtime.now.mockReturnValueOnce(0).mockReturnValueOnce(12_000).mockReturnValue(12_000);
        await main(['bun', 'script'], runtime.deps);
        expect(runtime.list).toHaveBeenCalledTimes(2);
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
        const pending = main(['bun', 'script'], runtime.deps);
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
