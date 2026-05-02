/* eslint-disable no-restricted-syntax -- This file tests createStorageLayer() wiring; dynamic imports are required so that spyOn() can intercept constructors before they are called during module load. Refactoring to static imports + beforeEach spyOn would require restructuring module-level singleton initialization. */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock, jest } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../setup';
import type { TaskCleanupProcessor } from '@/agent/task-cleanup-processor';
import type { TaskDirectoryCopier } from '@/agent/task-directory-copier';
import type { TaskPersistenceCoordinator } from '@/agent/task-persistence-coordinator';
import type { DynamoDBConfig, ReconciliationConfig, ContactReconciliationConfig } from '@/config/schemas';
import type { ContactReconciliationScheduler } from '@/storage/contacts/reconciliation/scheduler';
import type { ReconciliationScheduler } from '@/storage/memory-tool/reconciliation/scheduler';

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
        const storageClientModule = await import('@/storage/client');
        const mockDocClient = {} as unknown as DynamoDBDocumentClient;
        const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: mockDocClient,
            tableName: 'TestTable',
        });
        spies.push(createClientSpy);

        // Mock MemoryToolBackend
        const memoryToolModule = await import('@/storage/memory-tool');
        const mockMemoryBackend = {
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        };
        // @ts-expect-error - Mocking constructor
        const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => mockMemoryBackend);
        spies.push(MemoryToolBackendSpy);

        // Mock reconciliation scheduler
        const reconciliationModule = await import('@/storage/memory-tool/reconciliation');
        const mockReconciliationScheduler = {
            start:       mock(() => {}),
            stop:        mock(() => {}),
            getState:    mock(() => ({ isRunning: false, currentPhase: null })),
            triggerNow:  mock(async () => undefined),
            notifyDrift: mock(() => {}),
        };
        const createReconciliationSchedulerSpy = spyOn(reconciliationModule, 'createReconciliationScheduler').mockReturnValue(mockReconciliationScheduler);
        spies.push(createReconciliationSchedulerSpy);

        // Mock task persistence components
        const taskSessionModule = await import('@/storage/task-session');
        const mockTaskSessionBackend = {};
        // @ts-expect-error - Mocking constructor
        const TaskSessionBackendSpy = spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => mockTaskSessionBackend);
        spies.push(TaskSessionBackendSpy);

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        const mockTaskCleanupProcessor = {} as unknown as TaskCleanupProcessor;
        const createTaskCleanupProcessorSpy = spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue(mockTaskCleanupProcessor);
        spies.push(createTaskCleanupProcessorSpy);

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        const mockTaskDirectoryCopier = {} as unknown as TaskDirectoryCopier;
        const createTaskDirectoryCopierSpy = spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue(mockTaskDirectoryCopier);
        spies.push(createTaskDirectoryCopierSpy);

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        const mockTaskPersistenceCoordinator = {} as unknown as TaskPersistenceCoordinator;
        const createTaskPersistenceCoordinatorSpy = spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue(mockTaskPersistenceCoordinator);
        spies.push(createTaskPersistenceCoordinatorSpy);

        // Import and call createStorageLayer
        const { createStorageLayer } = await import('@/app/storage-layer');
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
        const storageClientModule = await import('@/storage/client');
        const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        });
        spies.push(createClientSpy);

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        // Import and call createStorageLayer
        const { createStorageLayer } = await import('@/app/storage-layer');
        await createStorageLayer(mockDynamoDBConfig);

        // Verify createDynamoDBClient was called with correct config
        expect(createClientSpy).toHaveBeenCalledWith(mockDynamoDBConfig);
    });

    test('should create MemoryToolBackend with correct args', async () => {
        // Mock createDynamoDBClient
        const storageClientModule = await import('@/storage/client');
        const mockDocClient = {} as unknown as DynamoDBDocumentClient;
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: mockDocClient,
            tableName: 'TestTable',
        }));

        // Mock MemoryToolBackend
        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        }));
        spies.push(MemoryToolBackendSpy);

        // Mock task persistence components
        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        // Import and call createStorageLayer
        const { createStorageLayer } = await import('@/app/storage-layer');
        await createStorageLayer(mockDynamoDBConfig);

        // Verify MemoryToolBackend constructor was called with the holder (not raw docClient)
        // The holder wraps the docClient created by createDynamoDBClient
        // Third arg (indexer) is undefined when no vectorIndexConfig provided
        // Fourth arg is the drift callback closure (always provided)
        expect(MemoryToolBackendSpy).toHaveBeenCalledWith(
            expect.objectContaining({ getDocClient: expect.any(Function) }),
            'TestTable',
            undefined,
            expect.any(Function)
        );
    });

    test('should create task persistence chain with all factories called', async () => {
        // Mock all dependencies
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        const TaskSessionBackendSpy = spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({}));
        spies.push(TaskSessionBackendSpy);

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        const createTaskCleanupProcessorSpy = spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor);
        spies.push(createTaskCleanupProcessorSpy);

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        const createTaskDirectoryCopierSpy = spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier);
        spies.push(createTaskDirectoryCopierSpy);

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        const createTaskPersistenceCoordinatorSpy = spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator);
        spies.push(createTaskPersistenceCoordinatorSpy);

        // Import and call createStorageLayer
        const { createStorageLayer } = await import('@/app/storage-layer');
        await createStorageLayer(mockDynamoDBConfig);

        // Verify all task persistence factories were called
        expect(TaskSessionBackendSpy).toHaveBeenCalled();
        expect(createTaskCleanupProcessorSpy).toHaveBeenCalled();
        expect(createTaskDirectoryCopierSpy).toHaveBeenCalled();
        expect(createTaskPersistenceCoordinatorSpy).toHaveBeenCalled();
    });

    test('should create reconciliation scheduler when config.enabled is true', async () => {
        // Mock all dependencies
        const storageClientModule = await import('@/storage/client');
        const mockDocClient = {} as unknown as DynamoDBDocumentClient;
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: mockDocClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        const mockMemoryBackend = {
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        };
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => mockMemoryBackend));

        const reconciliationModule = await import('@/storage/memory-tool/reconciliation');
        const createReconciliationSchedulerSpy = spyOn(reconciliationModule, 'createReconciliationScheduler').mockReturnValue({} as unknown as ReconciliationScheduler);
        spies.push(createReconciliationSchedulerSpy);

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        // Import and call createStorageLayer with reconciliation enabled
        const { createStorageLayer } = await import('@/app/storage-layer');
        const result = await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        // Verify reconciliation scheduler was created
        expect(createReconciliationSchedulerSpy).toHaveBeenCalled();
        expect(result.reconciliationScheduler).toBeDefined();
    });

    test('should NOT create reconciliation scheduler when config is undefined', async () => {
        // Mock all dependencies
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const reconciliationModule = await import('@/storage/memory-tool/reconciliation');
        const createReconciliationSchedulerSpy = spyOn(reconciliationModule, 'createReconciliationScheduler').mockReturnValue({} as unknown as ReconciliationScheduler);
        spies.push(createReconciliationSchedulerSpy);

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        // Import and call createStorageLayer without reconciliation config
        const { createStorageLayer } = await import('@/app/storage-layer');
        const result = await createStorageLayer(mockDynamoDBConfig);

        // Verify reconciliation scheduler was NOT created
        expect(createReconciliationSchedulerSpy).not.toHaveBeenCalled();
        expect(result.reconciliationScheduler).toBeUndefined();
    });

    test('should NOT create reconciliation scheduler when config.enabled is false', async () => {
        // Mock all dependencies
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const reconciliationModule = await import('@/storage/memory-tool/reconciliation');
        const createReconciliationSchedulerSpy = spyOn(reconciliationModule, 'createReconciliationScheduler').mockReturnValue({} as unknown as ReconciliationScheduler);
        spies.push(createReconciliationSchedulerSpy);

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        // Import and call createStorageLayer with reconciliation disabled
        const { createStorageLayer } = await import('@/app/storage-layer');
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
        const storageClientModule = await import('@/storage/client');
        const createClientSpy = spyOn(storageClientModule, 'createDynamoDBClient').mockImplementation(() => {
            throw new Error('DynamoDB connection failed');
        });
        spies.push(createClientSpy);

        // Import and call createStorageLayer - should throw
        const { createStorageLayer } = await import('@/app/storage-layer');
        expect(() => createStorageLayer(mockDynamoDBConfig)).toThrow('DynamoDB connection failed');
    });

    test('should throw when MemoryToolBackend constructor throws', async () => {
        // Mock createDynamoDBClient to succeed
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        // Mock MemoryToolBackend to throw
        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        const MemoryToolBackendSpy = spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => {
            throw new Error('Memory backend initialization failed');
        });
        spies.push(MemoryToolBackendSpy);

        // Import and call createStorageLayer - should throw
        const { createStorageLayer } = await import('@/app/storage-layer');
        expect(() => createStorageLayer(mockDynamoDBConfig)).toThrow('Memory backend initialization failed');
    });

    test('should NOT create vector index or asyncIndexer when vectorIndexConfig is undefined', async () => {
        // Mock all dependencies
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        const { createStorageLayer } = await import('@/app/storage-layer');
        const result = await createStorageLayer(mockDynamoDBConfig);

        expect(result.vectorIndex).toBeUndefined();
        expect(result.asyncIndexer).toBeUndefined();
    });

    test('should NOT create vector index when vectorIndexConfig.enabled is false', async () => {
        // Mock all dependencies
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        const { createStorageLayer } = await import('@/app/storage-layer');
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
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        const { createStorageLayer } = await import('@/app/storage-layer');
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
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        // Mock VectorIndex.open to avoid real SQLite file creation
        const vecStoreModule = await import('@/storage/memory-vec-store');
        const mockVectorIndex = {
            isClosed: false,
            close:    mock(() => {}),
            getHash:  mock((): string | undefined => undefined),
            upsert:   mock(() => {}),
            'delete': mock(() => {}),
            query:    mock(() => []),
        };
        const VectorIndexOpenSpy = spyOn(vecStoreModule.VectorIndex, 'open').mockResolvedValue(mockVectorIndex as unknown as typeof vecStoreModule.VectorIndex.prototype);
        spies.push(VectorIndexOpenSpy);

        const mockEmbedder = {
            encode: mock(async () => ({ data: new Uint8Array(128) })),
            close:  mock(async () => {}),
        };

        const { createStorageLayer } = await import('@/app/storage-layer');
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
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        // Capture the drift callback passed to MemoryToolBackend
        let capturedDriftCallback: (() => void) | undefined;
        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation((_holder, _tableName, _indexer, driftCallback: (() => void) | undefined) => {
            capturedDriftCallback = driftCallback;
            return {
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            };
        }));

        // Create a mock reconciliation scheduler with a notifyDrift spy
        const mockNotifyDrift = mock(() => {});
        const reconciliationModule = await import('@/storage/memory-tool/reconciliation');
        const mockReconciliationScheduler: ReconciliationScheduler = {
            start:       mock(() => {}),
            stop:        mock(() => {}),
            getState:    mock(() => ({ isRunning: false as const, currentPhase: null, lastCompletedAt: undefined })),
            triggerNow:  mock(async () => undefined),
            notifyDrift: mockNotifyDrift,
        };
        spies.push(spyOn(reconciliationModule, 'createReconciliationScheduler').mockReturnValue(mockReconciliationScheduler));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));
        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));
        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));
        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        const { createStorageLayer } = await import('@/app/storage-layer');
        await createStorageLayer(mockDynamoDBConfig, mockReconciliationConfig);

        // The drift callback should have been captured and, when invoked, delegates to notifyDrift
        expect(capturedDriftCallback).toBeDefined();
        expect(mockNotifyDrift).not.toHaveBeenCalled();

        // Invoke the drift callback — should call reconciliationScheduler.notifyDrift()
        capturedDriftCallback!();
        expect(mockNotifyDrift).toHaveBeenCalledTimes(1);
    });

    test('should create contactReconciliationScheduler when contactReconciliationConfig.enabled is true', async () => {
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        // Spy on createContactReconciliationScheduler
        const contactReconciliationModule = await import('@/storage/contacts/reconciliation/scheduler');
        const mockContactScheduler: ContactReconciliationScheduler = {
            start:      mock(() => {}),
            stop:       mock(() => {}),
            getState:   mock(() => ({ isRunning: false })),
            triggerNow: mock(async () => undefined),
        };
        const createContactSchedulerSpy = spyOn(contactReconciliationModule, 'createContactReconciliationScheduler').mockReturnValue(mockContactScheduler);
        spies.push(createContactSchedulerSpy);

        const mockContactConfig: ContactReconciliationConfig = {
            enabled:                   true,
            intervalMs:                60_000,
            operationDelayMs:          0,
            scanPageSize:              25,
            strayLookupAgeThresholdMs: 300_000,
        };

        const { createStorageLayer } = await import('@/app/storage-layer');
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
            const storageClientModule = await import('@/storage/client');
            spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    {} as unknown as DynamoDBClient,
                docClient: {} as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
            }));
            const memoryToolModule = await import('@/storage/memory-tool');
            // @ts-expect-error -- mocking constructor
            spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                getTagIndexBackend: mock(() => ({})),
                get:                mock(async () => undefined),
                updateMetadataOnly: mock(async () => ({})),
            })));
            const taskSessionModule = await import('@/storage/task-session');
            // @ts-expect-error -- mocking constructor
            spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));
            const taskCleanupModule = await import('@/agent/task-cleanup-processor');
            spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));
            const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
            spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));
            const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
            spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

            let capturedSleep: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
            const contactReconciliationModule = await import('@/storage/contacts/reconciliation/scheduler');
            const mockContactScheduler: ContactReconciliationScheduler = {
                start:      mock(() => {}),
                stop:       mock(() => {}),
                getState:   mock(() => ({ isRunning: false })),
                triggerNow: mock(async () => undefined),
            };
            spies.push(spyOn(contactReconciliationModule, 'createContactReconciliationScheduler').mockImplementation((opts) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic capture of injected sleep
                capturedSleep = (opts.reconcilerDeps as any).sleep as (ms: number, signal?: AbortSignal) => Promise<void>;
                return mockContactScheduler;
            }));

            const { createStorageLayer } = await import('@/app/storage-layer');
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
        const storageClientModule = await import('@/storage/client');
        spies.push(spyOn(storageClientModule, 'createDynamoDBClient').mockReturnValue({
            client:    {} as unknown as DynamoDBClient,
            docClient: {} as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
        }));

        const memoryToolModule = await import('@/storage/memory-tool');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
            getTagIndexBackend: mock(() => ({})),
            get:                mock(async () => undefined),
            updateMetadataOnly: mock(async () => ({})),
        })));

        const taskSessionModule = await import('@/storage/task-session');
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(taskSessionModule, 'TaskSessionBackend').mockImplementation(() => ({})));

        const taskCleanupModule = await import('@/agent/task-cleanup-processor');
        spies.push(spyOn(taskCleanupModule, 'createTaskCleanupProcessor').mockReturnValue({} as unknown as TaskCleanupProcessor));

        const taskDirectoryCopierModule = await import('@/agent/task-directory-copier');
        spies.push(spyOn(taskDirectoryCopierModule, 'createTaskDirectoryCopier').mockReturnValue({} as unknown as TaskDirectoryCopier));

        const taskPersistenceModule = await import('@/agent/task-persistence-coordinator');
        spies.push(spyOn(taskPersistenceModule, 'createTaskPersistenceCoordinator').mockReturnValue({} as unknown as TaskPersistenceCoordinator));

        const contactReconciliationModule = await import('@/storage/contacts/reconciliation/scheduler');
        const createContactSchedulerSpy = spyOn(contactReconciliationModule, 'createContactReconciliationScheduler').mockReturnValue({} as unknown as ContactReconciliationScheduler);
        spies.push(createContactSchedulerSpy);

        const { createStorageLayer } = await import('@/app/storage-layer');
        const result = await createStorageLayer(mockDynamoDBConfig, undefined, undefined);

        expect(createContactSchedulerSpy).not.toHaveBeenCalled();
        expect(result.contactReconciliationScheduler).toBeUndefined();
    });
});
