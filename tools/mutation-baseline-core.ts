/**
 * Pure core of `tools/mutation-baseline.ts`: the CI mutation-baseline provenance file, the
 * file-to-slice partition, and the `gate` / `pick` / `finish` decisions.
 *
 * Nothing here reads the clock, the environment or the filesystem: every input (meta, file
 * list, fingerprint, `now`, incremental report) is an argument and every result is a value
 * the thin CLI writes out.
 */
import { createHash } from 'node:crypto';

/** Number of baseline slices the file universe is partitioned into. */
export const SLICE_COUNT = 14;

/** Version of the provenance file's layout. */
export const META_SCHEMA = 1;

/** How old a slice's refresh may get, while its stamp is on another fingerprint, before the gate goes red. */
export const OVERDUE_DAYS = 10;

/** Most `::error::` annotations `finish` emits; the summary lists every survivor. */
export const MAX_ANNOTATIONS = 10;

/** Cache-key prefix every v2 baseline entry carries. */
export const CACHE_KEY_PREFIX = 'stryker-incremental-v2-';

/** Seed command named in the incomplete-baseline failure. */
export const SEED_COMMAND = 'gh workflow run mutation-baseline.yml --ref develop -f slots=14';

/** Command that lists the refresh workflow's runs, named in the overdue failure. */
export const REFRESH_RUNS_COMMAND = 'gh run list --workflow mutation-baseline.yml';

const MS_PER_DAY = 86_400_000;
const MAX_REPLACEMENT_IN_ANNOTATION = 120;
const FINGERPRINT_IN_KEY = /^stryker-incremental-v2-([^-]+-bun[^-]+-lock[^-]+)-/;

/** One slice's refresh stamp: written only by a forced refresh of that slice. */
export interface SliceStamp {
    fingerprint: string
    refreshedAt: string
    runId:       string
}

/** The provenance file `reports/stryker-baseline-meta.json`. */
export interface BaselineMeta {
    schema:     number
    sliceCount: number
    slices:     Partial<Record<string, SliceStamp>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTime(value: unknown): value is string {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Parses JSON text. Neither result is a usable record, so callers treat both alike.
 * @param text - The raw text, or undefined when the file does not exist
 * @returns The parsed value; `undefined` when there was no text, `null` when it was malformed
 */
export function parseJson(text: string | undefined): unknown {
    if(text === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch{
        return null;
    }
}

/** A meta with no stamps. */
export function emptyMeta(): BaselineMeta {
    return { schema: META_SCHEMA, sliceCount: SLICE_COUNT, slices: {} };
}

function isSliceKey(key: string): boolean {
    return /^(?:0|[1-9]\d?)$/.test(key) && Number(key) < SLICE_COUNT;
}

function readSlices(value: unknown): Partial<Record<string, SliceStamp>> {
    const slices: Partial<Record<string, SliceStamp>> = {};
    if(!isRecord(value)) {
        return slices;
    }
    for(const [key, stamp] of Object.entries(value)) {
        if(isSliceKey(key) && isRecord(stamp) && typeof stamp.fingerprint === 'string' && isIsoTime(stamp.refreshedAt) && typeof stamp.runId === 'string') {
            slices[key] = { fingerprint: stamp.fingerprint, refreshedAt: stamp.refreshedAt, runId: stamp.runId };
        }
    }
    return slices;
}

/**
 * Reads the provenance file's text. A missing or unparseable file, a wrong `schema` or a
 * `sliceCount` other than {@link SLICE_COUNT} reads as an empty meta; a stamp that is
 * malformed or names a slice outside 0..13 is dropped (its slice reads as never
 * refreshed). Any other key, such as a legacy `toolchain`, is ignored.
 * @param raw - The file's text, or undefined when it does not exist
 * @returns A well-formed meta
 */
export function loadMeta(raw: string | undefined): BaselineMeta {
    const parsed = parseJson(raw);
    if(!isRecord(parsed) || parsed.schema !== META_SCHEMA || parsed.sliceCount !== SLICE_COUNT) {
        return emptyMeta();
    }
    return { schema: META_SCHEMA, sliceCount: SLICE_COUNT, slices: readSlices(parsed.slices) };
}

/** Serialises a meta for writing back to disk. */
export function serializeMeta(meta: BaselineMeta): string {
    return `${JSON.stringify(meta, null, 2)}\n`;
}

/**
 * The slice a repo-relative POSIX path belongs to: the first 8 hex characters of the
 * sha256 of the path, read as an integer, modulo {@link SLICE_COUNT}.
 * @param path - Repo-relative POSIX path
 * @returns The slice index, 0..13
 */
export function sliceOf(path: string): number {
    const digest = createHash('sha256').update(path).digest('hex');
    return Number.parseInt(digest.slice(0, 8), 16) % SLICE_COUNT;
}

function byText(a: string, b: string): number {
    return a.localeCompare(b);
}

/** Files of each slice: an array of {@link SLICE_COUNT} sorted lists, empty slices included. */
export function bucketFiles(files: readonly string[]): string[][] {
    const buckets: string[][] = Array.from({ length: SLICE_COUNT }, () => []);
    for(const file of files.toSorted(byText)) {
        buckets.at(sliceOf(file))?.push(file);
    }
    return buckets;
}

/** The non-negated patterns of a Stryker `mutate` list. */
export function positivePatterns(patterns: readonly string[]): string[] {
    return patterns.filter(p => !p.startsWith('!'));
}

/**
 * Applies a Stryker `mutate` list to candidate paths: a path is in the universe when it
 * matches a positive pattern and no negated (`!`) pattern.
 * @param patterns - The `mutate` globs of stryker.conf.mjs
 * @param candidates - Repo-relative POSIX paths to test
 * @returns The matching paths, sorted and de-duplicated
 */
export function selectFiles(patterns: readonly string[], candidates: readonly string[]): string[] {
    const include = positivePatterns(patterns).map(p => new Bun.Glob(p));
    const exclude = patterns.filter(p => p.startsWith('!')).map(p => new Bun.Glob(p.slice(1)));
    const selected = new Set(candidates.filter(c => include.some(g => g.match(c)) && !exclude.some(g => g.match(c))));
    return [...selected].toSorted(byText);
}

/** How one slice's stamp relates to the current toolchain. */
export type SliceState = 'current' | 'inherited' | 'never';

interface RowBase {
    slice: number
    files: number
    paths: readonly string[]
}

/** A non-empty slice that has never been stamped. */
interface NeverRow extends RowBase {
    state: 'never'
}

/** A non-empty slice with a stamp, on the current fingerprint or another one. */
interface StampedRow extends RowBase {
    state: 'current' | 'inherited'
    stamp: SliceStamp
}

type SliceRow = NeverRow | StampedRow;

function sliceRows(meta: BaselineMeta, buckets: readonly (readonly string[])[], fingerprint: string): SliceRow[] {
    const rows: SliceRow[] = [];
    for(const [slice, files] of buckets.entries()) {
        if(files.length === 0) {
            continue;
        }
        const base = { slice, files: files.length, paths: files };
        const stamp = meta.slices[String(slice)];
        if(stamp === undefined) {
            rows.push({ ...base, state: 'never' });
        } else {
            rows.push({ ...base, state: stamp.fingerprint === fingerprint ? 'current' : 'inherited', stamp });
        }
    }
    return rows;
}

function stateLabel(row: SliceRow): string {
    if(row.state === 'never') {
        return 'never refreshed';
    }
    return row.state === 'current' ? 'current' : `inherited from ${row.stamp.fingerprint}`;
}

function ageMs(row: StampedRow, now: Date): number {
    return now.getTime() - Date.parse(row.stamp.refreshedAt);
}

/** The `Refreshed at` and `Age (days)` cells of a gate table row; the age is in whole days, rounded down. */
function refreshCells(row: SliceRow, now: Date): string {
    if(row.state === 'never') {
        return '- | -';
    }
    return `${row.stamp.refreshedAt} | ${Math.floor(ageMs(row, now) / MS_PER_DAY)}`;
}

/** The fingerprint a cache key was saved under, or undefined when the key is not a v2 key. */
export function fingerprintOfKey(key: string): string | undefined {
    return FINGERPRINT_IN_KEY.exec(key)?.[1];
}

function formatSliceList(rows: readonly SliceRow[]): string {
    return rows.map(r => String(r.slice)).join(', ');
}

/** Everything the CLI needs after a `gate` decision. */
export interface GateResult {
    exitCode: 0 | 1
    /** Markdown for the step summary. */
    summary:  string
    /** One-line status for stdout. */
    message:  string
    /** `::error::` workflow commands (empty when green). */
    errors:   string[]
}

/** Inputs of {@link evaluateGate}. */
export interface GateInput {
    meta:        BaselineMeta
    files:       readonly string[]
    fingerprint: string
    /** `cache-matched-key` of the restore; empty when nothing matched. */
    matchedKey:  string
    now:         Date
}

/**
 * Decides the gate from the meta as it is (it never writes): renders the provenance summary
 * and fails when a non-empty slice was never stamped (INCOMPLETE, checked first) or when a
 * non-empty slice is stamped with another fingerprint and was last refreshed more than
 * {@link OVERDUE_DAYS} days ago (OVERDUE). A slice on the current fingerprint is never
 * overdue, however old.
 * @param input - Meta, file universe, fingerprint, matched cache key and the current time
 * @returns The exit code, summary markdown, status line and error annotations
 */
export function evaluateGate(input: GateInput): GateResult {
    const { meta, fingerprint, matchedKey, now } = input;
    const rows = sliceRows(meta, bucketFiles(input.files), fingerprint);
    const failure = gateFailure(rows, fingerprint, now);

    const lines = [
        '## Mutation baseline',
        '',
        `- Matched cache key: ${matchedKey === '' ? 'none' : `\`${matchedKey}\``}`,
        `- Current toolchain fingerprint: \`${fingerprint}\``,
        '',
    ];
    if(matchedKey !== '' && !matchedKey.startsWith(`${CACHE_KEY_PREFIX}${fingerprint}-`)) {
        lines.push(`**Baseline inherited from toolchain ${fingerprintOfKey(matchedKey) ?? matchedKey}**`, '');
    }
    lines.push('| Slice | Files | State | Refreshed at | Age (days) |', '| --- | --- | --- | --- | --- |');
    for(const row of rows) {
        lines.push(`| ${row.slice} | ${row.files} | ${stateLabel(row)} | ${refreshCells(row, now)} |`);
    }
    if(failure !== undefined) {
        lines.push('', `**${failure}**`);
    }

    return {
        exitCode: failure === undefined ? 0 : 1,
        summary:  `${lines.join('\n')}\n`,
        message:  failure ?? 'Baseline provenance ok',
        errors:   failure === undefined ? [] : [`::error::${escapeData(failure)}`],
    };
}

/** The red-state message for these rows, or undefined when the gate is green. INCOMPLETE outranks OVERDUE. */
function gateFailure(rows: readonly SliceRow[], fingerprint: string, now: Date): string | undefined {
    const missing = rows.filter(r => r.state === 'never');
    if(missing.length > 0) {
        return `BASELINE INCOMPLETE: slice(s) ${formatSliceList(missing)} have never been refreshed. A seed is in progress or needed: ${SEED_COMMAND}`;
    }
    const overdue = rows.filter((r): r is StampedRow => r.state === 'inherited' && ageMs(r, now) > OVERDUE_DAYS * MS_PER_DAY);
    if(overdue.length > 0) {
        const detail = overdue.map(r => `${r.slice} (${stateLabel(r)}, refreshed ${r.stamp.refreshedAt})`).join(', ');
        return `BASELINE OVERDUE: slice(s) ${detail} have not been refreshed under toolchain ${fingerprint} within ${OVERDUE_DAYS} days. Check the nightly refresh runs: ${REFRESH_RUNS_COMMAND}`;
    }
    return undefined;
}

/** Result of {@link pickSlice}. */
export interface PickResult {
    exitCode: 0 | 1
    slice:    number | undefined
    files:    readonly string[]
    /** Lines for `$GITHUB_OUTPUT` (`slice=…`, `globs=…`); empty when nothing was picked. */
    outputs:  string
    summary:  string
    message:  string
}

/** Inputs of {@link pickSlice}. */
export interface PickInput {
    meta:        BaselineMeta
    files:       readonly string[]
    fingerprint: string
}

/** An unstamped slice sorts before every stamped one (time -Infinity); two of them compare NaN, which falls through to the index. */
function stampTime(row: SliceRow): number {
    if(row.state === 'never') {
        return Number.NEGATIVE_INFINITY;
    }
    return Date.parse(row.stamp.refreshedAt);
}

/**
 * Stalest first: not current under this toolchain (unstamped, then stamped under another
 * fingerprint) before current ones; within each group the oldest refresh first. Ties keep
 * their input order, which is ascending slice index (sliceRows walks the buckets in order
 * and Array#toSorted is stable), i.e. the lowest index wins.
 */
function byStaleness(a: SliceRow, b: SliceRow): number {
    const aCurrent = Number(a.state === 'current');
    const bCurrent = Number(b.state === 'current');
    return aCurrent - bCurrent || stampTime(a) - stampTime(b);
}

/**
 * Chooses the stalest non-empty slice: never stamped first, then stamped under another
 * fingerprint, then the oldest `refreshedAt`, ties to the lowest index. It never writes the
 * meta.
 * @param input - Meta, file universe and fingerprint
 * @returns The chosen slice with its files, and the `$GITHUB_OUTPUT` lines
 */
export function pickSlice(input: PickInput): PickResult {
    const buckets = bucketFiles(input.files);
    const rows = sliceRows(input.meta, buckets, input.fingerprint);
    const chosen = rows.toSorted(byStaleness).at(0);
    if(chosen === undefined) {
        const message = 'No non-empty slice: the mutate globs matched no files';
        return { exitCode: 1, slice: undefined, files: [], outputs: '', summary: `${message}\n`, message };
    }
    const files = chosen.paths;
    const message = `Refreshing slice ${chosen.slice} (${stateLabel(chosen)}, ${files.length} files)`;
    return {
        exitCode: 0,
        slice:    chosen.slice,
        files,
        outputs:  `slice=${chosen.slice}\nglobs=${files.join(',')}\n`,
        summary:  `${message}\n`,
        message,
    };
}

/** A mutant the refresh could not earn: Survived or NoCoverage under the current toolchain. */
export interface Survivor {
    file:        string
    line:        number
    column:      number
    mutator:     string
    status:      'Survived' | 'NoCoverage'
    replacement: string
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' ? value : fallback;
}

function readSurvivor(file: string, mutant: unknown): Survivor | undefined {
    if(!isRecord(mutant) || (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage')) {
        return undefined;
    }
    const start = isRecord(mutant.location) && isRecord(mutant.location.start) ? mutant.location.start : {};
    return {
        file,
        line:        numberOr(start.line, 0),
        column:      numberOr(start.column, 0),
        mutator:     typeof mutant.mutatorName === 'string' ? mutant.mutatorName : 'unknown',
        status:      mutant.status,
        replacement: typeof mutant.replacement === 'string' ? mutant.replacement : '',
    };
}

/** The `files` map of an incremental report, or undefined when the report is unusable. */
function reportFiles(report: unknown): Record<string, unknown> | undefined {
    return isRecord(report) && isRecord(report.files) ? report.files : undefined;
}

/**
 * Counts every mutant in an incremental report and lists those that are Survived or
 * NoCoverage, in report order.
 * @param report - The parsed incremental report
 * @returns The totals, or undefined when the report has no `files` map
 */
export function collectSurvivors(report: unknown): { total: number, survivors: Survivor[] } | undefined {
    const files = reportFiles(report);
    if(files === undefined) {
        return undefined;
    }
    let total = 0;
    const survivors: Survivor[] = [];
    for(const [file, entry] of Object.entries(files)) {
        if(!isRecord(entry) || !Array.isArray(entry.mutants)) {
            continue;
        }
        total += entry.mutants.length;
        for(const mutant of entry.mutants as unknown[]) {
            const survivor = readSurvivor(file, mutant);
            if(survivor !== undefined) {
                survivors.push(survivor);
            }
        }
    }
    return { total, survivors };
}

/**
 * Deletes every Survived / NoCoverage mutant entry from an incremental report; every other
 * entry and field is carried over unchanged.
 * @param report - The parsed incremental report
 * @returns A new report without those mutants (the same object when it has no `files` map)
 */
export function dropSurvivors(report: unknown): unknown {
    const files = reportFiles(report);
    if(files === undefined) {
        return report;
    }
    const kept: Record<string, unknown> = {};
    for(const [file, entry] of Object.entries(files)) {
        kept[file] = isRecord(entry) && Array.isArray(entry.mutants)
            ? { ...entry, mutants: (entry.mutants as unknown[]).filter(m => readSurvivor(file, m) === undefined) }
            : entry;
    }
    return { ...(report as Record<string, unknown>), files: kept };
}

/** Escapes a workflow-command message (the part after `::`). */
export function escapeData(text: string): string {
    return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Escapes a workflow-command property value. */
export function escapeProperty(text: string): string {
    return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** A backtick fence longer than any backtick run in `text`, so the text cannot close it. */
export function fenceFor(text: string): string {
    const needed = (text.match(/`+/g) ?? []).map(run => run.length + 1);
    return '`'.repeat(Math.max(3, ...needed));
}

function snippet(text: string): string {
    const oneLine = text.replaceAll(/\s+/g, ' ').trim();
    return oneLine.length > MAX_REPLACEMENT_IN_ANNOTATION ? `${oneLine.slice(0, MAX_REPLACEMENT_IN_ANNOTATION)}…` : oneLine;
}

function annotationFor(s: Survivor): string {
    return `::error file=${escapeProperty(s.file)},line=${s.line},col=${s.column}::${escapeData(`Mutant survived under the current toolchain: ${s.mutator} (${s.status}) replaced with ${snippet(s.replacement)}`)}`;
}

/** Everything the CLI needs after a `finish` decision. */
export type FinishResult = {
    /** 0 re-earned, 1 survivors found, 2 not a threshold failure (nothing changed). */
    exitCode:    0 | 1 | 2
    summary:     string
    message:     string
    annotations: string[]
} & (
    /** Save: the report and meta to write back before the cache is saved. */
    { save: true, report: unknown, meta: BaselineMeta }
    /** Nothing changed; nothing to write or save. */
    | { save: false }
);

/** Inputs of {@link finishSlice}. */
export interface FinishInput {
    /** The parsed incremental report; undefined when the file is missing or unparseable. */
    report:      unknown
    strykerExit: number
    slice:       number
    meta:        BaselineMeta
    fingerprint: string
    runId:       string
    now:         Date
}

/**
 * Finishes a forced slice refresh: strips every Survived / NoCoverage mutant from the
 * incremental report, stamps the slice, and says whether the result is worth saving. A
 * non-zero Stryker exit with no survivors (a crash, a failed dry run), or an unusable
 * report, changes nothing and is exit 2.
 * @param input - Report, Stryker exit code, slice, meta, fingerprint, run id and the current time
 * @returns The decision with the report and meta to write, the summary and annotations
 */
export function finishSlice(input: FinishInput): FinishResult {
    const collected = collectSurvivors(input.report);
    if(collected === undefined || (input.strykerExit !== 0 && collected.survivors.length === 0)) {
        const reason = collected === undefined
            ? 'the incremental report is missing or unreadable'
            : `Stryker exited ${input.strykerExit} without any Survived or NoCoverage mutant, so this is not a threshold failure`;
        const message = `Slice ${input.slice} not saved: ${reason}.`;
        return { exitCode: 2, save: false, summary: `${message}\n`, message, annotations: [] };
    }

    const { total, survivors } = collected;
    const meta: BaselineMeta = {
        ...input.meta,
        slices: {
            ...input.meta.slices,
            [String(input.slice)]: { fingerprint: input.fingerprint, refreshedAt: input.now.toISOString(), runId: input.runId },
        },
    };
    const report = dropSurvivors(input.report);

    if(survivors.length === 0) {
        const message = `slice ${input.slice} re-earned: ${total} mutants, 0 survivors`;
        return { exitCode: 0, save: true, report, meta, summary: `${message}\n`, message, annotations: [] };
    }

    const message = `Slice ${input.slice} refreshed with ${survivors.length} mutant(s) surviving under the current toolchain`;
    const lines = [
        `## Mutation baseline refresh: slice ${input.slice}`,
        '',
        `**${message}.** They were removed from the saved baseline; kill them with tests or the next gate run re-executes them.`,
    ];
    for(const s of survivors) {
        const fence = fenceFor(s.replacement);
        lines.push('', `${s.file}:${s.line}:${s.column}  ${s.mutator}  ${s.status}`, '', fence, s.replacement, fence);
    }
    if(survivors.length > MAX_ANNOTATIONS) {
        lines.push('', `Annotations are capped at ${MAX_ANNOTATIONS}; every survivor is listed above.`);
    }
    return {
        exitCode:    1,
        save:        true,
        report,
        meta,
        summary:     `${lines.join('\n')}\n`,
        message,
        annotations: survivors.slice(0, MAX_ANNOTATIONS).map(s => annotationFor(s)),
    };
}

/** The command-line arguments after parsing. */
export interface CliArgs {
    command:         'gate' | 'pick' | 'finish'
    slice:           number
    strykerExit:     number
    incrementalPath: string
    metaPath:        string
}

/** Result of {@link parseArgs}. */
export type ParsedArgs = { ok: true, args: CliArgs } | { ok: false, message: string };

/** Usage text printed on a bad command line. */
export const USAGE = 'Usage: bun tools/mutation-baseline.ts <gate|pick|finish --slice <0-13> --stryker-exit <code>> [--incremental <path>] [--meta <path>]';

export const DEFAULT_INCREMENTAL_PATH = 'reports/stryker-incremental.json';
export const DEFAULT_META_PATH = 'reports/stryker-baseline-meta.json';

function parseCount(text: string | undefined, max = Infinity): number | undefined {
    if(text === undefined || !/^\d+$/.test(text)) {
        return undefined;
    }
    const value = Number(text);
    return value <= max ? value : undefined;
}

/**
 * Parses `argv` (including the leading runtime and script entries).
 * @param argv - `process.argv`
 * @returns The arguments, or an error message
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
    const command = argv[2];
    if(command !== 'gate' && command !== 'pick' && command !== 'finish') {
        return { ok: false, message: USAGE };
    }
    const flags = new Map<string, string>();
    for(let i = 3; i < argv.length; i += 2) {
        const flag = argv[i];
        const value = argv.at(i + 1);
        if(!['--slice', '--stryker-exit', '--incremental', '--meta'].includes(flag) || value === undefined) {
            return { ok: false, message: USAGE };
        }
        flags.set(flag, value);
    }
    const slice = parseCount(flags.get('--slice'), SLICE_COUNT - 1);
    const strykerExit = parseCount(flags.get('--stryker-exit'));
    if(command === 'finish' && (slice === undefined || strykerExit === undefined)) {
        return { ok: false, message: USAGE };
    }
    return {
        ok:   true,
        args: {
            command,
            slice:           slice ?? 0,
            strykerExit:     strykerExit ?? 0,
            incrementalPath: flags.get('--incremental') ?? DEFAULT_INCREMENTAL_PATH,
            metaPath:        flags.get('--meta') ?? DEFAULT_META_PATH,
        },
    };
}
