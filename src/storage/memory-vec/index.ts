/**
 * memory-vec — production embedding library using node-llama-cpp.
 *
 * Produces 1024-bit packed binary embeddings from text using pplx-embed-v1 models.
 *
 * Quick start:
 *   const embedder = await loadEmbedder();
 *   const result = await embedder.encode(['hello world']);
 *   await embedder.close();
 *
 * NOTE: Requires llama.cpp ≥ b8950 (Qwen3 non-causal embedding fix). node-llama-cpp's
 * prebuilt binaries satisfy this; loadEmbedder() rejects an older loaded release, or
 * one from a repo other than ggml-org/llama.cpp.
 */

// Core API
export { Embedder, loadEmbedder } from './embedder.js';

// Types
export type { EmbedderOptions, EmbedResult, ModelQuant, ModelSlug } from './types.js';

// Error classes — callers can catch specifically
export {
    EmbedderClosedError,
    IncompatibleLlamaCppError,
    MemoryVecError,
    ModelFileNotFoundError
} from '@/errors';

// Path utility — so callers know where the GGUF should be placed
export { ggufPath } from './paths.js';
