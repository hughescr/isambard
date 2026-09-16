/**
 * Tests for version-check.ts — bundled llama.cpp version validation
 *
 * node:fs/promises is globally mocked via tests/setup.ts mock.module().
 * We use mockFsPromises.readFile directly and call resetMockFs() in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mockFsPromises, resetMockFs } from '../../setup';
import { IncompatibleLlamaCppError } from '@/storage/memory-vec/errors';
import { assertLlamaCppCompatible, getBundledLlamaCppVersion } from '@/storage/memory-vec/version-check';

describe('getBundledLlamaCppVersion', () => {
    afterEach(() => {
        resetMockFs();
    });

    it('rejects a build tag too large to represent exactly', async () => {
        mockFsPromises.readFile.mockImplementation(async () => JSON.stringify({ tag: 'b9007199254740993' }));
        expect(await getBundledLlamaCppVersion()).toBeNull();
    });

    it('parses a valid info file and returns build number and tag', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag: 'b8953', llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        const result = await getBundledLlamaCppVersion();
        expect(result).not.toBeNull();
        expect(result?.build).toBe(8953);
        expect(result?.releaseTag).toBe('b8953');
        expect(mockFsPromises.readFile.mock.calls[0]?.[0]).toBe(`${process.cwd()}/node_modules/node-llama-cpp/llama/llama.cpp.info.json`);
    });

    it('parses build number 8950 correctly', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag: 'b8950', llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        const result = await getBundledLlamaCppVersion();
        expect(result?.build).toBe(8950);
    });

    it('returns null when the file does not exist', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) => {
            const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
        });
        const result = await getBundledLlamaCppVersion();
        expect(result).toBeNull();
    });

    it.each([
        { label: 'JSON is malformed', raw: 'not-valid-json' },
        { label: 'JSON is a primitive (null JSON value)', raw: 'null' },
        { label: 'JSON is a number (not an object)', raw: '42' },
    ])('returns null when $label', async ({ raw }) => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) => raw);
        const result = await getBundledLlamaCppVersion();
        expect(result).toBeNull();
    });

    it('returns null when tag field is missing', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        const result = await getBundledLlamaCppVersion();
        expect(result).toBeNull();
    });

    it.each([
        { label: 'tag does not match expected format', tag: 'not-a-build-tag' },
        { label: 'tag has no leading b prefix (e.g. "8953")', tag: '8953' },
        { label: 'tag has trailing extra chars (e.g. "b8953extra")', tag: 'b8953extra' },
        { label: 'tag has leading extra chars (e.g. "xb8953")', tag: 'xb8953' },
    ])('returns null when $label', async ({ tag }) => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag, llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        const result = await getBundledLlamaCppVersion();
        expect(result).toBeNull();
    });
});

describe('assertLlamaCppCompatible', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    afterEach(() => {
        resetMockFs();
        jest.restoreAllMocks();
    });

    it('does not throw when build is exactly 8950', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag: 'b8950', llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        await expect(assertLlamaCppCompatible()).resolves.toBeUndefined();
    });

    it('throws when build is one below the supported minimum', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag: 'b8949', llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        await expect(assertLlamaCppCompatible()).rejects.toBeInstanceOf(IncompatibleLlamaCppError);
    });

    it('does not throw when build is above 8950', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag: 'b8953', llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        await expect(assertLlamaCppCompatible()).resolves.toBeUndefined();
    });

    it('throws IncompatibleLlamaCppError when build is below 8950', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag: 'b8390', llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        await expect(assertLlamaCppCompatible()).rejects.toBeInstanceOf(IncompatibleLlamaCppError);
    });

    it('throws IncompatibleLlamaCppError when version file is missing', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
        });
        await expect(assertLlamaCppCompatible()).rejects.toBeInstanceOf(IncompatibleLlamaCppError);
    });

    it('error message includes remediation command when build is too old', async () => {
        mockFsPromises.readFile.mockImplementation(async (_path, _opts) =>
            JSON.stringify({ tag: 'b8390', llamaCppGithubRepo: 'ggml-org/llama.cpp' })
        );
        let err: unknown;
        try {
            await assertLlamaCppCompatible();
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(IncompatibleLlamaCppError);
        if(err instanceof Error) {
            expect(err.message).toContain('source build');
        }
    });
});
