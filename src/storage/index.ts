// Client
export { createDynamoDBClient, probeDynamoDB } from './client';

// Client Holder
export { DynamoDBClientHolder } from './client-holder';

// Storage utilities
export { createPrefixedKey, parsePrefixedKey, stripDynamoKeys } from './utils';

// Base repository
export { DynamoTableAccess, type DeleteItemOptions } from './repositories/base';
export { epochSecondsSchema, createEpochSeconds, isEpochSeconds, type EpochSeconds } from './repositories/types';

// Session Resume
export { SessionResumeBackend, createSessionId, type SessionId } from './session-resume';

// Session Journal
export { SessionJournalBackend, journalEntrySchema, type SessionJournalItem } from './session-journal';

// Operational State
export {
    OperationalStateBackend,
    type OperationalStateKey,
    type OperationalStateRead,
    type OperationalStateSchema,
    type OperationalStateStore
} from './operational-state';

// Memory Tool
export * from './memory-tool';

// DynamoDB Timeout and Health Notifier
export { withDynamoTimeout, setDynamoHealthNotifier } from './dynamo-retry';

// DynamoDB Probe Callback
export { runDynamoDBProbe, type ProbeEventSender } from './dynamo-probe-callback';

// Contacts
export * from './contacts';

// Person Allowlist
export { PersonAllowlist, type PersonAllowlistEntry } from './person-allowlist';

// Activity Logger
export { createActivityLogger, type ActivityLogger, type ActivityLogEntry } from './activity-log';

// Memory-Vec embedding library
export {
    Embedder,
    EmbedderClosedError,
    ggufPath,
    IncompatibleLlamaCppError,
    loadEmbedder,
    MemoryVecError,
    ModelFileNotFoundError,
    type EmbedderOptions,
    type EmbedResult,
    type ModelQuant,
    type ModelSlug
} from './memory-vec';

// Memory-Vec-Store: SQLite vector index + async indexer
export {
    VectorIndex,
    AsyncIndexer,
    createVectorPruneScheduler,
    type VectorPruneScheduler,
    createVectorCrossCheckScheduler,
    type VectorCrossCheckScheduler,
    type VectorRowSnapshot,
    type VectorTtlUpdate,
    PACKED_EMBEDDING_BYTES,
    encodeOne,
    VectorIndexError,
    VectorIndexClosedError,
    VectorIndexUnavailableError,
    type EmbedderLike,
    type VectorIndexEntry,
    type IndexerJob,
    type IndexerUpsertJob,
    type IndexerDeleteJob,
    type VectorQueryResult
} from './memory-vec-store';
