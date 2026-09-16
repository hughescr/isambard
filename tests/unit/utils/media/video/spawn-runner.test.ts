import { afterEach, describe, expect, it, spyOn } from 'bun:test';
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

        const timeoutResult = await createSpawnRunner()(['tool'], { timeout: 5 });
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
        await Bun.sleep(15);
        expect(killed).toBe(1);
    });

    it('uses the default binary timeout without killing a normally completing process', async () => {
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
        await Bun.sleep(5);
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
});
