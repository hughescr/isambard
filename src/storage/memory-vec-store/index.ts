/**
 * memory-vec-store — SQLite-backed vector index for semantic memory search.
 *
 * Provides:
 * - VectorIndex: SQLite+sqlite-vec CRUD and KNN search
 * - AsyncIndexer: non-blocking background indexer for DynamoDB write hooks
 */

// Core classes
export { VectorIndex } from './backend.js';
export { AsyncIndexer } from './indexer.js';

// Types
export { PACKED_EMBEDDING_BYTES, encodeOne } from './types.js';
export type { PackedBinaryEmbedding1024 } from './types.js';
export type {
    EmbedderLike,
    VectorIndexEntry,
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
