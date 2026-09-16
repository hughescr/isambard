import { describe, it, expect } from 'bun:test';
import {
    extractSceneFrames,
    extractFramesAtTimestamps,
    extractFramesInRange
} from '@/utils/media/video/frame-extractor';
import type { SceneInfo, BinarySpawnRunner } from '@/utils/media/video/types';

const FAKE_PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG magic bytes

function makeSuccessRunner(): BinarySpawnRunner {
    return async (): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => ({
        stdout:   FAKE_PNG_BUFFER,
        stderr:   '',
        exitCode: 0,
    });
}

function makeFailingRunner(): BinarySpawnRunner {
    return async (): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => ({
        stdout:   Buffer.alloc(0),
        stderr:   'ffmpeg error',
        exitCode: 1,
    });
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
    let resolveFn!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolveFn = resolve;
    });
    return { promise, resolve: resolveFn };
}

/** Returns a runner that captures the -ss timestamp from the ffmpeg command. */
function makeTrackingRunner(capturedTimestamps: number[]): BinarySpawnRunner {
    return async (cmd: string[]): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => {
        const ssIdx = [...cmd.entries()].find(([, v]) => v === '-ss')?.[0] ?? -1;
        if(ssIdx !== -1) {
            capturedTimestamps.push(Number(cmd[ssIdx + 1] ?? '0'));
        }
        return { stdout: FAKE_PNG_BUFFER, stderr: '', exitCode: 0 };
    };
}

/** Runner that fails for a specific timestamp, succeeds for all others. */
function makePartialRunner(failTimestamp: number): BinarySpawnRunner {
    return async (cmd: string[]): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => {
        const ssIdx = [...cmd.entries()].find(([, v]) => v === '-ss')?.[0] ?? -1;
        const ts    = ssIdx === -1 ? -1 : Number(cmd[ssIdx + 1] ?? '0');
        if(Math.abs(ts - failTimestamp) < 0.001) {
            return { stdout: Buffer.alloc(0), stderr: 'frame error', exitCode: 1 };
        }
        return { stdout: FAKE_PNG_BUFFER, stderr: '', exitCode: 0 };
    };
}

const TWO_SCENES: SceneInfo[] = [
    { index: 0, startTime: 0,  endTime: 10 },
    { index: 1, startTime: 10, endTime: 20 },
];

describe('extractSceneFrames', () => {
    it('does not seek before a scene for zero or negative frame rate', async () => {
        await Promise.all([0, -5].map(async (frameRate) => {
            const captured: number[] = [];
            await extractSceneFrames('/test/video.mp4', [{ index: 0, startTime: 5, endTime: 15 }], frameRate, makeTrackingRunner(captured));
            expect(captured).toEqual([5, 10, 15]);
        }));
    });
    it('extracts 3 frames per scene (begin/mid/end)', async () => {
        const frames = await extractSceneFrames('/test/video.mp4', TWO_SCENES, 30, makeSuccessRunner());
        // 2 scenes × 3 frames = 6 frames
        expect(frames).toHaveLength(6);
        for(const frame of frames) {
            expect(frame.mediaType).toBe('image/png');
            expect(frame.base64Data).toBe(FAKE_PNG_BUFFER.toString('base64'));
        }
    });

    it('offsets begin frame by 1/frameRate seconds from scene start', async () => {
        const capturedTimestamps: number[] = [];
        const frameRate = 30;
        const scenes: SceneInfo[] = [{ index: 0, startTime: 5, endTime: 15 }];
        await extractSceneFrames('/test/video.mp4', scenes, frameRate, makeTrackingRunner(capturedTimestamps));
        // begin = 5 + 1/30
        expect(capturedTimestamps[0]).toBeCloseTo(5 + 1 / 30, 5);
        // mid = (5 + 15) / 2 = 10
        expect(capturedTimestamps[1]).toBe(10);
        // end = max(5, 15 - 1/30)
        expect(capturedTimestamps[2]).toBeCloseTo(15 - 1 / 30, 5);
    });

    it('skips failed frames and continues with successful ones', async () => {
        // Middle timestamp of scene 0 is 5.0 — make that fail
        const failTs = (0 + 10) / 2;  // 5.0
        const frames = await extractSceneFrames('/test/video.mp4', [{ index: 0, startTime: 0, endTime: 10 }], 30, makePartialRunner(failTs));
        // 3 - 1 failed = 2 frames returned
        expect(frames).toHaveLength(2);
    });

    it('applies the offset once frameRate exceeds the zero boundary (frameRate=1)', async () => {
        // frameRate=1 is > the "frameRate > 0" threshold, so offset = 1/1 = 1.
        // A mutant widening the boundary to "frameRate > 1" would leave frameRate=1
        // in the else branch, producing offset=0 instead.
        const capturedTimestamps: number[] = [];
        const scenes: SceneInfo[] = [{ index: 0, startTime: 5, endTime: 15 }];
        await extractSceneFrames('/test/video.mp4', scenes, 1, makeTrackingRunner(capturedTimestamps));
        expect(capturedTimestamps[0]).toBe(6);  // 5 + 1/1
        expect(capturedTimestamps[2]).toBe(14); // 15 - 1/1
    });

    it('appends each scene\'s frames after the previous scene\'s (push, not unshift)', async () => {
        const capturedTimestamps: number[] = [];
        await extractSceneFrames('/test/video.mp4', TWO_SCENES, 30, makeTrackingRunner(capturedTimestamps));
        expect(capturedTimestamps).toHaveLength(6);
        // Scene 0's begin frame must be captured first; scene 1's begin frame fourth.
        // Swapping push for unshift would prepend each scene's block, reversing this.
        expect(capturedTimestamps[0]).toBeCloseTo(0 + 1 / 30, 5);
        expect(capturedTimestamps[3]).toBeCloseTo(10 + 1 / 30, 5);
    });
});

describe('extractFramesAtTimestamps', () => {
    it('uses the ffmpeg PNG pipe protocol and returns a timestamped filename', async () => {
        const commands: string[][] = [];
        const runner: BinarySpawnRunner = async (command) => {
            commands.push(command);
            return { stdout: FAKE_PNG_BUFFER, stderr: '', exitCode: 0 };
        };
        const frames = await extractFramesAtTimestamps('/test/video.mp4', [1.25], runner);
        expect(commands).toEqual([[
            'ffmpeg', '-ss', '1.25', '-i', '/test/video.mp4',
            '-vframes', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
        ]]);
        expect(frames[0]?.filename).toBe('frame-1.250s.png');
    });

    it('returns frames for all successful timestamps', async () => {
        const frames = await extractFramesAtTimestamps('/test/video.mp4', [1, 5, 9], makeSuccessRunner());
        expect(frames).toHaveLength(3);
    });

    it('returns results in input order when processing with concurrency limit', async () => {
        // 8 timestamps — exceeds FRAME_EXTRACT_CONCURRENCY=4, verifying order is preserved
        const capturedTimestamps: number[] = [];
        const orderRunner = makeTrackingRunner(capturedTimestamps);
        const inputTimestamps = [1, 2, 3, 4, 5, 6, 7, 8];
        const frames = await extractFramesAtTimestamps('/test/video.mp4', inputTimestamps, orderRunner);
        expect(frames).toHaveLength(8);
        // Each frame's filename encodes the timestamp — verify order via captured timestamps
        expect(capturedTimestamps).toHaveLength(8);
        // All timestamps should be present (order from workers may vary, but results[i] is correct)
        for(const ts of inputTimestamps) {
            expect(capturedTimestamps).toContain(ts);
        }
        expect(frames.map(frame => frame.filename)).toEqual(inputTimestamps.map(ts => `frame-${ts.toFixed(3)}s.png`));
    });

    it('runs no more than four ffmpeg jobs at a time', async () => {
        let inFlight = 0;
        let maximum = 0;
        const releases: (() => void)[] = [];
        const runner: BinarySpawnRunner = async () => {
            inFlight++;
            maximum = Math.max(maximum, inFlight);
            await new Promise<void>((resolve) => {
                releases.push(resolve);
            });
            inFlight--;
            return { stdout: FAKE_PNG_BUFFER, stderr: '', exitCode: 0 };
        };
        const task = extractFramesAtTimestamps('/test/video.mp4', [1, 2, 3, 4, 5, 6], runner);
        await Promise.resolve();
        expect(maximum).toBe(4);
        async function releasePending(): Promise<void> {
            releases.shift()?.();
            await Promise.resolve();
            if(releases.length > 0) {
                await releasePending();
            }
        }
        await releasePending();
        expect(await task).toHaveLength(6);
        expect(maximum).toBe(4);
    });

    it('waits for every concurrent ffmpeg worker before returning', async () => {
        const pending = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
        let nextCall = 0;
        const runner: BinarySpawnRunner = async () => {
            const completion = pending[nextCall++];
            await completion.promise;
            return { stdout: FAKE_PNG_BUFFER, stderr: '', exitCode: 0 };
        };
        let settled = false;
        const task = extractFramesAtTimestamps('/test/video.mp4', [1, 2, 3, 4], runner);
        void task.then(() => {
            settled = true;
            return undefined;
        });

        await Promise.resolve();
        try {
            pending[0].resolve();
            for(let i = 0; i < 20; i += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic microtask drain for the promise-combinator witness
                await Promise.resolve();
            }

            expect(settled).toBe(false);
        } finally {
            for(const completion of pending) {
                completion.resolve();
            }
        }

        expect(await task).toHaveLength(4);
    });

    it('skips null results from failing ffmpeg calls', async () => {
        const frames = await extractFramesAtTimestamps('/test/video.mp4', [1, 5, 9], makeFailingRunner());
        expect(frames).toHaveLength(0);
    });

    it('skips output from ffmpeg when the process failed', async () => {
        const runner: BinarySpawnRunner = async () => ({ stdout: FAKE_PNG_BUFFER, stderr: 'decode error', exitCode: 1 });
        expect(await extractFramesAtTimestamps('/test/video.mp4', [1], runner)).toEqual([]);
    });

    it('rejects a sparse timestamp array at the public boundary', async () => {
        const timestamps = [undefined] as unknown as number[];

        await expect(extractFramesAtTimestamps('/test/video.mp4', timestamps, makeSuccessRunner())).rejects.toThrow(
            'items[i] undefined despite i < items.length'
        );
    });

    it('attributes sparse-array failure to the concurrency mapper', async () => {
        try {
            await extractFramesAtTimestamps('/test/video.mp4', [undefined] as unknown as number[], makeSuccessRunner());
            throw new Error('expected sparse array to fail');
        } catch (error) {
            expect(error).toMatchObject({ context: { location: 'mapWithConcurrency' } });
        }
    });

    it('returns null for ffmpeg success but empty stdout (no frame data)', async () => {
        // exitCode=0 but empty buffer — the || stdout.length===0 check
        const emptySuccessRunner: BinarySpawnRunner = async (): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => ({
            stdout:   Buffer.alloc(0),
            stderr:   '',
            exitCode: 0,
        });
        const frames = await extractFramesAtTimestamps('/test/video.mp4', [1], emptySuccessRunner);
        expect(frames).toHaveLength(0);
    });

    it('treats only stdout.length === 0 as empty output, not any length <= 0', async () => {
        // A Buffer's length can never be negative, but a mutant weakening the
        // check to "<= 0" is only observable by faking a negative-length stdout.
        const negativeLengthRunner: BinarySpawnRunner = async () => ({
            stdout:   { length: -1 } as unknown as Buffer,
            stderr:   '',
            exitCode: 0,
        });
        const frames = await extractFramesAtTimestamps('/test/video.mp4', [1], negativeLengthRunner);
        expect(frames).toHaveLength(1);
    });

    it('builds the -ss argument with String() so a coerced null timestamp fails at toFixed(), not earlier', async () => {
        // timestamp is typed as number, but a caller could still hand back null
        // through an unsafe cast (as the sparse-array tests above already do).
        // String(null) === 'null' (no throw), so with the real code the failure
        // only surfaces later at timestamp.toFixed(3). A mutant using
        // timestamp.toString() instead would throw immediately on the null,
        // before ever reaching toFixed — a different failure point/message.
        // This also distinguishes "item === undefined" from "item == undefined":
        // under == , null is loosely equal to undefined and the call would be
        // rejected earlier with the mapWithConcurrency invariant-violation message.
        const timestamps = [null] as unknown as number[];
        await expect(extractFramesAtTimestamps('/test/video.mp4', timestamps, makeSuccessRunner()))
            .rejects.toThrow(/toFixed/);
    });
});

describe('extractFramesInRange', () => {
    it('extracts count=4 evenly-spaced frames in range', async () => {
        const capturedTimestamps: number[] = [];
        await extractFramesInRange('/test/video.mp4', 0, 30, 4, makeTrackingRunner(capturedTimestamps));
        expect(capturedTimestamps).toHaveLength(4);
        expect(capturedTimestamps[0]).toBe(0);
        expect(capturedTimestamps[1]).toBe(10);
        expect(capturedTimestamps[2]).toBe(20);
        expect(capturedTimestamps[3]).toBe(30);
    });

    it('extracts single frame at midpoint when count=1', async () => {
        const capturedTimestamps: number[] = [];
        await extractFramesInRange('/test/video.mp4', 10, 20, 1, makeTrackingRunner(capturedTimestamps));
        expect(capturedTimestamps).toHaveLength(1);
        expect(capturedTimestamps[0]).toBe(15);
    });

    it('step is based on range not sum (endTime - startTime not endTime + startTime)', async () => {
        // With startTime=10, endTime=20, count=3:
        //   step = (20-10) / (3-1) = 5 → timestamps: 10, 15, 20
        // If step were (20+10)/(3-1) = 15, timestamps would be: 10, 25, 40 (wrong)
        const capturedTimestamps: number[] = [];
        await extractFramesInRange('/test/video.mp4', 10, 20, 3, makeTrackingRunner(capturedTimestamps));
        expect(capturedTimestamps[1]).toBe(15);  // not 25 (which would be wrong)
    });

    it('extracts no frames when count=0 (only count=1 takes the midpoint branch)', async () => {
        // A mutant widening "count === 1" to "count <= 1" would push a midpoint
        // frame for count=0 too, instead of the empty timestamps the for-loop
        // (0 < 0, never runs) produces.
        const capturedTimestamps: number[] = [];
        const frames = await extractFramesInRange('/test/video.mp4', 0, 30, 0, makeTrackingRunner(capturedTimestamps));
        expect(frames).toHaveLength(0);
        expect(capturedTimestamps).toHaveLength(0);
    });
});
