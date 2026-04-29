/**
 * Cache directory resolution and GGUF filename construction for pplx-embed-v1 models.
 *
 * GGUFs live in the llama.cpp shared cache, which is shared across tools
 * (homebrew llama-cli, node-llama-cpp, llama-server) to avoid duplication.
 *
 * Naming convention: local_<repo>_<file>.gguf where `local_` distinguishes
 * hand-built models from HF auto-downloaded ones.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import type { ModelQuant, ModelSlug } from './types.js';

/**
 * Returns the llama.cpp shared cache directory.
 *
 * On macOS this is ~/Library/Caches/llama.cpp.
 * On Linux (if Izzy ever runs there), falls back to ${XDG_CACHE_HOME:-~/.cache}/llama.cpp.
 * Note: the Linux fallback only matters if Isambard is deployed on Linux.
 */
export function cacheDir(): string {
    const home = homedir();
    // macOS
    // Stryker disable next-line ConditionalExpression,EqualityOperator: platform branch — darwin and Linux paths are both correct; Linux branch is not exercised in macOS CI
    if(process.platform === 'darwin') {
        // macOS: ~/Library/Caches/llama.cpp (shared with homebrew llama-cli)
        return path.join(home, 'Library', 'Caches', 'llama.cpp');
    }
    // Linux (XDG or fallback) — not exercised in macOS CI; mutations here cannot be detected
    // Stryker disable LogicalOperator,StringLiteral: Linux-only branch — XDG fallback and path strings cannot be tested on macOS where all tests run
    const xdgCache = process.env.XDG_CACHE_HOME;
    const cacheBase = xdgCache ?? path.join(home, '.cache');
    return path.join(cacheBase, 'llama.cpp');
    // Stryker restore LogicalOperator,StringLiteral
}

/**
 * Returns the canonical GGUF filename for a given model slug and quantization.
 * Quant is lowercased in the filename (Q8_0 → q8_0, Q4_K_M → q4_k_m).
 */
export function ggufFilename(slug: ModelSlug, quant: ModelQuant): string {
    return `local_pplx-embed-v1-${slug}_${quant.toLowerCase()}-noncausal.gguf`;
}

/**
 * Returns the full absolute path to the GGUF file for a given slug and quant.
 */
export function ggufPath(slug: ModelSlug, quant: ModelQuant): string {
    return path.join(cacheDir(), ggufFilename(slug, quant));
}
