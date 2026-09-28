import { describe, test, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { KILL_GRACE_MS, createBoundedRunner } from '@/integrations/email/preview/bounded-runner';

const TIMEOUT = 5000;

/** A stream that has sent `text` and closed. */
function closed(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

/** A stream that never closes, like a pipe a grandchild still holds open. */
function open(): ReadableStream<Uint8Array> {
    return new ReadableStream({ start() {} });
}

interface FakeProc {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    kills:  unknown[]
    kill:   (signal?: unknown) => void
}

function fakeProc(parts: { stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>, exited: Promise<number>, onKill?: (signal: unknown) => void }): FakeProc {
    const kills: unknown[] = [];
    return {
        ...parts,
        kills,
        kill(signal?: unknown) {
            kills.push(signal);
            parts.onKill?.(signal);
        },
    };
}

function spawnReturning(proc: FakeProc): ReturnType<typeof spyOn<typeof Bun, 'spawn'>> {
    return spyOn(Bun, 'spawn').mockImplementation((() => proc) as unknown as typeof Bun.spawn);
}

/** Records how `pending` settles, so a test can check it has not settled yet. */
function track(pending: Promise<unknown>): { outcome: string | undefined } {
    const state: { outcome: string | undefined } = { outcome: undefined };
    void (async () => {
        try {
            state.outcome = `resolved ${JSON.stringify(await pending)}`;
        } catch (err: unknown) {
            state.outcome = `rejected ${(err as Error).message}`;
        }
    })();
    return state;
}

async function flush(remaining = 10): Promise<void> {
    if(remaining > 0) {
        await Promise.resolve();
        await flush(remaining - 1);
    }
}

describe('createBoundedRunner', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('gives SIGKILL a one-second grace', () => {
        expect(KILL_GRACE_MS).toBe(1000);
    });

    test('returns the output and exit code of a command that finishes in time, and never kills it', async () => {
        const proc = fakeProc({ stdout: closed('{"ok":true}\n'), stderr: closed('warning'), exited: Promise.resolve(3) });
        const spawn = spawnReturning(proc);

        expect(await createBoundedRunner()(['/bin/tailscale', 'status', '--json'], { timeout: TIMEOUT })).toEqual({ stdout: '{"ok":true}\n', stderr: 'warning', exitCode: 3 });
        expect(spawn.mock.calls).toEqual([[['/bin/tailscale', 'status', '--json'], { stdout: 'pipe', stderr: 'pipe' }]] as unknown as typeof spawn.mock.calls);

        jest.advanceTimersByTime(TIMEOUT + KILL_GRACE_MS);
        expect(proc.kills).toEqual([]);
    });

    test('rejects when the command cannot be spawned', async () => {
        spyOn(Bun, 'spawn').mockImplementation(() => {
            throw new Error('EACCES');
        });

        await expect(createBoundedRunner()(['/bin/tailscale'], { timeout: TIMEOUT })).rejects.toThrow('EACCES');
    });

    test('kills a command that ignores SIGTERM: times out at the deadline, then SIGKILLs after the grace', async () => {
        const proc = fakeProc({ stdout: open(), stderr: open(), exited: Promise.withResolvers<number>().promise });
        spawnReturning(proc);
        const state = track(createBoundedRunner()(['/bin/tailscale', 'serve', 'status'], { timeout: TIMEOUT }));

        jest.advanceTimersByTime(TIMEOUT - 1);
        await flush();
        expect(state.outcome).toBeUndefined();
        expect(proc.kills).toEqual([]);

        jest.advanceTimersByTime(1);
        await flush();
        expect(state.outcome).toBe('rejected timed out after 5000 ms and was killed');
        expect(proc.kills).toEqual(['SIGTERM']);

        jest.advanceTimersByTime(KILL_GRACE_MS - 1);
        expect(proc.kills).toEqual(['SIGTERM']);
        jest.advanceTimersByTime(1);
        expect(proc.kills).toEqual(['SIGTERM', 'SIGKILL']);
    });

    test('settles at the deadline even when the output streams never close, and skips SIGKILL once the command has exited', async () => {
        const exit = Promise.withResolvers<number>();
        const proc = fakeProc({ stdout: open(), stderr: closed(''), exited: exit.promise, onKill: () => exit.resolve(143) });
        spawnReturning(proc);
        const state = track(createBoundedRunner()(['/bin/tailscale', 'serve', 'off'], { timeout: 250 }));

        jest.advanceTimersByTime(250);
        await flush();
        expect(state.outcome).toBe('rejected timed out after 250 ms and was killed');

        jest.advanceTimersByTime(KILL_GRACE_MS);
        expect(proc.kills).toEqual(['SIGTERM']);
    });

    test('skips SIGKILL when the command\'s exit status rejects after SIGTERM', async () => {
        const exit = Promise.withResolvers<number>();
        const proc = fakeProc({ stdout: open(), stderr: open(), exited: exit.promise, onKill: () => exit.reject(new Error('gone')) });
        spawnReturning(proc);
        const state = track(createBoundedRunner()(['/bin/tailscale'], { timeout: TIMEOUT }));

        jest.advanceTimersByTime(TIMEOUT);
        await flush();
        expect(state.outcome).toBe('rejected timed out after 5000 ms and was killed');

        jest.advanceTimersByTime(KILL_GRACE_MS);
        expect(proc.kills).toEqual(['SIGTERM']);
    });
});
