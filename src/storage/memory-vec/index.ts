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
 * NOTE: Requires a source-built node-llama-cpp binary (≥ b8950):
 *   bunx node-llama-cpp source download --release b8953
 *   bunx node-llama-cpp source build
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
} from './errors.js';

// Path utility — so callers know where the GGUF should be placed
export { ggufPath } from './paths.js';
