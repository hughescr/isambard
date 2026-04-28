/**
 * Tests for indexer.ts — AsyncIndexer:
 * - enqueue → embed → upsert flow
 * - hash short-circuit (no embed when content unchanged)
 * - drain semantics
 * - error handling drops job (doesn't crash worker)
 * - close drains then closes embedder
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { EmbedResult } from '@/storage/memory-vec';
import { AsyncIndexer } from '@/storage/memory-vec-store/indexer';

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
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/identity/foo', content: 'hello world' });
            await indexer.drain();
            expect(mockEmbedder.encode).toHaveBeenCalledWith(['/identity/foo\nhello world']);
        });

        it('calls vectorIndex.upsert with correct fields after embedding', async () => {
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'state', path: '/state/bar', content: 'some content' });
            await indexer.drain();
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
            const arg = mockVectorIndex.upsert.mock.calls[0][0] as { pk: string, sk: string, layer: string, contentHash: string, vector: Uint8Array, updatedAt: number };
            expect(arg.pk).toBe('pk1');
            expect(arg.sk).toBe('sk1');
            expect(arg.layer).toBe('state');
            expect(typeof arg.contentHash).toBe('string');
            expect(arg.contentHash.length).toBeGreaterThan(0);
            expect(arg.vector).toBeInstanceOf(Uint8Array);
            expect(arg.vector).toHaveLength(128);
        });

        it('sets updatedAt to a positive integer (timestamp)', async () => {
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/identity/foo', content: 'text' });
            await indexer.drain();
            const arg = mockVectorIndex.upsert.mock.calls[0][0] as { updatedAt: number };
            expect(arg.updatedAt).toBeGreaterThan(0);
        });

        it('drain resolves immediately when queue is empty', async () => {
            expect(indexer.drain()).resolves.toBeUndefined();
        });

        it('drain waits for all queued jobs to complete', async () => {
            let encodeCallCount = 0;
            mockEmbedder.encode.mockImplementation(async (): Promise<EmbedResult> => {
                await Promise.resolve();
                encodeCallCount++;
                return makeEmbedResult();
            });

            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/a', content: 'a' });
            indexer.enqueue({ kind: 'upsert', pk: 'pk2', sk: 'sk2', layer: 'identity', path: '/b', content: 'b' });
            expect(encodeCallCount).toBe(0);
            await indexer.drain();
            expect(encodeCallCount).toBe(2);
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(2);
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
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/identity/foo', content: 'hello world' });
            await indexer.drain();
            expect(mockEmbedder.encode).not.toHaveBeenCalled();
            expect(mockVectorIndex.upsert).not.toHaveBeenCalled();
        });

        it('does embed when contentHash differs', async () => {
            mockVectorIndex.getHash.mockReturnValue('old-different-hash');
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/identity/foo', content: 'hello world' });
            await indexer.drain();
            expect(mockEmbedder.encode).toHaveBeenCalledTimes(1);
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
        });
    });

    describe('delete flow', () => {
        it('calls vectorIndex.delete for a delete job', async () => {
            indexer.enqueue({ kind: 'delete', pk: 'pk1', sk: 'sk1' });
            await indexer.drain();
            expect(mockVectorIndex.delete).toHaveBeenCalledWith('pk1', 'sk1');
            expect(mockEmbedder.encode).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('logs and drops job when embed throws, does not crash worker', async () => {
            mockEmbedder.encode.mockImplementation(async () => {
                throw new Error('embed failed');
            });
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/a', content: 'a' });
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
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/a', content: 'a' });
            indexer.enqueue({ kind: 'upsert', pk: 'pk2', sk: 'sk2', layer: 'identity', path: '/b', content: 'b' });
            await indexer.drain();
            // Second job should still be processed
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
        });

        it('logs and drops job when vectorIndex.delete throws, continues', async () => {
            mockVectorIndex.delete.mockImplementation(() => {
                throw new Error('delete failed');
            });
            indexer.enqueue({ kind: 'delete', pk: 'pk1', sk: 'sk1' });
            indexer.enqueue({ kind: 'upsert', pk: 'pk2', sk: 'sk2', layer: 'identity', path: '/b', content: 'b' });
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
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/a', content: 'a' });
            await indexer.close();
            expect(mockEmbedder.encode).toHaveBeenCalledTimes(1);
            expect(mockEmbedder.close).toHaveBeenCalledTimes(1);
        });

        it('is idempotent — calling close twice does not throw', async () => {
            await indexer.close();
            expect(indexer.close()).resolves.toBeUndefined();
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
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/a', content: 'a' });
            await indexer.drain();
            expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
            const upsertCalls = mockVectorIndex.upsert.mock.calls as unknown as [{ vector: Uint8Array }][];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- noUncheckedIndexedAccess; upsert called once per check above
            const arg = upsertCalls[0]![0];
            expect(arg.vector).toHaveLength(128);
        });
    });

    describe('error logging', () => {
        it('logs warn with pk, sk, and msg fields when embed fails', async () => {
            mockEmbedder.encode.mockImplementation(async () => {
                throw new Error('embed error');
            });
            indexer.enqueue({ kind: 'upsert', pk: 'pk-log', sk: 'sk-log', layer: 'identity', path: '/a', content: 'a' });
            await indexer.drain();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            const warnCalls = logger.warn.mock.calls as unknown as Record<string, unknown>[][];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- noUncheckedIndexedAccess; warn called once per check above
            const warnArg = warnCalls[0]![0]!;
            expect(warnArg.pk).toBe('pk-log');
            expect(warnArg.sk).toBe('sk-log');
            expect(typeof warnArg.msg).toBe('string');
            expect((warnArg.msg as string).length).toBeGreaterThan(0);
        });

        it('includes "AsyncIndexer" in the msg field', async () => {
            mockEmbedder.encode.mockImplementation(async () => {
                throw new Error('embed error');
            });
            indexer.enqueue({ kind: 'upsert', pk: 'pk1', sk: 'sk1', layer: 'identity', path: '/a', content: 'a' });
            await indexer.drain();
            const warnCalls = logger.warn.mock.calls as unknown as Record<string, unknown>[][];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- noUncheckedIndexedAccess; warn called once per test setup
            const warnArg = warnCalls[0]![0]!;
            expect(warnArg.msg).toContain('AsyncIndexer');
        });
    });

    describe('queue soft-cap warn', () => {
        it('logs a warn when queue depth exceeds threshold by a multiple of QUEUE_WARN_THROTTLE', async () => {
            // The warn fires when: queueLen > QUEUE_WARN_THRESHOLD AND
            // (queueLen - QUEUE_WARN_THRESHOLD) % QUEUE_WARN_THROTTLE === 0.
            // First fire is at threshold + throttle (e.g. 1000 + 100 = 1100).
            const threshold = AsyncIndexer.QUEUE_WARN_THRESHOLD;
            const throttle = AsyncIndexer.QUEUE_WARN_THROTTLE;
            const firstWarnAt = threshold + throttle;
            for(let n = 0; n < firstWarnAt; n++) {
                indexer.enqueue({ kind: 'delete', pk: `pk${n}`, sk: `sk${n}` });
            }
            await indexer.drain();
            // Warn should have been called exactly once (at the first throttle boundary)
            expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg:      expect.stringContaining('growing large') as string,
                queueLen: expect.any(Number) as number,
            }));
        });

        it('warn log includes pk and sk of the triggering job', async () => {
            const threshold = AsyncIndexer.QUEUE_WARN_THRESHOLD;
            const throttle = AsyncIndexer.QUEUE_WARN_THROTTLE;
            // First warn fires when queue length = threshold + throttle
            for(let n = 0; n < threshold + throttle - 1; n++) {
                indexer.enqueue({ kind: 'delete', pk: `pk${n}`, sk: `sk${n}` });
            }
            // The final job triggers the warn
            indexer.enqueue({ kind: 'delete', pk: 'pk-trigger', sk: 'sk-trigger' });
            await indexer.drain();
            const warnCalls = logger.warn.mock.calls as unknown as Record<string, unknown>[][];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- noUncheckedIndexedAccess; warn called at least once per expect check above
            const warnArg = warnCalls[0]![0]!;
            expect(warnArg.pk).toBe('pk-trigger');
            expect(warnArg.sk).toBe('sk-trigger');
        });

        it('throttles warn to once per QUEUE_WARN_THROTTLE additional enqueues above threshold', async () => {
            const threshold = AsyncIndexer.QUEUE_WARN_THRESHOLD;
            const throttle = AsyncIndexer.QUEUE_WARN_THROTTLE;
            // First warn at threshold+throttle, second at threshold+2*throttle
            const totalJobs = threshold + throttle * 2;
            for(let n = 0; n < totalJobs; n++) {
                indexer.enqueue({ kind: 'delete', pk: `pk${n}`, sk: `sk${n}` });
            }
            await indexer.drain();
            // Should have warned exactly twice: at threshold+throttle and threshold+2*throttle
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });
    });
});
