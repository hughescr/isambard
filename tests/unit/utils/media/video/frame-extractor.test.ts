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

/** Returns a runner that captures the -ss timestamp from the ffmpeg command. */
function makeTrackingRunner(capturedTimestamps: number[]): BinarySpawnRunner {
    return async (cmd: string[]): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => {
        // eslint-disable-next-line sonarjs/argument-type -- string literal is valid for string[] indexOf
        const ssIdx = cmd.indexOf('-ss');
        if(ssIdx !== -1) {
            capturedTimestamps.push(Number(cmd[ssIdx + 1] ?? '0'));
        }
        return { stdout: FAKE_PNG_BUFFER, stderr: '', exitCode: 0 };
    };
}

/** Runner that fails for a specific timestamp, succeeds for all others. */
function makePartialRunner(failTimestamp: number): BinarySpawnRunner {
    return async (cmd: string[]): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => {
        // eslint-disable-next-line sonarjs/argument-type -- string literal is valid for string[] indexOf
        const ssIdx = cmd.indexOf('-ss');
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
});

describe('extractFramesAtTimestamps', () => {
    it('returns frames for all successful timestamps', async () => {
        const frames = await extractFramesAtTimestamps('/test/video.mp4', [1, 5, 9], makeSuccessRunner());
        expect(frames).toHaveLength(3);
    });

    it('skips null results from failing ffmpeg calls', async () => {
        const frames = await extractFramesAtTimestamps('/test/video.mp4', [1, 5, 9], makeFailingRunner());
        expect(frames).toHaveLength(0);
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
});
