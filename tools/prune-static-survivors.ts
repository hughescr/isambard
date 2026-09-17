/**
 * Prunes stale cached verdicts for *static* mutants out of a Stryker incremental report.
 *
 * Stryker core's incremental differ (`node_modules/@stryker-mutator/core/dist/src/mutants/
 * incremental-differ.js`, `mutantCanBeReused`/`diffTestCoverage`) reuses a previously-Survived
 * mutant unless a NEW covering test appeared. A static mutant (module-level code, `static:
 * true` in the report) has no covering tests at all — its `coveredBy` is empty — so a stale
 * Survived/NoCoverage verdict for it is reused forever, no matter how many killing tests are
 * added later. Deleting those entries from the cached report before a run forces Stryker to
 * re-execute them, at the cost of re-running a small, bounded set of module-level mutants.
 *
 * Usage:
 *   bun tools/prune-static-survivors.ts [path]   (default: reports/stryker-incremental.json)
 */
import { rename as fsRename } from 'node:fs/promises';

/** One mutant entry as it appears in `files[*].mutants[*]` of a Stryker mutation report. */
interface MutantLike {
    'static'?: unknown
    status?:   unknown
}

/** One file entry as it appears in `files[*]` of a Stryker mutation report. */
interface FileEntryLike {
    mutants?: unknown
}

/** The subset of a Stryker mutation/incremental report's shape this tool reads. */
interface ReportLike {
    files?: unknown
}

/** Result of {@link pruneStaticSurvivors}: the (possibly rebuilt) report and how many entries were dropped. */
export interface PruneResult {
    report:  unknown
    removed: number
}

/** A stale cached verdict for a static mutant: `static: true` with a non-fresh status. */
function isStaleStaticMutant(mutant: unknown): boolean {
    if(mutant === null || typeof mutant !== 'object') {
        return false;
    }
    const m = mutant as MutantLike;
    return m.static === true && (m.status === 'Survived' || m.status === 'NoCoverage');
}

/**
 * Removes every stale static-mutant verdict (`static === true` and status `Survived` or
 * `NoCoverage`) from `report.files[*].mutants`. Every other entry — non-static mutants,
 * static mutants with any other status (e.g. `Killed`), and every other field of the report —
 * is left untouched; a file whose mutants need no pruning keeps its original object reference,
 * and a report needing no pruning at all is returned as-is.
 *
 * Tolerant of a missing or malformed report: `undefined`, `null`, a non-object, a report with
 * no `files` key, or a file entry with no `mutants` array all pass through unchanged with
 * `removed: 0`.
 */
export function pruneStaticSurvivors(report: unknown): PruneResult {
    if(report === null || typeof report !== 'object') {
        return { report, removed: 0 };
    }
    const files = (report as ReportLike).files;
    if(files === null || typeof files !== 'object') {
        return { report, removed: 0 };
    }

    let removed = 0;
    let changed = false;
    const newFiles: Record<string, unknown> = {};

    for(const [path, entry] of Object.entries(files as Record<string, unknown>)) {
        if(entry === null || typeof entry !== 'object' || !Array.isArray((entry as FileEntryLike).mutants)) {
            newFiles[path] = entry;
            continue;
        }
        const mutants = (entry as FileEntryLike).mutants as unknown[];
        const kept = mutants.filter(m => !isStaleStaticMutant(m));
        if(kept.length === mutants.length) {
            newFiles[path] = entry;
            continue;
        }
        removed += mutants.length - kept.length;
        changed = true;
        newFiles[path] = { ...entry, mutants: kept };
    }

    if(!changed) {
        return { report, removed: 0 };
    }

    return { report: { ...report, files: newFiles }, removed };
}

/** Injectable IO boundary for {@link runCli}, so tests never touch the real filesystem. */
export interface PruneCliDeps {
    fileExists?: (path: string) => Promise<boolean>
    readFile?:   (path: string) => Promise<string>
    writeFile?:  (path: string, data: string) => Promise<void>
    rename?:     (from: string, to: string) => Promise<void>
    write?:      (text: string) => void
}

/**
 * CLI entry point: reads the report at `argv[2]` (default `reports/stryker-incremental.json`),
 * prunes it with {@link pruneStaticSurvivors}, and — only when something was actually removed —
 * writes the result back atomically (temp file + rename) and prints a one-line summary.
 * No-ops silently when the file does not exist, so it is safe to run unconditionally before
 * every `bun mutate`, including the very first run with no cache yet.
 */
export async function runCli(argv: string[], deps: PruneCliDeps = {}): Promise<void> {
    const path = argv[2] ?? 'reports/stryker-incremental.json';
    const fileExists = deps.fileExists ?? (p => Bun.file(p).exists());
    const readFile = deps.readFile ?? (p => Bun.file(p).text());
    const writeFile = deps.writeFile ?? (async (p, data) => {
        await Bun.write(p, data);
    });
    const rename = deps.rename ?? fsRename;
    const write = deps.write ?? ((text: string) => {
        process.stdout.write(text);
    });

    if(!(await fileExists(path))) {
        return;
    }

    const raw = await readFile(path);
    const report: unknown = JSON.parse(raw);
    const { report: pruned, removed } = pruneStaticSurvivors(report);

    if(removed === 0) {
        return;
    }

    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(pruned));
    await rename(tmpPath, path);

    write(`pruned ${removed} stale static mutant verdict(s) from ${path}\n`);
}

if(import.meta.main) {
    // Stryker disable next-line AwaitDrop: entrypoint call with nothing following it in this block; same equivalent-mutant reasoning as tools/backfill-contact-lookup-gsi2.ts's identical AwaitDrop disable.
    await runCli(process.argv);
}
