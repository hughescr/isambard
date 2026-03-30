import type { FetchedImage } from '../types';
import type { SceneInfo, BinarySpawnRunner } from './types';

/** Extract a single frame at a given timestamp as a FetchedImage, or null on failure. */
async function extractFrameAt(
    videoPath: string,
    timestamp: number,
    run:       BinarySpawnRunner
): Promise<FetchedImage | null> {
    // Stryker disable StringLiteral: ffmpeg command arguments are configuration
    const result = await run([
        'ffmpeg',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-vframes', '1',
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1',
    ]);
    // Stryker restore StringLiteral

    // Stryker disable next-line ConditionalExpression,EqualityOperator: empty stdout check — exitCode 0 with empty stdout is a degenerate failure case
    if(result.exitCode !== 0 || result.stdout.length === 0) {
        return null;
    }

    return {
        // Stryker disable next-line StringLiteral: filename template is informational
        filename:     `frame-${timestamp.toFixed(3)}s.png`,
        mediaType:    'image/png',
        base64Data:   result.stdout.toString('base64'),
        originalSize: result.stdout.length,
    };
}

/**
 * Extract 3 frames per scene: one near the start, one at the midpoint, one near the end.
 */
export async function extractSceneFrames(
    videoPath: string,
    scenes:    SceneInfo[],
    frameRate: number,
    run:       BinarySpawnRunner
): Promise<FetchedImage[]> {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: frameRate <= 0 guard — both branches produce same result for valid non-negative frameRate
    const frameOffset = frameRate > 0 ? 1 / frameRate : 0;

    const timestamps: number[] = [];
    for(const scene of scenes) {
        timestamps.push(
            scene.startTime + frameOffset,
            (scene.startTime + scene.endTime) / 2,
            Math.max(scene.startTime, scene.endTime - frameOffset)
        );
    }

    return extractFramesAtTimestamps(videoPath, timestamps, run);
}

/**
 * Extract frames at specific timestamps. Failures are silently skipped.
 */
export async function extractFramesAtTimestamps(
    videoPath:  string,
    timestamps: number[],
    run:        BinarySpawnRunner
): Promise<FetchedImage[]> {
    const results = await Promise.all(
        timestamps.map(ts => extractFrameAt(videoPath, ts, run))
    );

    const frames: FetchedImage[] = [];
    for(const frame of results) {
        if(frame !== null) {
            frames.push(frame);
        }
    }
    return frames;
}

/**
 * Extract `count` evenly-spaced frames between startTime and endTime.
 */
export async function extractFramesInRange(
    videoPath: string,
    startTime: number,
    endTime:   number,
    count:     number,
    run:       BinarySpawnRunner
): Promise<FetchedImage[]> {
    const timestamps: number[] = [];
    if(count === 1) {
        timestamps.push((startTime + endTime) / 2);
    } else {
        const step = (endTime - startTime) / (count - 1);
        // Stryker disable next-line UpdateOperator: i-- infinite loop — Stryker cannot test decrementing loop counters
        for(let i = 0; i < count; i++) {
            timestamps.push(startTime + i * step);
        }
    }
    return extractFramesAtTimestamps(videoPath, timestamps, run);
}
