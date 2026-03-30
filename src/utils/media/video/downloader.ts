import path from 'node:path';
import type { SpawnRunner } from './types';

// Stryker disable next-line ArithmeticOperator: 5-minute download timeout is configuration
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
        // Stryker disable StringLiteral,ObjectLiteral: ffmpeg command arguments and options are configuration
        const result = await run([
            'ffmpeg',
            '-i', url,
            '-c', 'copy',
            outputPath,
        ], { timeout: DOWNLOAD_TIMEOUT_MS });
        // Stryker restore StringLiteral,ObjectLiteral

        if(result.exitCode !== 0) {
            throw new Error(`HLS download failed with exit code ${result.exitCode}: ${result.stderr}`);
        }

        return outputPath;
    }

    // Direct HTTP download via fetch
    // Stryker disable next-line ObjectLiteral: AbortSignal timeout option is configuration
    const response = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if(!response.ok) {
        throw new Error(`HTTP download failed: ${response.status} ${response.statusText}`);
    }

    // Stream response body directly to disk without buffering in memory
    await Bun.write(outputPath, response);

    return outputPath;
}
