/**
 * Tests for indexer.ts — AsyncIndexer:
 * - enqueue → embed → upsert flow
 * - hash short-circuit (no embed when content unchanged)
 * - drain semantics
 * - error handling drops job (doesn't crash worker)
 * - close drains then closes embedder
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { VectorIndexError } from '@/errors';
import { MemoryToolKeyGenerator } from '@/storage/memory-tool/key-generator';
import { createMemoryPath, createIndexLayer } from '@/storage/memory-tool/types';
import type { EmbedResult } from '@/storage/memory-vec';
import { sha256Hex } from '@/storage/memory-vec-store/hash';
import { AsyncIndexer } from '@/storage/memory-vec-store/indexer';
import { encodeOne, PACKED_EMBEDDING_BYTES } from '@/storage/memory-vec-store/types';
import { createEpochSeconds } from '@/storage/repositories/types';

/** Build a minimal fake EmbedResult */
function makeEmbedResult(byte = 0xAA): EmbedResult {
    return {
        data:        new Uint8Array(128).fill(byte),
        shape:       [1, 128] as const,
        dtype:       'uint8',
        vectorBytes: 128,
        vectorBits:  1024,
    };
}

describe('single packed embedding', () => {
    it('accepts an exact buffer and copies only the first vector of an overlong buffer', async () => {
        const embedder = { encode: mock(async (_texts: readonly string[]) => ({ data: new Uint8Array(256).fill(7) })) };
        const result = await encodeOne(embedder, 'query');
        expect(PACKED_EMBEDDING_BYTES).toBe(128);
        expect(embedder.encode).toHaveBeenCalledWith(['query']);
        expect(result).toHaveLength(128);
        expect(result[0]).toBe(7);
        expect(await encodeOne({ encode: async () => ({ data: new Uint8Array(128) }) }, 'exact')).toHaveLength(128);
    });

    it('rejects a short embedding with a typed error rather than submitting it to the vector index', async () => {
        const short = encodeOne({ encode: async () => ({ data: new Uint8Array(127) }) }, 'short');
        await expect(short).rejects.toBeInstanceOf(VectorIndexError);
        await expect(short).rejects.toThrow('Embedding must be at least 128 bytes; got 127');
    });
});

/** Build a no-op logger that captures calls */
function makeLogger() {
    return {
        warn:  mock(() => {}),
        error: mock(() => {}),
        info:  mock(() => {}),
        debug: mock(() => {}),
    };
}

describe('AsyncIndexer', () => {
    let mockVectorIndex: {
        getHash:  ReturnType<typeof mock>
        upsert:   ReturnType<typeof mock>
        setTtls:  ReturnType<typeof mock>
        'delete': ReturnType<typeof mock>
        query:    ReturnType<typeof mock>
        close:    ReturnType<typeof mock>
        isClosed: boolean
    };
    let mockEmbedder: {
        encode: ReturnType<typeof mock>
        close:  ReturnType<typeof mock>
    };
    let logger: ReturnType<typeof makeLogger>;
    let indexer: AsyncIndexer;

    beforeEach(() => {
        mockVectorIndex = {
            getHash:  mock(() => undefined),
            upsert:   mock(() => {}),
            setTtls:  mock(() => 0),
            'delete': mock(() => {}),
            query:    mock(() => []),
            close:    mock(() => {}),
            isClosed: false,
        };
        mockEmbedder = {
            encode: mock(async (): Promise<EmbedResult> => makeEmbedResult()),
            close:  mock(async () => {}),
        };
        logger = makeLogger();
        indexer = new AsyncIndexer({
            vectorIndex: mockVectorIndex,
            embedder:    mockEmbedder,
            logger,
        });
    });

    afterEach(async () => {
        // Ensure clean shutdown
        if(!indexer.isClosed) {
            await indexer.close();
        }
        mock.restore();
    });

    describe('enqueue + drain (upsert flow)', () => {
        it('calls embedder.encode with the correct text for an upsert job', async () => {
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/identity/foo'), content: 'hello world', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(mockEmbedder.encode).toHaveBeenCalledWith(['/identity/foo\nhello world']);
        });

        it('calls vectorIndex.upsert with correct fields after embedding', async () => {
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('state'), path: createMemoryPath('/state/bar'), content: 'some content', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
            const arg = mockVectorIndex.upsert.mock.calls[0][0] as { pk: string, sk: string, layer: string, contentHash: string, vector: Uint8Array, updatedAt: number };
            const keys = MemoryToolKeyGenerator.createKeys(createMemoryPath('/state/bar'));
            expect(arg.pk).toBe(keys.PK);
            expect(arg.sk).toBe(keys.SK);
            expect(mockVectorIndex.getHash).toHaveBeenCalledWith(keys.PK, keys.SK);
            expect(arg.layer).toBe('state');
            expect(typeof arg.contentHash).toBe('string');
            expect(arg.contentHash.length).toBeGreaterThan(0);
            expect(arg.vector).toBeInstanceOf(Uint8Array);
            expect(arg.vector).toHaveLength(128);
        });

        it('sets updatedAt to a positive integer (timestamp)', async () => {
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/identity/foo'), content: 'text', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            const arg = mockVectorIndex.upsert.mock.calls[0][0] as { updatedAt: number };
            expect(arg.updatedAt).toBeGreaterThan(0);
        });

        it('drain resolves immediately when queue is empty', async () => {
            await expect(indexer.drain()).resolves.toBeUndefined();
        });

        it('drain waits for all queued jobs to complete', async () => {
            let encodeCallCount = 0;
            mockEmbedder.encode.mockImplementation(async (): Promise<EmbedResult> => {
                await Promise.resolve();
                encodeCallCount++;
                return makeEmbedResult();
            });

            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/b'), content: 'b', ttl: undefined, sourceUpdatedAt: 1 });
            expect(encodeCallCount).toBe(0);
            await indexer.drain();
            expect(encodeCallCount).toBe(2);
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(2);
        });

        it('a drain waits for its captured work while a later enqueue remains pending', async () => {
            let resolveFirst!: (result: EmbedResult) => void;
            let resolveSecond!: (result: EmbedResult) => void;
            const firstResult = new Promise<EmbedResult>((resolve) => {
                resolveFirst = resolve;
            });
            const secondResult = new Promise<EmbedResult>((resolve) => {
                resolveSecond = resolve;
            });
            let encodeCount = 0;
            mockEmbedder.encode.mockImplementation(() => {
                return encodeCount++ === 0 ? firstResult : secondResult;
            });

            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            const firstDrain = indexer.drain();
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/b'), content: 'b', ttl: undefined, sourceUpdatedAt: 1 });

            try {
                resolveFirst(makeEmbedResult());
                await firstDrain;
                expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);

                resolveSecond(makeEmbedResult());
                await indexer.drain();
                expect(mockEmbedder.encode).toHaveBeenCalledTimes(2);
                expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(2);
            } finally {
                resolveFirst(makeEmbedResult());
                resolveSecond(makeEmbedResult());
                await firstDrain;
                await indexer.drain();
            }
        });
    });

    describe('queue bookkeeping', () => {
        it('removes completed jobs before calculating later queue pressure', async () => {
            indexer.enqueue({ kind: 'delete', path: createMemoryPath('/completed') });
            await Promise.resolve();
            await Promise.resolve();

            for(let i = 0; i < 1100; i++) {
                indexer.enqueue({ kind: 'delete', path: createMemoryPath(`/jobs/item-${i}`) });
            }
            await indexer.drain();

            expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
                queueLen: 1100,
                path:     createMemoryPath('/jobs/item-1099'),
            }));
        });
    });

    describe('hash short-circuit', () => {
        it('skips embed when contentHash is unchanged', async () => {
            // Pre-seed a hash that will match
            mockVectorIndex.getHash.mockReturnValue('existing-hash');
            // We need to enqueue something where the SHA-256 of "/identity/foo\nhello world" matches 'existing-hash'
            // Instead — set up getHash to return the actual SHA-256 we'd compute
            // The simplest approach: compute it in the test
            const text = '/identity/foo\nhello world';
            const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            const existingHash = [...new Uint8Array(hashBytes)].map(b => b.toString(16).padStart(2, '0')).join('');

            mockVectorIndex.getHash.mockReturnValue(existingHash);
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/identity/foo'), content: 'hello world', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(mockEmbedder.encode).not.toHaveBeenCalled();
            expect(mockVectorIndex.upsert).not.toHaveBeenCalled();
        });

        it('does embed when contentHash differs', async () => {
            mockVectorIndex.getHash.mockReturnValue('old-different-hash');
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/identity/foo'), content: 'hello world', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(mockEmbedder.encode).toHaveBeenCalledTimes(1);
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
            expect(mockVectorIndex.setTtls).not.toHaveBeenCalled();
        });
    });

    describe('TTL (#129)', () => {
        const path = createMemoryPath('/events/activity/chat/2026-09-24');
        const keys = MemoryToolKeyGenerator.createKeys(path);

        it('carries the job ttl into the upsert, and a missing ttl as null', async () => {
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('events'), path, content: 'x', ttl: createEpochSeconds(1_700_000_000), sourceUpdatedAt: 2000 });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('events'), path, content: 'y', ttl: undefined, sourceUpdatedAt: 3000 });
            await indexer.drain();
            const written = mockVectorIndex.upsert.mock.calls.map((call) => {
                const { ttl, sourceUpdatedAt } = call[0] as { ttl: unknown, sourceUpdatedAt: unknown };
                return { ttl, sourceUpdatedAt };
            });
            expect(written).toEqual([{ ttl: 1_700_000_000, sourceUpdatedAt: 2000 }, { ttl: null, sourceUpdatedAt: 3000 }]);
        });

        it.each([
            ['a new ttl', createEpochSeconds(1_700_000_000), 1_700_000_000],
            ['an absent ttl as null', undefined, null],
        ] as const)('on a hash match, skips the embed but stamps %s', async (_label, ttl, expected) => {
            mockVectorIndex.getHash.mockReturnValue(await sha256Hex(`${path}\nsame`));
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('events'), path, content: 'same', ttl, sourceUpdatedAt: 4000 });
            await indexer.drain();
            expect(mockEmbedder.encode).not.toHaveBeenCalled();
            expect(mockVectorIndex.upsert).not.toHaveBeenCalled();
            expect(mockVectorIndex.setTtls.mock.calls).toEqual([[[{ pk: keys.PK, sk: keys.SK, ttl: expected, sourceUpdatedAt: 4000 }]]]);
        });

        it('logs and drops a job whose TTL stamp throws, and keeps working', async () => {
            const failure = new Error('database is locked');
            mockVectorIndex.getHash.mockReturnValue(await sha256Hex(`${path}\nsame`));
            mockVectorIndex.setTtls.mockImplementationOnce(() => {
                throw failure;
            });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('events'), path, content: 'same', ttl: undefined, sourceUpdatedAt: 1 });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('events'), path, content: 'same', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(logger.warn).toHaveBeenCalledWith({ error: failure, path, msg: 'AsyncIndexer job failed: dropping and continuing' });
            expect(mockVectorIndex.setTtls).toHaveBeenCalledTimes(2);
        });
    });

    describe('delete flow', () => {
        it('calls vectorIndex.delete for a delete job', async () => {
            indexer.enqueue({ kind: 'delete', path: createMemoryPath('/identity/foo') });
            await indexer.drain();
            const keys = MemoryToolKeyGenerator.createKeys(createMemoryPath('/identity/foo'));
            expect(mockVectorIndex.delete).toHaveBeenCalledWith(keys.PK, keys.SK);
            expect(mockEmbedder.encode).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('logs and drops job when embed throws, does not crash worker', async () => {
            mockEmbedder.encode.mockImplementation(async () => {
                throw new Error('embed failed');
            });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            // Should not throw
            await indexer.drain();
            expect(logger.warn).toHaveBeenCalled();
        });

        it('continues processing subsequent jobs after one fails', async () => {
            let callCount = 0;
            mockEmbedder.encode.mockImplementation(async (): Promise<EmbedResult> => {
                callCount++;
                if(callCount === 1) {
                    throw new Error('first fails');
                }
                return makeEmbedResult();
            });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/b'), content: 'b', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            // Second job should still be processed
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
        });

        it('logs and drops job when vectorIndex.delete throws, continues', async () => {
            mockVectorIndex.delete.mockImplementation(() => {
                throw new Error('delete failed');
            });
            indexer.enqueue({ kind: 'delete', path: createMemoryPath('/identity/foo') });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/b'), content: 'b', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(logger.warn).toHaveBeenCalled();
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
        });
    });

    describe('close()', () => {
        it('sets isClosed to true', async () => {
            await indexer.close();
            expect(indexer.isClosed).toBe(true);
        });

        it('drains pending jobs before closing embedder', async () => {
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.close();
            expect(mockEmbedder.encode).toHaveBeenCalledTimes(1);
            expect(mockEmbedder.close).toHaveBeenCalledTimes(1);
        });

        it('is idempotent — calling close twice does not throw', async () => {
            await indexer.close();
            await expect(indexer.close()).resolves.toBeUndefined();
        });

        it('calls embedder.close exactly once even when close() is called twice', async () => {
            await indexer.close();
            await indexer.close();
            expect(mockEmbedder.close).toHaveBeenCalledTimes(1);
        });
    });

    describe('vector slice', () => {
        it('passes exactly 128-byte slice to upsert even when encode returns more bytes', async () => {
            // Return 256-byte data to verify slice(0, 128) is applied
            mockEmbedder.encode.mockImplementation(async () => ({
                data:        new Uint8Array(256).fill(0xCC),
                shape:       [1, 128] as unknown as EmbedResult['shape'],
                dtype:       'uint8' as const,
                vectorBytes: 128 as const,
                vectorBits:  1024 as const,
            }));
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
            const upsertCalls = mockVectorIndex.upsert.mock.calls as unknown as [{ vector: Uint8Array }][];
            const arg = upsertCalls[0][0];
            expect(arg.vector).toHaveLength(128);
        });
    });

    describe('error logging', () => {
        it('logs warn with path and msg fields when embed fails', async () => {
            mockEmbedder.encode.mockImplementation(async () => {
                throw new Error('embed error');
            });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            const warnCalls = logger.warn.mock.calls as unknown as Record<string, unknown>[][];
            const warnArg = warnCalls[0][0];
            expect(warnArg.path).toBe(createMemoryPath('/a'));
            expect(typeof warnArg.msg).toBe('string');
            expect((warnArg.msg as string).length).toBeGreaterThan(0);
        });

        it('includes "AsyncIndexer" in the msg field', async () => {
            mockEmbedder.encode.mockImplementation(async () => {
                throw new Error('embed error');
            });
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/a'), content: 'a', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            const warnCalls = logger.warn.mock.calls as unknown as Record<string, unknown>[][];
            const warnArg = warnCalls[0][0];
            expect(warnArg.msg).toContain('AsyncIndexer');
        });
    });

    describe('queue soft-cap warn', () => {
        it('pins QUEUE_WARN_THRESHOLD at 1000 — the soft-cap trigger point for the growing-queue warn', () => {
            // Direct literal pin (not derived from the constant itself): the warn tests below
            // compute their loop counts from AsyncIndexer.QUEUE_WARN_THRESHOLD, so they would
            // still pass even if the underlying literal changed — only this test catches that.
            expect(AsyncIndexer.QUEUE_WARN_THRESHOLD).toBe(1000);
        });

        it('logs a warn when queue depth exceeds threshold by a multiple of QUEUE_WARN_THROTTLE', async () => {
            // The warn fires when: queueLen > QUEUE_WARN_THRESHOLD AND
            // (queueLen - QUEUE_WARN_THRESHOLD) % QUEUE_WARN_THROTTLE === 0.
            // First fire is at threshold + throttle (e.g. 1000 + 100 = 1100).
            const threshold = AsyncIndexer.QUEUE_WARN_THRESHOLD;
            const throttle = AsyncIndexer.QUEUE_WARN_THROTTLE;
            const firstWarnAt = threshold + throttle;
            for(let n = 0; n < firstWarnAt; n++) {
                indexer.enqueue({ kind: 'delete', path: createMemoryPath(`/jobs/item${n}`) });
            }
            await indexer.drain();
            // Warn should have been called exactly once (at the first throttle boundary)
            expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg:      expect.stringContaining('growing large') as string,
                queueLen: expect.any(Number) as number,
            }));
        });

        it('warn log includes the path of the triggering job', async () => {
            const threshold = AsyncIndexer.QUEUE_WARN_THRESHOLD;
            const throttle = AsyncIndexer.QUEUE_WARN_THROTTLE;
            // First warn fires when queue length = threshold + throttle
            for(let n = 0; n < threshold + throttle - 1; n++) {
                indexer.enqueue({ kind: 'delete', path: createMemoryPath(`/jobs/item${n}`) });
            }
            // The final job triggers the warn
            indexer.enqueue({ kind: 'delete', path: createMemoryPath('/jobs/trigger') });
            await indexer.drain();
            const warnCalls = logger.warn.mock.calls as unknown as Record<string, unknown>[][];
            const warnArg = warnCalls[0][0];
            expect(warnArg.path).toBe(createMemoryPath('/jobs/trigger'));
        });

        it('throttles warn to once per QUEUE_WARN_THROTTLE additional enqueues above threshold', async () => {
            const threshold = AsyncIndexer.QUEUE_WARN_THRESHOLD;
            const throttle = AsyncIndexer.QUEUE_WARN_THROTTLE;
            // First warn at threshold+throttle, second at threshold+2*throttle
            const totalJobs = threshold + throttle * 2;
            for(let n = 0; n < totalJobs; n++) {
                indexer.enqueue({ kind: 'delete', path: createMemoryPath(`/jobs/item${n}`) });
            }
            await indexer.drain();
            // Should have warned exactly twice: at threshold+throttle and threshold+2*throttle
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });
    });

    describe('updatedAt stamping', () => {
        const FIXED_NOW = 1_700_000_000_000;

        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(FIXED_NOW);
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('stamps updatedAt with the clock value at upsert time', async () => {
            indexer.enqueue({ kind: 'upsert', layer: createIndexLayer('identity'), path: createMemoryPath('/identity/foo'), content: 'text', ttl: undefined, sourceUpdatedAt: 1 });
            await indexer.drain();
            const arg = mockVectorIndex.upsert.mock.calls[0][0] as { updatedAt: number };
            expect(arg.updatedAt).toBe(FIXED_NOW);
        });
    });
});
