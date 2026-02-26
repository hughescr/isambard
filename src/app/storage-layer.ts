import { logger } from '@hughescr/logger';
import { createTaskPersistenceCoordinator, createTaskCleanupProcessor, createTaskDirectoryCopier, type TaskPersistenceCoordinator  } from '@/agent';
import type { DynamoDBConfig, ReconciliationConfig } from '@/config';
import { type ReconciliationScheduler, createDynamoDBClient, MemoryToolBackend, TaskSessionBackend, createReconciliationScheduler, runReconciliation  } from '@/storage';

/**
 * Storage layer components
 */
export interface StorageLayer {
    docClient:                  ReturnType<typeof createDynamoDBClient>['docClient']
    tableName:                  string
    memoryBackend:              MemoryToolBackend
    taskPersistenceCoordinator: TaskPersistenceCoordinator
    reconciliationScheduler?:   ReconciliationScheduler
}

/**
 * Creates the storage layer with DynamoDB client, memory backend, task persistence, and optional reconciliation.
 *
 * @param dynamoDBConfig - DynamoDB configuration
 * @param reconciliationConfig - Optional reconciliation configuration
 * @returns Storage layer components
 * @throws Error if DynamoDB client creation or backend initialization fails
 */
export function createStorageLayer(
    dynamoDBConfig: DynamoDBConfig,
    reconciliationConfig?: ReconciliationConfig
): StorageLayer {
    // Create DynamoDB client
    const { docClient, tableName } = createDynamoDBClient(dynamoDBConfig);

    // Create memory backend
    const memoryBackend = new MemoryToolBackend(docClient, tableName);

    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info(`Memory system initialized with DynamoDB: ${tableName}`);

    // Create reconciliation scheduler if enabled
    let reconciliationScheduler: ReconciliationScheduler | undefined;
    if(reconciliationConfig?.enabled) {
        reconciliationScheduler = createReconciliationScheduler({
            config:         reconciliationConfig,
            runReconciliation,
            reconcilerDeps: {
                docClient,
                tableName,
                tagIndex:             memoryBackend.getTagIndexBackend(),
                getMemory:            path => memoryBackend.get(path),
                updateMemoryMetadata: (path, input) =>
                    memoryBackend.updateMetadataOnly(path, input),
            },
        });
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Tag index reconciliation scheduler configured');
    }

    // Create task persistence system
    const taskSessionBackend = new TaskSessionBackend(docClient, tableName);
    const taskCleanupProcessor = createTaskCleanupProcessor({ logger });
    const taskDirectoryCopier = createTaskDirectoryCopier({
        logger,
        cleanupProcessor: taskCleanupProcessor,
    });
    const taskPersistenceCoordinator = createTaskPersistenceCoordinator({
        backend: taskSessionBackend,
        copier:  taskDirectoryCopier,
        logger,
    });

    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Task persistence system initialized');

    return {
        docClient,
        tableName,
        memoryBackend,
        taskPersistenceCoordinator,
        reconciliationScheduler,
    };
}
