/* eslint-disable n/no-sync -- real filesystem fixtures: node:fs/promises is globally mocked in tests/setup.ts (see makeRealTempDir) */
import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type CliDeps, EXIT_USAGE, createDefaultDeps, runCli } from '../../../tools/mutation-baseline';
import { SEED_COMMAND, USAGE, loadMeta, serializeMeta } from '../../../tools/mutation-baseline-core';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const NOW_ISO = '2026-11-17T12:00:00.000Z';
const FP = 'Linux-bun1.4.4-lockaaaa';
const OLD_FP = 'Linux-bun1.4.3-lockbbbb';
const GLOBS = ['src/**/*.ts', '!src/index.ts', 'tools/**/*.ts'];
/** src/f7.ts is slice 0, src/f14.ts slice 1 (see the core tests' fixture table). */
const UNIVERSE = ['src/f7.ts', 'src/f14.ts'];

/**
 * Creates a real, process-unique temp dir (node:fs/promises is mocked in tests/setup.ts, so
 * mkdtemp/rm from it would not touch the disk).
 * @returns The absolute path of the new directory
 */
function makeRealTempDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'mutation-baseline-'));
}

interface Harness {
    deps:        CliDeps
    /** While `on`, writeText and appendText stay pending until their resolver is taken from `pending`. */
    hold:        { on: boolean }
    pending:     (() => void)[]
    /** Every writeText/appendText call, in call order, as `write:<path>` / `append:<path>`. */
    ops:         string[]
    files:       Map<string, string>
    stdout:      string[]
    stderr:      string[]
    /** Every writeText path, in call order. */
    written:     string[]
    listed:      (readonly string[])[]
    loadedGlobs: { count: number }
}

function harness(env: Record<string, string | undefined>, files: Record<string, string> = {}, universe: string[] = UNIVERSE): Harness {
    const store = new Map(Object.entries(files));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const written: string[] = [];
    const listed: (readonly string[])[] = [];
    const loadedGlobs = { count: 0 };
    const hold = { on: false };
    const pending: (() => void)[] = [];
    const ops: string[] = [];
    const settle = async (): Promise<void> => {
        if(hold.on) {
            await new Promise<void>((resolve) => {
                pending.push(resolve);
            });
        }
    };
    const deps: CliDeps = {
        env,
        now:       () => NOW,
        readText:  async file => store.get(file),
        writeText: async (file, data) => {
            written.push(file);
            ops.push(`write:${file}`);
            store.set(file, data);
            await settle();
        },
        appendText: async (file, data) => {
            ops.push(`append:${file}`);
            store.set(file, `${store.get(file) ?? ''}${data}`);
            await settle();
        },
        stdout:          (text) => { stdout.push(text); },
        stderr:          (text) => { stderr.push(text); },
        loadMutateGlobs: async () => {
            loadedGlobs.count += 1;
            return GLOBS;
        },
        listFiles: async (patterns) => {
            listed.push(patterns);
            return universe;
        },
    };
    return { deps, hold, pending, ops, files: store, stdout, stderr, written, listed, loadedGlobs };
}

/** Flushes enough microtask ticks for promise chains to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

/**
 * Runs the CLI with every write/append held open and releases them one at a time. Each write
 * must be awaited before the next begins and before the CLI returns, so at most one is ever
 * pending and the CLI is still running while it is.
 * @returns The exit code
 */
async function runSerially(h: Harness, args: string[]): Promise<number> {
    h.hold.on = true;
    let exit: number | undefined;
    const running = (async (): Promise<void> => {
        exit = await runCli(args, h.deps);
    })();
    for(;;) {
        // eslint-disable-next-line no-await-in-loop -- steps must be released one at a time
        await flush();
        if(h.pending.length === 0) {
            break;
        }
        expect(h.pending).toHaveLength(1);
        expect(exit).toBeUndefined();
        h.pending.shift()?.();
    }
    await running;
    return exit ?? -1;
}

const argv = (...rest: string[]) => ['bun', 'tools/mutation-baseline.ts', ...rest];
const META = 'reports/stryker-baseline-meta.json';
const INCREMENTAL = 'reports/stryker-incremental.json';

function metaText(slices: Record<string, unknown> = {}): string {
    return JSON.stringify({ schema: 1, sliceCount: 14, slices });
}

const stampOf = (fingerprint: string, refreshedAt: string, runId = '1') => ({ fingerprint, refreshedAt, runId });

function incremental(...statuses: string[]): string {
    return JSON.stringify({
        schemaVersion: '2',
        files:         {
            'src/a.ts': { language: 'typescript', mutants: statuses.map((status, i) => ({ id: String(i), mutatorName: 'M', replacement: 'r', location: { start: { line: 1, column: 2 }, end: { line: 1, column: 3 } }, status })) },
        },
    });
}

describe('runCli: command line', () => {
    test('a bad command line prints the usage to stderr and exits 64 without touching anything', async () => {
        const h = harness({ FINGERPRINT: FP });
        expect(await runCli(argv('bogus'), h.deps)).toBe(EXIT_USAGE);
        expect(EXIT_USAGE).toBe(64);
        expect(h.stderr).toEqual([`${USAGE}\n`]);
        expect(h.stdout).toEqual([]);
        expect(h.written).toEqual([]);
        expect(h.loadedGlobs.count).toBe(0);
    });

    test.each([['unset', undefined], ['empty', '']])('a %s FINGERPRINT exits 64 without touching anything', async (_name, fingerprint) => {
        const h = harness({ FINGERPRINT: fingerprint });
        expect(await runCli(argv('gate'), h.deps)).toBe(64);
        expect(h.stderr).toEqual(['FINGERPRINT is required\n']);
        expect(h.written).toEqual([]);
        expect(h.loadedGlobs.count).toBe(0);
    });
});

describe('runCli: gate', () => {
    const stamps = { '0': stampOf(FP, '2026-11-16T00:00:00.000Z'), '1': stampOf(FP, '2026-11-16T01:00:00.000Z') };

    test('green: resolves the universe from the mutate globs, appends the summary, prints the status and writes nothing else', async () => {
        const text = metaText(stamps);
        const h = harness({ FINGERPRINT: FP, MATCHED_KEY: `stryker-incremental-v2-${FP}-develop-abc-1-1`, GITHUB_STEP_SUMMARY: 'summary.md' }, {
            [META]:       text,
            'summary.md': 'earlier\n',
        });
        expect(await runCli(argv('gate'), h.deps)).toBe(0);
        expect(h.listed).toEqual([['src/**/*.ts', 'tools/**/*.ts']]);
        expect(h.written).toEqual([]);
        expect(h.files.get(META)).toBe(text);
        expect(h.files.get('summary.md')).toStartWith('earlier\n## Mutation baseline\n');
        expect(h.files.get('summary.md')).toContain('| 0 | 1 | current | 2026-11-16T00:00:00.000Z | 1 |');
        expect(h.files.get('summary.md')).toEndWith('|\n\n');
        expect(h.stdout).toEqual(['Baseline provenance ok\n']);
    });

    test('passes MATCHED_KEY to the gate; an inherited baseline within 10 days is green and the meta is left alone', async () => {
        const text = metaText({ '0': stampOf(OLD_FP, '2026-11-10T00:00:00.000Z'), '1': stampOf(OLD_FP, '2026-11-10T00:00:00.000Z') });
        const h = harness({ FINGERPRINT: FP, MATCHED_KEY: `stryker-incremental-v2-${OLD_FP}-develop-abc-1-1`, GITHUB_STEP_SUMMARY: 'summary.md' }, { [META]: text });
        expect(await runCli(argv('gate'), h.deps)).toBe(0);
        expect(h.files.get(META)).toBe(text);
        expect(h.files.get('summary.md')).toContain(`**Baseline inherited from toolchain ${OLD_FP}**`);
    });

    test('an unset MATCHED_KEY reads as none', async () => {
        const h = harness({ FINGERPRINT: FP }, { [META]: metaText(stamps) });
        await runCli(argv('gate'), h.deps);
        expect(h.stdout.join('')).toContain('- Matched cache key: none\n');
    });

    test('with no GITHUB_STEP_SUMMARY (unset or empty) the summary goes to stdout before the status line', async () => {
        for(const summary of [undefined, '']) {
            const h = harness({ FINGERPRINT: FP, GITHUB_STEP_SUMMARY: summary }, { [META]: metaText(stamps) });
            // eslint-disable-next-line no-await-in-loop -- two fixed iterations
            expect(await runCli(argv('gate'), h.deps)).toBe(0);
            expect(h.stdout).toHaveLength(2);
            expect(h.stdout[0]).toStartWith('## Mutation baseline\n');
            expect(h.stdout[1]).toBe('Baseline provenance ok\n');
        }
    });

    test('incomplete: exit 1, the ::error:: line on stdout after the status, and no meta file is created', async () => {
        const h = harness({ FINGERPRINT: FP, GITHUB_STEP_SUMMARY: 'summary.md' });
        expect(await runCli(argv('gate'), h.deps)).toBe(1);
        const message = `BASELINE INCOMPLETE: slice(s) 0, 1 have never been refreshed. A seed is in progress or needed: ${SEED_COMMAND}`;
        expect(h.stdout).toEqual([`${message}\n`, `::error::${message}\n`]);
        expect(h.written).toEqual([]);
        expect(h.files.has(META)).toBe(false);
    });

    test('overdue: exit 1 with one ::error:: line, meta untouched', async () => {
        const text = metaText({ '0': stampOf(OLD_FP, '2026-10-01T00:00:00.000Z'), '1': stampOf(FP, '2026-11-16T00:00:00.000Z') });
        const h = harness({ FINGERPRINT: FP, GITHUB_STEP_SUMMARY: 'summary.md' }, { [META]: text });
        expect(await runCli(argv('gate'), h.deps)).toBe(1);
        expect(h.stdout).toHaveLength(2);
        expect(h.stdout[1]).toStartWith('::error::BASELINE OVERDUE: ');
        expect(h.files.get(META)).toBe(text);
        expect(h.written).toEqual([]);
    });

    test('--meta overrides the meta path', async () => {
        const h = harness({ FINGERPRINT: FP, GITHUB_STEP_SUMMARY: 's.md' }, { 'alt/meta.json': metaText(stamps) });
        expect(await runCli(argv('gate', '--meta', 'alt/meta.json'), h.deps)).toBe(0);
        expect(h.files.has(META)).toBe(false);
    });

    test('--meta is where the stamps are read from: the default path is ignored when --meta is given', async () => {
        const h = harness({ FINGERPRINT: FP, GITHUB_STEP_SUMMARY: 's.md' }, { [META]: metaText(stamps) });
        expect(await runCli(argv('gate', '--meta', 'alt/meta.json'), h.deps)).toBe(1);
    });
});

describe('runCli: pick', () => {
    test('writes slice and globs to GITHUB_OUTPUT and the summary line to the step summary, leaving the meta file alone', async () => {
        const text = metaText({ '0': stampOf(FP, '2026-11-01T00:00:00.000Z') });
        const h = harness({ FINGERPRINT: FP, GITHUB_OUTPUT: 'out.txt', GITHUB_STEP_SUMMARY: 'summary.md' }, {
            [META]:    text,
            'out.txt': 'earlier=1\n',
        });
        expect(await runCli(argv('pick'), h.deps)).toBe(0);
        expect(h.files.get('out.txt')).toBe('earlier=1\nslice=1\nglobs=src/f14.ts\n');
        expect(h.files.get('summary.md')).toBe('Refreshing slice 1 (never refreshed, 1 files)\n\n');
        expect(h.stdout).toEqual(['Refreshing slice 1 (never refreshed, 1 files)\n']);
        expect(h.written).toEqual([]);
        expect(h.files.get(META)).toBe(text);
    });

    test('with no GITHUB_OUTPUT or GITHUB_STEP_SUMMARY, outputs and summary go to stdout', async () => {
        const h = harness({ FINGERPRINT: FP });
        expect(await runCli(argv('pick'), h.deps)).toBe(0);
        expect(h.stdout).toEqual(['slice=0\nglobs=src/f7.ts\n', 'Refreshing slice 0 (never refreshed, 1 files)\n', 'Refreshing slice 0 (never refreshed, 1 files)\n']);
        expect(h.written).toEqual([]);
    });

    test('an empty GITHUB_OUTPUT counts as unset', async () => {
        const h = harness({ FINGERPRINT: FP, GITHUB_OUTPUT: '' });
        await runCli(argv('pick'), h.deps);
        expect(h.stdout[0]).toBe('slice=0\nglobs=src/f7.ts\n');
    });

    test('an empty universe exits 1 and writes no outputs', async () => {
        const h = harness({ FINGERPRINT: FP, GITHUB_OUTPUT: 'out.txt', GITHUB_STEP_SUMMARY: 's.md' }, {}, []);
        expect(await runCli(argv('pick'), h.deps)).toBe(1);
        expect(h.files.get('out.txt')).toBe('');
    });
});

describe('runCli: finish', () => {
    const finishArgs = (...extra: string[]) => argv('finish', '--slice', '5', '--stryker-exit', '0', ...extra);
    const env = { FINGERPRINT: FP, GITHUB_RUN_ID: '4242', GITHUB_OUTPUT: 'out.txt', GITHUB_STEP_SUMMARY: 'summary.md' };

    test('clean slice: writes the incremental report, then meta with the stamp, save=true, summary line, exit 0', async () => {
        const h = harness(env, {
            [INCREMENTAL]: incremental('Killed', 'Timeout'),
            [META]:        metaText({ '1': stampOf(OLD_FP, '2026-11-01T00:00:00.000Z', 'x') }),
        });
        expect(await runCli(finishArgs(), h.deps)).toBe(0);
        expect(h.written).toEqual([INCREMENTAL, META]);
        expect(JSON.parse(h.files.get(INCREMENTAL) ?? '')).toEqual(JSON.parse(incremental('Killed', 'Timeout')));
        expect(loadMeta(h.files.get(META)).slices).toEqual({ '1': stampOf(OLD_FP, '2026-11-01T00:00:00.000Z', 'x'), '5': stampOf(FP, NOW_ISO, '4242') });
        expect(h.files.get('out.txt')).toBe('save=true\n');
        expect(h.files.get('summary.md')).toBe('slice 5 re-earned: 2 mutants, 0 survivors\n\n');
        expect(h.stdout).toEqual(['slice 5 re-earned: 2 mutants, 0 survivors\n']);
    });

    test('survivors: removed from the written report, annotations on stdout, exit 1, save=true', async () => {
        const h = harness(env, { [INCREMENTAL]: incremental('Killed', 'Survived', 'NoCoverage') });
        expect(await runCli(argv('finish', '--slice', '5', '--stryker-exit', '1'), h.deps)).toBe(1);
        const written = JSON.parse(h.files.get(INCREMENTAL) ?? '') as { files: Record<string, { mutants: { status: string }[] }> };
        expect(written.files['src/a.ts']?.mutants.map(m => m.status)).toEqual(['Killed']);
        expect(h.files.get('out.txt')).toBe('save=true\n');
        expect(h.stdout[0]).toBe('Slice 5 refreshed with 2 mutant(s) surviving under the current toolchain\n');
        expect(h.stdout.slice(1)).toEqual([
            '::error file=src/a.ts,line=1,col=2::Mutant survived under the current toolchain: M (Survived) replaced with r\n',
            '::error file=src/a.ts,line=1,col=2::Mutant survived under the current toolchain: M (NoCoverage) replaced with r\n',
        ]);
        expect(h.files.get('summary.md')).toContain('src/a.ts:1:2  M  Survived');
        expect(loadMeta(h.files.get(META)).slices['5']).toEqual(stampOf(FP, NOW_ISO, '4242'));
    });

    test('not a threshold failure: nothing written, save=false, reason printed, exit 2', async () => {
        const h = harness(env, { [INCREMENTAL]: incremental('Killed') });
        expect(await runCli(argv('finish', '--slice', '5', '--stryker-exit', '1'), h.deps)).toBe(2);
        expect(h.written).toEqual([]);
        expect(h.files.get('out.txt')).toBe('save=false\n');
        expect(h.stdout).toEqual(['Slice 5 not saved: Stryker exited 1 without any Survived or NoCoverage mutant, so this is not a threshold failure.\n']);
    });

    test.each([['missing', undefined], ['unparseable', '{truncated']])('a %s incremental file is exit 2 with nothing written', async (_name, text) => {
        const h = harness(env, text === undefined ? {} : { [INCREMENTAL]: text });
        expect(await runCli(finishArgs(), h.deps)).toBe(2);
        expect(h.written).toEqual([]);
        expect(h.files.get('out.txt')).toBe('save=false\n');
    });

    test('a missing meta file starts from an empty meta; an unset GITHUB_RUN_ID stamps local', async () => {
        const h = harness({ FINGERPRINT: FP }, { [INCREMENTAL]: incremental('Killed') });
        expect(await runCli(finishArgs(), h.deps)).toBe(0);
        expect(loadMeta(h.files.get(META)).slices).toEqual({ '5': stampOf(FP, NOW_ISO, 'local') });
        expect(h.stdout.join('')).toContain('save=true\n');
    });

    test('--incremental and --meta override the paths', async () => {
        const h = harness(env, { 'alt/inc.json': incremental('Killed') });
        expect(await runCli(finishArgs('--incremental', 'alt/inc.json', '--meta', 'alt/meta.json'), h.deps)).toBe(0);
        expect(h.written).toEqual(['alt/inc.json', 'alt/meta.json']);
    });

    test('finish does not resolve the file universe', async () => {
        const h = harness(env, { [INCREMENTAL]: incremental('Killed') });
        await runCli(finishArgs(), h.deps);
        expect(h.loadedGlobs.count).toBe(0);
        expect(h.listed).toEqual([]);
    });

    test('finish needs --slice and --stryker-exit', async () => {
        const h = harness(env);
        expect(await runCli(argv('finish'), h.deps)).toBe(64);
        expect(h.stderr).toEqual([`${USAGE}\n`]);
    });

    test('a legacy toolchain key on disk is dropped when finish rewrites the meta', async () => {
        const legacy = JSON.stringify({ schema: 1, sliceCount: 14, toolchain: { fingerprint: OLD_FP, since: NOW_ISO }, slices: {} });
        const h = harness(env, { [INCREMENTAL]: incremental('Killed'), [META]: legacy });
        expect(await runCli(finishArgs(), h.deps)).toBe(0);
        expect(h.files.get(META)).not.toContain('toolchain');
    });

    test('the meta is written in the canonical format', async () => {
        const h = harness(env, { [INCREMENTAL]: incremental('Killed') });
        await runCli(finishArgs(), h.deps);
        expect(h.files.get(META)).toBe(serializeMeta(loadMeta(h.files.get(META))));
    });
});

describe('runCli: every write is awaited, in order', () => {
    const env = { FINGERPRINT: FP, GITHUB_RUN_ID: '1', GITHUB_OUTPUT: 'out.txt', GITHUB_STEP_SUMMARY: 'summary.md' };

    test('gate: the summary only', async () => {
        const h = harness(env);
        expect(await runSerially(h, argv('gate'))).toBe(1);
        expect(h.ops).toEqual(['append:summary.md']);
    });

    test('pick: outputs, then summary', async () => {
        const h = harness(env);
        expect(await runSerially(h, argv('pick'))).toBe(0);
        expect(h.ops).toEqual(['append:out.txt', 'append:summary.md']);
    });

    test('finish with a save: incremental, meta, save output, summary', async () => {
        const h = harness(env, { [INCREMENTAL]: incremental('Killed') });
        expect(await runSerially(h, argv('finish', '--slice', '5', '--stryker-exit', '0'))).toBe(0);
        expect(h.ops).toEqual([`write:${INCREMENTAL}`, `write:${META}`, 'append:out.txt', 'append:summary.md']);
    });

    test('finish without a save: save output, then summary', async () => {
        const h = harness(env, { [INCREMENTAL]: incremental('Killed') });
        expect(await runSerially(h, argv('finish', '--slice', '5', '--stryker-exit', '1'))).toBe(2);
        expect(h.ops).toEqual(['append:out.txt', 'append:summary.md']);
    });
});

describe('createDefaultDeps', () => {
    test('reads the real environment and clock', () => {
        const deps = createDefaultDeps();
        expect(deps.env).toBe(process.env);
        expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(5000);
    });

    test('readText returns undefined for a missing file and the text for an existing one', async () => {
        const dir = makeRealTempDir();
        try {
            const deps = createDefaultDeps();
            await Bun.write(path.join(dir, 'f.txt'), 'hello');
            expect(await deps.readText(path.join(dir, 'f.txt'))).toBe('hello');
            expect(await deps.readText(path.join(dir, 'nope.txt'))).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('writeText replaces the file atomically, creating parent directories and leaving no temp file', async () => {
        const dir = makeRealTempDir();
        try {
            const deps = createDefaultDeps();
            const target = path.join(dir, 'nested', 'f.json');
            await deps.writeText(target, 'one');
            await deps.writeText(target, 'two');
            expect(await Bun.file(target).text()).toBe('two');
            expect([...new Bun.Glob('*').scanSync(path.join(dir, 'nested'))]).toEqual(['f.json']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('appendText creates a missing file and appends to an existing one', async () => {
        const dir = makeRealTempDir();
        try {
            const deps = createDefaultDeps();
            const target = path.join(dir, 'summary.md');
            await deps.appendText(target, 'a\n');
            await deps.appendText(target, 'b\n');
            expect(await Bun.file(target).text()).toBe('a\nb\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('listFiles scans each glob from the repo root and de-duplicates', async () => {
        const files = await createDefaultDeps().listFiles(['tools/mutation-baseline*.ts', 'tools/mutation-baseline.ts']);
        expect(files.toSorted((a, b) => a.localeCompare(b))).toEqual(['tools/mutation-baseline-core.ts', 'tools/mutation-baseline.ts']);
    });

    test('stdout and stderr write to the process streams', () => {
        const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
        const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const deps = createDefaultDeps();
            deps.stdout('o');
            deps.stderr('e');
            expect(out).toHaveBeenCalledWith('o');
            expect(err).toHaveBeenCalledWith('e');
        } finally {
            out.mockRestore();
            err.mockRestore();
        }
    });
});

describe('main entry', () => {
    test('running the file as a script reports a usage error through the exit code', async () => {
        const subprocess = Bun.spawn(['bun', 'tools/mutation-baseline.ts', 'bogus'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
        expect(exitCode).toBe(64);
        expect(stderr).toBe(`${USAGE}\n`);
    });

    test('importing the module does not run the CLI', async () => {
        const originalArgv = process.argv;
        const originalExitCode = process.exitCode;
        const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
        process.argv = ['bun', 'mutation-baseline.ts', 'bogus'];
        try {
            // @ts-expect-error -- Bun resolves this cache-busting query-string specifier at runtime; tsc cannot.
            // ast-grep-ignore: no-test-dynamic-await-import -- query makes this a fresh in-process entrypoint evaluation.
            await import('../../../tools/mutation-baseline.ts?import-test=guard');
            expect(err).not.toHaveBeenCalled();
            expect(process.exitCode).toBe(originalExitCode);
        } finally {
            process.argv = originalArgv;
            err.mockRestore();
        }
    });
});
