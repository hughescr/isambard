import { describe, test, expect, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneStaticSurvivors, runCli } from '../../../tools/prune-static-survivors';

/** Flushes enough microtask ticks for promise chains to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

describe('pruneStaticSurvivors', () => {
    test('removes a static Survived mutant', () => {
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Survived' }] } } };
        expect(pruneStaticSurvivors(report)).toEqual({
            report:  { files: { 'a.ts': { mutants: [] } } },
            removed: 1,
        });
    });

    test('removes a static NoCoverage mutant', () => {
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'NoCoverage' }] } } };
        expect(pruneStaticSurvivors(report)).toEqual({
            report:  { files: { 'a.ts': { mutants: [] } } },
            removed: 1,
        });
    });

    test('keeps a static Killed mutant', () => {
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Killed' }] } } };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('keeps a non-static Survived mutant', () => {
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': false, status: 'Survived' }] } } };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('preserves order of remaining mutants and files, across multiple files', () => {
        const report = {
            files: {
                'a.ts': {
                    mutants: [
                        { id: '1', 'static': true, status: 'Survived' },
                        { id: '2', 'static': false, status: 'Survived' },
                        { id: '3', 'static': true, status: 'Killed' },
                        { id: '4', 'static': true, status: 'NoCoverage' },
                    ],
                },
                'b.ts': {
                    mutants: [{ id: '5', 'static': false, status: 'Killed' }],
                },
            },
        };
        const result = pruneStaticSurvivors(report);
        expect(result).toEqual({
            report: {
                files: {
                    'a.ts': {
                        mutants: [
                            { id: '2', 'static': false, status: 'Survived' },
                            { id: '3', 'static': true, status: 'Killed' },
                        ],
                    },
                    'b.ts': {
                        mutants: [{ id: '5', 'static': false, status: 'Killed' }],
                    },
                },
            },
            removed: 2,
        });
        expect(Object.keys((result.report as { files: Record<string, unknown> }).files)).toEqual(['a.ts', 'b.ts']);
    });

    test('an empty files map is left unchanged', () => {
        const report = { files: {} };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('a file entry with no mutants array is left unchanged', () => {
        const report = { files: { 'a.ts': { language: 'typescript' } } };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('a missing top-level files key is tolerated', () => {
        const report = { schemaVersion: '1.0' };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('an undefined report is tolerated', () => {
        expect(pruneStaticSurvivors(undefined)).toEqual({ report: undefined, removed: 0 });
    });

    test('a null report is tolerated', () => {
        expect(pruneStaticSurvivors(null)).toEqual({ report: null, removed: 0 });
    });

    test('an empty object report is tolerated', () => {
        const report = {};
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('a non-object entry in a mutants array is kept as-is, not mistaken for a stale static mutant', () => {
        const report = { files: { 'a.ts': { mutants: [null, { id: '1', 'static': true, status: 'Survived' }] } } };
        expect(pruneStaticSurvivors(report)).toEqual({
            report:  { files: { 'a.ts': { mutants: [null] } } },
            removed: 1,
        });
    });

    test('an undefined entry in a mutants array is kept as-is (property access on it must not throw)', () => {
        const report = { files: { 'a.ts': { mutants: [undefined, { id: '1', 'static': true, status: 'Survived' }] } } };
        expect(pruneStaticSurvivors(report)).toEqual({
            report:  { files: { 'a.ts': { mutants: [undefined] } } },
            removed: 1,
        });
    });

    test('a null files map is tolerated (typeof null is "object", so Object.entries(null) must never run)', () => {
        const report = { files: null };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('a null file entry is left unchanged, not mistaken for a mutants-bearing object', () => {
        const report = { files: { 'a.ts': null } };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('an undefined file entry is left unchanged (property access on it must not throw)', () => {
        const report = { files: { 'a.ts': undefined } };
        expect(pruneStaticSurvivors(report)).toEqual({ report, removed: 0 });
    });

    test('reuses the exact same report and file-entry references when nothing needs pruning', () => {
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Killed' }] } } };
        const result = pruneStaticSurvivors(report);
        expect(result.report).toBe(report);
        expect((result.report as { files: Record<string, unknown> }).files['a.ts']).toBe(report.files['a.ts']);
    });

    test('other top-level and per-file fields are preserved untouched', () => {
        const report = {
            schemaVersion: '1.0',
            thresholds:    { high: 80 },
            files:         {
                'a.ts': { language: 'typescript', mutants: [{ id: '1', 'static': true, status: 'Survived' }] },
            },
        };
        expect(pruneStaticSurvivors(report)).toEqual({
            report: {
                schemaVersion: '1.0',
                thresholds:    { high: 80 },
                files:         {
                    'a.ts': { language: 'typescript', mutants: [] },
                },
            },
            removed: 1,
        });
    });
});

describe('runCli', () => {
    test('no-ops silently when the file does not exist', async () => {
        const readFile = mock(async (): Promise<string> => {
            throw new Error('must not read');
        });
        const writeFile = mock(async () => {});
        const rename = mock(async () => {});
        const write = mock(() => {});
        await runCli(['bun', 'script.ts', '/does/not/exist.json'], {
            fileExists: async () => false,
            readFile,
            writeFile,
            rename,
            write,
        });
        expect(readFile).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    test('uses the default path when argv has no path argument', async () => {
        let sawPath: string | undefined;
        await runCli(['bun', 'script.ts'], {
            fileExists: async (p) => {
                sawPath = p;
                return false;
            },
        });
        expect(sawPath).toBe('reports/stryker-incremental.json');
    });

    test('uses the given path from argv[2]', async () => {
        let sawPath: string | undefined;
        await runCli(['bun', 'script.ts', 'custom/path.json'], {
            fileExists: async (p) => {
                sawPath = p;
                return false;
            },
        });
        expect(sawPath).toBe('custom/path.json');
    });

    test('prunes, writes atomically via temp file + rename, and prints a message when mutants are removed', async () => {
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Survived' }] } } };
        let writtenPath: string | undefined;
        let writtenData: string | undefined;
        let renamedFrom: string | undefined;
        let renamedTo: string | undefined;
        const writes: string[] = [];

        await runCli(['bun', 'script.ts', 'reports/x.json'], {
            fileExists: async () => true,
            readFile:   async () => JSON.stringify(report),
            writeFile:  async (p, data) => {
                writtenPath = p;
                writtenData = data;
            },
            rename: async (from, to) => {
                renamedFrom = from;
                renamedTo = to;
            },
            write: (t) => { writes.push(t); },
        });

        expect(writtenPath).toBe(renamedFrom);
        expect(renamedTo).toBe('reports/x.json');
        expect(writtenPath).not.toBe('reports/x.json');
        expect(JSON.parse(writtenData ?? 'null')).toEqual({ files: { 'a.ts': { mutants: [] } } });
        expect(writes).toEqual(['pruned 1 stale static mutant verdict(s) from reports/x.json\n']);
    });

    test('does not write or rename when nothing is removed', async () => {
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Killed' }] } } };
        const writeFile = mock(async () => {});
        const rename = mock(async () => {});
        const write = mock(() => {});
        await runCli(['bun', 'script.ts', 'reports/x.json'], {
            fileExists: async () => true,
            readFile:   async () => JSON.stringify(report),
            writeFile,
            rename,
            write,
        });
        expect(writeFile).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    test('propagates a JSON parse error so the caller (and `set -e`) can fail loudly', async () => {
        await expect(runCli(['bun', 'script.ts', 'bad.json'], {
            fileExists: async () => true,
            readFile:   async () => 'not json',
        })).rejects.toThrow();
    });

    test('default deps perform real atomic file IO end-to-end against a temp file', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'prune-static-survivors-'));
        const filePath = path.join(dir, 'incremental.json');
        const report = {
            files: {
                'a.ts': {
                    mutants: [
                        { id: '1', 'static': true, status: 'Survived' },
                        { id: '2', 'static': true, status: 'Killed' },
                    ],
                },
            },
        };
        try {
            await Bun.write(filePath, JSON.stringify(report));

            const writes: string[] = [];
            await runCli(['bun', 'script.ts', filePath], {
                write: (t) => { writes.push(t); },
            });

            const written: unknown = JSON.parse(await Bun.file(filePath).text());
            expect(written).toEqual({ files: { 'a.ts': { mutants: [{ id: '2', 'static': true, status: 'Killed' }] } } });
            expect(writes).toEqual([`pruned 1 stale static mutant verdict(s) from ${filePath}\n`]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('the default write writer goes to process.stdout.write', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'prune-static-survivors-'));
        const filePath = path.join(dir, 'incremental.json');
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await Bun.write(filePath, JSON.stringify({ files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Survived' }] } } }));
            await runCli(['bun', 'script.ts', filePath]);
            expect(stdoutSpy).toHaveBeenCalled();
        } finally {
            stdoutSpy.mockRestore();
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('the actual CLI main entry prunes the requested report', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'prune-static-survivors-'));
        const filePath = path.join(dir, 'incremental.json');
        try {
            await Bun.write(filePath, JSON.stringify({
                files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Survived' }] } },
            }));
            const subprocess = Bun.spawn(['bun', 'tools/prune-static-survivors.ts', filePath], {
                cwd:    process.cwd(),
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const [exitCode, stdout] = await Promise.all([
                subprocess.exited,
                new Response(subprocess.stdout).text(),
            ]);

            expect(exitCode).toBe(0);
            expect(stdout).toBe(`pruned 1 stale static mutant verdict(s) from ${filePath}\n`);
            expect(JSON.parse(await Bun.file(filePath).text())).toEqual({ files: { 'a.ts': { mutants: [] } } });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('importing the CLI entrypoint does not prune process.argv[2]', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'prune-static-survivors-'));
        const filePath = path.join(dir, 'incremental.json');
        const originalArgv = process.argv;
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Survived' }] } } };
        process.argv = ['bun', 'prune-static-survivors.ts', filePath];
        try {
            await Bun.write(filePath, JSON.stringify(report));
            // @ts-expect-error -- Bun resolves this cache-busting query-string specifier at runtime; tsc cannot.
            // eslint-disable-next-line no-restricted-syntax -- query makes this a fresh in-process entrypoint evaluation.
            await import('../../../tools/prune-static-survivors.ts?import-test=guard');

            expect(stdoutSpy).not.toHaveBeenCalled();
            expect(JSON.parse(await Bun.file(filePath).text())).toEqual(report);
        } finally {
            // eslint-disable-next-line require-atomic-updates -- restore the process-global argv before this test returns.
            process.argv = originalArgv;
            stdoutSpy.mockRestore();
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('awaits deps.writeFile before renaming, so a slow write cannot race the rename', async () => {
        let resolveWrite: (() => void) | undefined;
        const writePromise = new Promise<void>((resolve) => {
            resolveWrite = resolve;
        });
        const writeFile = mock(() => writePromise);
        const rename = mock(async () => {});
        const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Survived' }] } } };

        const runPromise = runCli(['bun', 'script.ts', 'reports/x.json'], {
            fileExists: async () => true,
            readFile:   async () => JSON.stringify(report),
            writeFile,
            rename,
        });

        await flush();
        expect(writeFile).toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();

        resolveWrite?.();
        await runPromise;
        expect(rename).toHaveBeenCalled();
    });

    test('the default writeFile awaits Bun.write before the caller can proceed to rename', async () => {
        let resolveBunWrite: ((n: number) => void) | undefined;
        const bunWritePromise = new Promise<number>((resolve) => {
            resolveBunWrite = resolve;
        });
        const writeSpy = spyOn(Bun, 'write').mockImplementation(() => bunWritePromise);
        const rename = mock(async () => {});
        try {
            const report = { files: { 'a.ts': { mutants: [{ id: '1', 'static': true, status: 'Survived' }] } } };
            const runPromise = runCli(['bun', 'script.ts', 'reports/x.json'], {
                fileExists: async () => true,
                readFile:   async () => JSON.stringify(report),
                rename,
            });

            await flush();
            expect(writeSpy).toHaveBeenCalled();
            expect(rename).not.toHaveBeenCalled();

            resolveBunWrite?.(0);
            await runPromise;
            expect(rename).toHaveBeenCalled();
        } finally {
            writeSpy.mockRestore();
        }
    });

    test('the default fileExists reports false for a path that does not exist', async () => {
        const writes: string[] = [];
        await runCli(['bun', 'script.ts', '/definitely/not/a/real/path/incremental.json'], {
            write: (t) => { writes.push(t); },
        });
        expect(writes).toEqual([]);
    });
});
