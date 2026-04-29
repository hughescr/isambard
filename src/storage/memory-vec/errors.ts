/**
 * Error hierarchy for the memory-vec embedding library.
 *
 * All errors extend MemoryVecError which extends IsambardError.
 */
import type { ModelQuant, ModelSlug } from './types.js';
import { ErrorCode, IsambardError } from '@/errors';

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
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
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
            // Stryker disable next-line ObjectLiteral: context bag is debug-only — mutation to {} doesn't affect throw behavior
            { modelPath, slug, quant }
        );
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
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
        // Stryker disable ConditionalExpression,StringLiteral: cosmetic message text — checked via message.toContain('unknown') / message.toContain('b8390'); remediation instructions don't affect throw behavior
        const currentDesc = currentBuild === null ? 'unknown (version file missing)' : `b${currentBuild}`;
        const message = `Bundled llama.cpp is incompatible: found ${currentDesc}, need ≥ b${minimumBuild}.\n`
          + 'Run a source build to fix:\n'
          + '  bunx node-llama-cpp source download --release b8953\n'
          + '  bunx node-llama-cpp source build';
        // Stryker restore ConditionalExpression,StringLiteral
        super(
            message,
            ErrorCode.INCOMPATIBLE_LLAMA_CPP,
            // Stryker disable next-line ObjectLiteral: context bag is debug-only — mutation to {} doesn't affect throw behavior
            { currentBuild, minimumBuild }
        );
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
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
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
        this.name = 'EmbedderClosedError';
    }
}
