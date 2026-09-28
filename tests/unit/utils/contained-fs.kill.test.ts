/* eslint-disable n/no-sync -- real filesystem fixtures: node:fs/promises is globally mocked in tests/setup.ts, and these tests exercise real syscalls */
/**
 * Behaviour pins for the handle-relative file helpers (#157) that the main suite leaves open:
 * the libc bind cache, segment validation on the read path, exact error wording, the size check
 * that runs before any buffer is allocated, descriptor 0 as a valid handle, and that every
 * descriptor opened is closed (and a failed close is reported) before a call settles.
 * Real syscalls throughout; descriptors are observed through /dev/fd (or /proc/self/fd). Results no
 * real call gives on demand (descriptor 0, a failed close, a short write) come from the `io` seam,
 * which wraps the real operations; the process's own descriptors are never touched (#172).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { constants as bufferConstants } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvariantViolationError, PathSecurityError, type PathSecurityReason } from '@/errors';
import { type ContainedIo, openContainedForRead, writeContainedAtomic } from '@/utils/contained-fs';

const FD_DIR = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
const PDF = new TextEncoder().encode('%PDF-1.7 hello');

type IoWrap = (real: ContainedIo) => ContainedIo;

/** What an `*at` call opened, as the tests name it: `root` for the absolute root path, `temp` for a temp file, else the segment. */
function openedName(name: Buffer): string {
    const text = name.toString('utf8', 0, name.length - 1);
    if(path.isAbsolute(text)) {
        return 'root';
    }
    return text.endsWith('.part') ? 'temp' : text;
}

/**
 * Hands out descriptor 0 for the first open `wantZero` picks while 0 is free, and stands the real
 * descriptor in for it in every later call, so the code under test sees a 0 handle while the
 * process's own descriptor 0 is never touched. `log` records when 0 is handed out and closed.
 */
function descriptorZero(wantZero: (name: string, nth: number) => boolean, log: string[]): IoWrap {
    return (real) => {
        let behindZero: number | undefined;
        const opens = new Map<string, number>();
        const actual = (fd: number): number => (fd === 0 ? behindZero ?? Number.NaN : fd);
        return {
            openat: (dirFd, name, flags, mode) => {
                const fd = real.openat(actual(dirFd), name, flags, mode);
                expect(fd).not.toBe(0);
                const key = openedName(name);
                const nth = (opens.get(key) ?? 0) + 1;
                opens.set(key, nth);
                if(fd > 0 && behindZero === undefined && wantZero(key, nth)) {
                    behindZero = fd;
                    log.push(`0 is ${key} #${nth}`);
                    return 0;
                }
                return fd;
            },
            mkdirat:   (dirFd, name, mode) => real.mkdirat(actual(dirFd), name, mode),
            renameat:  (fromDirFd, from, toDirFd, to) => real.renameat(actual(fromDirFd), from, actual(toDirFd), to),
            unlinkat:  (dirFd, name, flags) => real.unlinkat(actual(dirFd), name, flags),
            fstat:     async fd => real.fstat(actual(fd)),
            read:      async (fd, buffer, offset, length, position) => real.read(actual(fd), buffer, offset, length, position),
            write:     async (fd, bytes, offset, length, position) => real.write(actual(fd), bytes, offset, length, position),
            fdatasync: async fd => real.fdatasync(actual(fd)),
            fchmod:    async (fd, mode) => real.fchmod(actual(fd), mode),
            close:     async (fd) => {
                const underlying = actual(fd);
                if(fd === 0) {
                    behindZero = undefined;
                    log.push('0 closed');
                }
                await real.close(underlying);
            },
        };
    };
}

let base = '';
let counter = 0;

beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'contained-fs-kill-'));
});

afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

function freshRoot(): string {
    counter++;
    const root = path.join(base, `t${counter}`);
    fs.mkdirSync(root);
    return root;
}

function inodeKey(stat: fs.Stats): string {
    return `${stat.dev}:${stat.ino}`;
}

/** The dev:ino of `dir` and of everything below it. */
function inodesUnder(dir: string, into = new Set<string>()): Set<string> {
    into.add(inodeKey(fs.lstatSync(dir)));
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if(entry.isDirectory()) {
            inodesUnder(child, into);
        } else {
            into.add(inodeKey(fs.lstatSync(child)));
        }
    }
    return into;
}

/** Descriptors of this process that are open on `dir` or on anything below it. */
function fdsOpenUnder(dir: string): number[] {
    const inodes = inodesUnder(dir);
    return fs.readdirSync(FD_DIR).map(Number).filter((fd) => {
        try {
            return inodes.has(inodeKey(fs.fstatSync(fd)));
        } catch{
            return false;
        }
    });
}

function isOpen(fd: number): boolean {
    try {
        fs.fstatSync(fd);
        return true;
    } catch{
        return false;
    }
}

/** The one descriptor open on `target`. */
function fdOn(target: string): number {
    const want = inodeKey(fs.lstatSync(target));
    const matches = fs.readdirSync(FD_DIR).map(Number).filter(fd => isOpen(fd) && inodeKey(fs.fstatSync(fd)) === want);
    expect(matches).toHaveLength(1);
    return matches[0] ?? -1;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

describe('libc binding', () => {
    test('binds a libc once and reuses it on later calls', async () => {
        const root = freshRoot();
        fs.writeFileSync(path.join(root, 'x.pdf'), PDF);
        const bound: ContainedIo['openat'][] = [];
        const io: IoWrap = (real) => {
            bound.push(real.openat);
            return real;
        };

        await openContainedForRead(root, 'x.pdf', 100, { io });
        await openContainedForRead(root, 'x.pdf', 100, { io });

        expect(bound).toHaveLength(2);
        expect(bound[1]).toBe(bound[0]);
    });
});

describe('openContainedForRead', () => {
    test('a NUL inside the read path is an invalid segment, never a truncated name', async () => {
        const root = freshRoot();
        fs.writeFileSync(path.join(root, 'a'), 'the file a NUL would truncate to');

        const error = await caught(openContainedForRead(root, 'a\0b.pdf', 100));

        expect(error).toBeInstanceOf(InvariantViolationError);
        expect((error as InvariantViolationError).message).toBe(String.raw`Invariant violated in contained-fs: invalid path segment "a\u0000b.pdf"`);
        expect((error as InvariantViolationError).context).toEqual({ location: 'contained-fs', invariant: String.raw`invalid path segment "a\u0000b.pdf"` });
        expect(fdsOpenUnder(root)).toEqual([]);
    });

    test('a directory whose name ends in two dots is inside the root', async () => {
        const root = freshRoot();
        fs.mkdirSync(path.join(root, 'foo..'));
        fs.writeFileSync(path.join(root, 'foo..', 'bar.pdf'), PDF);

        const result = await openContainedForRead(root, 'foo../bar.pdf', 100);

        expect(result.size).toBe(PDF.length);
    });

    test('the root itself is refused with a "Not a file" message', async () => {
        const root = freshRoot();

        const error = await caught(openContainedForRead(root, '.', 100));

        expect(error).toBeInstanceOf(PathSecurityError);
        expect((error as PathSecurityError).message).toBe('Not a file: .');
        expect((error as PathSecurityError).context).toEqual({ path: '.', reason: 'not_file' });
    });

    test('a file larger than any buffer is refused by its size before a buffer is allocated', async () => {
        const root = freshRoot();
        const size = bufferConstants.MAX_LENGTH;
        const fd = fs.openSync(path.join(root, 'huge.pdf'), 'w');
        fs.ftruncateSync(fd, size);
        fs.closeSync(fd);

        const error = await caught(openContainedForRead(root, 'huge.pdf', 100));

        expect(error).toBeInstanceOf(PathSecurityError);
        expect((error as PathSecurityError).message).toBe('File is larger than the 100-byte limit: huge.pdf');
        expect(fdsOpenUnder(root)).toEqual([]);
    });

    test.each<[string, string, PathSecurityReason | undefined]>([
        ['a nested read', 'a/b/c.pdf', undefined],
        ['a missing middle directory', 'a/missing/c.pdf', 'not_directory'],
        ['a missing file', 'a/b/none.pdf', 'not_found'],
        ['a directory in place of the file', 'a/b', 'not_file'],
        ['a file over the limit', 'a/b/big.pdf', 'too_large'],
    ])('%s leaves no descriptor open once it settles', async (_label, rel, reason) => {
        const root = freshRoot();
        fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(root, 'a', 'b', 'c.pdf'), PDF);
        fs.writeFileSync(path.join(root, 'a', 'b', 'big.pdf'), new Uint8Array(200));

        const outcome = await openContainedForRead(root, rel, 100)
            .then(result => result.size)
            .catch((error: unknown) => (error as PathSecurityError).context.reason);

        expect(fdsOpenUnder(root)).toEqual([]);
        expect(outcome).toBe(reason ?? PDF.length);
    });
});

describe('writeContainedAtomic', () => {
    test('a directory at the destination name is refused with a "Could not replace" message', async () => {
        const root = freshRoot();
        fs.mkdirSync(path.join(root, 'd', 'p.pdf'), { recursive: true });

        const error = await caught(writeContainedAtomic(root, ['d'], 'p.pdf', PDF));

        expect((error as PathSecurityError).message).toBe('Could not replace d/p.pdf: it is not a regular file');
        expect(fdsOpenUnder(root)).toEqual([]);
    });

    test('a nested write leaves no descriptor open, the temp file closed before commit', async () => {
        const root = freshRoot();
        const tempOpen: boolean[] = [];

        const result = await writeContainedAtomic(root, ['a', 'b'], 'p.pdf', PDF, {
            afterTempWritten: (tempName) => {
                tempOpen.push(fdsOpenUnder(root).some(fd => inodeKey(fs.fstatSync(fd)) === inodeKey(fs.lstatSync(path.join(root, 'a', 'b', tempName)))));
            },
        });

        expect(result).toEqual({ path: 'a/b/p.pdf' });
        expect(tempOpen).toEqual([false]);
        expect(fdsOpenUnder(root)).toEqual([]);
    });

    test('a directory swapped during the write leaves no descriptor open', async () => {
        const root = freshRoot();

        const error = await caught(writeContainedAtomic(root, ['a', 'b'], 'p.pdf', PDF, {
            afterTempWritten: () => {
                fs.renameSync(path.join(root, 'a', 'b'), path.join(root, 'b-moved'));
            },
        }));

        expect((error as PathSecurityError).context.reason).toBe('changed_during_write');
        expect(fdsOpenUnder(root)).toEqual([]);
    });

    test('a failed data write leaves no descriptor open', async () => {
        const root = freshRoot();

        await caught(writeContainedAtomic(root, ['d'], 'p.pdf', 'not bytes' as unknown as Uint8Array));

        expect(fdsOpenUnder(root)).toEqual([]);
        expect(fs.readdirSync(path.join(root, 'd'))).toEqual([]);
    });

    test('a held directory handle that fails to close is reported, not swallowed', async () => {
        const root = freshRoot();

        const error = await caught(writeContainedAtomic(root, ['a', 'b'], 'p.pdf', PDF, {
            afterTempWritten: () => {
                // The handle on `a` is not used again after the walk; closing it here makes the final close fail.
                fs.closeSync(fdOn(path.join(root, 'a')));
            },
        }));

        expect((error as NodeJS.ErrnoException).code).toBe('EBADF');
        expect(fs.readFileSync(path.join(root, 'a', 'b', 'p.pdf'), 'utf8')).toBe('%PDF-1.7 hello');
        expect(fdsOpenUnder(root)).toEqual([]);
    });
});

describe('descriptor 0 is a valid handle', () => {
    test.each<[string, string, number]>([
        ['the root', 'root', 1],
        ['a directory', 'a', 1],
        ['the file', 'b.pdf', 1],
    ])('a read with %s on descriptor 0 reads the file and closes 0', async (_label, name, nth) => {
        const root = freshRoot();
        fs.mkdirSync(path.join(root, 'a'));
        fs.writeFileSync(path.join(root, 'a', 'b.pdf'), PDF);
        const log: string[] = [];

        const result = await openContainedForRead(root, 'a/b.pdf', 100, { io: descriptorZero((key, n) => key === name && n === nth, log) });

        expect(new TextDecoder().decode(result.bytes)).toBe('%PDF-1.7 hello');
        expect(log).toEqual([`0 is ${name} #${nth}`, '0 closed']);
        expect(fdsOpenUnder(root)).toEqual([]);
    });

    test.each<[string, string, number]>([
        ['the root', 'root', 1],
        ['the directory', 'd', 1],
        ['the temp file', 'temp', 1],
        ['the re-walked directory', 'd', 2],
    ])('a write with %s on descriptor 0 commits and closes 0', async (_label, name, nth) => {
        const root = freshRoot();
        const log: string[] = [];

        const result = await writeContainedAtomic(root, ['d'], 'p.pdf', PDF, { io: descriptorZero((key, n) => key === name && n === nth, log) });

        expect(result).toEqual({ path: 'd/p.pdf' });
        expect(fs.readFileSync(path.join(root, 'd', 'p.pdf'), 'utf8')).toBe('%PDF-1.7 hello');
        expect(log).toEqual([`0 is ${name} #${nth}`, '0 closed']);
        expect(fdsOpenUnder(root)).toEqual([]);
    });
});
