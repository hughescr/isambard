/**
 * Types for the memory-vec-store SQLite vector index module.
 */
import type { MemoryPath, IndexLayer } from '../memory-tool/types.js';
import type { EmbedResult } from '../memory-vec/types.js';
import { VectorIndexError } from '@/errors';

/** Fixed width of the packed 1024-bit model embedding. */
export const PACKED_EMBEDDING_BYTES: EmbedResult['vectorBytes'] = 128;
export type PackedBinaryEmbedding1024 = Uint8Array & { readonly __packedBinaryEmbedding1024: unique symbol };

/**
 * Encode one text and return its first packed vector.
 * @throws {VectorIndexError} If the embedder returned fewer than {@link PACKED_EMBEDDING_BYTES} bytes.
 */
export async function encodeOne(embedder: Pick<EmbedderLike, 'encode'>, text: string): Promise<PackedBinaryEmbedding1024> {
    const result = await embedder.encode([text]);
    if(result.data.length < PACKED_EMBEDDING_BYTES) {
        throw new VectorIndexError(`Embedding must be at least ${PACKED_EMBEDDING_BYTES} bytes; got ${result.data.length}`);
    }
    return result.data.slice(0, PACKED_EMBEDDING_BYTES) as PackedBinaryEmbedding1024;
}

/**
 * Represents a single row in the vector index.
 */
export interface VectorIndexEntry {
    /** DynamoDB partition key */
    pk:          string
    /** DynamoDB sort key */
    sk:          string
    /** Memory layer (identity, state, events, etc.) */
    layer:       IndexLayer
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
    layer:   IndexLayer
    /** Sole identity, also used as part of the text fed to the embedder */
    path:    MemoryPath
    /** Memory content, combined with path as `${path}\n${content}` */
    content: string
}

/**
 * A delete job: remove a memory item from the vector index.
 */
export interface IndexerDeleteJob {
    kind: 'delete'
    path: MemoryPath
}

/**
 * A job for the AsyncIndexer to process.
 */
export type IndexerJob = IndexerUpsertJob | IndexerDeleteJob;

/**
 * KNN query result from the vector index.
 */
export interface VectorQueryResult {
    path:     MemoryPath
    layer:    IndexLayer
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
