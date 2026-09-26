import { afterEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { createBinarySpawnRunner, createSpawnRunner } from '@/utils/media/video/spawn-runner';

const originalSpawn = Bun.spawn;

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}

describe('video subprocess runners', () => {
    afterEach(() => {
        Bun.spawn = originalSpawn;
        jest.useRealTimers();
    });

    it('decodes text output, preserves binary output, and forwards cwd', async () => {
        const calls: unknown[][] = [];
        Bun.spawn = ((cmd: string[], options: unknown) => {
            calls.push([cmd, options]);
            return {
                stdout: stream(Uint8Array.from([0, 255, 2])),
                stderr: stream(new TextEncoder().encode('diagnostic')),
                exited: Promise.resolve(3),
                kill() {},
            };
        }) as typeof Bun.spawn;

        expect(await createSpawnRunner()(['tool', 'arg'], { cwd: '/tmp' })).toEqual({
            stdout: '\u0000�\u0002', stderr: 'diagnostic', exitCode: 3,
        });
        expect(await createBinarySpawnRunner()(['tool', 'arg'])).toEqual({
            stdout: Buffer.from([0, 255, 2]), stderr: 'diagnostic', exitCode: 3,
        });
        expect(calls).toEqual([
            [['tool', 'arg'], { stdout: 'pipe', stderr: 'pipe', cwd: '/tmp' }],
            [['tool', 'arg'], { stdout: 'pipe', stderr: 'pipe' }],
        ]);
    });

    it('maps missing commands to exit 127 and rethrows unrelated spawn errors', async () => {
        const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
            throw new Error('ENOENT');
        });
        expect(await createSpawnRunner()(['missing'])).toEqual({ stdout: '', stderr: 'Command not found: missing', exitCode: 127 });
        expect(await createBinarySpawnRunner()(['missing'])).toEqual({ stdout: Buffer.alloc(0), stderr: 'Command not found: missing', exitCode: 127 });
        expect(await createSpawnRunner()([])).toEqual({ stdout: '', stderr: 'Command not found: ', exitCode: 127 });
        expect(await createBinarySpawnRunner()([])).toEqual({ stdout: Buffer.alloc(0), stderr: 'Command not found: ', exitCode: 127 });
        spawnSpy.mockImplementation(() => {
            throw new Error('permission denied');
        });
        await expect(createSpawnRunner()(['blocked'])).rejects.toThrow('permission denied');
        await expect(createBinarySpawnRunner()(['blocked'])).rejects.toThrow('permission denied');
    });

    it('does not infer a missing command from an Error display name', async () => {
        const error = new Error('permission denied');
        error.name = 'ENOENTError';
        spyOn(Bun, 'spawn').mockImplementation(() => {
            throw error;
        });

        await expect(createSpawnRunner()(['blocked'])).rejects.toBe(error);
        await expect(createBinarySpawnRunner()(['blocked'])).rejects.toBe(error);
    });

    it.each([
        ['ENOENT', 'Failed to spawn "missing": ENOENT while resolving executable'],
        ['not found', 'Spawn failed because executable was not found in the configured PATH'],
    ])('maps a subprocess %s marker embedded in its diagnostic', async (_case, message) => {
        spyOn(Bun, 'spawn').mockImplementation(() => {
            throw new Error(message);
        });

        expect(await createSpawnRunner()(['missing'])).toEqual({
            stdout: '', stderr: 'Command not found: missing', exitCode: 127,
        });
        expect(await createBinarySpawnRunner()(['missing'])).toEqual({
            stdout: Buffer.alloc(0), stderr: 'Command not found: missing', exitCode: 127,
        });
    });

    it('kills a timed-out process and clears completed text and binary timers', async () => {
        jest.useFakeTimers();
        let killed = 0;
        let finish!: (exitCode: number) => void;
        Bun.spawn = (() => ({
            stdout: stream(new Uint8Array()),
            stderr: stream(new Uint8Array()),
            exited: new Promise<number>((resolve) => { finish = resolve; }),
            kill() {
                killed++;
                finish(143);
            },
        })) as unknown as typeof Bun.spawn;

        const timeoutTask = createSpawnRunner()(['tool'], { timeout: 5 });
        jest.advanceTimersByTime(5);
        const timeoutResult = await timeoutTask;
        expect(timeoutResult.exitCode).toBe(143);
        expect(killed).toBe(1);

        const text = createSpawnRunner()(['tool'], { timeout: 5 });
        finish(0);
        const textResult = await text;
        expect(textResult.exitCode).toBe(0);
        const binary = createBinarySpawnRunner()(['tool'], { timeout: 5 });
        finish(0);
        const binaryResult = await binary;
        expect(binaryResult.exitCode).toBe(0);
        jest.advanceTimersByTime(15);
        expect(killed).toBe(1);
    });

    it('uses the default binary timeout without killing a normally completing process', async () => {
        jest.useFakeTimers();
        let killed = 0;
        let finish!: (exitCode: number) => void;
        Bun.spawn = (() => ({
            stdout: stream(new Uint8Array()), stderr: stream(new Uint8Array()),
            exited: new Promise<number>((resolve) => { finish = resolve; }),
            kill() {
                killed++;
                finish(143);
            },
        })) as unknown as typeof Bun.spawn;
        const task = createBinarySpawnRunner()(['tool']);
        jest.advanceTimersByTime(5);
        expect(killed).toBe(0);
        finish(0);
        const result = await task;
        expect(result.exitCode).toBe(0);
    });

    it('kills a binary process on its configured timeout', async () => {
        let killed = 0;
        let finish!: (exitCode: number) => void;
        Bun.spawn = (() => ({
            stdout: stream(new Uint8Array()), stderr: stream(new Uint8Array()),
            exited: new Promise<number>((resolve) => { finish = resolve; }),
            kill() {
                killed++;
                finish(143);
            },
        })) as unknown as typeof Bun.spawn;
        const result = await createBinarySpawnRunner()(['tool'], { timeout: 5 });
        expect(result.exitCode).toBe(143);
        expect(killed).toBe(1);
    });

    it('kills the process at the 120 s default timeout boundary', async () => {
        jest.useFakeTimers();
        let killed = 0;
        let finish!: (exitCode: number) => void;
        Bun.spawn = (() => ({
            stdout: stream(new Uint8Array()), stderr: stream(new Uint8Array()),
            exited: new Promise<number>((resolve) => { finish = resolve; }),
            kill() {
                killed++;
                finish(143);
            },
        })) as unknown as typeof Bun.spawn;

        const task = createSpawnRunner()(['tool']);
        jest.advanceTimersByTime(119_999);
        expect(killed).toBe(0);
        jest.advanceTimersByTime(1);
        expect(killed).toBe(1);
        const result = await task;
        expect(result.exitCode).toBe(143);
    });

    it('leaves the subprocess cwd unset so it inherits the process working directory', async () => {
        const calls: unknown[][] = [];
        Bun.spawn = ((cmd: string[], options: unknown) => {
            calls.push([cmd, options]);
            return {
                stdout: stream(new Uint8Array()),
                stderr: stream(new Uint8Array()),
                exited: Promise.resolve(0),
                kill() {},
            };
        }) as typeof Bun.spawn;

        await createSpawnRunner()(['tool']);

        expect(calls).toHaveLength(1);
        const options = calls[0]?.[1] as { cwd?: string };
        expect(options.cwd).toBeUndefined();
    });

    it('decodes binary-runner stderr as UTF-8', async () => {
        Bun.spawn = (() => ({
            stdout: stream(new Uint8Array()),
            stderr: stream(new TextEncoder().encode('café — résumé')),
            exited: Promise.resolve(0),
            kill() {},
        })) as unknown as typeof Bun.spawn;

        const result = await createBinarySpawnRunner()(['tool']);

        expect(result.stderr).toBe('café — résumé');
    });
});
