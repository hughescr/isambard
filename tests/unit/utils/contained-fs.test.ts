/* eslint-disable n/no-sync -- real filesystem fixtures: node:fs/promises is globally mocked in tests/setup.ts, and these tests exercise real syscalls */
/**
 * Real-syscall tests for the handle-relative, no-follow file helpers (#157, design §6.5).
 * One tmp dir per file (mkdtemp under $TMPDIR), a fresh root per test, and no mocks of bun:ffi.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvariantViolationError, PathSecurityError, type PathSecurityReason } from '@/errors';
import * as utils from '@/utils';
import { openContainedForRead, platformSyscalls, writeContainedAtomic } from '@/utils/contained-fs';

let base = '';
let fifoRoot = '';
let counter = 0;

beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'contained-fs-'));
    fifoRoot = path.join(base, 'fifo-root');
    fs.mkdirSync(fifoRoot);
    if(Bun.spawnSync(['mkfifo', path.join(fifoRoot, 'fifo')]).exitCode !== 0) {
        throw new Error('mkfifo failed');
    }
});

afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

/** A fresh root directory plus an `outside` sibling, unique to one test. */
function freshRoot(): { root: string, outside: string } {
    counter++;
    const dir = path.join(base, `t${counter}`);
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside);
    return { root, outside };
}

/** Permission bits of a path, without bitwise operators. */
function modeOf(target: string): number {
    return fs.statSync(target).mode % 0o1000;
}

const PDF = new TextEncoder().encode('%PDF-1.7 hello');

async function sizeOf(root: string, rel: string, maxBytes = 1000): Promise<number> {
    const result = await openContainedForRead(root, rel, maxBytes);
    return result.size;
}

async function securityError(promise: Promise<unknown>): Promise<PathSecurityError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(PathSecurityError);
        return error as PathSecurityError;
    }
    throw new Error('expected a PathSecurityError');
}

async function readError(root: string, rel: string, maxBytes = 1000): Promise<PathSecurityError> {
    return securityError(openContainedForRead(root, rel, maxBytes));
}

async function readReason(root: string, rel: string): Promise<PathSecurityReason> {
    const error = await readError(root, rel);
    return error.context.reason;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return undefined;
}

describe('platformSyscalls', () => {
    test('darwin and linux tables carry the libc name, O_CLOEXEC and AT_FDCWD', () => {
        expect(platformSyscalls('darwin')).toEqual({ libc: 'libc.dylib', O_CLOEXEC: 0x1_00_00_00, AT_FDCWD: -2 });
        expect(platformSyscalls('linux')).toEqual({ libc: 'libc.so.6', O_CLOEXEC: 0x8_00_00, AT_FDCWD: -100 });
    });

    test('any other platform has no table', () => {
        expect(platformSyscalls('win32')).toBeUndefined();
        expect(platformSyscalls('toString')).toBeUndefined();
    });

    test('returns a copy the caller cannot use to change the table', () => {
        const table = platformSyscalls('darwin');
        if(table) {
            table.libc = 'changed';
        }

        expect(platformSyscalls('darwin')?.libc).toBe('libc.dylib');
    });

    test('the utils barrel exports the helpers', () => {
        expect(utils.openContainedForRead).toBe(openContainedForRead);
        expect(utils.writeContainedAtomic).toBe(writeContainedAtomic);
        expect(utils.platformSyscalls).toBe(platformSyscalls);
    });
});

describe('openContainedForRead', () => {
    test('reads a regular file under the root', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'paper.pdf'), PDF);

        const result = await openContainedForRead(root, 'paper.pdf', 1000);

        expect(new TextDecoder().decode(result.bytes)).toBe('%PDF-1.7 hello');
        expect(result.size).toBe(PDF.length);
    });

    test('reads a nested file, tolerating ./, doubled and trailing slashes', async () => {
        const { root } = freshRoot();
        fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(root, 'a', 'b', 'c.pdf'), PDF);

        expect(await sizeOf(root, './a/b/c.pdf')).toBe(PDF.length);
        expect(await sizeOf(root, 'a//b/c.pdf/')).toBe(PDF.length);
    });

    test('accepts an absolute path under the root and under its realpath', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'x.pdf'), PDF);

        expect(await sizeOf(root, path.join(root, 'x.pdf'))).toBe(PDF.length);
        expect(await sizeOf(root, path.join(fs.realpathSync(root), 'x.pdf'))).toBe(PDF.length);
    });

    test('reads a file of exactly maxBytes and rejects one byte more', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'x.pdf'), PDF);

        expect(await sizeOf(root, 'x.pdf', PDF.length)).toBe(PDF.length);
        const error = await readError(root, 'x.pdf', PDF.length - 1);
        expect(error.context).toEqual({ path: 'x.pdf', reason: 'too_large' });
        expect(error.message).toBe(`File is larger than the ${PDF.length - 1}-byte limit: x.pdf`);
    });

    test('reads an empty file', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'empty.txt'), '');

        const result = await openContainedForRead(root, 'empty.txt', 10);

        expect(result.size).toBe(0);
        expect(result.bytes).toHaveLength(0);
    });

    test('rejects a path through a parent symlinked outside the root', async () => {
        const { root, outside } = freshRoot();
        fs.writeFileSync(path.join(outside, 'paper.pdf'), PDF);
        fs.symlinkSync(outside, path.join(root, 'linked-parent'));

        const error = await readError(root, 'linked-parent/paper.pdf');

        expect(error.context).toEqual({ path: 'linked-parent/paper.pdf', reason: 'not_directory' });
        expect(error.message).toContain('"linked-parent"');
    });

    test('rejects a missing parent directory as not_directory', async () => {
        const { root } = freshRoot();

        expect(await readReason(root, 'nope/paper.pdf')).toBe('not_directory');
    });

    test('rejects a final symlink', async () => {
        const { root, outside } = freshRoot();
        fs.writeFileSync(path.join(outside, 'secret.pdf'), PDF);
        fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(root, 'paper.pdf'));

        const error = await readError(root, 'paper.pdf');

        expect(error.context.reason).toBe('is_symlink');
        expect(error.message).toBe('Refusing to follow a symlink: paper.pdf');
    });

    test('rejects a missing file', async () => {
        const { root } = freshRoot();

        const error = await readError(root, 'missing.pdf');

        expect(error.context.reason).toBe('not_found');
        expect(error.message).toBe('File not found: missing.pdf');
    });

    test('rejects a hard link to a file outside the root', async () => {
        const { root, outside } = freshRoot();
        fs.writeFileSync(path.join(outside, 'secret.pdf'), PDF);
        fs.linkSync(path.join(outside, 'secret.pdf'), path.join(root, 'paper.pdf'));

        const error = await readError(root, 'paper.pdf');

        expect(error.context.reason).toBe('hardlinked');
        expect(error.message).toContain('hard link');
    });

    test('rejects a directory as not_file', async () => {
        const { root } = freshRoot();
        fs.mkdirSync(path.join(root, 'dir'));

        const error = await readError(root, 'dir');

        expect(error.context.reason).toBe('not_file');
        expect(error.message).toBe('Not a regular file: dir');
    });

    test('rejects a FIFO as not_file without blocking', async () => {
        expect(await readReason(fifoRoot, 'fifo')).toBe('not_file');
    });

    test('rejects a file that cannot be opened as not_file', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'locked.pdf'), PDF);
        fs.chmodSync(path.join(root, 'locked.pdf'), 0o000);

        const error = await readError(root, 'locked.pdf');

        expect(error.context.reason).toBe('not_file');
        expect(error.message).toBe('Not a readable regular file: locked.pdf');
    });

    test.each([
        ['a parent escape', '../x.pdf'],
        ['a bare ..', '..'],
        ['an escape after a real segment', 'a/../../x.pdf'],
    ])('rejects %s as outside_cwd', async (_label, rel) => {
        const { root } = freshRoot();

        const error = await readError(root, rel);

        expect(error.context).toEqual({ path: rel, reason: 'outside_cwd' });
        expect(error.message).toBe(`Path is outside the working directory: ${rel}`);
    });

    test('rejects an absolute path outside the root', async () => {
        const { root, outside } = freshRoot();
        fs.writeFileSync(path.join(outside, 'x.pdf'), PDF);

        expect(await readReason(root, path.join(outside, 'x.pdf'))).toBe('outside_cwd');
    });

    test('allows a file whose name starts with two dots', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, '..notes.txt'), 'x');

        expect(await sizeOf(root, '..notes.txt', 10)).toBe(1);
    });

    test.each(['.', '', 'trailing-separator'])('rejects the root itself (%p) as not_file', async (rel) => {
        const { root } = freshRoot();
        const target = rel === 'trailing-separator' ? `${root}${path.sep}` : rel;

        expect(await readReason(root, target)).toBe('not_file');
    });

    test('rejects a missing root as not_found and a file root as not_directory', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'file'), 'x');

        const missing = await readError(path.join(root, 'missing'), 'x');
        expect(missing.context.reason).toBe('not_found');
        expect(missing.message).toContain('Root directory does not exist');
        const fileRoot = await readError(path.join(root, 'file'), 'x');
        expect(fileRoot.context.reason).toBe('not_directory');
        expect(fileRoot.message).toContain('Root is not a directory');
    });

    test('fails closed as unsupported_platform with no syscall table or an unloadable libc', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'x.pdf'), PDF);

        const noTable = await securityError(openContainedForRead(root, 'x.pdf', 1000, { syscalls: null }));
        expect(noTable.context).toEqual({ path: 'x.pdf', reason: 'unsupported_platform' });
        expect(noTable.message).toContain('not supported on this platform');

        const badLibc = await securityError(openContainedForRead(root, 'x.pdf', 1000, { syscalls: { libc: 'libdoes-not-exist.so.0', O_CLOEXEC: 0, AT_FDCWD: -2 } }));
        expect(badLibc.context.reason).toBe('unsupported_platform');
    });

    test('an explicit syscall table for this platform works like the default', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'x.pdf'), PDF);

        const result = await openContainedForRead(root, 'x.pdf', 1000, { syscalls: platformSyscalls(process.platform) });

        expect(result.size).toBe(PDF.length);
    });
});

describe('writeContainedAtomic', () => {
    test('creates 0700 directories and a 0600 file, returning the root-relative path', async () => {
        const { root } = freshRoot();

        const result = await writeContainedAtomic(root, ['zotero-files', 'ABCD2345'], 'paper.pdf', PDF);

        expect(result).toEqual({ path: 'zotero-files/ABCD2345/paper.pdf' });
        const dir = path.join(root, 'zotero-files', 'ABCD2345');
        expect(fs.readFileSync(path.join(dir, 'paper.pdf'), 'utf8')).toBe('%PDF-1.7 hello');
        expect(modeOf(path.join(dir, 'paper.pdf'))).toBe(0o600);
        expect(modeOf(dir)).toBe(0o700);
        expect(modeOf(path.join(root, 'zotero-files'))).toBe(0o700);
        expect(fs.readdirSync(dir)).toEqual(['paper.pdf']);
    });

    test('replaces an existing file and writes into the root with no segments', async () => {
        const { root } = freshRoot();
        fs.writeFileSync(path.join(root, 'x.txt'), 'old contents');

        const result = await writeContainedAtomic(root, [], 'x.txt', new TextEncoder().encode('new'));

        expect(result).toEqual({ path: 'x.txt' });
        expect(fs.readFileSync(path.join(root, 'x.txt'), 'utf8')).toBe('new');
    });

    test.each([
        ['before temp creation', 'afterDirsOpened'],
        ['before rename', 'afterTempWritten'],
    ] as const)('a <key> directory swapped for an outside symlink %s never writes outside', async (_label, hook) => {
        const { root, outside } = freshRoot();
        const keyDir = path.join(root, 'zotero-files', 'KEY');
        const swap = () => {
            fs.renameSync(keyDir, `${keyDir}-moved`);
            fs.symlinkSync(outside, keyDir);
        };

        const error = await securityError(writeContainedAtomic(root, ['zotero-files', 'KEY'], 'p.pdf', PDF, { [hook]: swap }));

        expect(error.context).toEqual({ path: 'zotero-files/KEY/p.pdf', reason: 'changed_during_write' });
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.readdirSync(`${keyDir}-moved`)).toEqual(['p.pdf']);
        expect(fs.readFileSync(path.join(`${keyDir}-moved`, 'p.pdf'), 'utf8')).toBe('%PDF-1.7 hello');
    });

    test('the zotero-files segment swapped for an outside symlink never writes outside', async () => {
        const { root, outside } = freshRoot();
        const zf = path.join(root, 'zotero-files');
        const swap = () => {
            fs.renameSync(zf, `${zf}-moved`);
            fs.symlinkSync(outside, zf);
        };

        const error = await securityError(writeContainedAtomic(root, ['zotero-files', 'KEY'], 'p.pdf', PDF, { afterTempWritten: swap }));

        expect(error.context.reason).toBe('changed_during_write');
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.readdirSync(path.join(`${zf}-moved`, 'KEY'))).toEqual(['p.pdf']);
    });

    test('an opened directory moved out of the root takes the file with it and the call reports it', async () => {
        const { root } = freshRoot();
        const keyDir = path.join(root, 'zotero-files', 'KEY');
        const movedTo = path.join(path.dirname(root), 'moved-KEY');

        const error = await securityError(writeContainedAtomic(root, ['zotero-files', 'KEY'], 'p.pdf', PDF, {
            afterDirsOpened: () => {
                fs.renameSync(keyDir, movedTo);
            },
        }));

        expect(error.context.reason).toBe('changed_during_write');
        expect(error.message).toContain('may now be elsewhere');
        expect(fs.readdirSync(movedTo)).toEqual(['p.pdf']);
        expect(fs.readdirSync(path.join(root, 'zotero-files'))).toEqual([]);
    });

    test('a directory replaced by a fresh one of the same name is reported as changed', async () => {
        const { root } = freshRoot();
        const keyDir = path.join(root, 'zotero-files', 'KEY');

        const error = await securityError(writeContainedAtomic(root, ['zotero-files', 'KEY'], 'p.pdf', PDF, {
            afterTempWritten: () => {
                fs.renameSync(keyDir, `${keyDir}-old`);
                fs.mkdirSync(keyDir);
            },
        }));

        expect(error.context.reason).toBe('changed_during_write');
        expect(fs.readdirSync(keyDir)).toEqual([]);
        expect(fs.readdirSync(`${keyDir}-old`)).toEqual(['p.pdf']);
    });

    test.each([
        ['zotero-files', ['zotero-files']],
        ['<key>', ['zotero-files', 'KEY']],
    ])('a pre-existing symlinked %s segment is rejected with nothing written outside', async (_label, linkSegs) => {
        const { root, outside } = freshRoot();
        fs.mkdirSync(path.join(root, 'zotero-files'), { recursive: true });
        if(linkSegs.length === 1) {
            fs.rmdirSync(path.join(root, 'zotero-files'));
        }
        fs.symlinkSync(outside, path.join(root, ...linkSegs));

        const error = await securityError(writeContainedAtomic(root, ['zotero-files', 'KEY'], 'p.pdf', PDF));

        expect(error.context).toEqual({ path: 'zotero-files/KEY/p.pdf', reason: 'not_directory' });
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    test('a symlink planted at the destination name is replaced by a regular file', async () => {
        const { root, outside } = freshRoot();
        fs.writeFileSync(path.join(outside, 'victim'), 'orig');
        fs.mkdirSync(path.join(root, 'd'));
        fs.symlinkSync(path.join(outside, 'victim'), path.join(root, 'd', 'p.pdf'));

        await writeContainedAtomic(root, ['d'], 'p.pdf', PDF);

        expect(fs.readFileSync(path.join(outside, 'victim'), 'utf8')).toBe('orig');
        expect(fs.lstatSync(path.join(root, 'd', 'p.pdf')).isFile()).toBe(true);
        expect(modeOf(path.join(root, 'd', 'p.pdf'))).toBe(0o600);
    });

    test('a directory at the destination name fails the commit and removes the temp file', async () => {
        const { root } = freshRoot();
        fs.mkdirSync(path.join(root, 'd', 'p.pdf'), { recursive: true });
        fs.writeFileSync(path.join(root, 'd', 'p.pdf', 'inner'), 'x');

        const error = await securityError(writeContainedAtomic(root, ['d'], 'p.pdf', PDF));

        expect(error.context).toEqual({ path: 'd/p.pdf', reason: 'not_file' });
        expect(fs.readdirSync(path.join(root, 'd'))).toEqual(['p.pdf']);
    });

    test('a directory that refuses new files fails before anything is written', async () => {
        const { root } = freshRoot();

        const error = await securityError(writeContainedAtomic(root, ['d'], 'p.pdf', PDF, {
            afterDirsOpened: () => {
                fs.chmodSync(path.join(root, 'd'), 0o500);
            },
        }));

        fs.chmodSync(path.join(root, 'd'), 0o700);
        expect(error.context).toEqual({ path: 'd/p.pdf', reason: 'not_directory' });
        expect(error.message).toContain('temporary file');
        expect(fs.readdirSync(path.join(root, 'd'))).toEqual([]);
    });

    test('a failed data write removes the temp file', async () => {
        const { root } = freshRoot();

        const caught = await rejection(writeContainedAtomic(root, ['d'], 'p.pdf', 'not bytes' as unknown as Uint8Array));

        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(PathSecurityError);
        expect(fs.readdirSync(path.join(root, 'd'))).toEqual([]);
    });

    test('two simultaneous writers to one destination both succeed with distinct temp files', async () => {
        const { root } = freshRoot();
        const temps: string[] = [];
        const record = (name: string) => {
            temps.push(name);
        };

        const results = await Promise.all([
            writeContainedAtomic(root, ['zotero-files', 'KEY'], 'c.pdf', PDF, { afterTempWritten: record }),
            writeContainedAtomic(root, ['zotero-files', 'KEY'], 'c.pdf', PDF, { afterTempWritten: record }),
        ]);

        expect(results).toEqual([{ path: 'zotero-files/KEY/c.pdf' }, { path: 'zotero-files/KEY/c.pdf' }]);
        expect(temps).toHaveLength(2);
        expect(temps[0]).not.toBe(temps[1]);
        for(const name of temps) {
            expect(name).toMatch(/^\.c\.pdf\.[0-9a-f]{16}\.part$/);
        }
        expect(fs.readdirSync(path.join(root, 'zotero-files', 'KEY'))).toEqual(['c.pdf']);
        expect(fs.readFileSync(path.join(root, 'zotero-files', 'KEY', 'c.pdf'), 'utf8')).toBe('%PDF-1.7 hello');
    });

    test.each([
        ['an empty segment', [''], 'p.pdf'],
        ['a dot segment', ['.'], 'p.pdf'],
        ['a dot-dot segment', ['..'], 'p.pdf'],
        ['a slash', ['a/b'], 'p.pdf'],
        ['a NUL', ['a\0b'], 'p.pdf'],
        ['an invalid name', ['d'], '..'],
    ])('rejects %s before any syscall', async (_label, segs, name) => {
        const { root } = freshRoot();

        const caught = await rejection(writeContainedAtomic(root, segs, name, PDF));

        expect(caught).toBeInstanceOf(InvariantViolationError);
        expect((caught as InvariantViolationError).context.invariant).toBe(`invalid path segment ${JSON.stringify(segs[0] === 'd' ? name : segs[0])}`);
        expect(fs.readdirSync(root)).toEqual([]);
    });

    test('fails closed as unsupported_platform without a syscall table', async () => {
        const { root } = freshRoot();

        const error = await securityError(writeContainedAtomic(root, ['d'], 'p.pdf', PDF, { syscalls: null }));

        expect(error.context).toEqual({ path: 'd/p.pdf', reason: 'unsupported_platform' });
        expect(fs.readdirSync(root)).toEqual([]);
    });

    test('rejects a missing root', async () => {
        const { root } = freshRoot();

        const error = await securityError(writeContainedAtomic(path.join(root, 'missing'), ['d'], 'p.pdf', PDF));

        expect(error.context.reason).toBe('not_found');
    });
});
