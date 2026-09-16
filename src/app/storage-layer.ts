import { logger } from '@hughescr/logger';
import {
    createSessionJournal, createResumeStore, type RoleResumeStore, type SessionJournal,
    type Clock, type SessionRole
} from '@/agent';
import type { DynamoDBConfig, ReconciliationConfig, ContactReconciliationConfig, VectorIndexConfig } from '@/config';
import {
    DynamoDBClientHolder, type ReconciliationScheduler, createDynamoDBClient, MemoryToolBackend, TaskSessionBackend, createReconciliationScheduler, runReconciliation, ContactBackend, createContactReconciliationScheduler, runContactReconciliation, type ContactReconciliationScheduler, VectorIndex, AsyncIndexer, type EmbedderLike,
    SessionJournalBackend
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
        message = reason;
    } else {
        message = 'Aborted';
    }
    return new DOMException(message, 'AbortError');
}
// Stryker restore all

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
    holder:                          DynamoDBClientHolder
    tableName:                       string
    memoryBackend:                   MemoryToolBackend
    contactBackend:                  ContactBackend
    /** Write-through backend for the SESSION_JOURNAL#<role> partition (P8). Prefer {@link createJournal} over constructing a {@link SessionJournal} against this directly. */
    sessionJournalBackend:           SessionJournalBackend
    /** Builds a {@link SessionJournal} bound to `role`, backed by {@link sessionJournalBackend}. */
    createJournal:                   (role: SessionRole, clock: Clock) => SessionJournal
    /** Builds a role-bound resume store over the shared `taskSessionBackend`'s TASK_SESSION#<role> rows. */
    createResumeStore:               (role: SessionRole) => RoleResumeStore
    reconciliationScheduler?:        ReconciliationScheduler
    contactReconciliationScheduler?: ContactReconciliationScheduler
    /**
     * Vector index for semantic search queries.
     * Undefined when vector indexing is disabled.
     * @internal
     */
    vectorIndex?:                    VectorIndex
    /**
     * Async indexer for background vector embedding.
     * Undefined when vector indexing is disabled.
     * Call `asyncIndexer.close()` on shutdown.
     * @internal
     */
    asyncIndexer?:                   AsyncIndexer
}

async function releaseFailedStorage(
    holder: DynamoDBClientHolder,
    vectorIndex: VectorIndex | undefined,
    asyncIndexer: AsyncIndexer | undefined,
    reconciliationScheduler: ReconciliationScheduler | undefined,
    contactReconciliationScheduler: ContactReconciliationScheduler | undefined
): Promise<void> {
    // Unwind dependencies in order and attempt every release.
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
        reconciliationScheduler?.stop();
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
    let reconciliationScheduler: ReconciliationScheduler | undefined;
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
            logger.info(`Vector index initialized at ${vectorIndexConfig.dbPath}`);
        }

        // Declare reconciliationScheduler before memoryBackend so the drift callback closure
        // can reference it by binding (late-binding: value is assigned below, after memoryBackend).
        // Create memory backend (with optional async indexer).
        // The drift callback is a late-binding closure that reads reconciliationScheduler at
        // call time — the scheduler is assigned after memoryBackend is constructed.
        const memoryBackend = new MemoryToolBackend(holder, tableName, asyncIndexer, () => {
            reconciliationScheduler?.notifyDrift();
        }, onIdentityWrite);

        // Create contact backend
        const contactBackend = new ContactBackend(holder, tableName);

        logger.info(`Memory system initialized with DynamoDB: ${tableName}`);

        // Create reconciliation scheduler if enabled
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
                                reject(makeAbortError(signal!.reason));
                            }
                            signal?.addEventListener('abort', onAbort, { once: true });
                        });
                    },
                    // Stryker restore all
                },
            });
            logger.info('Contact reconciliation scheduler configured');
        }

        // Task session backend: role-keyed resume-store rows (SESSION journal/resume, P8/P13b).
        const taskSessionBackend = new TaskSessionBackend(holder, tableName);
        // P8: write-through session journal (SESSION_JOURNAL#<role> partition) and its role-bound convenience factories
        const sessionJournalBackend = new SessionJournalBackend(holder, tableName);
        const createJournal = (role: SessionRole, clock: Clock): SessionJournal => createSessionJournal({
            backend: sessionJournalBackend, role, clock, logger,
        });
        const createResumeStoreForRole = (role: SessionRole): RoleResumeStore => createResumeStore(taskSessionBackend, role);

        return {
            holder,
            tableName,
            memoryBackend,
            contactBackend,
            sessionJournalBackend,
            createJournal,
            createResumeStore: createResumeStoreForRole,
            reconciliationScheduler,
            contactReconciliationScheduler,
            vectorIndex,
            asyncIndexer,
        };
    } catch (error) {
        // The caller has not received ownership yet. Unwind in dependency order,
        // attempting every release while retaining the construction failure.
        await releaseFailedStorage(holder, vectorIndex, asyncIndexer, reconciliationScheduler, contactReconciliationScheduler);
        throw error;
    }
}
