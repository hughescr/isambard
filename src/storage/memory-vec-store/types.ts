/**
 * Types for the memory-vec-store SQLite vector index module.
 */

/**
 * Represents a single row in the vector index.
 */
export interface VectorIndexEntry {
    /** DynamoDB partition key */
    pk:          string
    /** DynamoDB sort key */
    sk:          string
    /** Memory layer (identity, state, events, etc.) */
    layer:       string
    /** SHA-256 hash of the indexed text (`${path}\n${content}`) */
    contentHash: string
    /** Packed 1024-bit binary embedding (128 bytes) */
    vector:      Uint8Array
    /** Unix timestamp (ms) of the last index update */
    updatedAt:   number
}

/**
 * An upsert job: index or re-index a memory item.
 */
export interface IndexerUpsertJob {
    kind:    'upsert'
    pk:      string
    sk:      string
    layer:   string
    /** Memory path, used as part of the text fed to the embedder */
    path:    string
    /** Memory content, combined with path as `${path}\n${content}` */
    content: string
}

/**
 * A delete job: remove a memory item from the vector index.
 */
export interface IndexerDeleteJob {
    kind: 'delete'
    pk:   string
    sk:   string
}

/**
 * A job for the AsyncIndexer to process.
 */
export type IndexerJob = IndexerUpsertJob | IndexerDeleteJob;

/**
 * KNN query result from the vector index.
 */
export interface VectorQueryResult {
    pk:       string
    sk:       string
    layer:    string
    distance: number
}

/**
 * Structural embedder interface for semantic search.
 * Matches the `Embedder` class from memory-vec, plus any compatible duck-typed alternative.
 * Using a structural interface decouples the MCP server and indexer from the concrete class.
 */
export interface EmbedderLike {
    /**
     * Encodes an array of texts into packed binary embeddings.
     * Returns at least `data: Uint8Array` with 128 bytes per vector.
     */
    encode: (texts: readonly string[]) => Promise<{ data: Uint8Array }>
    /** Releases resources (GPU memory, model context). Idempotent. */
    close:  () => Promise<void>
}
