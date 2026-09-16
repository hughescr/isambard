import { describe, it, expect, mock, afterEach, jest } from 'bun:test';
import { rm, mkdir } from 'node:fs/promises';
import { MediaProcessingError } from '@/errors';
import { isHlsUrl, downloadVideo } from '@/utils/media/video/downloader';
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
        jest.restoreAllMocks();
        globalThis.fetch = originalFetch;
        try {
            await rm(TEST_DIR, { recursive: true });
        } catch{
            // ignore cleanup errors
        }
    });

    it('uses ffmpeg for HLS URLs', async () => {
        const capturedCmds: string[][] = [];
        const options: { timeout?: number }[] = [];
        const trackingRunner: SpawnRunner = async (cmd, opts): Promise<{ stdout: string, stderr: string, exitCode: number }> => {
            capturedCmds.push(cmd);
            options.push(opts ?? {});
            return { stdout: '', stderr: '', exitCode: 0 };
        };
        // HLS download path: ffmpeg writes the output file (we don't verify the file exists)
        const resultPath = await downloadVideo('https://example.com/stream.m3u8', `${TEST_DIR}/hls`, trackingRunner);
        expect(capturedCmds).toHaveLength(1);
        expect(capturedCmds[0]).toEqual([
            'ffmpeg', '-i', 'https://example.com/stream.m3u8', '-c', 'copy', resultPath,
        ]);
        expect(options[0]).toEqual({ timeout: 300_000 });
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
        // The diagnostic detail must be ffmpeg's stderr, not its (empty) stdout.
        expect((caught as MediaProcessingError).context.detail).toBe('HLS error');
    });

    it('fetches directly for non-HLS URLs and writes to disk', async () => {
        // node:fs/promises is globally mocked (see tests/setup.ts mockFsPromises); this satisfies
        // that in-memory mock. The real on-disk write below goes through Bun.write, which creates
        // any missing parent directories itself, so no real mkdir is required.
        await mkdir(`${TEST_DIR}/direct`, { recursive: true });

        const fakeBuffer = Buffer.from('fake video data');
        const fetchMock = mock(async (_url: string, _options?: RequestInit): Promise<Response> => new Response(fakeBuffer, { status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const resultPath = await downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/direct`, makeSuccessRunner());
        expect(resultPath).toContain('video-original.mp4');
        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

        // The download must be guarded by a minutes-long timeout, not a zero-delay one:
        // a zero-delay signal has aborted by the next event-loop turn, the real one has not.
        await Bun.sleep(0);
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    });

    it('propagates a disk-write failure from the direct download', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => new Response(Buffer.from('fake video data'), { status: 200 })) as unknown as typeof fetch;
        jest.spyOn(Bun, 'write').mockImplementationOnce(async () => {
            throw new Error('ENOSPC: no space left on device');
        });

        await expect(downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/write-fail`, makeSuccessRunner()))
            .rejects.toThrow('ENOSPC: no space left on device');
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
