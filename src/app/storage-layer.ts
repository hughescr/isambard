import { logger } from '@hughescr/logger';
import { createTaskPersistenceCoordinator, createTaskCleanupProcessor, createTaskDirectoryCopier, type TaskPersistenceCoordinator  } from '@/agent';
import type { DynamoDBConfig, ReconciliationConfig } from '@/config';
import { DynamoDBClientHolder, type ReconciliationScheduler, createDynamoDBClient, MemoryToolBackend, TaskSessionBackend, createReconciliationScheduler, runReconciliation, ContactBackend  } from '@/storage';

/**
 * Storage layer components
 */
export interface StorageLayer {
    /**
     * Live DynamoDB client holder.
     * Call `holder.swap()` on reconnect to atomically replace the wedged client pair
     * across all backends without restarting the process.
     *
     * @internal
     */
    holder:                     DynamoDBClientHolder
    tableName:                  string
    memoryBackend:              MemoryToolBackend
    contactBackend:             ContactBackend
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
    const { client, docClient, tableName } = createDynamoDBClient(dynamoDBConfig);

    // Wrap in a holder so all backends pick up the live client on every operation.
    // On DynamoDB reconnect, holder.swap() atomically replaces both client references
    // without restarting any backend.
    const holder = new DynamoDBClientHolder(client, docClient);

    // Create memory backend
    const memoryBackend = new MemoryToolBackend(holder, tableName);

    // Create contact backend
    const contactBackend = new ContactBackend(holder, tableName);

    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info(`Memory system initialized with DynamoDB: ${tableName}`);

    // Create reconciliation scheduler if enabled
    let reconciliationScheduler: ReconciliationScheduler | undefined;
    if(reconciliationConfig?.enabled) {
        reconciliationScheduler = createReconciliationScheduler({
            config:         reconciliationConfig,
            runReconciliation,
            reconcilerDeps: {
                docClient:            holder,
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
    const taskSessionBackend = new TaskSessionBackend(holder, tableName);
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
        holder,
        tableName,
        memoryBackend,
        contactBackend,
        taskPersistenceCoordinator,
        reconciliationScheduler,
    };
}
