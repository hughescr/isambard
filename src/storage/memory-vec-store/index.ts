/**
 * memory-vec-store — SQLite-backed vector index for semantic memory search.
 *
 * Provides:
 * - VectorIndex: SQLite+sqlite-vec CRUD and KNN search
 * - AsyncIndexer: non-blocking background indexer for DynamoDB write hooks
 */

// Core classes
export { VectorIndex, PRUNE_EXPIRED_BATCH_SIZE, PRUNE_TOMBSTONE_BATCH_SIZE, DELETE_TOMBSTONE_TTL_MS } from './backend.js';
export { AsyncIndexer } from './indexer.js';
export {
    createVectorPruneScheduler,
    VECTOR_PRUNE_INTERVAL_MS,
    type VectorPruneScheduler,
    type VectorPruneSchedulerDeps
} from './prune-scheduler.js';
export { configureVectorDbConnection, VECTOR_DB_BUSY_TIMEOUT_MS } from './connection.js';

// Types
export { PACKED_EMBEDDING_BYTES, encodeOne } from './types.js';
export type { PackedBinaryEmbedding1024 } from './types.js';
export type {
    EmbedderLike,
    VectorIndexEntry,
    VectorRowSnapshot,
    VectorTtlUpdate,
    IndexerJob,
    IndexerUpsertJob,
    IndexerDeleteJob,
    VectorQueryResult
} from './types.js';

// Errors
export {
    VectorIndexError,
    VectorIndexClosedError,
    VectorIndexUnavailableError
} from '@/errors';

// Utilities
export { sha256Hex } from './hash.js';
