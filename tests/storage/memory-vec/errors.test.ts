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
    const required = { repo: 'ggml-org/llama.cpp', minimumBuild: 8950, minimumRelease: 'v0.1.0' };

    function makeError(): IncompatibleLlamaCppError {
        return new IncompatibleLlamaCppError({ repo: 'someone/llama.cpp-fork', release: 'b8390' }, required);
    }

    it('is an instance of MemoryVecError', () => {
        expect(makeError()).toBeInstanceOf(MemoryVecError);
    });

    it('has error code INCOMPATIBLE_LLAMA_CPP', () => {
        expect(makeError().code).toBe(ErrorCode.INCOMPATIBLE_LLAMA_CPP);
    });

    it('names the loaded repo and release, the requirement, and both remediations in its message', () => {
        expect(makeError().message).toBe(
            'node-llama-cpp loaded llama.cpp release "b8390" from someone/llama.cpp-fork, '
            + 'which is not known to carry the Qwen3 non-causal embedding fix: '
            + 'need ggml-org/llama.cpp build ≥ b8950 or release ≥ v0.1.0.\n'
            + 'If a llama.cpp source download is overriding the prebuilt binaries, clear it:\n'
            + '  bunx node-llama-cpp source clear\n'
            + 'Otherwise upgrade node-llama-cpp.'
        );
    });

    it('has correct name', () => {
        expect(makeError().name).toBe('IncompatibleLlamaCppError');
    });

    it('preserves the loaded repo and release and the requirement in context', () => {
        expect(makeError().context).toEqual({
            repo:           'someone/llama.cpp-fork',
            release:        'b8390',
            requiredRepo:   'ggml-org/llama.cpp',
            minimumBuild:   8950,
            minimumRelease: 'v0.1.0',
        });
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
