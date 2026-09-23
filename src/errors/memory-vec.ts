/**
 * Error hierarchy for the memory-vec embedding library.
 *
 * All errors extend MemoryVecError which extends IsambardError.
 */
import { IsambardError } from './base';
import { ErrorCode } from './codes';

/** @see ModelSlug in src/storage/memory-vec/types.ts */
type ModelSlug = '0.6b' | '4b';

/** @see ModelQuant in src/storage/memory-vec/types.ts */
type ModelQuant = 'Q8_0' | 'Q4_K_M';

/**
 * Base error class for all memory-vec errors.
 */
export class MemoryVecError extends IsambardError {
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.MEMORY_VEC_ERROR,
        context?: Record<string, unknown>
    ) {
        super(message, code, context);
        this.name = 'MemoryVecError';
    }
}

/**
 * Error thrown when the GGUF model file is not found on disk.
 * The user must run the generate script to build the GGUF first.
 */
export class ModelFileNotFoundError extends MemoryVecError {
    declare public readonly context: { modelPath: string, slug: ModelSlug, quant: ModelQuant };

    constructor(modelPath: string, slug: ModelSlug, quant: ModelQuant) {
        super(
            `Model file not found: ${modelPath}\n`
            + `Run \`tools/generate-embedding-gguf.sh ${slug} ${quant}\` to generate it.`,
            ErrorCode.MODEL_FILE_NOT_FOUND,
            { modelPath, slug, quant }
        );
        this.name = 'ModelFileNotFoundError';
    }
}

/**
 * Error thrown when the bundled llama.cpp is too old to support
 * Qwen3 non-causal embedding correctly (requires ≥ b8950).
 *
 * Remediation: rebuild node-llama-cpp from llama.cpp source:
 *   bunx node-llama-cpp source download --release b8953
 *   bunx node-llama-cpp source build
 */
export class IncompatibleLlamaCppError extends MemoryVecError {
    declare public readonly context: { currentBuild: number | null, minimumBuild: number };

    constructor(currentBuild: number | null, minimumBuild: number) {
        const currentDesc = currentBuild === null ? 'unknown (version file missing)' : `b${currentBuild}`;
        const message = `Bundled llama.cpp is incompatible: found ${currentDesc}, need ≥ b${minimumBuild}.\n`
          + 'Run a source build to fix:\n'
          + '  bunx node-llama-cpp source download --release b8953\n'
          + '  bunx node-llama-cpp source build';
        super(
            message,
            ErrorCode.INCOMPATIBLE_LLAMA_CPP,
            { currentBuild, minimumBuild }
        );
        this.name = 'IncompatibleLlamaCppError';
    }
}

/**
 * Error thrown when encode() is called after close().
 */
export class EmbedderClosedError extends MemoryVecError {
    constructor() {
        super(
            'Embedder has been closed. Create a new Embedder with loadEmbedder().',
            ErrorCode.EMBEDDER_CLOSED
        );
        this.name = 'EmbedderClosedError';
    }
}
