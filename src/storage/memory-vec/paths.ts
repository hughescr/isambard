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
 *
 * @param home - Home directory to build the cache path under. Defaults to `homedir()`;
 * overridable so tests can pin the absolute-path contract without relying on
 * `process.env.HOME`, which Bun only reads at startup. Resolved against the process cwd
 * before use so the returned path is always absolute, even if `home` itself is relative
 * (as `os.homedir()` can be when Bun is started with a relative `HOME`).
 */
export function cacheDir(home: string = homedir()): string {
    const resolvedHome = path.resolve(home);
    // macOS
    if(process.platform === 'darwin') {
        // macOS: ~/Library/Caches/llama.cpp (shared with homebrew llama-cli)
        // Stryker disable next-line llm: home is already absolute via path.resolve, so join/resolve and the embedded-slash form produce the same path
        return path.join(resolvedHome, 'Library', 'Caches', 'llama.cpp');
    }
    // Linux (XDG or fallback)
    const xdgCache = process.env.XDG_CACHE_HOME;
    // An empty XDG_CACHE_HOME must be treated as unset (XDG Base Directory spec): with `??` the empty
    // value would win and yield the relative path 'llama.cpp', resolved against the process cwd.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty XDG_CACHE_HOME must fall back to ~/.cache per the XDG Base Directory spec, so `||` is intentional here
    const cacheBase = xdgCache || path.join(resolvedHome, '.cache');
    return path.join(cacheBase, 'llama.cpp');
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
