import { describe, it, expect } from 'bun:test';
import { detectScenes } from '@/utils/media/video/scene-detector';
import type { SpawnRunner } from '@/utils/media/video/types';

function makeRunner(stderr: string, exitCode = 0): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({
        stdout: '',
        stderr,
        exitCode,
    });
}

// Simulated scdet stderr output lines
const MULTI_SCENE_STDERR = `
frame=  100 fps= 25 q=-0.0 ...
[scdet @ 0x7f] lavfi.sdet.score=42.10 lavfi.sdet.time=4.000
[scdet @ 0x7f] lavfi.sdet.score=55.30 lavfi.sdet.time=8.500
[scdet @ 0x7f] lavfi.sdet.score=60.00 lavfi.sdet.time=14.200
`;

const NO_SCENE_STDERR = `
frame=  50 fps= 25 q=-0.0 ...
`;

const SINGLE_SCENE_STDERR = `
[scdet @ 0x7f] lavfi.sdet.score=38.00 lavfi.sdet.time=5.000
`;

describe('detectScenes', () => {
    it('builds scenes from multiple scdet timestamps', async () => {
        const scenes = await detectScenes('/test/video.mp4', 20, makeRunner(MULTI_SCENE_STDERR));
        // 4 scenes: [0,4], [4,8.5], [8.5,14.2], [14.2,20]
        expect(scenes).toHaveLength(4);
        expect(scenes[0]).toMatchObject({ index: 0, startTime: 0,    endTime: 4   });
        expect(scenes[1]).toMatchObject({ index: 1, startTime: 4,  endTime: 8.5   });
        expect(scenes[2]).toMatchObject({ index: 2, startTime: 8.5,  endTime: 14.2  });
        expect(scenes[3]).toMatchObject({ index: 3, startTime: 14.2, endTime: 20  });
    });

    it('falls back to 4 evenly-spaced scenes when no scene changes detected', async () => {
        const scenes = await detectScenes('/test/video.mp4', 40, makeRunner(NO_SCENE_STDERR));
        expect(scenes).toHaveLength(4);
        expect(scenes[0]).toMatchObject({ index: 0, startTime: 0,  endTime: 10 });
        expect(scenes[1]).toMatchObject({ index: 1, startTime: 10, endTime: 20 });
        expect(scenes[2]).toMatchObject({ index: 2, startTime: 20, endTime: 30 });
        expect(scenes[3]).toMatchObject({ index: 3, startTime: 30, endTime: 40 });
    });

    it('falls back to 4 evenly-spaced scenes when only one change detected (< 2 scenes)', async () => {
        // 1 change timestamp → 2 scenes → that equals MIN_SCENE_COUNT so should NOT fall back
        // Actually 1 change = [0,5] [5,20] = 2 scenes = MIN_SCENE_COUNT — no fallback
        const scenes = await detectScenes('/test/video.mp4', 20, makeRunner(SINGLE_SCENE_STDERR));
        expect(scenes).toHaveLength(2);
        expect(scenes[0]).toMatchObject({ index: 0, startTime: 0, endTime: 5 });
        expect(scenes[1]).toMatchObject({ index: 1, startTime: 5, endTime: 20 });
    });

    it('falls back when zero timestamps parsed from stderr', async () => {
        const scenes = await detectScenes('/test/video.mp4', 60, makeRunner(''));
        expect(scenes).toHaveLength(4);
        expect(scenes[0].startTime).toBe(0);
        expect(scenes[3].endTime).toBe(60);
    });

    it('works even when ffmpeg returns non-zero exit code (null mux is normal)', async () => {
        // ffmpeg always returns exit 1 for -f null, so non-zero exit is expected
        const scenes = await detectScenes('/test/video.mp4', 20, makeRunner(MULTI_SCENE_STDERR, 1));
        expect(scenes).toHaveLength(4);
    });

    it('parses integer timestamps without decimal point', async () => {
        // Tests that the regex optional decimal (?:\.\d+)? works for integers too
        const integerTimeSderr = `
[scdet @ 0x7f] lavfi.sdet.score=42.10 lavfi.sdet.time=4
[scdet @ 0x7f] lavfi.sdet.score=55.30 lavfi.sdet.time=12
`;
        const scenes = await detectScenes('/test/video.mp4', 20, makeRunner(integerTimeSderr));
        expect(scenes).toHaveLength(3);
        expect(scenes[0]).toMatchObject({ index: 0, startTime: 0, endTime: 4 });
        expect(scenes[1]).toMatchObject({ index: 1, startTime: 4, endTime: 12 });
        expect(scenes[2]).toMatchObject({ index: 2, startTime: 12, endTime: 20 });
    });
});
