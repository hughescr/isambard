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
import type { TaskCleanupProcessor } from '@/agent/task-cleanup-processor';
import * as staticTaskCleanupModule from '@/agent/task-cleanup-processor';
import type { TaskDirectoryCopier } from '@/agent/task-directory-copier';
import * as staticTaskDirectoryCopierModule from '@/agent/task-directory-copier';
import type { TaskPersistenceCoordinator } from '@/agent/task-persistence-coordinator';
import * as staticTaskPersistenceModule from '@/agent/task-persistence-coordinator';
import * as staticStorageLayerModule from '@/app/storage-layer';
import type { DynamoDBConfig, ReconciliationConfig, ContactReconciliationConfig } from '@/config/schemas';
import * as staticStorageClientModule from '@/storage/client';
import type { ContactReconciliationScheduler } from '@/storage/contacts/reconciliation/scheduler';
import * as staticContactReconciliationModule from '@/storage/contacts/reconciliation/scheduler';
import * as staticMemoryToolModule from '@/storage/memory-tool';
import * as staticReconciliationModule from '@/storage/memory-tool/reconciliation';
import type { ReconciliationScheduler } from '@/storage/memory-tool/reconciliation/scheduler';
import * as staticVecStoreModule from '@/storage/memory-vec-store';
import * as staticTaskSessionModule from '@/storage/task-session';

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
        const mockReconciliationScheduler = {
            start:       mock(() => {}),
            stop:        mock(() => {}),
            getState:    mock(() => ({ isRunning: false, currentPhase: null })),
            triggerNow:  mock(async () => undefined),
            notifyDrift: mock(() => {}),
        };
        const createReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createReconciliationScheduler').mockReturnValue(mockReconciliationScheduler);
        spies.push(createReconciliationSchedulerSpy);

        // Mock task persistence components
        const mockTaskSessionBackend = {};
        // @ts-expect-error - Mocking constructor
        const TaskSessionBackendSpy = spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => mockTaskSessionBackend);
        spies.push(TaskSessionBackendSpy);

        const mockTaskCleanupProcessor = {} as unknown as TaskCleanupProcessor;
        const createTaskCleanupProcessorSpy = spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue(mockTaskCleanupProcessor);
        spies.push(createTaskCleanupProcessorSpy);

        const mockTaskDirectoryCopier = {} as unknown as TaskDirectoryCopier;
        const createTaskDirectoryCopierSpy = spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue(mockTaskDirectoryCopier);
        spies.push(createTaskDirectoryCopierSpy);

        const mockTaskPersistenceCoordinator = {} as unknown as TaskPersistenceCoordinator;
        const createTaskPersistenceCoordinatorSpy = spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue(mockTaskPersistenceCoordinator);
        spies.push(createTaskPersistenceCoordinatorSpy);

        // Import and call createStorageLayer
        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        // Verify all required fields are present
        expect(result).toHaveProperty('holder');
        expect(result).toHaveProperty('tableName');
        expect(result).toHaveProperty('memoryBackend');
        expect(result).toHaveProperty('taskPersistenceCoordinator');
        expect(result).toHaveProperty('reconciliationScheduler');

        // Verify values
        expect(result.holder).toBeDefined();
        // holder.getDocClient() returns the wrapped docClient
        expect(result.holder.getDocClient()).toBe(mockDocClient);
        expect(result.tableName).toBe('TestTable');
        expect(result.memoryBackend).toBeDefined();
        expect(result.taskPersistenceCoordinator).toBeDefined();
        expect(result.reconciliationScheduler).toBeDefined();
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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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

    test('should create task persistence chain with all factories called', async () => {
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

        // @ts-expect-error - Mocking constructor
        const TaskSessionBackendSpy = spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({}));
        spies.push(TaskSessionBackendSpy);

        const createTaskCleanupProcessorSpy = spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor);
        spies.push(createTaskCleanupProcessorSpy);

        const createTaskDirectoryCopierSpy = spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier);
        spies.push(createTaskDirectoryCopierSpy);

        const createTaskPersistenceCoordinatorSpy = spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator);
        spies.push(createTaskPersistenceCoordinatorSpy);

        // Import and call createStorageLayer
        const { createStorageLayer } = staticStorageLayerModule;
        await createStorageLayer(mockDynamoDBConfig);

        // Verify all task persistence factories were called
        expect(TaskSessionBackendSpy).toHaveBeenCalled();
        expect(createTaskCleanupProcessorSpy).toHaveBeenCalled();
        expect(createTaskDirectoryCopierSpy).toHaveBeenCalled();
        expect(createTaskPersistenceCoordinatorSpy).toHaveBeenCalled();
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

        const createReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createReconciliationScheduler').mockReturnValue({} as unknown as ReconciliationScheduler);
        spies.push(
            createReconciliationSchedulerSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
        );

        // Import and call createStorageLayer with reconciliation enabled
        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        // Verify reconciliation scheduler was created
        expect(createReconciliationSchedulerSpy).toHaveBeenCalled();
        expect(result.reconciliationScheduler).toBeDefined();
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

        const createReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createReconciliationScheduler').mockReturnValue({} as unknown as ReconciliationScheduler);
        spies.push(
            createReconciliationSchedulerSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
        );

        // Import and call createStorageLayer without reconciliation config
        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig);

        // Verify reconciliation scheduler was NOT created
        expect(createReconciliationSchedulerSpy).not.toHaveBeenCalled();
        expect(result.reconciliationScheduler).toBeUndefined();
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

        const createReconciliationSchedulerSpy = spyOn(staticReconciliationModule, 'createReconciliationScheduler').mockReturnValue({} as unknown as ReconciliationScheduler);
        spies.push(
            createReconciliationSchedulerSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
        );

        // Import and call createStorageLayer with reconciliation disabled
        const { createStorageLayer } = staticStorageLayerModule;
        const configWithDisabledReconciliation: ReconciliationConfig = {
            ...mockReconciliationConfig,
            enabled: false,
        };
        const result = await createStorageLayer(mockDynamoDBConfig, configWithDisabledReconciliation);

        // Verify reconciliation scheduler was NOT created
        expect(createReconciliationSchedulerSpy).not.toHaveBeenCalled();
        expect(result.reconciliationScheduler).toBeUndefined();
    });

    test('should throw when createDynamoDBClient throws', async () => {
        // Mock createDynamoDBClient to throw
        const createClientSpy = spyOn(staticStorageClientModule, 'createDynamoDBClient').mockImplementation(() => {
            throw new Error('DynamoDB connection failed');
        });
        spies.push(createClientSpy);

        // Import and call createStorageLayer - should throw
        const { createStorageLayer } = staticStorageLayerModule;
        expect(() => createStorageLayer(mockDynamoDBConfig)).toThrow('DynamoDB connection failed');
    });

    test('should throw when MemoryToolBackend constructor throws', async () => {
        // Mock createDynamoDBClient to succeed
        spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
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
        expect(() => createStorageLayer(mockDynamoDBConfig)).toThrow('Memory backend initialization failed');
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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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
    });

    test('drift callback calls notifyDrift on the reconciliation scheduler when set', async () => {
        spies.push(spyOn(staticStorageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        // Capture the drift callback passed to MemoryToolBackend
        let capturedDriftCallback: (() => void) | undefined;
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(staticMemoryToolModule, 'MemoryToolBackend').mockImplementation((_holder, _tableName, _indexer, driftCallback: (() => void) | undefined) => {
            capturedDriftCallback = driftCallback;
            return {
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            };
        }));

        // Create a mock reconciliation scheduler with a notifyDrift spy
        const mockNotifyDrift = mock(() => {});
        const mockReconciliationScheduler: ReconciliationScheduler = {
            start:       mock(() => {}),
            stop:        mock(() => {}),
            getState:    mock(() => ({ isRunning: false as const, currentPhase: null, lastCompletedAt: undefined })),
            triggerNow:  mock(async () => undefined),
            notifyDrift: mockNotifyDrift,
        };
        spies.push(
            spyOn(staticReconciliationModule, 'createReconciliationScheduler').mockReturnValue(mockReconciliationScheduler),
            // @ts-expect-error - Mocking constructor
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
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
                spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
                spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
                spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
                spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
            );

            let capturedSleep: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
            const mockContactScheduler: ContactReconciliationScheduler = {
                start:      mock(() => {}),
                stop:       mock(() => {}),
                getState:   mock(() => ({ isRunning: false })),
                triggerNow: mock(async () => undefined),
            };
            spies.push(spyOn(staticContactReconciliationModule, 'createContactReconciliationScheduler').mockImplementation((opts) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic capture of injected sleep
                capturedSleep = (opts.reconcilerDeps as any).sleep as (ms: number, signal?: AbortSignal) => Promise<void>;
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

        test('Fix 5+6: sleep completes normally (no abort) — once:true listener auto-removes; no double-cleanup error', async () => {
            jest.useFakeTimers();
            const sleep = await captureSleep();

            const controller = new AbortController();

            // Call sleep 100 times with the same signal and advance the timer each time
            const sleepPromises: Promise<void>[] = [];
            for(let i = 0; i < 100; i++) {
                sleepPromises.push(sleep(1, controller.signal));
            }
            // Advance time past all sleeps — all timers fire, all abort listeners are removed
            jest.advanceTimersByTime(100);
            await Promise.all(sleepPromises);

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
            spyOn(staticTaskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})),
            spyOn(staticTaskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor),
            spyOn(staticTaskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier),
            spyOn(staticTaskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator)
        );

        const createContactSchedulerSpy = spyOn(staticContactReconciliationModule, 'createContactReconciliationScheduler').mockReturnValue({} as unknown as ContactReconciliationScheduler);
        spies.push(createContactSchedulerSpy);

        const { createStorageLayer } = staticStorageLayerModule;
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, undefined);

        expect(createContactSchedulerSpy).not.toHaveBeenCalled();
        expect(result.contactReconciliationScheduler).toBeUndefined();
    });
});
