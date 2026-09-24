// Static (file-scope) imports for the module namespaces this file mocks (the
// `staticXModule` imports below). spyOn() still intercepts these exports before
// createStorageLayer() calls them, since ESM exports are live bindings — a per-test
// `await import(...)` is not required for that to work, and Bun's dynamic import has
// real per-call overhead (~0.6-3ms even for an already-cached module) which compounds
// toward the 60ms CI timeout cap on slow runners (see tests/unit/index.test.ts for the
// precedent fix).
import { describe, test, expect, beforeEach, afterEach, spyOn, mock, jest } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../setup';
import * as staticAgentSessionModule from '@/agent';
import * as staticStorageLayerModule from '@/app/storage-layer';
import type { DynamoDBConfig, ReconciliationConfig, ContactReconciliationConfig } from '@/config/schemas';
import type { EmbedderLike } from '@/storage';
import * as staticStorageClientModule from '@/storage/client';
import type { ContactReconciliationScheduler } from '@/storage/contacts/reconciliation/scheduler';
import * as staticContactReconciliationModule from '@/storage/contacts/reconciliation/scheduler';
import * as staticMemoryToolModule from '@/storage/memory-tool';
import * as staticReconciliationModule from '@/storage/memory-tool/reconciliation';
import type { TagIndexReconciliationScheduler } from '@/storage/memory-tool/reconciliation/scheduler';
import * as staticVecStoreModule from '@/storage/memory-vec-store';
import type { OperationalStateBackend, OperationalStateStore } from '@/storage/operational-state';
import * as staticOperationalStateModule from '@/storage/operational-state';
import type { SessionJournalBackend } from '@/storage/session-journal';
import * as staticSessionJournalModule from '@/storage/session-journal';
import * as staticSessionResumeModule from '@/storage/session-resume';

describe('createStorageLayer', () => {
    let spies: ReturnType<typeof spyOn>[];
    const mockDynamoDBConfig: DynamoDBConfig = {
        tableName: 'TestTable',
    };
    const mockReconciliationConfig: ReconciliationConfig = {
        enabled:          true,
        intervalMs:       24 * 60 * 60 * 1000, // 24 hours
        operationDelayMs: 1000,
        scanPageSize:     25,
        backoff:          {
            baseDelayMs: 100,
            maxAttempts: 3,
        },
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
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        };
        // @ts-expect-error - Mocking constructor
        const MemoryToolBackendSpy = spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => mockMemoryBackend);
        spies.push(MemoryToolBackendSpy);

        // Mock reconciliation scheduler
        const mockTagIndexReconciliationScheduler = {
            start:       mock(() => {}),
            stop:        mock(() => {}),
            getState:    mock(() => ({ isRunning: false })),
            triggerNow:  mock(async () => undefined),
            notifyDrift: mock(() => {}),
        };
        const createTagIndexReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createTagIndexReconciliationScheduler').mockReturnValue(mockTagIndexReconciliationScheduler);
        spies.push(createTagIndexReconciliationSchedulerSpy);

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
        const result = await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        // Verify all required fields are present
        expect(result).toHaveProperty('holder');
        expect(result).toHaveProperty('tableName');
        expect(result).toHaveProperty('memoryBackend');
        expect(result).toHaveProperty('tagIndexReconciliationScheduler');
        expect(result).toHaveProperty('sessionJournalBackend');
        expect(result).toHaveProperty('createJournal');
        expect(result).toHaveProperty('createResumeStore');

        // Verify values
        expect(result.holder).toBeDefined();
        // holder.getDocClient() returns the wrapped docClient
        expect(result.holder.getDocClient()).toBe(mockDocClient);
        expect(result.tableName).toBe('TestTable');
        expect(result.memoryBackend).toBeDefined();
        expect(result.tagIndexReconciliationScheduler).toBeDefined();
        expect(result.sessionJournalBackend).toBe(mockSessionJournalBackend);
        expect(typeof result.createJournal).toBe('function');
        expect(typeof result.createResumeStore).toBe('function');
        expect(mockLogger.info).toHaveBeenCalledWith('Memory system initialized with DynamoDB: TestTable');
        expect(mockLogger.info).toHaveBeenCalledWith('Tag index reconciliation scheduler configured');
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
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
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

        test('operationalStateStore wraps an OperationalStateBackend on the holder and table with the memory backend as legacy reader', async () => {
            mockCommonDeps();
            const mockBackend = {} as unknown as OperationalStateBackend;
            // @ts-expect-error - Mocking constructor
            const backendSpy = spyOn(staticOperationalStateModule, 'OperationalStateBackend').mockImplementation(() => mockBackend);
            const mockStore = {} as unknown as OperationalStateStore;
            const createStoreSpy = spyOn(staticOperationalStateModule, 'createOperationalStateStore').mockReturnValue(mockStore);
            spies.push(backendSpy, createStoreSpy);

            const result = await staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig);

            expect(backendSpy).toHaveBeenCalledTimes(1);
            expect(backendSpy.mock.calls[0] as unknown[]).toEqual([result.holder, 'TestTable']);
            expect(createStoreSpy).toHaveBeenCalledTimes(1);
            expect(createStoreSpy.mock.calls[0]?.[0]).toEqual({ backend: mockBackend, legacyMemoryBackend: result.memoryBackend });
            expect(createStoreSpy.mock.calls[0]?.[0].backend).toBe(mockBackend);
            expect(createStoreSpy.mock.calls[0]?.[0].legacyMemoryBackend).toBe(result.memoryBackend);
            expect(result.operationalStateStore).toBe(mockStore);
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
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
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
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
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
        // Third arg (indexer) is undefined when no vectorIndexConfig provided
        // Fourth arg is the drift callback closure (always provided)
        // Fifth arg (onIdentityWrite) is undefined when not supplied to createStorageLayer
        expect(MemoryToolBackendSpy).toHaveBeenCalledWith(
            expect.any(Object),
            'TestTable',
            undefined,
            expect.any(Function),
            undefined
        );
    });

    test('should create reconciliation scheduler when config.enabled is true', async () => {
        // Mock all dependencies
        const mockDocClient = {} as unknown as DynamoDBDocumentClient;
        spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: mockDocClient,
            tableName: 'TestTable',
        }));

        const mockMemoryBackend = {
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        };
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => mockMemoryBackend));

        const createTagIndexReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createTagIndexReconciliationScheduler').mockReturnValue({} as unknown as TagIndexReconciliationScheduler);
        spies.push(
            createTagIndexReconciliationSchedulerSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Import and call createStorageLayer with reconciliation enabled
        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        // Verify reconciliation scheduler was created
        expect(createTagIndexReconciliationSchedulerSpy).toHaveBeenCalled();
        expect(result.tagIndexReconciliationScheduler).toBeDefined();
        // The scheduler factory's generic `runReconciliation` deps slot must be bound to the
        // tag-index reconciler's own function by reference, not merely "some function".
        expect(createTagIndexReconciliationSchedulerSpy).toHaveBeenCalledWith(
            expect.objectContaining({ runReconciliation: staticReconciliationModule.runTagIndexReconciliation })
        );
    });

    test('should NOT create reconciliation scheduler when config is undefined', async () => {
        // Mock all dependencies
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            }))
        );

        const createTagIndexReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createTagIndexReconciliationScheduler').mockReturnValue({} as unknown as TagIndexReconciliationScheduler);
        spies.push(
            createTagIndexReconciliationSchedulerSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Import and call createStorageLayer without reconciliation config
        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig);

        // Verify reconciliation scheduler was NOT created
        expect(createTagIndexReconciliationSchedulerSpy).not.toHaveBeenCalled();
        expect(result.tagIndexReconciliationScheduler).toBeUndefined();
    });

    test('should NOT create reconciliation scheduler when config.enabled is false', async () => {
        // Mock all dependencies
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            }))
        );

        const createTagIndexReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createTagIndexReconciliationScheduler').mockReturnValue({} as unknown as TagIndexReconciliationScheduler);
        spies.push(
            createTagIndexReconciliationSchedulerSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Import and call createStorageLayer with reconciliation disabled
        const { createStorageLayer } = staticStorageLayerModule;
        const configWithDisabledReconciliation: ReconciliationConfig = {
            ...mockReconciliationConfig,
            enabled: false,
        };
        const result = await createStorageLayer(mockDynamoDBConfig, configWithDisabledReconciliation);

        // Verify reconciliation scheduler was NOT created
        expect(createTagIndexReconciliationSchedulerSpy).not.toHaveBeenCalled();
        expect(result.tagIndexReconciliationScheduler).toBeUndefined();
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

        await expect(staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, undefined, undefined, {
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
            // @ts-expect-error - Deliberately failing backend constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => { throw constructionError; })
        );

        await expect(staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, undefined, undefined, {
            enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0',
        }, embedder, undefined, onIndexerEmbedderCloseAttempt)).rejects.toBe(constructionError);
        expect(cleanupOrder).toEqual(['transfer', 'embedder', 'vector', 'holder']);
        expect(embedder.close).toHaveBeenCalledTimes(1);
        expect(onIndexerEmbedderCloseAttempt).toHaveBeenCalledTimes(1);
    });

    test('stops both schedulers before releasing the client when a later backend fails', async () => {
        const failure = new Error('task session backend failed');
        const released: string[] = [];
        const scheduler = { start: mock(() => {}), stop:  mock(() => {
            released.push('reconciliation');
        }), notifyDrift: mock(() => {}) };
        const contactScheduler = { start: mock(() => {}), stop:  mock(() => {
            released.push('contact');
        }) };
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    { destroy: mock(() => { released.push('holder'); }) } as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error -- mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({ getTagIndexBackend: mock(() => ({})) })),
            spyOn(staticReconciliationModule, 'createTagIndexReconciliationScheduler').mockReturnValue(scheduler as unknown as TagIndexReconciliationScheduler),
            spyOn(staticContactReconciliationModule, 'createContactReconciliationScheduler').mockReturnValue(contactScheduler as unknown as ContactReconciliationScheduler),
            // @ts-expect-error -- deliberate constructor failure
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => { throw failure; })
        );
        await expect(staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig, {
            enabled: true, intervalMs: 60_000, operationDelayMs: 0, scanPageSize: 25, strayLookupAgeThresholdMs: 300_000,
        })).rejects.toBe(failure);
        expect(released).toEqual(['contact', 'reconciliation', 'holder']);
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
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig);

        expect(result.vectorIndex).toBeUndefined();
        expect(result.asyncIndexer).toBeUndefined();
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
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, undefined, {
            enabled:    false,
            dbPath:     'memory-vec.sqlite',
            modelSlug:  '0.6b',
            modelQuant: 'Q8_0',
        });

        expect(result.vectorIndex).toBeUndefined();
        expect(result.asyncIndexer).toBeUndefined();
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
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, undefined, {
            enabled:    true,
            dbPath:     'memory-vec.sqlite',
            modelSlug:  '0.6b',
            modelQuant: 'Q8_0',
        }, undefined); // no embedder

        expect(result.vectorIndex).toBeUndefined();
        expect(result.asyncIndexer).toBeUndefined();
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
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Mock VectorIndex.open to avoid real SQLite file creation
        const mockVectorIndex = {
            isClosed: false,
            close:    mock(() => {}),
            getHash:  mock((): string | undefined => undefined),
            upsert:   mock(() => {}),
            'delete': mock(() => {}),
            query:    mock(() => []),
        };
        const VectorIndexOpenSpy = spyOn(staticVecStoreModule.VectorIndex, 'open').mockResolvedValue(mockVectorIndex as unknown as typeof staticVecStoreModule.VectorIndex.prototype);
        spies.push(VectorIndexOpenSpy);

        const mockEmbedder = {
            encode: mock(async () => ({ data: new Uint8Array(128) })),
            close:  mock(async () => {}),
        };

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, undefined, {
            enabled:    true,
            dbPath:     'memory-vec.sqlite',
            modelSlug:  '0.6b',
            modelQuant: 'Q8_0',
        }, mockEmbedder);

        expect(VectorIndexOpenSpy).toHaveBeenCalledWith('memory-vec.sqlite');
        expect(result.vectorIndex).toBeDefined();
        expect(result.asyncIndexer).toBeDefined();
        expect(mockLogger.info).toHaveBeenCalledWith('Vector index initialized at memory-vec.sqlite');
        expect(mockEmbedder.close).not.toHaveBeenCalled();
        await result.asyncIndexer?.close();
        await result.asyncIndexer?.close();
        expect(mockEmbedder.close).toHaveBeenCalledTimes(1);
    });

    test('drift callback calls notifyDrift on the reconciliation scheduler when set', async () => {
        spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        // Capture the drift callback passed to MemoryToolBackend
        let capturedDriftCallback: (() => void) | undefined;
        type MemoryToolConstructorArgs = ConstructorParameters<typeof staticMemoryToolModule.MemoryToolBackend>;
        // @ts-expect-error -- Bun types constructor-only spy implementations as never
        spies.push(spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation((
            _holder: MemoryToolConstructorArgs[0],
            _tableName: MemoryToolConstructorArgs[1],
            _indexer: MemoryToolConstructorArgs[2],
            driftCallback: MemoryToolConstructorArgs[3]
        ) => {
            capturedDriftCallback = driftCallback;
            return {
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            };
        }));

        // Create a mock reconciliation scheduler with a notifyDrift spy
        const mockNotifyDrift = mock(() => {});
        const mockTagIndexReconciliationScheduler: TagIndexReconciliationScheduler = {
            start:       mock(() => {}),
            stop:        mock(() => {}),
            getState:    mock(() => ({ isRunning: false as const, lastCompletedAt: undefined })),
            triggerNow:  mock(async () => undefined),
            notifyDrift: mockNotifyDrift,
        };
        spies.push(
            spyOn(staticReconciliationModule, 'createTagIndexReconciliationScheduler').mockReturnValue(mockTagIndexReconciliationScheduler),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        // The drift callback should have been captured and, when invoked, delegates to notifyDrift
        expect(capturedDriftCallback).toBeDefined();
        expect(mockNotifyDrift).not.toHaveBeenCalled();

        // Invoke the drift callback — should call reconciliationScheduler.notifyDrift()
        capturedDriftCallback!();
        expect(mockNotifyDrift).toHaveBeenCalledTimes(1);
    });

    test('should create contactReconciliationScheduler when contactReconciliationConfig.enabled is true', async () => {
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        // Spy on createContactReconciliationScheduler
        const mockContactScheduler: ContactReconciliationScheduler = {
            start:      mock(() => {}),
            stop:       mock(() => {}),
            getState:   mock(() => ({ isRunning: false })),
            triggerNow: mock(async () => undefined),
        };
        const createContactSchedulerSpy = spyOn(staticContactReconciliationModule, 'createContactReconciliationScheduler').mockReturnValue(mockContactScheduler);
        spies.push(createContactSchedulerSpy);

        const mockContactConfig: ContactReconciliationConfig = {
            enabled:                   true,
            intervalMs:                60_000,
            operationDelayMs:          0,
            scanPageSize:              25,
            strayLookupAgeThresholdMs: 300_000,
        };

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, mockContactConfig);

        expect(createContactSchedulerSpy).toHaveBeenCalledTimes(1);
        expect(result.contactReconciliationScheduler).toBeDefined();
        expect(mockLogger.info).toHaveBeenCalledWith('Contact reconciliation scheduler configured');
    });

    // ======================================================================
    // Fix 3: sleep rejects with proper DOMException(AbortError)
    // Fix 5: sleep abort listener is removed on normal completion (bounded listener count)
    // ======================================================================
    describe('contact reconciler sleep function (Fix 3 + Fix 5)', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        /** Helper: capture the sleep function injected into createContactReconciliationScheduler. */
        async function captureSleep(): Promise<(ms: number, signal?: AbortSignal) => Promise<void>> {
            spies.push(
                spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                    client:    {} as unknown as DynamoDBClient,
                    docClient: {} as unknown as DynamoDBDocumentClient,
                    tableName: 'TestTable',
                }),
                // @ts-expect-error -- mocking constructor
                spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                    getTagIndexBackend: mock(() => ({})),
                    get:                mock(async () => undefined),
                    updateMetadataOnly: mock(async () => ({})),
                })),
                // @ts-expect-error -- mocking constructor
                spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
            );

            let capturedSleep: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
            const mockContactScheduler: ContactReconciliationScheduler = {
                start:      mock(() => {}),
                stop:       mock(() => {}),
                getState:   mock(() => ({ isRunning: false })),
                triggerNow: mock(async () => undefined),
            };
            spies.push(spyOn(staticContactReconciliationModule, 'createContactReconciliationScheduler').mockImplementation((opts) => {
                capturedSleep = opts.reconcilerDeps.sleep;
                return mockContactScheduler;
            }));

            const { createStorageLayer } = staticStorageLayerModule;
            await createStorageLayer(mockDynamoDBConfig, undefined, {
                enabled:                   true,
                intervalMs:                60_000,
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 300_000,
            });

            if(!capturedSleep) {
                throw new Error('sleep not captured — createContactReconciliationScheduler spy did not fire');
            }
            return capturedSleep;
        }

        test('Fix 3: abort() with no reason → rejection has name="AbortError"', async () => {
            const sleep = await captureSleep();
            const controller = new AbortController();

            // Pre-abort before calling sleep — sleep checks signal.aborted immediately
            controller.abort();

            let rejected: unknown;
            await sleep(10_000, controller.signal).catch((err) => {
                rejected = err;
            });

            expect(rejected).toBeInstanceOf(Error);
            expect((rejected as Error).name).toBe('AbortError');
        });

        test('Fix 3: abort("stop reason") → rejection has name="AbortError", message="stop reason"', async () => {
            const sleep = await captureSleep();
            const controller = new AbortController();

            controller.abort('stop reason');

            let rejected: unknown;
            await sleep(10_000, controller.signal).catch((err) => {
                rejected = err;
            });

            expect((rejected as Error).name).toBe('AbortError');
            expect((rejected as DOMException).message).toBe('stop reason');
        });

        test('Fix 3: abort(new Error("something")) → rejection has name="AbortError" and message="something"', async () => {
            const sleep = await captureSleep();
            const controller = new AbortController();

            controller.abort(new Error('something'));

            let rejected: unknown;
            await sleep(10_000, controller.signal).catch((err) => {
                rejected = err;
            });

            expect((rejected as Error).name).toBe('AbortError');
            expect((rejected as DOMException).message).toBe('something');
        });

        test('preserves an existing AbortError reason and wraps a different DOMException', async () => {
            const sleep = await captureSleep();
            const existing = new DOMException('already cancelled', 'AbortError');
            const first = new AbortController();
            first.abort(existing);
            await expect(sleep(10, first.signal)).rejects.toBe(existing);

            const second = new AbortController();
            second.abort(new DOMException('connection lost', 'NetworkError'));
            await expect(sleep(10, second.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'connection lost' });
        });

        test('uses the default abort message when a signal has no reason', async () => {
            const sleep = await captureSleep();
            const signal = { aborted: true, reason: undefined } as AbortSignal;
            await expect(sleep(10, signal)).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
        });

        test('an in-flight abort cancels the timer and rejects with the caller reason', async () => {
            jest.useFakeTimers();
            const sleep = await captureSleep();
            const controller = new AbortController();
            const addListener = spyOn(controller.signal, 'addEventListener');
            const clearTimer = spyOn(globalThis, 'clearTimeout');
            try {
                const pending = sleep(10_000, controller.signal);
                let settled = 'pending';
                void pending.catch(() => {
                    settled = 'rejected';
                });
                expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
                controller.abort('interrupted');
                jest.advanceTimersByTime(10_000);
                await Promise.resolve();
                expect(settled).toBe('rejected');
                await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'interrupted' });
                expect(clearTimer).toHaveBeenCalledTimes(1);
            } finally {
                addListener.mockRestore();
                clearTimer.mockRestore();
            }
        });

        test('Fix 5+6: sleep completes normally (no abort) — once:true listener auto-removes; no double-cleanup error', async () => {
            jest.useFakeTimers();
            const sleep = await captureSleep();

            const controller = new AbortController();
            const removeListener = spyOn(controller.signal, 'removeEventListener');

            // Call sleep 100 times with the same signal and advance the timer each time
            const sleepPromises: Promise<void>[] = [];
            for(let i = 0; i < 100; i++) {
                sleepPromises.push(sleep(1, controller.signal));
            }
            // Advance time past all sleeps — all timers fire, all abort listeners are removed
            jest.advanceTimersByTime(100);
            await Promise.all(sleepPromises);
            expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
            removeListener.mockRestore();

            // If Fix 5 is correct, the signal should have no accumulated listeners.
            // We can't directly query listener count, but aborting after all sleeps complete
            // should not call any stale handlers — no throw, no unexpected side effects.
            expect(() => controller.abort()).not.toThrow();
        });
    });

    test('should NOT create contactReconciliationScheduler when contactReconciliationConfig is undefined', async () => {
        spies.push(
            spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }),
            // @ts-expect-error - Mocking constructor
            spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            })),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const createContactSchedulerSpy = spyOn(staticContactReconciliationModule, 'createContactReconciliationScheduler').mockReturnValue({} as unknown as ContactReconciliationScheduler);
        spies.push(createContactSchedulerSpy);

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, undefined);

        expect(createContactSchedulerSpy).not.toHaveBeenCalled();
        expect(result.contactReconciliationScheduler).toBeUndefined();
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
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
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
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, undefined, {
            enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0',
        }, brokenEmbedder, undefined, () => {});

        await expect(result.asyncIndexer!.close()).rejects.toThrow();
    });

    test('propagates a missing notifyDrift() on the reconciliation scheduler rather than silently succeeding', async () => {
        // TagIndexReconciliationScheduler.notifyDrift is a required method, so a conforming scheduler
        // always has one. This deliberately-nonconforming double proves the drift callback
        // really does call `reconciliationScheduler.notifyDrift()` unguarded.
        spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        let capturedDriftCallback: (() => void) | undefined;
        type MemoryToolConstructorArgs = ConstructorParameters<typeof staticMemoryToolModule.MemoryToolBackend>;
        // @ts-expect-error -- Bun types constructor-only spy implementations as never
        spies.push(spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation((
            _holder: MemoryToolConstructorArgs[0],
            _tableName: MemoryToolConstructorArgs[1],
            _indexer: MemoryToolConstructorArgs[2],
            driftCallback: MemoryToolConstructorArgs[3]
        ) => {
            capturedDriftCallback = driftCallback;
            return {
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            };
        }));

        const brokenScheduler = {
            start:      mock(() => {}),
            stop:       mock(() => {}),
            getState:   mock(() => ({ isRunning: false as const, lastCompletedAt: undefined })),
            triggerNow: mock(async () => undefined),
        } as unknown as TagIndexReconciliationScheduler;
        spies.push(
            spyOn(staticReconciliationModule, 'createTagIndexReconciliationScheduler').mockReturnValue(brokenScheduler),
            // @ts-expect-error - Mocking constructor
            spyOn(staticSessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({}))
        );

        const { createStorageLayer } = staticStorageLayerModule;
        await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        expect(capturedDriftCallback).toBeDefined();
        expect(() => capturedDriftCallback!()).toThrow();
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
        const promise = staticStorageLayerModule.createStorageLayer(mockDynamoDBConfig, undefined, undefined, {
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
