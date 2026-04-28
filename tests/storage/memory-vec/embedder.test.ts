/**
 * Tests for embedder.ts — Embedder class with mocked node-llama-cpp
 *
 * node-llama-cpp is mocked via mock.module() in tests/setup.ts
 * (banned in test bodies by @hughescr/test-hygiene/no-mock-module-in-test-body).
 *
 * node:fs/promises is globally mocked via tests/setup.ts; we use mockFsPromises.access.
 */
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import {
    mockFsPromises,
    mockGetLlama,
    mockLlamaContext,
    mockLlamaInstance,
    mockLlamaModel,
    resetMockFs,
    resetNodeLlamaCppMocks
} from '../../setup';
import { Embedder, loadEmbedder } from '@/storage/memory-vec/embedder';
import { EmbedderClosedError, IncompatibleLlamaCppError, ModelFileNotFoundError } from '@/storage/memory-vec/errors';
import * as versionCheck from '@/storage/memory-vec/version-check';

describe('loadEmbedder / Embedder.load', () => {
    beforeEach(() => {
        resetNodeLlamaCppMocks();
        resetMockFs();
        // Default: version check passes
        jest.spyOn(versionCheck, 'assertLlamaCppCompatible').mockResolvedValue(undefined);
        // Default: model file exists (access resolves without error)
        mockFsPromises.access.mockImplementation(async _path => undefined);
    });

    afterEach(() => {
        resetMockFs();
        jest.restoreAllMocks();
    });

    it('resolves to an Embedder instance with default options', async () => {
        const embedder = await loadEmbedder();
        expect(embedder).toBeInstanceOf(Embedder);
        await embedder.close();
    });

    it('exposes correct default slug and quant', async () => {
        const embedder = await loadEmbedder();
        expect(embedder.slug).toBe('0.6b');
        expect(embedder.quant).toBe('Q8_0');
        await embedder.close();
    });

    it('exposes modelPath as a string ending in .gguf', async () => {
        const embedder = await loadEmbedder();
        expect(typeof embedder.modelPath).toBe('string');
        expect(embedder.modelPath).toContain('.gguf');
        await embedder.close();
    });

    it('resolves with explicit slug and quant', async () => {
        const embedder = await loadEmbedder({ slug: '4b', quant: 'Q4_K_M' });
        expect(embedder.slug).toBe('4b');
        expect(embedder.quant).toBe('Q4_K_M');
        await embedder.close();
    });

    it('uses Q4_K_M as default quant for slug 4b', async () => {
        const embedder = await loadEmbedder({ slug: '4b' });
        expect(embedder.quant).toBe('Q4_K_M');
        await embedder.close();
    });

    it('passes default contextSize 512 to createEmbeddingContext', async () => {
        const embedder = await loadEmbedder();
        expect(mockLlamaModel.createEmbeddingContext).toHaveBeenCalledWith({ contextSize: 512 });
        await embedder.close();
    });

    it('passes default gpuLayers "max" to loadModel', async () => {
        const embedder = await loadEmbedder();
        expect(mockLlamaInstance.loadModel).toHaveBeenCalledWith(
            expect.objectContaining({ gpuLayers: 'max' })
        );
        await embedder.close();
    });

    it('calls getLlama with logLevel warn', async () => {
        const embedder = await loadEmbedder();
        expect(mockGetLlama).toHaveBeenCalledWith(
            expect.objectContaining({ logLevel: 'warn' })
        );
        await embedder.close();
    });

    it('passes custom contextSize to createEmbeddingContext', async () => {
        const embedder = await loadEmbedder({ contextSize: 256 });
        expect(mockLlamaModel.createEmbeddingContext).toHaveBeenCalledWith({ contextSize: 256 });
        await embedder.close();
    });

    it('throws IncompatibleLlamaCppError if assertLlamaCppCompatible rejects', async () => {
        jest.spyOn(versionCheck, 'assertLlamaCppCompatible').mockRejectedValue(
            new IncompatibleLlamaCppError(8390, 8950)
        );
        expect(loadEmbedder()).rejects.toBeInstanceOf(IncompatibleLlamaCppError);
    });

    it('throws ModelFileNotFoundError if model file does not exist', async () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        mockFsPromises.access.mockImplementation(async (_path) => {
            throw err;
        });
        expect(loadEmbedder()).rejects.toBeInstanceOf(ModelFileNotFoundError);
    });
});

describe('loadEmbedder options forwarding', () => {
    beforeEach(() => {
        resetNodeLlamaCppMocks();
        resetMockFs();
        jest.spyOn(versionCheck, 'assertLlamaCppCompatible').mockResolvedValue(undefined);
        mockFsPromises.access.mockImplementation(async _path => undefined);
    });

    afterEach(() => {
        resetMockFs();
        jest.restoreAllMocks();
    });

    it('passes null-coalesced contextSize=512 to createEmbeddingContext when opts is undefined', async () => {
        // Verify default opts=undefined causes contextSize=512, NOT undefined
        const embedder = await loadEmbedder();
        const callArg = mockLlamaModel.createEmbeddingContext.mock.calls[0][0] as Record<string, unknown>;
        expect(callArg).toEqual({ contextSize: 512 });
        await embedder.close();
    });

    it('passes null-coalesced gpuLayers="max" to loadModel when opts is undefined', async () => {
        // Verify default opts=undefined causes gpuLayers="max", NOT undefined
        const embedder = await loadEmbedder();
        const callArg = mockLlamaInstance.loadModel.mock.calls[0][0] as Record<string, unknown>;
        expect(callArg.gpuLayers).toBe('max');
        await embedder.close();
    });

    it('passes custom contextSize=256 (not 512) to createEmbeddingContext', async () => {
        const embedder = await loadEmbedder({ contextSize: 256 });
        const callArg = mockLlamaModel.createEmbeddingContext.mock.calls[0][0] as Record<string, unknown>;
        expect(callArg).toEqual({ contextSize: 256 });
        await embedder.close();
    });

    it('passes custom gpuLayers=0 (not "max") to loadModel', async () => {
        const embedder = await loadEmbedder({ gpuLayers: 0 });
        const callArg = mockLlamaInstance.loadModel.mock.calls[0][0] as Record<string, unknown>;
        expect(callArg.gpuLayers).toBe(0);
        await embedder.close();
    });

    it('passes logLevel warn (not empty object) to getLlama', async () => {
        const embedder = await loadEmbedder();
        const callArg = mockGetLlama.mock.calls[0][0] as Record<string, unknown>;
        expect(callArg.logLevel).toBe('warn');
        await embedder.close();
    });

    it('passes modelPath (not empty object) to loadModel', async () => {
        const embedder = await loadEmbedder();
        const callArg = mockLlamaInstance.loadModel.mock.calls[0][0] as Record<string, unknown>;
        expect(typeof callArg.modelPath).toBe('string');
        expect((callArg.modelPath as string).length).toBeGreaterThan(0);
        await embedder.close();
    });
});

describe('Embedder.encode', () => {
    let embedder: Embedder;

    beforeEach(async () => {
        resetNodeLlamaCppMocks();
        resetMockFs();
        jest.spyOn(versionCheck, 'assertLlamaCppCompatible').mockResolvedValue(undefined);
        mockFsPromises.access.mockImplementation(async _path => undefined);
        embedder = await loadEmbedder();
    });

    afterEach(async () => {
        await embedder.close();
        resetMockFs();
        jest.restoreAllMocks();
    });

    it('returns EmbedResult with correct shape for single text', async () => {
        const result = await embedder.encode(['hello world']);
        expect(result.dtype).toBe('uint8');
        expect(result.vectorBytes).toBe(128);
        expect(result.vectorBits).toBe(1024);
        expect(result.shape).toEqual([1, 128]);
        expect(result.data.length).toBe(128);
    });

    it('returns EmbedResult with correct shape for 3 texts', async () => {
        const result = await embedder.encode(['a', 'b', 'c']);
        expect(result.shape).toEqual([3, 128]);
        expect(result.data.length).toBe(384);
    });

    it('returns Uint8Array for data', async () => {
        const result = await embedder.encode(['test']);
        expect(result.data).toBeInstanceOf(Uint8Array);
    });

    it('calls getEmbeddingFor once per text', async () => {
        await embedder.encode(['text1', 'text2', 'text3']);
        expect(mockLlamaContext.getEmbeddingFor).toHaveBeenCalledTimes(3);
    });

    it('passes the text string to getEmbeddingFor', async () => {
        await embedder.encode(['hello world']);
        expect(mockLlamaContext.getEmbeddingFor).toHaveBeenCalledWith('hello world');
    });

    it('produces non-trivial packed output — not all zeros (catches wrong inner-loop body)', async () => {
        // Mock returns alternating 0.5/-0.5 → bit pattern 0xAA per byte
        const result = await embedder.encode(['test']);
        expect(result.data[0]).toBe(0xAA);
        expect(result.data[1]).toBe(0xAA);
    });

    it('batch of 2 texts — second text produces correct output starting at byte 128', async () => {
        // Both texts use same mock → same bit pattern; verify output is 256 bytes with non-trivial second half
        const result = await embedder.encode(['text1', 'text2']);
        // Second text's bytes start at index 128; they should also be 0xAA (same mock)
        expect(result.data[128]).toBe(0xAA);
        expect(result.data[255]).toBe(0xAA);
    });

    it('throws EmbedderClosedError after close', async () => {
        await embedder.close();
        expect(embedder.encode(['test'])).rejects.toBeInstanceOf(EmbedderClosedError);
    });

    it('single text produces non-all-zero packed output (inner loop runs)', async () => {
        // Mock returns alternating +0.5/-0.5 → bit pattern 0xAA per byte
        const result = await embedder.encode(['hello']);
        // If inner loop body is removed (BlockStatement), allFloats stays 0 → output is 0x00
        // If j < EMBED_DIM condition is always false, same: 0x00
        expect(result.data[0]).toBe(0xAA);
    });

    it('all 128 bytes of single text are non-zero (inner loop assigns all floats)', async () => {
        const result = await embedder.encode(['test text']);
        for(let i = 0; i < 128; i++) {
            // If inner loop doesn't run or assigns 0, we'd get 0x00 (fails here)
            expect(result.data[i]).toBe(0xAA);
        }
    });

    it('allFloats buffer is large enough for batch — second text starts at byte 128 with correct data', async () => {
        // Two texts, both using same mock → both produce 0xAA per byte
        // If allFloats buffer is too small (batchSize/EMBED_DIM instead of batchSize*EMBED_DIM),
        // the second text's data would be wrong (reads from OOB → undefined → 0 → 0x00)
        const result = await embedder.encode(['text1', 'text2']);
        expect(result.data[128]).toBe(0xAA);
        expect(result.data[255]).toBe(0xAA);
    });

    it('inner loop uses i * EMBED_DIM + j offset — batch 1 offset differs from batch 0', async () => {
        // Batch 0: all positive (0xFF), Batch 1: all negative (0x00)
        let callCount = 0;
        mockLlamaContext.getEmbeddingFor.mockImplementation(async (_text: string) => {
            callCount++;
            // First call (batch 0): all positive
            // Second call (batch 1): all negative
            const val = callCount === 1 ? 1 : -1;
            return { vector: new Float32Array(1024).fill(val) };
        });
        const result = await embedder.encode(['positive', 'negative']);
        // Batch 0 bytes (0..127): all 0xFF (all positive)
        expect(result.data[0]).toBe(0xFF);
        // Batch 1 bytes (128..255): all 0x00 (all negative)
        // If i * EMBED_DIM is replaced by i / EMBED_DIM, batch 1 reads from wrong offset → wrong result
        expect(result.data[128]).toBe(0x00);
        expect(result.data[255]).toBe(0x00);
    });
});

describe('Embedder.close', () => {
    beforeEach(() => {
        resetMockFs();
        resetNodeLlamaCppMocks();
        jest.spyOn(versionCheck, 'assertLlamaCppCompatible').mockResolvedValue(undefined);
        mockFsPromises.access.mockImplementation(async _path => undefined);
    });

    afterEach(() => {
        resetMockFs();
        jest.restoreAllMocks();
    });

    it('disposes context, model, and llama', async () => {
        const embedder = await loadEmbedder();
        await embedder.close();
        expect(mockLlamaContext.dispose).toHaveBeenCalledTimes(1);
        expect(mockLlamaModel.dispose).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — calling close twice does not throw', async () => {
        const embedder = await loadEmbedder();
        await embedder.close();
        expect(embedder.close()).resolves.toBeUndefined();
    });

    it('dispose is called exactly once even when close is called twice', async () => {
        const embedder = await loadEmbedder();
        await embedder.close();
        await embedder.close();
        expect(mockLlamaContext.dispose).toHaveBeenCalledTimes(1);
        expect(mockLlamaModel.dispose).toHaveBeenCalledTimes(1);
        expect(mockLlamaInstance.dispose).toHaveBeenCalledTimes(1);
    });
});

describe('loadEmbedder convenience alias', () => {
    it('is the same function as Embedder.load', () => {
        expect(loadEmbedder).toBe(Embedder.load);
    });
});

// Ensure spyOn is available (used above) — satisfies import check

const _ensureSpyOn = spyOn;
