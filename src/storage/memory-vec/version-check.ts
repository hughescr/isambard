/**
 * Bundled llama.cpp version validation.
 *
 * The prebuilt binary shipping with node-llama-cpp has a Qwen3 non-causal
 * embedding bug (present in b8390, fixed in ≥ b8950).
 *
 * Production must use a binary built from llama.cpp ≥ b8950.
 * Source rebuild:
 *   bunx node-llama-cpp source download --release b8953
 *   bunx node-llama-cpp source build
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncompatibleLlamaCppError } from '@/errors';

/** Minimum llama.cpp build required for correct Qwen3 non-causal embeddings */
const MINIMUM_LLAMA_CPP_BUILD = 8950;

/**
 * Path to the llama.cpp version info file bundled with node-llama-cpp.
 * Format: { "tag": "b8953", "llamaCppGithubRepo": "ggml-org/llama.cpp" }
 */
function getInfoFilePath(): string {
    // Resolve relative to node_modules/node-llama-cpp
    // Use import.meta.url to get the absolute path of this module,
    // then navigate to node_modules from the project root.
    const moduleDir = fileURLToPath(new URL('../../../', import.meta.url));
    return path.join(moduleDir, 'node_modules', 'node-llama-cpp', 'llama', 'llama.cpp.info.json');
}

interface LlamaCppInfo {
    tag:                string
    llamaCppGithubRepo: string
}

/**
 * Reads and parses the bundled llama.cpp version info.
 *
 * @returns Parsed build number and release tag, or null if the file is
 *          missing, malformed, or does not contain a parseable build number.
 */
export async function getBundledLlamaCppVersion(): Promise<{ build: number, releaseTag: string } | null> {
    try {
        const content = await readFile(getInfoFilePath(), 'utf8');
        // The outer catch treats malformed JSON and non-object JSON alike as an unknown
        // version. Accessing tag on null throws into that same catch.
        const info = JSON.parse(content) as Partial<LlamaCppInfo>;
        const tag = info.tag;
        if(typeof tag !== 'string') {
            return null;
        }

        // Tags look like "b8953" — extract the numeric part
        const match = /^b(\d+)$/.exec(tag);
        if(match === null) {
            return null;
        }

        // Stryker disable next-line NumberLiteralValue: radix 0 falls back to decimal unless the string starts with 0x, which the /^b(\d+)$/ guard rules out
        const build = Number.parseInt(match[1]!, 10);
        // A very long numeric tag can parse to Infinity or lose integer precision.
        // Neither is a trustworthy build number for a compatibility decision.
        if(!Number.isSafeInteger(build)) {
            return null;
        }

        return { build, releaseTag: tag };
    } catch{
        // Silent: file not found (ENOENT), permission error, or any unexpected I/O failure.
        // All of these mean "unknown version" — return null so assertLlamaCppCompatible
        // throws IncompatibleLlamaCppError and surfaces the problem at startup.
        return null;
    }
}

/**
 * Asserts that the bundled llama.cpp is compatible (build ≥ 8950).
 *
 * @throws {IncompatibleLlamaCppError} If the build is too old or the version file is missing.
 */
export async function assertLlamaCppCompatible(): Promise<void> {
    const version = await getBundledLlamaCppVersion();

    if(version === null || version.build < MINIMUM_LLAMA_CPP_BUILD) {
        throw new IncompatibleLlamaCppError(version?.build ?? null, MINIMUM_LLAMA_CPP_BUILD);
    }
}
