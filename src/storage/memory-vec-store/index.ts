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
} from './errors.js';

// Utilities
export { sha256Hex } from './hash.js';
