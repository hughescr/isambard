/**
 * CI mutation-baseline provenance tool: the `gate`, `pick` and `finish` steps of the Stryker
 * baseline workflows. The decisions live in `./mutation-baseline-core`; this file only reads
 * and writes files, the environment and the clock.
 *
 * Usage:
 *   bun tools/mutation-baseline.ts gate
 *   bun tools/mutation-baseline.ts pick
 *   bun tools/mutation-baseline.ts finish --slice <0-13> --stryker-exit <code>
 *   (any command) [--incremental <path>] [--meta <path>]
 *
 * Environment: FINGERPRINT (required), MATCHED_KEY (gate), GITHUB_RUN_ID (finish),
 * GITHUB_OUTPUT (pick, finish), GITHUB_STEP_SUMMARY (markdown is appended; stdout when unset).
 *
 * Only `finish` writes files (the incremental report and the meta file); `gate` and `pick` only read.
 *
 * Exit codes: 0 ok; 1 gate red / survivors found / no slice to pick; 2 finish found no
 * threshold failure and changed nothing; 64 bad command line or missing FINGERPRINT.
 */
import { rename as fsRename } from 'node:fs/promises';
import {
    type CliArgs,
    evaluateGate,
    finishSlice,
    loadMeta,
    parseArgs,
    parseJson,
    pickSlice,
    positivePatterns,
    selectFiles,
    serializeMeta
} from './mutation-baseline-core';

/** Exit code for a bad command line or missing environment (BSD `EX_USAGE`). */
export const EXIT_USAGE = 64;

/** Injectable IO boundary for {@link runCli}, so tests never touch the real filesystem, clock or Stryker config. */
export interface CliDeps {
    env:             Readonly<Record<string, string | undefined>>
    now:             () => Date
    /** File text, or undefined when the file does not exist. */
    readText:        (path: string) => Promise<string | undefined>
    /** Replaces a file atomically (temp file + rename). */
    writeText:       (path: string, data: string) => Promise<void>
    appendText:      (path: string, data: string) => Promise<void>
    stdout:          (text: string) => void
    stderr:          (text: string) => void
    /** The `mutate` globs of stryker.conf.mjs. */
    loadMutateGlobs: () => Promise<readonly string[]>
    /** Repo-relative POSIX paths matching any of the given globs, scanned from the repo root. */
    listFiles:       (patterns: readonly string[]) => Promise<string[]>
}

async function readTextIfExists(path: string): Promise<string | undefined> {
    const file = Bun.file(path);
    return await file.exists() ? file.text() : undefined;
}

async function appendTextToFile(path: string, data: string): Promise<void> {
    const existing = await readTextIfExists(path);
    return Bun.write(path, `${existing ?? ''}${data}`).then(() => undefined);
}

// Stryker disable all: wiring to stryker.conf.mjs, which loads Stryker plugins and takes ~10 s to evaluate; exercised only by the real CLI
/** The `mutate` globs of stryker.conf.mjs (imported, never copied). */
async function loadMutateGlobs(): Promise<readonly string[]> {
    // @ts-expect-error -- stryker.conf.mjs is untyped JavaScript
    const config = await import('../stryker.conf.mjs') as { 'default': { mutate: string[] } };
    return config.default.mutate;
}
// Stryker restore all

/** The real IO boundary. */
export function createDefaultDeps(): CliDeps {
    return {
        env:       process.env,
        now:       () => new Date(),
        readText:  readTextIfExists,
        writeText: async (path, data) => {
            const tmpPath = `${path}.tmp-${process.pid}`;
            await Bun.write(tmpPath, data);
            await fsRename(tmpPath, path);
        },
        appendText: appendTextToFile,
        stdout:     (text) => {
            process.stdout.write(text);
        },
        stderr: (text) => {
            process.stderr.write(text);
        },
        loadMutateGlobs,
        listFiles: async (patterns) => {
            // Stryker disable next-line StringLiteral: Bun treats scan('') and scan('.') identically; asserting this argument would pin an undocumented implementation detail.
            const scans = await Promise.all(patterns.map(pattern => Array.fromAsync(new Bun.Glob(pattern).scan('.'))));
            return [...new Set(scans.flat())];
        },
    };
}

/** Sends markdown to the step summary file, or to stdout when there is none. */
async function emitSummary(deps: CliDeps, markdown: string): Promise<void> {
    const target = deps.env.GITHUB_STEP_SUMMARY;
    if(target === undefined || target === '') {
        deps.stdout(markdown);
        return;
    }
    await deps.appendText(target, `${markdown}\n`);
}

/** Sends `key=value` lines to `$GITHUB_OUTPUT`, or to stdout when there is none. */
async function emitOutputs(deps: CliDeps, lines: string): Promise<void> {
    const target = deps.env.GITHUB_OUTPUT;
    if(target === undefined || target === '') {
        deps.stdout(lines);
        return;
    }
    await deps.appendText(target, lines);
}

/** The repo's mutation file universe: stryker.conf.mjs's `mutate` globs resolved against the working tree. */
async function loadUniverse(deps: CliDeps): Promise<string[]> {
    const patterns = await deps.loadMutateGlobs();
    return selectFiles(patterns, await deps.listFiles(positivePatterns(patterns)));
}

async function runFinish(args: CliArgs, fingerprint: string, deps: CliDeps): Promise<number> {
    const meta = loadMeta(await deps.readText(args.metaPath));
    const result = finishSlice({
        report:      parseJson(await deps.readText(args.incrementalPath)),
        strykerExit: args.strykerExit,
        slice:       args.slice,
        meta,
        fingerprint,
        runId:       deps.env.GITHUB_RUN_ID ?? 'local',
        now:         deps.now(),
    });
    if(result.save) {
        await deps.writeText(args.incrementalPath, JSON.stringify(result.report));
        await deps.writeText(args.metaPath, serializeMeta(result.meta));
    }
    await emitOutputs(deps, `save=${result.save}\n`);
    await emitSummary(deps, result.summary);
    deps.stdout(`${result.message}\n`);
    for(const annotation of result.annotations) {
        deps.stdout(`${annotation}\n`);
    }
    return result.exitCode;
}

/**
 * CLI entry point.
 * @param argv - `process.argv`
 * @param deps - The IO boundary (defaults to the real one)
 * @returns The process exit code
 */
export async function runCli(argv: readonly string[], deps: CliDeps = createDefaultDeps()): Promise<number> {
    const parsed = parseArgs(argv);
    if(!parsed.ok) {
        deps.stderr(`${parsed.message}\n`);
        return EXIT_USAGE;
    }
    const { args } = parsed;
    const fingerprint = deps.env.FINGERPRINT;
    if(fingerprint === undefined || fingerprint === '') {
        deps.stderr('FINGERPRINT is required\n');
        return EXIT_USAGE;
    }

    if(args.command === 'finish') {
        return runFinish(args, fingerprint, deps);
    }

    const meta = loadMeta(await deps.readText(args.metaPath));
    const files = await loadUniverse(deps);

    if(args.command === 'gate') {
        const result = evaluateGate({ meta, files, fingerprint, matchedKey: deps.env.MATCHED_KEY ?? '', now: deps.now() });
        await emitSummary(deps, result.summary);
        deps.stdout(`${result.message}\n`);
        for(const error of result.errors) {
            deps.stdout(`${error}\n`);
        }
        return result.exitCode;
    }

    const result = pickSlice({ meta, files, fingerprint });
    await emitOutputs(deps, result.outputs);
    await emitSummary(deps, result.summary);
    deps.stdout(`${result.message}\n`);
    return result.exitCode;
}

// Stryker disable next-line BlockStatement: main-entry block runs only as a CLI subprocess, invisible to in-process coverage
if(import.meta.main) {
    // Stryker disable next-line AwaitDrop: entrypoint call with nothing following it in this block; same equivalent-mutant reasoning as tools/backfill-contact-lookup-gsi2.ts's identical AwaitDrop disable.
    process.exitCode = await runCli(process.argv);
}
