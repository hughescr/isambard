// Client
export { createDynamoDBClient, probeDynamoDB } from './client';

// Client Holder
export { DynamoDBClientHolder } from './client-holder';

// Storage utilities
export { createPrefixedKey, parsePrefixedKey } from './utils';

// Base repository
export { BaseRepository } from './repositories/base';

// Task Session
export { TaskSessionBackend, createSessionId, type SessionId } from './task-session';

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
export { createActivityLogger, type ActivityLogger, type ActivityLogEntry, type ActivityType } from './activity-log';

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
