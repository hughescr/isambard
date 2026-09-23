/**
 * Tests for @/errors/memory-vec.ts — MemoryVecError hierarchy
 */
import { describe, expect, it } from 'bun:test';
import {
    EmbedderClosedError,
    IncompatibleLlamaCppError,
    MemoryVecError,
    ModelFileNotFoundError
} from '@/errors';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';

describe('MemoryVecError', () => {
    it('is an instance of IsambardError', () => {
        const err = new MemoryVecError('test error', ErrorCode.MEMORY_VEC_ERROR);
        expect(err).toBeInstanceOf(IsambardError);
    });

    it('is an instance of Error', () => {
        const err = new MemoryVecError('test error', ErrorCode.MEMORY_VEC_ERROR);
        expect(err).toBeInstanceOf(Error);
    });

    it('has the correct name', () => {
        const err = new MemoryVecError('test error', ErrorCode.MEMORY_VEC_ERROR);
        expect(err.name).toBe('MemoryVecError');
    });

    it('has the provided message', () => {
        const err = new MemoryVecError('my message', ErrorCode.MEMORY_VEC_ERROR);
        expect(err.message).toBe('my message');
    });

    it('has the provided error code', () => {
        const err = new MemoryVecError('test', ErrorCode.MEMORY_VEC_ERROR);
        expect(err.code).toBe(ErrorCode.MEMORY_VEC_ERROR);
    });
});

describe('ModelFileNotFoundError', () => {
    it('is an instance of MemoryVecError', () => {
        const err = new ModelFileNotFoundError('/path/to/model.gguf', '0.6b', 'Q8_0');
        expect(err).toBeInstanceOf(MemoryVecError);
    });

    it('is an instance of IsambardError', () => {
        const err = new ModelFileNotFoundError('/path/to/model.gguf', '0.6b', 'Q8_0');
        expect(err).toBeInstanceOf(IsambardError);
    });

    it('has error code MODEL_FILE_NOT_FOUND', () => {
        const err = new ModelFileNotFoundError('/path/to/model.gguf', '0.6b', 'Q8_0');
        expect(err.code).toBe(ErrorCode.MODEL_FILE_NOT_FOUND);
    });

    it('includes the path in the message', () => {
        const err = new ModelFileNotFoundError('/path/to/model.gguf', '0.6b', 'Q8_0');
        expect(err.message).toContain('/path/to/model.gguf');
    });

    it('includes generation command hint in message', () => {
        const err = new ModelFileNotFoundError('/path/to/model.gguf', '0.6b', 'Q8_0');
        expect(err.message).toContain('generate-embedding-gguf.sh');
    });

    it('has correct name', () => {
        const err = new ModelFileNotFoundError('/path/to/model.gguf', '0.6b', 'Q8_0');
        expect(err.name).toBe('ModelFileNotFoundError');
    });

    it('includes context with path, slug, and quant', () => {
        const err = new ModelFileNotFoundError('/path/to/model.gguf', '0.6b', 'Q8_0');
        expect(err.context).toBeDefined();
        expect((err.context as Record<string, unknown>).modelPath).toBe('/path/to/model.gguf');
        expect((err.context as Record<string, unknown>).slug).toBe('0.6b');
        expect((err.context as Record<string, unknown>).quant).toBe('Q8_0');
    });
});

describe('IncompatibleLlamaCppError', () => {
    it('is an instance of MemoryVecError', () => {
        const err = new IncompatibleLlamaCppError(8390, 8950);
        expect(err).toBeInstanceOf(MemoryVecError);
    });

    it('has error code INCOMPATIBLE_LLAMA_CPP', () => {
        const err = new IncompatibleLlamaCppError(8390, 8950);
        expect(err.code).toBe(ErrorCode.INCOMPATIBLE_LLAMA_CPP);
    });

    it.each([
        ['current build', '8390'],
        ['minimum build', '8950'],
        ['source build command hint', 'source build'],
        ['"Run a source build to fix" remediation line', 'Run a source build to fix'],
        ['node-llama-cpp source download command', 'source download'],
        // 'bunx node-llama-cpp source build' is the final line — unique because it has no trailing \n
        ['bunx node-llama-cpp source build (final step)', 'bunx node-llama-cpp source build']
    ])('includes %s in message', (_description, expected) => {
        const err = new IncompatibleLlamaCppError(8390, 8950);
        expect(err.message).toContain(expected);
    });

    it('has correct name', () => {
        const err = new IncompatibleLlamaCppError(8390, 8950);
        expect(err.name).toBe('IncompatibleLlamaCppError');
    });

    it('also works when current build is null (version file missing)', () => {
        const err = new IncompatibleLlamaCppError(null, 8950);
        expect(err).toBeInstanceOf(IncompatibleLlamaCppError);
        expect(err.message).toContain('8950');
        expect(err.message).toContain('unknown (version file missing)');
        expect(err.context).toEqual({ currentBuild: null, minimumBuild: 8950 });
    });

    it('preserves current and minimum build numbers in context', () => {
        const err = new IncompatibleLlamaCppError(8390, 8950);
        expect(err.context).toEqual({ currentBuild: 8390, minimumBuild: 8950 });
    });
});

describe('EmbedderClosedError', () => {
    it('is an instance of MemoryVecError', () => {
        const err = new EmbedderClosedError();
        expect(err).toBeInstanceOf(MemoryVecError);
    });

    it('has error code EMBEDDER_CLOSED', () => {
        const err = new EmbedderClosedError();
        expect(err.code).toBe(ErrorCode.EMBEDDER_CLOSED);
    });

    it('has correct name', () => {
        const err = new EmbedderClosedError();
        expect(err.name).toBe('EmbedderClosedError');
    });

    it('has a descriptive message', () => {
        const err = new EmbedderClosedError();
        expect(err.message.length).toBeGreaterThan(0);
    });

    it('message contains "Embedder" to describe what was closed', () => {
        const err = new EmbedderClosedError();
        expect(err.message).toContain('Embedder');
    });

    it('message contains "closed"', () => {
        const err = new EmbedderClosedError();
        expect(err.message.toLowerCase()).toContain('closed');
    });
});
