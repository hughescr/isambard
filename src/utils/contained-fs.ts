/**
 * Contained file access with no pathname I/O below the root (#157, design §6.5).
 *
 * `validateFilePath` checks containment lexically and `lstat`s only the final component, so a
 * symlinked ancestor escapes the root, and any check-then-open sequence can be raced by swapping a
 * directory for a symlink after the check. Node and Bun expose no `*at` calls, so these helpers bind
 * four libc symbols through `bun:ffi` (`openat`, `mkdirat`, `renameat`, `unlinkat`) and do every
 * operation below the root relative to a directory handle that was itself opened
 * `O_NOFOLLOW | O_DIRECTORY`. Swapping a directory after it has been opened cannot redirect anything,
 * because nothing below the root is resolved by path again.
 *
 * - Every directory open is `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC`.
 *   `O_NONBLOCK` stops a planted FIFO from hanging the (synchronous) FFI `open`; `O_CLOEXEC` keeps the
 *   fds out of the Claude CLI subprocesses (Bun's own opens do not set it, and `fs.constants` lacks it).
 * - `openat` is variadic and Apple's arm64 ABI passes variadic args on the stack, so the `mode` of a
 *   fixed-signature FFI call arrives as garbage on darwin arm64: the temp file is `fchmod`ed to 0600
 *   before any byte is written. `mkdirat` is not variadic, so directory modes are exact.
 * - No errno is read (it is not reliable across Bun's runtime between FFI calls); every decision is
 *   made from the return value, and an `lstat` is used only to word an error that is already decided.
 * - Data moves with the async callback forms of `fs.read`/`fs.write`/`fs.fdatasync` on the raw fds.
 * - Unsupported platforms, or a libc that will not load, fail closed with `unsupported_platform`.
 */

import { dlopen, FFIType } from 'bun:ffi';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { InvariantViolationError, PathSecurityError } from '@/errors';

/** The per-platform values `fs.constants` cannot supply. */
export interface PlatformSyscalls {
    libc:      string
    O_CLOEXEC: number
    AT_FDCWD:  number
}

const PLATFORM_SYSCALLS = new Map<string, PlatformSyscalls>([
    // The darwin O_CLOEXEC value was checked with fcntl(F_GETFD).
    ['darwin', { libc: 'libc.dylib', O_CLOEXEC: 0x1_00_00_00, AT_FDCWD: -2 }],
    ['linux', { libc: 'libc.so.6', O_CLOEXEC: 0x8_00_00, AT_FDCWD: -100 }],
]);

/** The syscall table for a platform, or undefined when contained file access is unsupported there. */
export function platformSyscalls(platform: string): PlatformSyscalls | undefined {
    const table = PLATFORM_SYSCALLS.get(platform);
    return table ? { ...table } : undefined;
}

/** Test seam: `null` simulates an unsupported platform; a table with a bad libc simulates a failed bind. */
export interface ContainedFsOptions {
    syscalls?: PlatformSyscalls | null
}

/** Test-only hooks that run at the two points where a directory swap matters. */
export interface ContainedWriteOptions extends ContainedFsOptions {
    afterDirsOpened?:  () => void
    afterTempWritten?: (tempName: string) => void
}

interface Libc {
    openat:   (dirFd: number, name: Buffer, flags: number, mode: number) => number
    mkdirat:  (dirFd: number, name: Buffer, mode: number) => number
    renameat: (fromDirFd: number, from: Buffer, toDirFd: number, to: Buffer) => number
    unlinkat: (dirFd: number, name: Buffer, flags: number) => number
}

interface Bound {
    libc:      Libc
    dirFlags:  number
    readFlags: number
    tempFlags: number
    atFdCwd:   number
}

const boundLibcs = new Map<string, Libc>();

const fstatAsync = promisify(fs.fstat);
const readAsync = promisify(fs.read);
const writeAsync = promisify(fs.write);
const fdatasyncAsync = promisify(fs.fdatasync);
const fchmodAsync = promisify(fs.fchmod);
const closeAsync = promisify(fs.close);
const realpathAsync = promisify(fs.realpath);
const lstatAsync = promisify(fs.lstat);

function unsupported(target: string): PathSecurityError {
    return new PathSecurityError(`Contained file access is not supported on this platform (${process.platform}); ${target} was not touched`, target, 'unsupported_platform');
}

function bind(options: ContainedFsOptions | undefined, target: string): Bound {
    const table = options?.syscalls === undefined ? platformSyscalls(process.platform) : options.syscalls;
    if(!table) {
        throw unsupported(target);
    }
    let libc = boundLibcs.get(table.libc);
    if(!libc) {
        try {
            libc = dlopen(table.libc, {
                openat:   { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
                mkdirat:  { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
                renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
                unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
            }).symbols;
        } catch{
            throw unsupported(target);
        }
        boundLibcs.set(table.libc, libc);
    }
    const C = fs.constants;
    /* eslint-disable no-bitwise -- open(2) flags are a bit set by definition */
    return {
        libc,
        dirFlags:  C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK | table.O_CLOEXEC,
        readFlags: C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | table.O_CLOEXEC,
        tempFlags: C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | table.O_CLOEXEC,
        atFdCwd:   table.AT_FDCWD,
    };
    /* eslint-enable no-bitwise -- end of the open(2) flag block */
}

/** True for a name an `*at` call may take: non-empty, not `.`/`..`, no `/` and no NUL. */
function isValidSegment(segment: string): boolean {
    return segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\0');
}

function assertSegment(segment: string): void {
    if(!isValidSegment(segment)) {
        throw new InvariantViolationError('contained-fs', `invalid path segment ${JSON.stringify(segment)}`);
    }
}

/** A NUL-terminated C string for one validated segment. */
function cSegment(segment: string): Buffer {
    assertSegment(segment);
    return Buffer.from(`${segment}\0`);
}

async function closeAll(fds: number[]): Promise<void> {
    await Promise.all(fds.map(fd => closeAsync(fd)));
}

/** Opens the root by its realpath. Its ancestors are outside Izzy's sandboxed write set, so the path is stable. */
async function openRoot(bound: Bound, root: string, target: string): Promise<{ fd: number, real: string }> {
    let real: string;
    try {
        real = await realpathAsync(root);
    } catch{
        throw new PathSecurityError(`Root directory does not exist: ${root}`, target, 'not_found');
    }
    // Stryker disable next-line NumberLiteralValue: open(2) reads mode only with O_CREAT, which dirFlags never carries
    const fd = bound.libc.openat(bound.atFdCwd, Buffer.from(`${real}\0`), bound.dirFlags, 0);
    if(fd < 0) {
        throw new PathSecurityError(`Root is not a directory: ${root}`, target, 'not_directory');
    }
    return { fd, real };
}

/**
 * Opens each segment no-follow relative to the previous handle, optionally creating it first
 * (the `mkdirat` result is ignored: the following open decides). Returns the opened fds, not
 * including `parentFd`; on failure it closes them and throws `not_directory`.
 */
async function walk(bound: Bound, parentFd: number, segments: string[], create: boolean, target: string): Promise<number[]> {
    const fds: number[] = [];
    let current = parentFd;
    for(const segment of segments) {
        const name = cSegment(segment);
        if(create) {
            bound.libc.mkdirat(current, name, 0o700);
        }
        // Stryker disable next-line NumberLiteralValue: open(2) reads mode only with O_CREAT, which dirFlags never carries
        const fd = bound.libc.openat(current, name, bound.dirFlags, 0);
        if(fd < 0) {
            // eslint-disable-next-line no-await-in-loop -- terminal: closes what was opened, then leaves the loop by throwing
            await closeAll(fds);
            throw new PathSecurityError(`Path component "${segment}" of ${target} is not a real directory (a symlink, a file or missing)`, target, 'not_directory');
        }
        fds.push(fd);
        current = fd;
    }
    return fds;
}

/** `rel` when it is lexically inside (or equal to) `base`, as a relative path; otherwise undefined. */
function relativeInside(base: string, target: string): string | undefined {
    const rel = path.relative(base, target);
    if(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return undefined;
    }
    return rel;
}

/** The lexical, root-relative segments of `relPath`, or throws `outside_cwd`. */
function containedSegments(root: string, realRoot: string, relPath: string): string[] {
    const resolved = path.resolve(root, relPath);
    const rel = relativeInside(path.resolve(root), resolved) ?? relativeInside(realRoot, resolved);
    if(rel === undefined) {
        throw new PathSecurityError(`Path is outside the working directory: ${relPath}`, relPath, 'outside_cwd');
    }
    return rel.split(path.sep).filter(segment => segment !== '');
}

/** Words an already-decided open failure, using a diagnostic-only `lstat`. */
async function openFailure(lexicalPath: string, relPath: string): Promise<PathSecurityError> {
    let stat: fs.Stats;
    try {
        stat = await lstatAsync(lexicalPath);
    } catch{
        return new PathSecurityError(`File not found: ${relPath}`, relPath, 'not_found');
    }
    return stat.isSymbolicLink()
        ? new PathSecurityError(`Refusing to follow a symlink: ${relPath}`, relPath, 'is_symlink')
        : new PathSecurityError(`Not a readable regular file: ${relPath}`, relPath, 'not_file');
}

function tooLarge(relPath: string, maxBytes: number): PathSecurityError {
    return new PathSecurityError(`File is larger than the ${maxBytes}-byte limit: ${relPath}`, relPath, 'too_large');
}

/** Reads at most `limit` bytes from the start of `fd`. */
async function readUpTo(fd: number, limit: number): Promise<Uint8Array> {
    const buffer = Buffer.alloc(limit);
    let total = 0;
    while(total < limit) {
        // eslint-disable-next-line no-await-in-loop -- sequential: each read continues where the previous one stopped
        const { bytesRead } = await readAsync(fd, buffer, total, limit - total, total);
        if(bytesRead === 0) {
            break;
        }
        total += bytesRead;
    }
    return buffer.subarray(0, total);
}

/**
 * Reads a regular file under `root` without following any symlink on the way. `relPath` may be
 * relative to `root`, or absolute under `root` or under `realpath(root)`.
 *
 * Rejects (`PathSecurityError`): a path outside the root (`outside_cwd`), a symlinked, missing or
 * non-directory ancestor (`not_directory`), a final symlink (`is_symlink`), a missing file
 * (`not_found`), a directory/FIFO/device (`not_file`), a hard link (`hardlinked`: it may name a file
 * outside the root), and a file larger than `maxBytes` (`too_large`).
 */
export async function openContainedForRead(
    root: string,
    relPath: string,
    maxBytes: number,
    options?: ContainedFsOptions
): Promise<{ bytes: Uint8Array, size: number }> {
    const bound = bind(options, relPath);
    const { fd: rootFd, real } = await openRoot(bound, root, relPath);
    const heldFds = [rootFd];
    try {
        const segments = containedSegments(root, real, relPath);
        const last = segments.pop();
        if(last === undefined) {
            throw new PathSecurityError(`Not a file: ${relPath}`, relPath, 'not_file');
        }
        heldFds.push(...await walk(bound, rootFd, segments, false, relPath));
        const dirFd = heldFds.at(-1)!;

        // Stryker disable next-line NumberLiteralValue: open(2) reads mode only with O_CREAT, which readFlags never carries
        const fileFd = bound.libc.openat(dirFd, cSegment(last), bound.readFlags, 0);
        if(fileFd < 0) {
            throw await openFailure(path.join(real, ...segments, last), relPath);
        }
        try {
            const stat = await fstatAsync(fileFd);
            if(!stat.isFile()) {
                throw new PathSecurityError(`Not a regular file: ${relPath}`, relPath, 'not_file');
            }
            if(stat.nlink !== 1) {
                throw new PathSecurityError(`Refusing a file with more than one hard link: ${relPath}`, relPath, 'hardlinked');
            }
            if(stat.size > maxBytes) {
                throw tooLarge(relPath, maxBytes);
            }
            // One byte past the size fstat reported detects a file that grew after the check.
            const bytes = await readUpTo(fileFd, stat.size + 1);
            if(bytes.length > maxBytes) {
                throw tooLarge(relPath, maxBytes);
            }
            return { bytes, size: bytes.length };
        } finally {
            await closeAsync(fileFd);
        }
    } finally {
        await closeAll(heldFds);
    }
}

async function writeAll(fd: number, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while(offset < bytes.length) {
        // eslint-disable-next-line no-await-in-loop -- sequential: each write continues where the previous one stopped
        const { bytesWritten } = await writeAsync(fd, bytes, offset, bytes.length - offset, offset);
        offset += bytesWritten;
    }
}

/** Writes the temp file's bytes; on any failure the temp file is unlinked through the held handle. */
async function writeTemp(bound: Bound, dirFd: number, tempName: string, bytes: Uint8Array, target: string): Promise<void> {
    const fd = bound.libc.openat(dirFd, cSegment(tempName), bound.tempFlags, 0o600);
    if(fd < 0) {
        throw new PathSecurityError(`Could not create a temporary file next to ${target}`, target, 'not_directory');
    }
    try {
        await fchmodAsync(fd, 0o600);
        await writeAll(fd, bytes);
        await fdatasyncAsync(fd);
    } catch (error) {
        await closeAsync(fd);
        bound.libc.unlinkat(dirFd, cSegment(tempName), 0);
        throw error;
    }
    await closeAsync(fd);
}

/** True when the path from the root still names the directory the write went into. */
async function stillSameDirectory(bound: Bound, rootFd: number, dirFd: number, dirSegments: string[], target: string): Promise<boolean> {
    const held = await fstatAsync(dirFd);
    let again: number[];
    try {
        again = await walk(bound, rootFd, dirSegments, false, target);
    } catch{
        return false;
    }
    try {
        const now = await fstatAsync(again.at(-1) ?? rootFd);
        return now.dev === held.dev && now.ino === held.ino;
    } finally {
        await closeAll(again);
    }
}

/**
 * Atomically writes `bytes` to `<root>/<dirSegments...>/<name>`, creating missing directories 0700,
 * with a 0600 file. Every component is opened no-follow relative to the previous handle, an
 * `O_EXCL` random-suffixed temp file is created in the held directory, and the commit is a
 * `renameat` within that handle: a directory swapped for a symlink at any point cannot redirect the
 * write, and a symlink at `name` is replaced, not followed.
 *
 * Two concurrent writers of one destination both succeed; the last rename wins.
 *
 * Throws `not_directory` for a symlinked or non-directory segment, `not_file` when `name` is a
 * directory, and `changed_during_write` when a segment was moved or replaced during the call (the
 * file was then written into the directory as it was opened, which may now be elsewhere; it is not
 * unlinked, since nothing is deleted by a path an attacker can redirect).
 */
export async function writeContainedAtomic(
    root: string,
    dirSegments: string[],
    name: string,
    bytes: Uint8Array,
    options?: ContainedWriteOptions
): Promise<{ path: string }> {
    for(const segment of [...dirSegments, name]) {
        assertSegment(segment);
    }
    const target = [...dirSegments, name].join('/');
    const bound = bind(options, target);
    const { fd: rootFd } = await openRoot(bound, root, target);
    const heldFds = [rootFd];
    try {
        heldFds.push(...await walk(bound, rootFd, dirSegments, true, target));
        const dirFd = heldFds.at(-1)!;
        options?.afterDirsOpened?.();

        const tempName = `.${name}.${randomBytes(8).toString('hex')}.part`;
        await writeTemp(bound, dirFd, tempName, bytes, target);
        options?.afterTempWritten?.(tempName);

        if(bound.libc.renameat(dirFd, cSegment(tempName), dirFd, cSegment(name)) !== 0) {
            bound.libc.unlinkat(dirFd, cSegment(tempName), 0);
            throw new PathSecurityError(`Could not replace ${target}: it is not a regular file`, target, 'not_file');
        }

        if(!await stillSameDirectory(bound, rootFd, dirFd, dirSegments, target)) {
            throw new PathSecurityError(
                `${target} was written into its directory as it was opened, but that directory was moved or replaced during the write; the file may now be elsewhere`,
                target,
                'changed_during_write'
            );
        }
        return { path: target };
    } finally {
        await closeAll(heldFds);
    }
}
