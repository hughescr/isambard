import { logger } from '@hughescr/logger';
import type { SceneInfo, SpawnRunner } from './types';

const SCENE_THRESHOLD = 10;
const MIN_SCENE_COUNT = 2;
const FALLBACK_SCENE_COUNT = 4;

/** Parse scdet filter output to extract scene change timestamps. */
function parseScdetTimestamps(stderr: string): number[] {
    const timestamps: number[] = [];
    // scdet outputs lines like: [scdet @ 0x...] lavfi.scd.time=12.345
    const lineRe = /lavfi\.scd\.time=(\d+(?:\.\d+)?)/g;
    let match    = lineRe.exec(stderr);
    while(match !== null) {
        timestamps.push(Number(match[1]));
        match = lineRe.exec(stderr);
    }
    // Stryker restore BlockStatement
    return timestamps;
}

/** Build scenes from scene change timestamps plus the total video duration. */
function buildScenes(changeTimestamps: number[], duration: number): SceneInfo[] {
    // Boundaries: 0, ...changeTimestamps, duration
    const boundaries = [0, ...changeTimestamps, duration];
    const scenes: SceneInfo[] = [];
    for(let i = 0; i < boundaries.length - 1; i++) {
        scenes.push({
            index:     i,
            // Stryker disable next-line llm, NumberLiteralValue: the loop selects only defined 0 or parsed nonnegative timestamps, so every fallback is unreachable.
            startTime: boundaries[i] ?? 0,
            endTime:   boundaries[i + 1] ?? duration,
        });
    }
    return scenes;
}

/** Build evenly-spaced pseudo-scenes when real scene detection yields too few results. */
function buildFallbackScenes(duration: number, count: number): SceneInfo[] {
    const segmentDuration = duration / count;
    const scenes: SceneInfo[] = [];
    for(let i = 0; i < count; i++) {
        scenes.push({
            index:     i,
            startTime: i * segmentDuration,
            endTime:   (i + 1) * segmentDuration,
        });
    }
    return scenes;
}

export async function detectScenes(
    videoPath: string,
    duration:  number,
    run:       SpawnRunner
): Promise<SceneInfo[]> {
    // Use ffmpeg scdet filter — outputs to stderr
    const result = await run([
        'ffmpeg',
        '-i', videoPath,
        '-vf', `scdet=s=1:t=${SCENE_THRESHOLD}`,
        '-f', 'null',
        '-',
    ]);
    // Stryker restore StringLiteral

    // ffmpeg writes filter output to stderr regardless of exit code
    // Non-zero exit on null mux is normal; warn only when exit is non-zero AND no scdet output
    const changeTimestamps = parseScdetTimestamps(result.stderr);
    if(result.exitCode !== 0 && changeTimestamps.length === 0) {
        // Could be a real failure (not just the null mux exit) — fall through to fallback below
        logger.warn({ exitCode: result.exitCode }, '[scene-detector] ffmpeg exited with non-zero code and produced no scdet output');
    }

    const scenes = buildScenes(changeTimestamps, duration);

    if(scenes.length < MIN_SCENE_COUNT) {
        return buildFallbackScenes(duration, FALLBACK_SCENE_COUNT);
    }

    return scenes;
}
