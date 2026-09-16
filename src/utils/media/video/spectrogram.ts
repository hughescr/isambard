import type { FetchedImage } from '../types';
import type { BinarySpawnRunner } from './types';
import { MediaProcessingError } from '@/errors';

/**
 * Generate an audio spectrogram image from a video file.
 * Uses ffmpeg's showspectrumpic filter to produce a PNG.
 */
export async function generateSpectrogram(
    videoPath: string,
    run:       BinarySpawnRunner
): Promise<FetchedImage> {
    const result = await run([
        'ffmpeg',
        '-i', videoPath,
        '-lavfi', 'showspectrumpic=s=1024x512',
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1',
    ]);
    // Stryker restore StringLiteral

    if(result.exitCode !== 0 || result.stdout.length === 0) {
        throw new MediaProcessingError(
            `Spectrogram generation failed with exit code ${result.exitCode}: ${result.stderr}`,
            'ffmpeg-spectrogram',
            result.stderr
        );
    }

    return {
        filename:     'spectrogram.png',
        mediaType:    'image/png',
        base64Data:   result.stdout.toString('base64'),
        originalSize: result.stdout.length,
    };
}
