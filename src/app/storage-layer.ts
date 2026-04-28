import { logger } from '@hughescr/logger';
import { createTaskPersistenceCoordinator, createTaskCleanupProcessor, createTaskDirectoryCopier, type TaskPersistenceCoordinator  } from '@/agent';
import type { DynamoDBConfig, ReconciliationConfig, VectorIndexConfig } from '@/config';
import { DynamoDBClientHolder, type ReconciliationScheduler, createDynamoDBClient, MemoryToolBackend, TaskSessionBackend, createReconciliationScheduler, runReconciliation, ContactBackend, VectorIndex, AsyncIndexer, type EmbedderLike  } from '@/storage';

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
    /**
     * Vector index for semantic search queries.
     * Undefined when vector indexing is disabled.
     * @internal
     */
    vectorIndex?:               VectorIndex
    /**
     * Async indexer for background vector embedding.
     * Undefined when vector indexing is disabled.
     * Call `asyncIndexer.close()` on shutdown.
     * @internal
     */
    asyncIndexer?:              AsyncIndexer
}

/**
 * Creates the storage layer with DynamoDB client, memory backend, task persistence, and optional reconciliation.
 *
 * @param dynamoDBConfig - DynamoDB configuration
 * @param reconciliationConfig - Optional reconciliation configuration
 * @param vectorIndexConfig - Optional vector index configuration
 * @param embedder - Optional embedder for vector indexing (required when vectorIndexConfig.enabled is true)
 * @returns Storage layer components
 * @throws Error if DynamoDB client creation or backend initialization fails
 */
export async function createStorageLayer(
    dynamoDBConfig:      DynamoDBConfig,
    reconciliationConfig?: ReconciliationConfig,
    vectorIndexConfig?:  VectorIndexConfig,
    embedder?:           EmbedderLike
): Promise<StorageLayer> {
    // Create DynamoDB client
    const { client, docClient, tableName } = createDynamoDBClient(dynamoDBConfig);

    // Wrap in a holder so all backends pick up the live client on every operation.
    // On DynamoDB reconnect, holder.swap() atomically replaces both client references
    // without restarting any backend.
    const holder = new DynamoDBClientHolder(client, docClient);

    // Optionally create vector index and async indexer
    let vectorIndex:  VectorIndex  | undefined;
    let asyncIndexer: AsyncIndexer | undefined;
    // Stryker disable next-line ConditionalExpression: configuration guard — false path is valid when vector indexing is disabled
    if(vectorIndexConfig?.enabled && embedder) {
        vectorIndex = await VectorIndex.open(vectorIndexConfig.dbPath);
        asyncIndexer = new AsyncIndexer({
            vectorIndex,
            embedder,
            logger,
        });
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info(`Vector index initialized at ${vectorIndexConfig.dbPath}`);
    }

    // Create memory backend (with optional async indexer)
    const memoryBackend = new MemoryToolBackend(holder, tableName, asyncIndexer);

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
        vectorIndex,
        asyncIndexer,
    };
}
