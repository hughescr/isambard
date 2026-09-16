import type { FetchedImage } from '../types';
import type { SceneInfo, BinarySpawnRunner } from './types';
import { InvariantViolationError } from '@/errors';

const FRAME_EXTRACT_CONCURRENCY = 4;

/** Run fn over items with at most concurrency items in flight at once. */
async function mapWithConcurrency<T, R>(
    items:       T[],
    concurrency: number,
    fn:          (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = Array.from({ length: items.length });
    let index = 0;
    async function worker(): Promise<void> {
        while(index < items.length) {
            const i = index++;
            const item = items[i];
            // Stryker disable next-line llm: typeof on this declared local is behaviorally identical to direct comparison with undefined.
            if(item === undefined) {
                throw new InvariantViolationError('mapWithConcurrency', 'items[i] undefined despite i < items.length');
            }
            // Stryker disable next-line llm: adding zero to this nonnegative integer index cannot change the selected result slot.
            results[i] = await fn(item); // eslint-disable-line no-await-in-loop -- sequential within each worker is intentional
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

/** Extract a single frame at a given timestamp as a FetchedImage, or null on failure. */
async function extractFrameAt(
    videoPath: string,
    timestamp: number,
    run:       BinarySpawnRunner
): Promise<FetchedImage | null> {
    const result = await run([
        'ffmpeg',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-vframes', '1',
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1',
    ]);

    if(result.exitCode !== 0 || result.stdout.length === 0) {
        return null;
    }

    return {
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
    const results = await mapWithConcurrency(
        timestamps,
        FRAME_EXTRACT_CONCURRENCY,
        ts => extractFrameAt(videoPath, ts, run)
    );

    const frames: FetchedImage[] = [];
    for(const frame of results) {
        // Stryker disable next-line llm: extractFrameAt returns only FetchedImage or null, so loose null comparison cannot add undefined.
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
        // Stryker disable next-line ArrayMethodSwap: this is the sole insertion into a fresh empty array, making push and unshift identical.
        timestamps.push((startTime + endTime) / 2);
    } else {
        const step = (endTime - startTime) / (count - 1);
        for(let i = 0; i < count; i++) {
            timestamps.push(startTime + i * step);
        }
    }
    return extractFramesAtTimestamps(videoPath, timestamps, run);
}
