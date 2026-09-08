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
// Stryker disable all: helper used only inside the untestable sleep I/O function
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

/**
 * Creates the storage layer with DynamoDB client, memory backend, task persistence, and optional reconciliation.
 *
 * @param dynamoDBConfig - DynamoDB configuration
 * @param reconciliationConfig - Optional tag-index reconciliation configuration
 * @param contactReconciliationConfig - Optional contact reconciliation configuration
 * @param vectorIndexConfig - Optional vector index configuration
 * @param embedder - Optional embedder for vector indexing (required when vectorIndexConfig.enabled is true)
 * @returns Storage layer components
 * @throws Error if DynamoDB client creation or backend initialization fails
 */
export async function createStorageLayer(
    dynamoDBConfig:               DynamoDBConfig,
    reconciliationConfig?:        ReconciliationConfig,
    contactReconciliationConfig?: ContactReconciliationConfig,
    vectorIndexConfig?:           VectorIndexConfig,
    embedder?:                    EmbedderLike,
    onIdentityWrite?:             () => void
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

    // Declare reconciliationScheduler before memoryBackend so the drift callback closure
    // can reference it by binding (late-binding: value is assigned below, after memoryBackend).
    let reconciliationScheduler: ReconciliationScheduler | undefined;

    // Create memory backend (with optional async indexer).
    // The drift callback is a late-binding closure that reads reconciliationScheduler at
    // call time — the scheduler is assigned after memoryBackend is constructed.
    const memoryBackend = new MemoryToolBackend(holder, tableName, asyncIndexer, () => {
        reconciliationScheduler?.notifyDrift();
    }, onIdentityWrite);

    // Create contact backend
    const contactBackend = new ContactBackend(holder, tableName);

    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
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
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
        logger.info('Tag index reconciliation scheduler configured');
    }

    // Create contact reconciliation scheduler if enabled
    let contactReconciliationScheduler: ContactReconciliationScheduler | undefined;
    if(contactReconciliationConfig?.enabled) {
        contactReconciliationScheduler = createContactReconciliationScheduler({
            config:            contactReconciliationConfig,
            runReconciliation: runContactReconciliation,
            reconcilerDeps:    {
                docClient: holder,
                tableName,
                // Stryker disable all: Default sleep is untestable I/O
                sleep:     (ms: number, signal?: AbortSignal): Promise<void> => {
                    if(signal?.aborted) {
                        return Promise.reject(makeAbortError(signal.reason));
                    }
                    return new Promise((resolve, reject) => {
                        // Fix 5: remove the abort listener in the normal-completion (resolve) path
                        // so long-lived signals don't accumulate listeners from completed sleeps.
                        // eslint-disable-next-line prefer-const -- timer is assigned below; let is needed for forward-reference in onAbort closure
                        let timer: ReturnType<typeof setTimeout>;
                        const onAbort = (): void => {
                            clearTimeout(timer);

                            reject(makeAbortError(signal!.reason));
                        };

                        timer = setTimeout(() => {
                            signal?.removeEventListener('abort', onAbort);
                            resolve();
                        }, ms);
                        signal?.addEventListener('abort', onAbort, { once: true });
                    });
                },
                // Stryker restore all
            },
        });
        // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
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
}
