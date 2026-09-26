import { logger } from '@hughescr/logger';
import {
    createSessionJournal, createResumeStore, type RoleResumeStore, type SessionJournal,
    type Clock, type SessionRole
} from '@/agent';
import type { DynamoDBConfig, ReconciliationConfig, ContactReconciliationConfig, VectorIndexConfig } from '@/config';
import {
    DynamoDBClientHolder, type TagIndexReconciliationScheduler, createDynamoDBClient, MemoryToolBackend, SessionResumeBackend, createMemoryTagIndexReconciliationScheduler, ContactBackend, createContactReconciliationScheduler, runContactReconciliation, type ContactReconciliationScheduler, VectorIndex, AsyncIndexer, type EmbedderLike,
    createVectorPruneScheduler, type VectorPruneScheduler, createVectorCrossCheckScheduler, type VectorCrossCheckScheduler,
    SessionJournalBackend, OperationalStateBackend, createOperationalStateStore, type OperationalStateStore
} from '@/storage';

/**
 * Wrap an abort reason in a proper AbortError-shaped DOMException.
 * Always produces a DOMException with name='AbortError', copying the
 * message from the original Error (if present) for diagnostic fidelity.
 * @internal
 */
function makeAbortError(reason: unknown): DOMException {
    if(reason instanceof DOMException && reason.name === 'AbortError') {
        return reason;
    }
    let message: string;
    if(reason instanceof Error) {
        message = reason.message;
    } else if(typeof reason === 'string') {
        // Stryker disable next-line llm: the enclosing typeof guard proves reason is a primitive string, so String(reason) is identical.
        message = reason;
    } else {
        message = 'Aborted';
    }
    return new DOMException(message, 'AbortError');
}

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
    holder:                           DynamoDBClientHolder
    tableName:                        string
    memoryBackend:                    MemoryToolBackend
    contactBackend:                   ContactBackend
    /** Write-through backend for the SESSION_JOURNAL#<role> partition (P8). Prefer {@link createJournal} over constructing a {@link SessionJournal} against this directly. */
    sessionJournalBackend:            SessionJournalBackend
    /** Builds a {@link SessionJournal} bound to `role`, backed by {@link sessionJournalBackend}. */
    createJournal:                    (role: SessionRole, clock: Clock) => SessionJournal
    /**
     * Operational-state store (OPERATIONAL_STATE#<owner> partitions) for integration replay
     * checkpoints. Transitionally reads through to the legacy `/state/services/...` memory rows
     * on a miss (read-only) until the checkpoint migration removes that fallback.
     */
    operationalStateStore:            OperationalStateStore
    /** Builds a role-bound resume store over the shared `sessionResumeBackend`'s TASK_SESSION#<role> rows. */
    createResumeStore:                (role: SessionRole) => RoleResumeStore
    tagIndexReconciliationScheduler?: TagIndexReconciliationScheduler
    contactReconciliationScheduler?:  ContactReconciliationScheduler
    /**
     * Vector index for semantic search queries.
     * Undefined when vector indexing is disabled.
     * @internal
     */
    vectorIndex?:                     VectorIndex
    /**
     * Async indexer for background vector embedding.
     * Undefined when vector indexing is disabled.
     * Call `asyncIndexer.close()` on shutdown.
     * @internal
     */
    asyncIndexer?:                    AsyncIndexer
    /**
     * Hourly local prune of expired vector-index rows (#129). Created (not started) only when
     * the vector index is open; the app starts it and stops it before closing the index.
     * @internal
     */
    vectorPruneScheduler?:            VectorPruneScheduler
    vectorCrossCheckScheduler?:       VectorCrossCheckScheduler
}

async function releaseFailedStorage(
    holder: DynamoDBClientHolder,
    vectorIndex: VectorIndex | undefined,
    asyncIndexer: AsyncIndexer | undefined,
    tagIndexReconciliationScheduler: TagIndexReconciliationScheduler | undefined,
    contactReconciliationScheduler: ContactReconciliationScheduler | undefined,
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
        contactReconciliationScheduler?.stop();
    } catch{ /* Preserve the construction error. */ }
    try {
        tagIndexReconciliationScheduler?.stop();
    } catch{ /* Preserve the construction error. */ }
    try {
        holder.destroy();
    } catch{ /* Preserve the construction error. */ }
}

/**
 * Creates the storage layer with DynamoDB client, memory backend, task persistence, and optional reconciliation.
 *
 * @param dynamoDBConfig - DynamoDB configuration
 * @param reconciliationConfig - Optional tag-index reconciliation configuration
 * @param contactReconciliationConfig - Optional contact reconciliation configuration
 * @param vectorIndexConfig - Optional vector index configuration
 * @param embedder - Optional embedder for vector indexing (required when vectorIndexConfig.enabled is true)
 * @param onIndexerEmbedderCloseAttempt - Called just before the indexer closes its owned embedder
 * @returns Storage layer components
 * @throws Error if DynamoDB client creation or backend initialization fails
 */
export async function createStorageLayer(
    dynamoDBConfig:               DynamoDBConfig,
    reconciliationConfig?:        ReconciliationConfig,
    contactReconciliationConfig?: ContactReconciliationConfig,
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
    let tagIndexReconciliationScheduler: TagIndexReconciliationScheduler | undefined;
    let contactReconciliationScheduler: ContactReconciliationScheduler | undefined;
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

        // Declare tagIndexReconciliationScheduler before memoryBackend so the drift callback closure
        // can reference it by binding (late-binding: value is assigned below, after memoryBackend).
        // Create memory backend (with optional async indexer).
        // The drift callback is a late-binding closure that reads tagIndexReconciliationScheduler at
        // call time — the scheduler is assigned after memoryBackend is constructed.
        const memoryBackend = new MemoryToolBackend(holder, tableName, asyncIndexer, () => {
            tagIndexReconciliationScheduler?.notifyDrift();
        }, onIdentityWrite);

        // Create contact backend
        const contactBackend = new ContactBackend(holder, tableName);

        logger.info(`Memory system initialized with DynamoDB: ${tableName}`);

        // Create reconciliation scheduler if enabled
        if(reconciliationConfig?.enabled) {
            tagIndexReconciliationScheduler = createMemoryTagIndexReconciliationScheduler(
                memoryBackend,
                reconciliationConfig,
                { docClient: holder, tableName }
            );
            logger.info('Tag index reconciliation scheduler configured');
        }

        // Create contact reconciliation scheduler if enabled
        if(contactReconciliationConfig?.enabled) {
            contactReconciliationScheduler = createContactReconciliationScheduler({
                config:            contactReconciliationConfig,
                runReconciliation: runContactReconciliation,
                reconcilerDeps:    {
                    docClient: holder,
                    tableName,
                    sleep:     (ms: number, signal?: AbortSignal): Promise<void> => {
                        if(signal?.aborted) {
                            // Stryker disable next-line llm: signal?.aborted can be truthy only when signal is non-nullish, so optional and direct reason access are equivalent.
                            return Promise.reject(makeAbortError(signal.reason));
                        }
                        return new Promise((resolve, reject) => {
                            // Fix 5: remove the abort listener in the normal-completion (resolve) path
                            // so long-lived signals don't accumulate listeners from completed sleeps.
                            const timer = setTimeout(() => {
                                signal?.removeEventListener('abort', onAbort);
                                resolve();
                            }, ms);
                            function onAbort(): void {
                                clearTimeout(timer);
                                // Stryker disable next-line llm: onAbort is registered only through signal?.addEventListener, so signal! and signal? read the same object.
                                reject(makeAbortError(signal!.reason));
                            }
                            signal?.addEventListener('abort', onAbort, { once: true });
                        });
                    },
                },
            });
            logger.info('Contact reconciliation scheduler configured');
        }

        // Session resume backend: role-keyed resume-store rows (SESSION journal/resume, P8/P13b).
        const sessionResumeBackend = new SessionResumeBackend(holder, tableName);
        // P8: write-through session journal (SESSION_JOURNAL#<role> partition) and its role-bound convenience factories
        const sessionJournalBackend = new SessionJournalBackend(holder, tableName);
        const createJournal = (role: SessionRole, clock: Clock): SessionJournal => createSessionJournal({
            backend: sessionJournalBackend, role, clock, logger,
        });
        const createResumeStoreForRole = (role: SessionRole): RoleResumeStore => createResumeStore(sessionResumeBackend, role);
        // #57: integration checkpoints live in OPERATIONAL_STATE#<owner>, reading through to the legacy memory rows on a miss
        const operationalStateStore = createOperationalStateStore({
            backend:             new OperationalStateBackend(holder, tableName),
            legacyMemoryBackend: memoryBackend,
        });

        return {
            holder,
            tableName,
            memoryBackend,
            contactBackend,
            sessionJournalBackend,
            createJournal,
            operationalStateStore,
            createResumeStore: createResumeStoreForRole,
            tagIndexReconciliationScheduler,
            contactReconciliationScheduler,
            vectorIndex,
            asyncIndexer,
            vectorPruneScheduler,
            vectorCrossCheckScheduler,
        };
    } catch (error) {
        // The caller has not received ownership yet. Unwind in dependency order,
        // attempting every release while retaining the construction failure.
        await releaseFailedStorage(holder, vectorIndex, asyncIndexer, tagIndexReconciliationScheduler, contactReconciliationScheduler, vectorPruneScheduler, vectorCrossCheckScheduler);
        throw error;
    }
}
