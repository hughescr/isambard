// Static (file-scope) imports for the module namespaces this file mocks (the
// `staticXModule` imports below). spyOn() still intercepts these exports before
// createStorageLayer() calls them, since ESM exports are live bindings — a per-test
// `await import(...)` is not required for that to work, and Bun's dynamic import has
// real per-call overhead (~0.6-3ms even for an already-cached module) which compounds
// toward the 60ms CI timeout cap on slow runners (see tests/unit/index.test.ts for the
// precedent fix).
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../setup';
import * as staticAgentSessionModule from '@/agent';
import * as staticStorageLayerModule from '@/app/storage-layer';
import type { DynamoDBConfig } from '@/config/schemas';
import type { EmbedderLike } from '@/storage';
import * as staticStorageClientModule from '@/storage/client';
import * as staticMemoryToolModule from '@/storage/memory-tool';
import * as staticVecStoreModule from '@/storage/memory-vec-store';
import type { OperationalStateBackend } from '@/storage/operational-state';
import * as staticOperationalStateModule from '@/storage/operational-state';
import type { SessionJournalBackend } from '@/storage/session-journal';
import * as staticSessionJournalModule from '@/storage/session-journal';
import * as staticSessionResumeModule from '@/storage/session-resume';

describe('createStorageLayer', () => {
    let spies: ReturnType<typeof spyOn>[];
    const mockDynamoDBConfig: DynamoDBConfig = {
        tableName: 'TestTable',
    };
    beforeEach(() => {
        spies = [];
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // Ignore errors - spy may already be restored
            }
        }
        spies.length = 0;
    });

    test('should return StorageLayer with all required fields', async () => {
        // Mock createDynamoDBClient
        const mockDocClient = {} as unknown as DynamoDBDocumentClient;
        const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: mockDocClient,
            tableName: 'TestTable',
        });
        spies.push(createClientSpy);

        // Mock MemoryToolBackend
        const mockMemoryBackend = {
            get: mock(async () => undefined),
        };
        // @ts-expect-error - Mocking constructor
        const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => mockMemoryBackend);
        spies.push(MemoryToolBackendSpy);

        // Mock task persistence components
        const mockSessionResumeBackend = {};
        // @ts-expect-error - Mocking constructor
        const SessionResumeBackendSpy = spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => mockSessionResumeBackend);
        spies.push(SessionResumeBackendSpy);

        // Mock the P8 session journal backend
        const mockSessionJournalBackend = {} as unknown as SessionJournalBackend;
        // @ts-expect-error - Mocking constructor
        const SessionJournalBackendSpy = spyOn(staticSessionJournalModule, 'SessionJournalBackend').mockImplementation(() => mockSessionJournalBackend);
        spies.push(SessionJournalBackendSpy);

        // Import and call createStorageLayer
        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig);

        // Verify all required fields are present
        expect(result).toHaveProperty('holder');
        expect(result).toHaveProperty('tableName');
        expect(result).toHaveProperty('memoryBackend');
        expect(result).toHaveProperty('sessionJournalBackend');
        expect(result).toHaveProperty('createJournal');
        expect(result).toHaveProperty('createResumeStore');

        // Verify values
        expect(result.holder).toBeDefined();
        // holder.getDocClient() returns the wrapped docClient
        expect(result.holder.getDocClient()).toBe(mockDocClient);
        expect(result.tableName).toBe('TestTable');
        expect(result.memoryBackend).toBeDefined();
        expect(result.sessionJournalBackend).toBe(mockSessionJournalBackend);
        expect(typeof result.createJournal).toBe('function');
        expect(typeof result.createResumeStore).toBe('function');
        expect(mockLogger.info).toHaveBeenCalledWith('Memory system initialized with DynamoDB: TestTable');
    });

    describe('P8: sessionJournalBackend, createJournal, createResumeStore', () => {
        function mockCommonDeps(): void {
            const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            });
            spies.push(createClientSpy);

            const mockMemoryBackend = {
                get: mock(async () => undefined),
            };
            // @ts-expect-error - Mocking constructor
            const memoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => mockMemoryBackend);
            // @ts-expect-error - Mocking constructor
            const sessionResumeBackendSpy = spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}));
            spies.push(memoryToolBackendSpy, sessionResumeBackendSpy);
        }

        test('sessionJournalBackend is constructed with the holder and tableName', async () => {
            mockCommonDeps();
            const mockSessionJournalBackend = {} as unknown as SessionJournalBackend;
            // @ts-expect-error - Mocking constructor
            const SessionJournalBackendSpy = spyOn(staticSessionJournalModule, 'SessionJournalBackend').mockImplementation(() => mockSessionJournalBackend);
            spies.push(SessionJournalBackendSpy);

            const result = await staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig);

            expect(SessionJournalBackendSpy).toHaveBeenCalledTimes(1);
            const constructorArgs = SessionJournalBackendSpy.mock.calls[0] as unknown as [unknown, string];
            expect(constructorArgs[1]).toBe('TestTable');
            expect(result.sessionJournalBackend).toBe(mockSessionJournalBackend);
        });

        test('createJournal(role, clock) builds a SessionJournal bound to that role over sessionJournalBackend', async () => {
            mockCommonDeps();
            const mockSessionJournalBackend = {} as unknown as SessionJournalBackend;
            // @ts-expect-error - Mocking constructor
            spies.push(spyOn(staticSessionJournalModule, 'SessionJournalBackend').mockImplementation(() => mockSessionJournalBackend));
            const mockJournal = { append: mock(() => undefined), flush: mock(async () => undefined), readSince: mock(async () => []) };
            const createSessionJournalSpy = spyOn(staticAgentSessionModule, 'createSessionJournal').mockReturnValue(mockJournal);
            spies.push(createSessionJournalSpy);
            const fakeClock = { now: () => 0, setTimer: () => ({}) as never, clearTimer: () => undefined };

            const result = await staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig);
            const journal = result.createJournal('conversation', fakeClock);

            expect(createSessionJournalSpy).toHaveBeenCalledWith(expect.objectContaining({ backend: mockSessionJournalBackend, role: 'conversation', clock: fakeClock }));
            expect(journal).toBe(mockJournal);
        });

        test('createResumeStore(role) builds a resume store bound to that role over sessionResumeBackend', async () => {
            mockCommonDeps();
            const mockSessionResumeBackend = {};
            // @ts-expect-error - Mocking constructor
            spies.push(spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => mockSessionResumeBackend));
            const mockResumeStore = { load: mock(async () => undefined), save: mock(async () => undefined), clear: mock(async () => undefined) };
            const createResumeStoreSpy = spyOn(staticAgentSessionModule, 'createResumeStore').mockReturnValue(mockResumeStore);
            spies.push(createResumeStoreSpy);

            const result = await staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig);
            const store = result.createResumeStore('perch');

            expect(createResumeStoreSpy).toHaveBeenCalledWith(mockSessionResumeBackend, 'perch');
            expect(store).toBe(mockResumeStore);
        });

        test('operationalStateStore is the OperationalStateBackend on the holder and table itself', async () => {
            mockCommonDeps();
            const mockBackend = {} as unknown as OperationalStateBackend;
            // @ts-expect-error - Mocking constructor
            const backendSpy = spyOn(staticOperationalStateModule, 'OperationalStateBackend').mockImplementation(() => mockBackend);
            spies.push(backendSpy);

            const result = await staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig);

            expect(backendSpy).toHaveBeenCalledTimes(1);
            expect(backendSpy.mock.calls[0] as unknown[]).toEqual([result.holder, 'TestTable']);
            expect(result.operationalStateStore).toBe(mockBackend);
        });
    });

    test('should pass dynamoDBConfig to createDynamoDBClient', async () => {
        // Mock all dependencies
        const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        });
        spies.push(
            createClientSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                get: mock(async () => undefined),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Import and call createStorageLayer
        const { createStorageLayer } = staticStorageLayerModule;
        await createStorageLayer(mockDynamoDBConfig);

        // Verify createDynamoDBClient was called with correct config
        expect(createClientSpy).toHaveBeenCalledWith(mockDynamoDBConfig);
    });

    test('should create MemoryToolBackend with correct args', async () => {
        // Mock createDynamoDBClient
        const mockDocClient = {} as unknown as DynamoDBDocumentClient;
        spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: mockDocClient,
            tableName: 'TestTable',
        }));

        // Mock MemoryToolBackend
        // @ts-expect-error - Mocking constructor
        const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            get: mock(async () => undefined),
        }));
        // Mock task persistence components
        spies.push(
            MemoryToolBackendSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Import and call createStorageLayer
        const { createStorageLayer } = staticStorageLayerModule;
        await createStorageLayer(mockDynamoDBConfig);

        // Verify MemoryToolBackend constructor was called with the holder (not raw docClient)
        // The holder wraps the docClient created by createDynamoDBClient
        expect(MemoryToolBackendSpy).toHaveBeenCalledWith(
            expect.any(Object),
            'TestTable',
            undefined,
            undefined
        );
    });

    test('should throw when createDynamoDBClient throws', async () => {
        // Mock createDynamoDBClient to throw
        const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockImplementation(() => {
            throw new Error('DynamoDB connection failed');
        });
        spies.push(createClientSpy);

        // Import and call createStorageLayer - should throw
        const { createStorageLayer } = staticStorageLayerModule;
        await expect(createStorageLayer(mockDynamoDBConfig)).rejects.toThrow('DynamoDB connection failed');
    });

    test('should throw when MemoryToolBackend constructor throws', async () => {
        // Mock createDynamoDBClient to succeed
        const destroy = mock(() => undefined);
        spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    { destroy } as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        // Mock MemoryToolBackend to throw
        // @ts-expect-error - Mocking constructor
        const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
            throw new Error('Memory backend initialization failed');
        });
        spies.push(MemoryToolBackendSpy);

        // Import and call createStorageLayer - should throw
        const { createStorageLayer } = staticStorageLayerModule;
        await expect(createStorageLayer(mockDynamoDBConfig)).rejects.toThrow('Memory backend initialization failed');
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    test('releases the DynamoDB holder if opening the vector index rejects', async () => {
        const openError = new Error('vector open failed');
        const destroy = mock(() => undefined);
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy } as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            spyOn(staticVecStoreModule.VectorIndex, 'open').mockRejectedValue(openError)
        );
        const embedder = { encode: mock(async () => ({ data: new Uint8Array(128) })), close: mock(async () => {}) };

        await expect(staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, {
            enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0',
        }, embedder)).rejects.toBe(openError);
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(embedder.close).not.toHaveBeenCalled();
    });

    test('unwinds indexer, vector, and holder after a later constructor fails', async () => {
        const constructionError = new Error('backend failed');
        const cleanupOrder: string[] = [];
        const destroy = mock(() => {
            cleanupOrder.push('holder');
        });
        const vectorClose = mock(() => {
            cleanupOrder.push('vector');
            throw new Error('vector close failed');
        });
        const embedder = {
            encode: mock(async () => ({ data: new Uint8Array(128) })),
            close:  mock(async () => {
                cleanupOrder.push('embedder');
                throw new Error('partial embedder disposal failed');
            }),
        };
        const onIndexerEmbedderCloseAttempt = mock(() => {
            cleanupOrder.push('transfer');
        });
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy } as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            spyOn(staticVecStoreModule.VectorIndex, 'open').mockResolvedValue({ close: vectorClose } as unknown as typeof staticVecStoreModule.VectorIndex.prototype),
            spyOn(staticVecStoreModule, 'createVectorPruneScheduler').mockReturnValue({
                start:   mock(() => {}),
                stop:    mock(() => { cleanupOrder.push('prune'); }),
                runOnce: mock(() => {}),
            }),
            // @ts-expect-error - Deliberately failing backend constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => { throw constructionError; })
        );

        await expect(staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, {
            enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0',
        }, embedder, undefined, onIndexerEmbedderCloseAttempt)).rejects.toBe(constructionError);
        expect(cleanupOrder).toEqual(['prune', 'transfer', 'embedder', 'vector', 'holder']);
        expect(embedder.close).toHaveBeenCalledTimes(1);
        expect(onIndexerEmbedderCloseAttempt).toHaveBeenCalledTimes(1);
    });

    test('should NOT create vector index or asyncIndexer when vectorIndexConfig is undefined', async () => {
        // Mock all dependencies
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                get: mock(async () => undefined),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig);

        expect(result.vectorIndex).toBeUndefined();
        expect(result.asyncIndexer).toBeUndefined();
        expect(result.vectorPruneScheduler).toBeUndefined();
        expect(result.vectorCrossCheckScheduler).toBeUndefined();
    });

    test('should NOT create vector index when vectorIndexConfig.enabled is false', async () => {
        // Mock all dependencies
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                get: mock(async () => undefined),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, {
            enabled:    false,
            dbPath:     'memory-vec.sqlite',
            modelSlug:  '0.6b',
            modelQuant: 'Q8_0',
        });

        expect(result.vectorIndex).toBeUndefined();
        expect(result.asyncIndexer).toBeUndefined();
        expect(result.vectorPruneScheduler).toBeUndefined();
        expect(result.vectorCrossCheckScheduler).toBeUndefined();
    });

    test('should NOT create vector index when embedder is undefined even if vectorIndexConfig.enabled is true', async () => {
        // Mock all dependencies
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                get: mock(async () => undefined),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, {
            enabled:    true,
            dbPath:     'memory-vec.sqlite',
            modelSlug:  '0.6b',
            modelQuant: 'Q8_0',
        }, undefined); // no embedder

        expect(result.vectorIndex).toBeUndefined();
        expect(result.asyncIndexer).toBeUndefined();
        expect(result.vectorPruneScheduler).toBeUndefined();
        expect(result.vectorCrossCheckScheduler).toBeUndefined();
    });

    test('should create vector index and asyncIndexer when vectorIndexConfig.enabled and embedder provided', async () => {
        // Mock all dependencies
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                get: mock(async () => undefined),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Mock VectorIndex.open to avoid real SQLite file creation
        const mockVectorIndex = {
            isClosed:     false,
            close:        mock(() => {}),
            getHash:      mock((): string | undefined => undefined),
            upsert:       mock(() => {}),
            'delete':     mock(() => {}),
            query:        mock(() => []),
            pruneExpired: mock(() => 0),
        };
        const VectorIndexOpenSpy = spyOn(staticVecStoreModule.VectorIndex, 'open').mockResolvedValue(mockVectorIndex as unknown as typeof staticVecStoreModule.VectorIndex.prototype);
        spies.push(VectorIndexOpenSpy);

        const mockEmbedder = {
            encode: mock(async () => ({ data: new Uint8Array(128) })),
            close:  mock(async () => {}),
        };

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, {
            enabled:    true,
            dbPath:     'memory-vec.sqlite',
            modelSlug:  '0.6b',
            modelQuant: 'Q8_0',
        }, mockEmbedder);

        expect(VectorIndexOpenSpy).toHaveBeenCalledWith('memory-vec.sqlite');
        expect(result.vectorIndex).toBeDefined();
        expect(result.asyncIndexer).toBeDefined();
        // The prune scheduler is built over the opened index but not started (app.start() does that)
        expect(result.vectorPruneScheduler).toBeDefined();
        expect(result.vectorCrossCheckScheduler).toBeDefined();
        expect(mockVectorIndex.pruneExpired).not.toHaveBeenCalled();
        result.vectorPruneScheduler!.runOnce();
        expect(mockVectorIndex.pruneExpired).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith('Vector index initialized at memory-vec.sqlite');
        expect(mockEmbedder.close).not.toHaveBeenCalled();
        await result.asyncIndexer?.close();
        await result.asyncIndexer?.close();
        expect(mockEmbedder.close).toHaveBeenCalledTimes(1);
    });

    test('propagates a missing embedder.close() through the wrapped indexer embedder rather than silently succeeding', async () => {
        // EmbedderLike.close is a required method, so a conforming embedder always has one.
        // This deliberately-nonconforming double (cast past the type system, same pattern the
        // file already uses elsewhere) proves the wrapped closure at the onIndexerEmbedderCloseAttempt
        // call site really does call `embedder.close()` unguarded rather than swallowing a missing method.
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                get: mock(async () => undefined),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({})),
            spyOn(staticVecStoreModule.VectorIndex, 'open').mockResolvedValue({
                close: mock(() => {}),
            } as unknown as typeof staticVecStoreModule.VectorIndex.prototype)
        );

        const brokenEmbedder = {
            encode: mock(async () => ({ data: new Uint8Array(128) })),
        } as unknown as EmbedderLike;

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, {
            enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0',
        }, brokenEmbedder, undefined, () => {});

        await expect(result.asyncIndexer!.close()).rejects.toThrow();
    });

    test('stops the cross-check scheduler before releasing the index on failed construction', async () => {
        const constructionError = new Error('backend failed');
        const order: string[] = [];
        let resolveStop!: () => void;
        const stop = mock(() => new Promise<void>((resolve) => {
            resolveStop = resolve;
        }));
        const close = mock(() => {
            order.push('vector');
        });
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client: { destroy: mock(() => {
                    order.push('holder');
                }) } as unknown as DynamoDBClient,
                docClient: {} as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            spyOn(staticVecStoreModule.VectorIndex, 'open').mockResolvedValue({ close } as unknown as typeof staticVecStoreModule.VectorIndex.prototype),
            spyOn(staticVecStoreModule, 'createVectorCrossCheckScheduler').mockReturnValue({ stop } as unknown as ReturnType<typeof staticVecStoreModule.createVectorCrossCheckScheduler>),
            // @ts-expect-error - Deliberately failing backend constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => { throw constructionError; })
        );
        const embedder = { encode: mock(async () => ({ data: new Uint8Array(128) })), close: mock(async () => {}) };
        let settled = false;
        const pending = staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, {
            enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0',
        }, embedder);
        void pending.catch(() => {
            settled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        expect(order).toEqual([]);
        resolveStop();
        await expect(pending).rejects.toBe(constructionError);
        expect(order).toEqual(['vector', 'holder']);
    });

    test('waits for releaseFailedStorage to finish before rejecting when a later constructor fails', async () => {
        // AwaitDrop guard: if the `await` on releaseFailedStorage(...) in the catch block were
        // dropped, createStorageLayer would reject immediately, racing ahead of cleanup instead
        // of waiting for it. Hold the embedder's close() pending to prove the rejection blocks
        // on it.
        const constructionError = new Error('backend failed');
        const cleanupOrder: string[] = [];
        const destroy = mock(() => {
            cleanupOrder.push('holder');
        });
        let resolveEmbedderClose: (() => void) | undefined;
        const embedder = {
            encode: mock(async () => ({ data: new Uint8Array(128) })),
            close:  mock(async () => new Promise<void>((resolve) => {
                resolveEmbedderClose = resolve;
            })),
        };
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy } as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            spyOn(staticVecStoreModule.VectorIndex, 'open').mockResolvedValue({
                close: mock(() => {
                    cleanupOrder.push('vector');
                }),
            } as unknown as typeof staticVecStoreModule.VectorIndex.prototype),
            // @ts-expect-error - Deliberately failing backend constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => { throw constructionError; })
        );

        let settled = false;
        const promise = staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, {
            enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0',
        }, embedder);
        void promise.catch(() => {
            settled = true;
        });

        // embedder.close() is still pending -- createStorageLayer must still be blocked on
        // `await releaseFailedStorage(...)`, which is itself blocked on `await asyncIndexer.close()`.
        // No number of microtask flushes can settle this promise while resolveEmbedderClose is unused.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(cleanupOrder).toEqual([]);

        resolveEmbedderClose!();
        await expect(promise).rejects.toBe(constructionError);
        expect(settled).toBe(true);
        expect(cleanupOrder).toEqual(['vector', 'holder']);
    });
});
