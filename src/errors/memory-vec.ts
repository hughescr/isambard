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

/** The llama.cpp repo and release node-llama-cpp reports it loaded (`llama.llamaCppRelease`). */
interface LoadedLlamaCppRelease {
    repo:    string
    release: string
}

/** The upstream repo and the oldest build tag and semver release known to carry the fix. */
interface RequiredLlamaCppRelease {
    repo:           string
    minimumBuild:   number
    minimumRelease: string
}

/**
 * Error thrown when the llama.cpp release node-llama-cpp loaded is not known to
 * support Qwen3 non-causal embedding correctly: it comes from a repo other than
 * upstream llama.cpp, or predates the fix (requires ≥ b8950 or ≥ v0.1.0).
 *
 * Remediation: node-llama-cpp's own prebuilt binaries are new enough, so clear
 * any llama.cpp source download that overrides them, or upgrade node-llama-cpp:
 *   bunx node-llama-cpp source clear
 */
export class IncompatibleLlamaCppError extends MemoryVecError {
    declare public readonly context: {
        repo:           string
        release:        string
        requiredRepo:   string
        minimumBuild:   number
        minimumRelease: string
    };

    constructor(loaded: LoadedLlamaCppRelease, required: RequiredLlamaCppRelease) {
        const message = `node-llama-cpp loaded llama.cpp release "${loaded.release}" from ${loaded.repo}, `
          + 'which is not known to carry the Qwen3 non-causal embedding fix: '
          + `need ${required.repo} build ≥ b${required.minimumBuild} or release ≥ ${required.minimumRelease}.\n`
          + 'If a llama.cpp source download is overriding the prebuilt binaries, clear it:\n'
          + '  bunx node-llama-cpp source clear\n'
          + 'Otherwise upgrade node-llama-cpp.';
        super(
            message,
            ErrorCode.INCOMPATIBLE_LLAMA_CPP,
            {
                repo:           loaded.repo,
                release:        loaded.release,
                requiredRepo:   required.repo,
                minimumBuild:   required.minimumBuild,
                minimumRelease: required.minimumRelease,
            }
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
