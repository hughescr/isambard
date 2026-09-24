/**
 * Tests for version-check.ts — validation of the llama.cpp release node-llama-cpp loaded.
 *
 * The check is pure: it takes the repo and release tag reported by `llama.llamaCppRelease`
 * (the prebuilt binary's, or a local source build's) and needs no mocks.
 */
import { describe, expect, it } from 'bun:test';
import { IncompatibleLlamaCppError } from '@/errors';
import { assertLlamaCppCompatible } from '@/storage/memory-vec/version-check';

const UPSTREAM = 'ggml-org/llama.cpp';

function thrownBy(repo: string, release: string): unknown {
    try {
        assertLlamaCppCompatible(repo, release);
    } catch (error) {
        return error;
    }
    return undefined;
}

describe('assertLlamaCppCompatible', () => {
    it.each([
        { label: 'build tag exactly at the b8950 floor', release: 'b8950' },
        { label: 'build tag above the floor', release: 'b8953' },
        { label: 'five-digit build tag', release: 'b10816' },
        { label: 'semver release exactly at the v0.1.0 floor', release: 'v0.1.0' },
        { label: 'semver release (node-llama-cpp 3.21.1 prebuilt)', release: 'v0.4.0' },
        { label: 'semver release with a multi-digit minor', release: 'v0.10.0' },
        { label: 'first major semver release', release: 'v1.0.0' },
        { label: 'semver release with multi-digit components', release: 'v10.11.12' },
    ])('accepts an upstream $label ($release)', ({ release }) => {
        expect(thrownBy(UPSTREAM, release)).toBeUndefined();
    });

    it.each([
        { label: 'build tag one below the floor', repo: UPSTREAM, release: 'b8949' },
        { label: 'build tag with the Qwen3 non-causal bug', repo: UPSTREAM, release: 'b8390' },
        { label: 'build tag too large to represent exactly', repo: UPSTREAM, release: 'b9007199254740993' },
        { label: 'build tag without the b prefix', repo: UPSTREAM, release: '8953' },
        { label: 'build tag with trailing characters', repo: UPSTREAM, release: 'b8953extra' },
        { label: 'build tag with leading characters', repo: UPSTREAM, release: 'xb8953' },
        { label: 'semver release v0.0.0, below the first semver tag', repo: UPSTREAM, release: 'v0.0.0' },
        { label: 'semver release v0.0.9, below the first semver tag', repo: UPSTREAM, release: 'v0.0.9' },
        { label: 'semver release with a pre-release suffix', repo: UPSTREAM, release: 'v0.4.0-rc1' },
        { label: 'semver release with leading characters', repo: UPSTREAM, release: 'xv0.4.0' },
        { label: 'semver release missing a component', repo: UPSTREAM, release: 'v0.4' },
        { label: 'semver release with a non-numeric patch', repo: UPSTREAM, release: 'v0.4.x' },
        { label: 'semver release with non-dot separators', repo: UPSTREAM, release: 'v0x4x0' },
        { label: 'non-numeric release name', repo: UPSTREAM, release: 'latest' },
        { label: 'empty release', repo: UPSTREAM, release: '' },
        { label: 'semver release from a fork', repo: 'someone/llama.cpp', release: 'v1.0.0' },
        { label: 'build tag from a fork', repo: 'someone/llama.cpp', release: 'b9999' },
        { label: 'release from a repo that only extends the upstream name', repo: 'ggml-org/llama.cpp-fork', release: 'v0.4.0' },
        { label: 'release with an empty repo', repo: '', release: 'v0.4.0' },
    ])('throws IncompatibleLlamaCppError for a $label ($repo $release)', ({ repo, release }) => {
        const error = thrownBy(repo, release);
        expect(error).toBeInstanceOf(IncompatibleLlamaCppError);
        expect((error as IncompatibleLlamaCppError).context).toEqual({
            repo,
            release,
            requiredRepo:   UPSTREAM,
            minimumBuild:   8950,
            minimumRelease: 'v0.1.0',
        });
    });

    it('names the offending repo in the error message', () => {
        const error = thrownBy('someone/llama.cpp', 'b9999') as IncompatibleLlamaCppError;
        expect(error.message).toStartWith('node-llama-cpp loaded llama.cpp release "b9999" from someone/llama.cpp, ');
    });
});
