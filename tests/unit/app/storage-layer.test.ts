import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../setup';
import type { TaskCleanupProcessor } from '@/agent/task-cleanup-processor';
import type { TaskDirectoryCopier } from '@/agent/task-directory-copier';
import type { TaskPersistenceCoordinator } from '@/agent/task-persistence-coordinator';
import type { DynamoDBConfig, ReconciliationConfig } from '@/config/schemas';
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
            start:      mock(() => {}),
            stop:       mock(() => {}),
            getState:   mock(() => ({ isRunning: false, currentPhase: null })),
            triggerNow: mock(async () => undefined),
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
        expect(result).toHaveProperty('docClient');
        expect(result).toHaveProperty('tableName');
        expect(result).toHaveProperty('memoryBackend');
        expect(result).toHaveProperty('taskPersistenceCoordinator');
        expect(result).toHaveProperty('reconciliationScheduler');

        // Verify values
        expect(result.docClient).toBe(mockDocClient);
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

        // Verify MemoryToolBackend constructor was called with correct args
        expect(MemoryToolBackendSpy).toHaveBeenCalledWith(mockDocClient, 'TestTable');
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
});
