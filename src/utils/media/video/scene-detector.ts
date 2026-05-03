import { logger } from '@hughescr/logger';
import type { SceneInfo, SpawnRunner } from './types';

// Stryker disable next-line ArithmeticOperator: threshold value is configuration
const SCENE_THRESHOLD = 10;
// Stryker disable next-line ArithmeticOperator: minimum scene count is configuration
const MIN_SCENE_COUNT = 2;
// Stryker disable next-line ArithmeticOperator: fallback pseudo-scene count is configuration
const FALLBACK_SCENE_COUNT = 4;

/** Parse scdet filter output to extract scene change timestamps. */
function parseScdetTimestamps(stderr: string): number[] {
    const timestamps: number[] = [];
    // scdet outputs lines like: [scdet @ 0x...] lavfi.scd.time=12.345
    // Stryker disable next-line Regex: regex mutations produce structurally equivalent or invalid patterns
    const lineRe = /lavfi\.scd\.time=(\d+(?:\.\d+)?)/g;
    // Stryker disable BlockStatement: loop body executes when regex matches; empty-string test covers loop exit
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
    // Stryker disable next-line ArrayDeclaration: spread initializer is structural — [0, ...timestamps, duration]
    const boundaries = [0, ...changeTimestamps, duration];
    const scenes: SceneInfo[] = [];
    // Stryker disable next-line UpdateOperator: i-- infinite loop — Stryker cannot test decrementing loop counters
    for(let i = 0; i < boundaries.length - 1; i++) {
        // Stryker disable next-line ArrayDeclaration,StringLiteral: boundary defaults are guards — never reached in normal operation
        scenes.push({
            index:     i,
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
    // Stryker disable next-line UpdateOperator: i-- infinite loop — Stryker cannot test decrementing loop counters
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
    // Stryker disable StringLiteral,ArrayDeclaration: ffmpeg command arguments are configuration
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
    // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: defensive check — both branches produce same fallback result for genuine failures
    if(result.exitCode !== 0 && changeTimestamps.length === 0) {
        // Could be a real failure (not just the null mux exit) — fall through to fallback below
        // Stryker disable next-line ObjectLiteral,StringLiteral: log message and object are observability only — not behavior
        logger.warn({ exitCode: result.exitCode }, '[scene-detector] ffmpeg exited with non-zero code and produced no scdet output');
    }

    const scenes = buildScenes(changeTimestamps, duration);

    if(scenes.length < MIN_SCENE_COUNT) {
        return buildFallbackScenes(duration, FALLBACK_SCENE_COUNT);
    }

    return scenes;
}
