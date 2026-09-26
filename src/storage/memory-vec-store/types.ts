/**
 * Types for the memory-vec-store SQLite vector index module.
 */
import type { MemoryPath, IndexLayer } from '../memory-tool/types.js';
import type { EmbedResult } from '../memory-vec/types.js';
import type { EpochSeconds } from '../repositories/types.js';
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
    pk:               string
    /** DynamoDB sort key */
    sk:               string
    /** Memory layer (identity, state, events, etc.) */
    layer:            IndexLayer
    /** SHA-256 hash of the indexed text (`${path}\n${content}`) */
    contentHash:      string
    /** Packed 1024-bit binary embedding (128 bytes) */
    vector:           PackedBinaryEmbedding1024
    /** Unix timestamp (ms) of the last index update */
    updatedAt:        number
    /**
     * The memory's DynamoDB `TTL` (epoch SECONDS), or null when it never expires. Required so
     * every writer states it: an upsert replaces the stored value, matching DynamoDB PutItem.
     */
    ttl:              EpochSeconds | null
    /**
     * The source version: epoch ms of the DynamoDB item's `updatedAt` as of the read or write this
     * entry reflects. A write never replaces a row that already reflects a newer source version, so
     * a stale read (a backfill page fetched before a live refresh) cannot roll a row back. Omitted
     * or null means unknown: it fills a new or legacy (unversioned) row but never replaces a
     * versioned one.
     */
    sourceUpdatedAt?: number | null
}

/**
 * One row's TTL for {@link VectorIndex.setTtls}: `null` clears it. `sourceUpdatedAt` is the source
 * version the TTL was read at, guarded exactly as for {@link VectorIndexEntry.sourceUpdatedAt}.
 */
export interface VectorTtlUpdate {
    pk:               string
    sk:               string
    ttl:              EpochSeconds | null
    sourceUpdatedAt?: number | null
}

/**
 * A row's identity plus the fields that change whenever it is rewritten. The weekly cross-check
 * (#137) snapshots this and deletes an orphan only if it is still the same generation, so a vector
 * re-indexed after the snapshot survives.
 */
export interface VectorRowSnapshot {
    pk:              string
    sk:              string
    contentHash:     string
    updatedAt:       number
    ttl:             number | null
    /** Advances even when a same-content, same-TTL write only re-stamps the row. */
    sourceUpdatedAt: number | null
}

/**
 * An upsert job: index or re-index a memory item.
 */
export interface IndexerUpsertJob {
    kind:            'upsert'
    layer:           IndexLayer
    /** Sole identity, also used as part of the text fed to the embedder */
    path:            MemoryPath
    /** Memory content, combined with path as `${path}\n${content}` */
    content:         string
    /** The TTL persisted to DynamoDB with this write (undefined = none); required so no writer forgets it. */
    ttl:             EpochSeconds | undefined
    /** Epoch ms of the `updatedAt` persisted with this write: the source version the row will carry. */
    sourceUpdatedAt: number
}

/**
 * A delete job: remove a memory item from the vector index.
 */
export interface IndexerDeleteJob {
    kind:            'delete'
    path:            MemoryPath
    /**
     * The delete's own version marker: epoch ms of `Date.now()` at the moment the underlying
     * DynamoDB delete completed. Unlike {@link IndexerUpsertJob.sourceUpdatedAt} (which reuses the
     * persisted `updatedAt`), a delete carries no persisted version to reuse — this is stamped by
     * the caller instead. Guards {@link VectorIndexEntry.sourceUpdatedAt}-style resurrection: a
     * backfill page read before this delete cannot recreate the row (#134).
     */
    sourceUpdatedAt: number
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
