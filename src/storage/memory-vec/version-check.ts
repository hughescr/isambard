/**
 * llama.cpp release validation for the binary node-llama-cpp actually loaded.
 *
 * llama.cpp builds before b8950 have a Qwen3 non-causal embedding bug (present
 * in b8390, fixed in b8950), so the embedder refuses any older release.
 *
 * The repo and release come from `llama.llamaCppRelease` after `getLlama()`:
 * the prebuilt binaries', or those of a local source build when a
 * `node-llama-cpp source download` has overridden them. Release tags are only
 * meaningful for upstream llama.cpp, so any other repo (a fork, whose tags
 * could say anything) is rejected outright. Upstream releases take two forms:
 *   - `bNNNN` build tags: compatible when NNNN ≥ 8950.
 *   - `vX.Y.Z` semver releases: compatible from v0.1.0, upstream's first
 *     semver tag, 1513 commits after b8950. (node-llama-cpp 3.21.1's
 *     prebuilts report v0.4.0, which is b10816.)
 * Anything else is an unknown release and is rejected.
 */
import { IncompatibleLlamaCppError } from '@/errors';

/** The only repo whose release tags this check can interpret */
const UPSTREAM_LLAMA_CPP_REPO = 'ggml-org/llama.cpp';

/** Minimum llama.cpp build required for correct Qwen3 non-causal embeddings */
const MINIMUM_LLAMA_CPP_BUILD = 8950;

/**
 * Upstream's first semver release, which already carries the b8950 fix.
 * {@link isCompatibleSemver} encodes this floor as `major > 0 || minor >= 1`.
 */
const MINIMUM_LLAMA_CPP_RELEASE = 'v0.1.0';

const BUILD_TAG = /^b(\d+)$/;
const SEMVER_RELEASE = /^v(\d+)\.(\d+)\.\d+$/;

/** True for vX.Y.Z at or above v0.1.0; the patch number never decides it. */
function isCompatibleSemver(major: number, minor: number): boolean {
    return major > 0 || minor >= 1;
}

function isCompatibleRelease(release: string): boolean {
    const semver = SEMVER_RELEASE.exec(release);
    if(semver !== null) {
        return isCompatibleSemver(Number(semver[1]), Number(semver[2]));
    }
    const match = BUILD_TAG.exec(release);
    if(match === null) {
        return false;
    }
    const build = Number(match[1]);
    // A very long numeric tag can parse to Infinity or lose integer precision.
    // Neither is a trustworthy build number for a compatibility decision.
    return Number.isSafeInteger(build) && build >= MINIMUM_LLAMA_CPP_BUILD;
}

/**
 * Asserts that the loaded llama.cpp is an upstream release carrying the b8950
 * Qwen3 non-causal embedding fix.
 *
 * @param repo - The loaded release's GitHub repo, from `llama.llamaCppRelease.repo`.
 * @param release - The loaded release tag, from `llama.llamaCppRelease.release`.
 * @throws {IncompatibleLlamaCppError} If the repo is not upstream llama.cpp, or the
 *   release predates b8950 / v0.1.0 or is not a recognised tag.
 */
export function assertLlamaCppCompatible(repo: string, release: string): void {
    if(repo !== UPSTREAM_LLAMA_CPP_REPO || !isCompatibleRelease(release)) {
        throw new IncompatibleLlamaCppError(
            { repo, release },
            {
                repo:           UPSTREAM_LLAMA_CPP_REPO,
                minimumBuild:   MINIMUM_LLAMA_CPP_BUILD,
                minimumRelease: MINIMUM_LLAMA_CPP_RELEASE,
            }
        );
    }
}
