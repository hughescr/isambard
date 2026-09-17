import { describe, test, expect, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneStaticSurvivors, runCli } from '../../../tools/prune-static-survivors';

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

    test('the default fileExists reports false for a path that does not exist', async () => {
        const writes: string[] = [];
        await runCli(['bun', 'script.ts', '/definitely/not/a/real/path/incremental.json'], {
            write: (t) => { writes.push(t); },
        });
        expect(writes).toEqual([]);
    });
});
