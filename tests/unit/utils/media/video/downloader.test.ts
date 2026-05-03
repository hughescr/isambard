import { describe, it, expect, mock, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { isHlsUrl, downloadVideo } from '@/utils/media/video/downloader';
import { MediaProcessingError } from '@/errors';
import type { SpawnRunner } from '@/utils/media/video/types';

const originalFetch = globalThis.fetch;

const TEST_DIR = `${process.env.TMPDIR ?? '/tmp'}/isambard-downloader-test-${Date.now()}`;

function makeSuccessRunner(): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({
        stdout:   '',
        stderr:   '',
        exitCode: 0,
    });
}

function makeFailingRunner(stderr: string): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({
        stdout:   '',
        stderr,
        exitCode: 1,
    });
}

describe('isHlsUrl', () => {
    it('returns true for .m3u8 URLs', () => {
        expect(isHlsUrl('https://example.com/stream.m3u8')).toBe(true);
        expect(isHlsUrl('https://cdn.example.com/hls/playlist.m3u8?token=abc')).toBe(true);
    });

    it('returns false for direct video URLs', () => {
        expect(isHlsUrl('https://example.com/video.mp4')).toBe(false);
        expect(isHlsUrl('https://example.com/video.webm')).toBe(false);
    });
});

describe('downloadVideo', () => {
    afterEach(async () => {
        globalThis.fetch = originalFetch;
        try {
            await rm(TEST_DIR, { recursive: true });
        } catch{
            // ignore cleanup errors
        }
    });

    it('uses ffmpeg for HLS URLs', async () => {
        const capturedCmds: string[][] = [];
        const trackingRunner: SpawnRunner = async (cmd): Promise<{ stdout: string, stderr: string, exitCode: number }> => {
            capturedCmds.push(cmd);
            return { stdout: '', stderr: '', exitCode: 0 };
        };
        // HLS download path: ffmpeg writes the output file (we don't verify the file exists)
        const resultPath = await downloadVideo('https://example.com/stream.m3u8', `${TEST_DIR}/hls`, trackingRunner);
        expect(capturedCmds).toHaveLength(1);
        expect(capturedCmds[0]).toContain('ffmpeg');
        expect(capturedCmds[0]).toContain('https://example.com/stream.m3u8');
        expect(resultPath).toContain('video-original.mp4');
    });

    it('throws MediaProcessingError when HLS download fails', async () => {
        let caught: unknown;
        try {
            await downloadVideo('https://example.com/stream.m3u8', `${TEST_DIR}/hls-fail`, makeFailingRunner('HLS error'));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).message).toContain('HLS download failed');
        expect((caught as MediaProcessingError).context.operation).toBe('ffmpeg-hls');
    });

    it('fetches directly for non-HLS URLs and writes to disk', async () => {
        // eslint-disable-next-line no-restricted-syntax -- node:fs/promises is imported dynamically to use the real fs after mock setup (mockFsPromises in setup.ts only mocks the module mock, but this test uses the real fs for temp dirs)
        const { mkdir } = await import('node:fs/promises');
        await mkdir(`${TEST_DIR}/direct`, { recursive: true });

        const fakeBuffer = Buffer.from('fake video data');
        globalThis.fetch = mock(async (): Promise<Response> => new Response(fakeBuffer, { status: 200 })) as unknown as typeof fetch;

        const resultPath = await downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/direct`, makeSuccessRunner());
        expect(resultPath).toContain('video-original.mp4');
    });

    it('throws MediaProcessingError on HTTP error during direct download', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => new Response(null, { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;

        let caught: unknown;
        try {
            await downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/direct-fail`, makeSuccessRunner());
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).message).toBe('HTTP download failed: 404 Not Found');
        expect((caught as MediaProcessingError).context.operation).toBe('http-download');
        expect((caught as MediaProcessingError).context.detail).toBe('404 Not Found');
    });
});
