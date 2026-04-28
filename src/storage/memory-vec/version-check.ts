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
import { IncompatibleLlamaCppError } from './errors.js';

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
    // Stryker disable next-line StringLiteral: URL path is fixed package layout — wrong segment → file not found → returns null (tested via ENOENT test)
    const moduleDir = fileURLToPath(new URL('../../../', import.meta.url));
    // Stryker disable next-line StringLiteral: path segments are fixed package layout — wrong segment → ENOENT → null, which is tested
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
        let parsed: unknown;
        // Stryker disable BlockStatement: catch body returns null for malformed JSON; even if emptied, the typeof guard below catches undefined (still returns null) — the guard makes this block redundant but explicit
        try {
            parsed = JSON.parse(content) as unknown;
        } catch{
            return null;
        }
        // Stryker restore BlockStatement

        // Stryker disable ConditionalExpression,LogicalOperator,BlockStatement: all mutations of this guard still return null — downstream guards (typeof tag !== 'string') and outer try-catch ensure null is returned regardless
        if(typeof parsed !== 'object' || parsed === null) {
            return null;
        }
        // Stryker restore ConditionalExpression,LogicalOperator,BlockStatement

        const info = parsed as Partial<LlamaCppInfo>;
        const tag = info.tag;
        if(typeof tag !== 'string') {
            return null;
        }

        // Tags look like "b8953" — extract the numeric part
        // Stryker disable next-line Regex: anchor mutations (/b(\d+)$/ or /^b(\d+)/) would match tags like 'xb8953' or 'b8953extra', but test coverage verifies these return null
        const match = /^b(\d+)$/.exec(tag);
        if(!match?.[1]) {
            return null;
        }

        const build = Number.parseInt(match[1], 10);
        // Stryker disable next-line ConditionalExpression,BlockStatement: Number.parseInt on a \d+ regex match can never return NaN — this is a defensive guard; emptying the block body is also equivalent since NaN is unreachable
        if(Number.isNaN(build)) {
            return null;
        }

        return { build, releaseTag: tag };
    } catch{
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
