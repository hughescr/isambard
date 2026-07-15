/**
 * Tests for paths.ts — cache-dir resolution + GGUF filename construction
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import path from 'node:path';
import { cacheDir, ggufFilename, ggufPath } from '@/storage/memory-vec/paths';

describe('cacheDir', () => {
    // Stub process.platform directly (writable data property) rather than mock.module, matching
    // the established pattern in tests/unit/agent/browser/webview-adapter.test.ts. This lets both
    // the darwin and non-darwin branches run deterministically on any host OS, so CI on
    // ubuntu-latest actually exercises (and can kill mutants in) the darwin branch, and macOS runs
    // actually exercise the Linux/XDG branch — neither was true before this change.
    let realPlatform: string;

    beforeEach(() => {
        realPlatform = process.platform;
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: realPlatform, writable: true });
    });

    it('returns path inside homedir', () => {
        const result = cacheDir();
        expect(result.startsWith(homedir())).toBe(true);
    });

    it('contains the llama.cpp segment', () => {
        const result = cacheDir();
        expect(result).toContain('llama.cpp');
    });

    describe('on darwin', () => {
        beforeEach(() => {
            Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
        });

        it('returns the Library/Caches/llama.cpp path', () => {
            const result = cacheDir();
            const expected = path.join(homedir(), 'Library', 'Caches', 'llama.cpp');
            expect(result).toBe(expected);
        });

        it('path has Library before Caches before llama.cpp', () => {
            const result = cacheDir();
            const libIdx = result.indexOf('Library');
            const cachesIdx = result.indexOf('Caches');
            const llamaIdx = result.indexOf('llama.cpp');
            expect(libIdx).toBeLessThan(cachesIdx);
            expect(cachesIdx).toBeLessThan(llamaIdx);
        });
    });

    describe('on linux', () => {
        let originalXdgCacheHome: string | undefined;

        beforeEach(() => {
            Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
            originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        });

        afterEach(() => {
            if(originalXdgCacheHome === undefined) {
                delete process.env.XDG_CACHE_HOME;
            } else {
                process.env.XDG_CACHE_HOME = originalXdgCacheHome;
            }
        });

        it('falls back to ~/.cache/llama.cpp when XDG_CACHE_HOME is unset', () => {
            delete process.env.XDG_CACHE_HOME;
            const result = cacheDir();
            const expected = path.join(homedir(), '.cache', 'llama.cpp');
            expect(result).toBe(expected);
        });

        it('uses XDG_CACHE_HOME when set', () => {
            process.env.XDG_CACHE_HOME = '/custom/xdg-cache';
            const result = cacheDir();
            expect(result).toBe(path.join('/custom/xdg-cache', 'llama.cpp'));
        });
    });
});

describe('ggufFilename', () => {
    it('produces canonical filename for 0.6b Q8_0', () => {
        const result = ggufFilename('0.6b', 'Q8_0');
        expect(result).toBe('local_pplx-embed-v1-0.6b_q8_0-noncausal.gguf');
    });

    it('produces canonical filename for 4b Q4_K_M', () => {
        const result = ggufFilename('4b', 'Q4_K_M');
        expect(result).toBe('local_pplx-embed-v1-4b_q4_k_m-noncausal.gguf');
    });

    it('lowercases the quant in the filename', () => {
        const result = ggufFilename('0.6b', 'Q8_0');
        expect(result).toMatch(/q8_0/);
        expect(result).not.toMatch(/Q8_0/);
    });

    it('uses lowercase Q4_K_M for 4b model', () => {
        const result = ggufFilename('4b', 'Q4_K_M');
        expect(result).toMatch(/q4_k_m/);
        expect(result).not.toMatch(/Q4_K_M/);
    });

    it('includes the slug in the filename', () => {
        expect(ggufFilename('0.6b', 'Q8_0')).toContain('0.6b');
        expect(ggufFilename('4b', 'Q4_K_M')).toContain('4b');
    });
});

describe('ggufPath', () => {
    it('joins cacheDir and ggufFilename', () => {
        const result = ggufPath('0.6b', 'Q8_0');
        const expected = path.join(cacheDir(), ggufFilename('0.6b', 'Q8_0'));
        expect(result).toBe(expected);
    });

    it('is an absolute path', () => {
        const result = ggufPath('0.6b', 'Q8_0');
        expect(result.startsWith('/')).toBe(true);
    });

    it('ends with .gguf', () => {
        expect(ggufPath('0.6b', 'Q8_0')).toMatch(/\.gguf$/);
        expect(ggufPath('4b', 'Q4_K_M')).toMatch(/\.gguf$/);
    });
});
