import type { SpawnResult, SpawnRunner, BinarySpawnResult, BinarySpawnRunner } from './types';

// Stryker disable next-line ArithmeticOperator: default timeout is configuration
const DEFAULT_TIMEOUT_MS = 120_000;

/** Subset of Bun subprocess with piped stdout/stderr streams. */
interface PipedProc {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    kill(): void
}

// Stryker disable all: real subprocess I/O — not unit-testable without integration test harness
async function runTextProcess(
    cmd:     string[],
    options?: { timeout?: number, cwd?: string }
): Promise<SpawnResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    let proc: PipedProc;
    try {
        proc = Bun.spawn(cmd, {
            stdout: 'pipe',
            stderr: 'pipe',
            cwd:    options?.cwd,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if(msg.includes('ENOENT') || msg.includes('not found')) {
            return { stdout: '', stderr: `Command not found: ${cmd[0] ?? ''}`, exitCode: 127 };
        }
        throw err;
    }

    const timer = setTimeout(() => proc.kill(), timeout);

    try {
        const [stdoutBuf, stderrBuf] = await Promise.all([
            new Response(proc.stdout).arrayBuffer(),
            new Response(proc.stderr).arrayBuffer(),
        ]);
        const exitCode = await proc.exited;

        return {
            stdout: Buffer.from(stdoutBuf).toString('utf8'),
            stderr: Buffer.from(stderrBuf).toString('utf8'),
            exitCode,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function runBinaryProcess(
    cmd:     string[],
    options?: { timeout?: number }
): Promise<BinarySpawnResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    let proc: PipedProc;
    try {
        proc = Bun.spawn(cmd, {
            stdout: 'pipe',
            stderr: 'pipe',
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if(msg.includes('ENOENT') || msg.includes('not found')) {
            return { stdout: Buffer.alloc(0), stderr: `Command not found: ${cmd[0] ?? ''}`, exitCode: 127 };
        }
        throw err;
    }

    const timer = setTimeout(() => proc.kill(), timeout);

    try {
        const [stdoutBuf, stderrBuf] = await Promise.all([
            new Response(proc.stdout).arrayBuffer(),
            new Response(proc.stderr).arrayBuffer(),
        ]);
        const exitCode = await proc.exited;

        return {
            stdout: Buffer.from(stdoutBuf),
            stderr: Buffer.from(stderrBuf).toString('utf8'),
            exitCode,
        };
    } finally {
        clearTimeout(timer);
    }
}

export function createSpawnRunner(): SpawnRunner {
    return runTextProcess;
}

export function createBinarySpawnRunner(): BinarySpawnRunner {
    return runBinaryProcess;
}
// Stryker restore all
