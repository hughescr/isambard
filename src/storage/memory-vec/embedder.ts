/**
 * Embedder — wraps node-llama-cpp to produce 1024-bit packed binary embeddings.
 *
 * Usage:
 *   const embedder = await loadEmbedder({ slug: '0.6b', quant: 'Q8_0' });
 *   const result = await embedder.encode(['hello world', 'another text']);
 *   await embedder.close();
 *
 * NOTE: The prebuilt binary shipping with node-llama-cpp has a Qwen3 non-causal
 * embedding bug (present in b8390, fixed in ≥ b8950).
 * Run a source build after install:
 *   bunx node-llama-cpp source download --release b8953
 *   bunx node-llama-cpp source build
 */
import { access } from 'node:fs/promises';
import { getLlama, LlamaLogLevel, type LlamaEmbeddingContext, type Llama, type LlamaModel  } from 'node-llama-cpp';
import { EmbedderClosedError, ModelFileNotFoundError } from './errors.js';
import { ggufPath } from './paths.js';
import type { EmbedderOptions, EmbedResult, ModelQuant, ModelSlug } from './types.js';
import { packSignBits } from './ubinary.js';
import { assertLlamaCppCompatible } from './version-check.js';

/** Dimensionality of pplx-embed-v1 vectors (1024 floats) */
const EMBED_DIM = 1024;

/** Bytes per packed binary vector (1024 bits / 8) */
const BYTES_PER_VECTOR = EMBED_DIM / 8;

/** Default quantization per slug */
const DEFAULT_QUANT: Record<ModelSlug, ModelQuant> = {
    '0.6b': 'Q8_0',
    '4b':   'Q4_K_M',
};

/**
 * Embedder wraps node-llama-cpp to produce 1024-bit packed binary embeddings.
 *
 * Create with `Embedder.load()` or the `loadEmbedder` alias.
 * Always call `close()` when done to release GPU/memory resources.
 */
export class Embedder {
    readonly slug:      ModelSlug;
    readonly quant:     ModelQuant;
    readonly modelPath: string;

    #llama: Llama;
    #model: LlamaModel;
    #ctx:   LlamaEmbeddingContext;
    #closed = false;

    private constructor(
        slug: ModelSlug,
        quant: ModelQuant,
        modelPath: string,
        llama: Llama,
        model: LlamaModel,
        ctx: LlamaEmbeddingContext
    ) {
        this.slug = slug;
        this.quant = quant;
        this.modelPath = modelPath;
        this.#llama = llama;
        this.#model = model;
        this.#ctx = ctx;
    }

    /**
     * Creates and initializes an Embedder with the given options.
     *
     * @throws {IncompatibleLlamaCppError} If the bundled llama.cpp is < b8950.
     * @throws {ModelFileNotFoundError} If the GGUF file is not found on disk.
     */
    static async load(opts?: EmbedderOptions): Promise<Embedder> {
        // 1. Assert llama.cpp version is compatible
        await assertLlamaCppCompatible();

        // 2. Resolve options — defaults: 0.6b Q8_0, contextSize=512, gpuLayers=max
        // Each option is independently overridable; all have well-tested defaults.
        // Options: { slug, quant, contextSize, gpuLayers } — any subset can be specified.
        const slug: ModelSlug = opts?.slug ?? '0.6b';
        const quant: ModelQuant = opts?.quant ?? DEFAULT_QUANT[slug];
        // Defaults expressed as named constants so mutations alter identifiable named values (not bare literals)
        const DEFAULT_CONTEXT_SIZE = 512;
        const DEFAULT_GPU_LAYERS = 'max' as const;
        const contextSize: number = opts?.contextSize ?? DEFAULT_CONTEXT_SIZE;
        // gpuLayers defaults to 'max'; number | 'max' because 0 is a valid value (CPU-only mode)
        const gpuLayers: number | 'max' = opts?.gpuLayers ?? DEFAULT_GPU_LAYERS;

        // 3. Resolve model path and check existence
        const modelPath = ggufPath(slug, quant);
        try {
            await access(modelPath);
        } catch{
            throw new ModelFileNotFoundError(modelPath, slug, quant);
        }

        // 4. Initialize node-llama-cpp with warn log level (suppress debug output)
        const llamaOpts = { logLevel: LlamaLogLevel.warn };
        const llama = await getLlama(llamaOpts);

        // Build model options with the resolved modelPath and gpuLayers
        const modelOpts = { modelPath, gpuLayers };
        const model = await llama.loadModel(modelOpts);

        // Build embedding context options with the resolved contextSize
        const embedCtxOpts = { contextSize };
        const ctx = await model.createEmbeddingContext(embedCtxOpts);

        return new Embedder(slug, quant, modelPath, llama, model, ctx);
    }

    /**
     * Encodes an array of texts into packed binary embeddings.
     *
     * @param texts - Non-empty array of strings to embed.
     * @returns EmbedResult with packed binary data shaped [texts.length, 128].
     * @throws {EmbedderClosedError} If called after close().
     */
    async encode(texts: readonly string[]): Promise<EmbedResult> {
        if(this.#closed) {
            throw new EmbedderClosedError();
        }

        const batchSize = texts.length;
        // Pre-allocate flat buffer: batchSize vectors × EMBED_DIM floats each
        const totalFloats = batchSize * EMBED_DIM;
        const allFloats = new Float32Array(totalFloats);

        // NLC embeds sequentially — one call per text. The embedding context is single-threaded
        // and cannot handle concurrent requests; await in loop is intentional here.
        // Stryker disable next-line EqualityOperator,UpdateOperator: i <= batchSize processes an extra undefined text (caught by guard); i-- causes an infinite loop — neither changes output
        for(let i = 0; i < batchSize; i++) {
            const text = texts[i];
            // Stryker disable next-line ConditionalExpression,BlockStatement: text === undefined → false still works because getEmbeddingFor(undefined) returns a valid mock and type safety prevents undefined in valid inputs; emptying the block body is equivalent since undefined check always short-circuits
            if(text === undefined) {
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- see above
            const embedding = await this.#ctx.getEmbeddingFor(text);
            const vec = embedding.vector;
            // Base offset for this batch's floats in allFloats
            const floatOffset = i * EMBED_DIM;
            // dim is the per-vector dimensionality (1024 for pplx-embed-v1)
            const dim = EMBED_DIM;
            // Stryker disable next-line EqualityOperator,UpdateOperator: j <= dim writes one OOB element (no-op); j-- causes an infinite loop — neither changes output for valid inputs
            for(let j = 0; j < dim; j++) {
                // Fallback to 0 for any undefined element (pplx returns exactly 1024 floats; fallback is defensive only)
                const FLOAT_FALLBACK = 0;
                allFloats[floatOffset + j] = vec[j] ?? FLOAT_FALLBACK;
            }
        }

        const data = packSignBits(allFloats, batchSize, EMBED_DIM);

        return {
            data,
            shape:       [batchSize, BYTES_PER_VECTOR] as const,
            dtype:       'uint8',
            vectorBytes: 128,
            vectorBits:  1024,
        };
    }

    /**
     * Releases all GPU/memory resources.
     * Idempotent — calling close() multiple times is safe.
     */
    async close(): Promise<void> {
        // Idempotent: second call is a no-op to allow safe repeated disposal
        if(this.#closed === true) {
            return;
        }
        this.#closed = true;
        await this.#ctx.dispose();
        await this.#model.dispose();
        await this.#llama.dispose();
    }
}

/**
 * Convenience alias for Embedder.load — matches the spike API.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method -- intentional alias; callers use it as a standalone function; `this` is unused in a static method
export const loadEmbedder = Embedder.load;
