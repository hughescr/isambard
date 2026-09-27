import { logger } from '@hughescr/logger';
import {
    createSessionJournal, createResumeStore, type RoleResumeStore, type SessionJournal,
    type Clock, type SessionRole
} from '@/agent';
import type { DynamoDBConfig, VectorIndexConfig } from '@/config';
import {
    DynamoDBClientHolder, createDynamoDBClient, MemoryToolBackend, SessionResumeBackend, ContactBackend, VectorIndex, AsyncIndexer, type EmbedderLike,
    createVectorPruneScheduler, type VectorPruneScheduler, createVectorCrossCheckScheduler, type VectorCrossCheckScheduler,
    SessionJournalBackend, OperationalStateBackend, type OperationalStateStore
} from '@/storage';

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
    /** Write-through backend for the SESSION_JOURNAL#<role> partition (P8). Prefer {@link createJournal} over constructing a {@link SessionJournal} against this directly. */
    sessionJournalBackend:      SessionJournalBackend
    /** Builds a {@link SessionJournal} bound to `role`, backed by {@link sessionJournalBackend}. */
    createJournal:              (role: SessionRole, clock: Clock) => SessionJournal
    /**
     * Operational-state store (OPERATIONAL_STATE#<owner> partitions) for integration replay
     * checkpoints.
     */
    operationalStateStore:      OperationalStateStore
    /** Builds a role-bound resume store over the shared `sessionResumeBackend`'s TASK_SESSION#<role> rows. */
    createResumeStore:          (role: SessionRole) => RoleResumeStore
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
    /**
     * Hourly local prune of expired vector-index rows (#129). Created (not started) only when
     * the vector index is open; the app starts it and stops it before closing the index.
     * @internal
     */
    vectorPruneScheduler?:      VectorPruneScheduler
    vectorCrossCheckScheduler?: VectorCrossCheckScheduler
}

async function releaseFailedStorage(
    holder: DynamoDBClientHolder,
    vectorIndex: VectorIndex | undefined,
    asyncIndexer: AsyncIndexer | undefined,
    vectorPruneScheduler: VectorPruneScheduler | undefined,
    vectorCrossCheckScheduler: VectorCrossCheckScheduler | undefined
): Promise<void> {
    // Unwind dependencies in order and attempt every release.
    // The prune scheduler's stop() only clears a timer and cannot throw.
    vectorPruneScheduler?.stop();
    try {
        await vectorCrossCheckScheduler?.stop();
    } catch{ /* Preserve the construction error and continue cleanup. */ }
    try {
        await asyncIndexer?.close();
    } catch{ /* Preserve the construction error and continue cleanup. */ }
    try {
        vectorIndex?.close();
    } catch{ /* Preserve the construction error. */ }
    try {
        holder.destroy();
    } catch{ /* Preserve the construction error. */ }
}

/**
 * Creates the storage layer with DynamoDB client, memory backend, and task persistence.
 *
 * @param dynamoDBConfig - DynamoDB configuration
 * @param vectorIndexConfig - Optional vector index configuration
 * @param embedder - Optional embedder for vector indexing (required when vectorIndexConfig.enabled is true)
 * @param onIndexerEmbedderCloseAttempt - Called just before the indexer closes its owned embedder
 * @returns Storage layer components
 * @throws Error if DynamoDB client creation or backend initialization fails
 */
export async function createStorageLayer(
    dynamoDBConfig:               DynamoDBConfig,
    vectorIndexConfig?:           VectorIndexConfig,
    embedder?:                    EmbedderLike,
    onIdentityWrite?:             () => void,
    onIndexerEmbedderCloseAttempt?: () => void
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
    let vectorPruneScheduler: VectorPruneScheduler | undefined;
    let vectorCrossCheckScheduler: VectorCrossCheckScheduler | undefined;
    try {
        if(vectorIndexConfig?.enabled && embedder) {
            vectorIndex = await VectorIndex.open(vectorIndexConfig.dbPath);
            const indexerEmbedder: EmbedderLike = onIndexerEmbedderCloseAttempt === undefined
                ? embedder
                : {
                    encode: texts => embedder.encode(texts),
                    close:  () => {
                        onIndexerEmbedderCloseAttempt();
                        return embedder.close();
                    },
                };
            asyncIndexer = new AsyncIndexer({
                vectorIndex,
                embedder: indexerEmbedder,
                logger,
            });
            vectorPruneScheduler = createVectorPruneScheduler({ vectorIndex, logger });
            vectorCrossCheckScheduler = createVectorCrossCheckScheduler({ vectorIndex, docClient: holder, tableName, indexer: asyncIndexer, logger });
            // Stryker disable next-line llm: dbPath only feeds this log message, and pinning its empty-string rendering has no behavioural value.
            logger.info(`Vector index initialized at ${vectorIndexConfig.dbPath}`);
        }

        const memoryBackend = new MemoryToolBackend(holder, tableName, asyncIndexer, onIdentityWrite);

        // Create contact backend
        const contactBackend = new ContactBackend(holder, tableName);

        logger.info(`Memory system initialized with DynamoDB: ${tableName}`);

        // Session resume backend: role-keyed resume-store rows (SESSION journal/resume, P8/P13b).
        const sessionResumeBackend = new SessionResumeBackend(holder, tableName);
        // P8: write-through session journal (SESSION_JOURNAL#<role> partition) and its role-bound convenience factories
        const sessionJournalBackend = new SessionJournalBackend(holder, tableName);
        const createJournal = (role: SessionRole, clock: Clock): SessionJournal => createSessionJournal({
            backend: sessionJournalBackend, role, clock, logger,
        });
        const createResumeStoreForRole = (role: SessionRole): RoleResumeStore => createResumeStore(sessionResumeBackend, role);
        // #57: integration checkpoints live in OPERATIONAL_STATE#<owner>
        const operationalStateStore = new OperationalStateBackend(holder, tableName);

        return {
            holder,
            tableName,
            memoryBackend,
            contactBackend,
            sessionJournalBackend,
            createJournal,
            operationalStateStore,
            createResumeStore: createResumeStoreForRole,
            vectorIndex,
            asyncIndexer,
            vectorPruneScheduler,
            vectorCrossCheckScheduler,
        };
    } catch (error) {
        // The caller has not received ownership yet. Unwind in dependency order,
        // attempting every release while retaining the construction failure.
        await releaseFailedStorage(holder, vectorIndex, asyncIndexer, vectorPruneScheduler, vectorCrossCheckScheduler);
        throw error;
    }
}
