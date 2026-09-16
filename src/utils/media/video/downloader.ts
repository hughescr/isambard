import path from 'node:path';
import type { SpawnRunner } from './types';
import { MediaProcessingError } from '@/errors';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const OUTPUT_FILENAME = 'video-original.mp4';

/** Returns true if the URL points to an HLS playlist. */
export function isHlsUrl(url: string): boolean {
    return url.includes('.m3u8');
}

/**
 * Download a video from a URL to outputDir.
 * Supports HLS playlists (via ffmpeg) and direct HTTP downloads (via fetch).
 * Returns the local file path.
 */
export async function downloadVideo(
    url:       string,
    outputDir: string,
    run:       SpawnRunner
): Promise<string> {
    const outputPath = path.join(outputDir, OUTPUT_FILENAME);

    if(isHlsUrl(url)) {
        const result = await run([
            'ffmpeg',
            '-i', url,
            '-c', 'copy',
            outputPath,
        ], { timeout: DOWNLOAD_TIMEOUT_MS });

        if(result.exitCode !== 0) {
            throw new MediaProcessingError(
                `HLS download failed with exit code ${result.exitCode}: ${result.stderr}`,
                'ffmpeg-hls',
                result.stderr
            );
        }

        return outputPath;
    }

    // Direct HTTP download via fetch
    const response = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if(!response.ok) {
        throw new MediaProcessingError(
            `HTTP download failed: ${response.status} ${response.statusText}`,
            'http-download',
            `${response.status} ${response.statusText}`
        );
    }

    // Stream response body directly to disk without buffering in memory
    await Bun.write(outputPath, response);

    return outputPath;
}
