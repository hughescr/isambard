/**
 * Types for the memory-vec embedding library.
 *
 * Wraps node-llama-cpp to produce 1024-bit packed binary embeddings
 * from text using pplx-embed-v1 models.
 */

/**
 * Available model size slugs.
 * - '0.6b': 610 MB Q8_0, ~34ms/text, parity 0.999 — DEFAULT
 * - '4b':   best at Q4_K_M (2.4 GB), ~187ms/text, parity 0.992
 */
export type ModelSlug = '0.6b' | '4b';

/**
 * Available quantization formats.
 * Only formats that passed parity testing are included:
 * - Q8_0:   high quality, larger file — default for 0.6b
 * - Q4_K_M: smaller, still high quality — candidate for 4b
 *
 * Formats that failed parity (IQ4_NL, IQ4_XS, Q4_K_M at 0.6b) are excluded.
 */
export type ModelQuant = 'Q8_0' | 'Q4_K_M';

/**
 * Options for creating an Embedder instance.
 */
export interface EmbedderOptions {
    /** Model size slug. Default: '0.6b' */
    slug?: ModelSlug

    /**
     * Quantization format. Default: 'Q8_0' for 0.6b; 'Q4_K_M' for 4b.
     * Must be specified explicitly if slug is '4b' to pick the right GGUF.
     */
    quant?: ModelQuant

    /**
     * Context window size in tokens. Default: 512.
     * Bidirectional Qwen3 supports up to 32768, but larger values cost more RAM.
     */
    contextSize?: number

    /**
     * Number of GPU layers to offload. Default: 'max' (full Metal offload).
     * Set to 0 to run on CPU only.
     */
    gpuLayers?: number | 'max'
}

/**
 * Result of an embedding operation.
 * Contains packed binary data (sign-bit quantized from float32).
 */
export interface EmbedResult {
    /**
     * Packed binary data as Uint8Array.
     * Layout: [batch_0_bytes, batch_1_bytes, ...] where each batch is 128 bytes.
     * Total length = batch * 128.
     */
    data: Uint8Array

    /**
     * Shape of the result: [batch_size, bytes_per_vector].
     * bytes_per_vector is always 128 (= 1024 bits / 8).
     */
    shape: readonly [number, number]

    /** Data type of the packed bytes. Always 'uint8'. */
    dtype: 'uint8'

    /** Bytes per vector. Always 128. */
    vectorBytes: 128

    /** Bits per vector. Always 1024. */
    vectorBits: 1024
}
