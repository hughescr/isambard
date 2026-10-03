/* eslint-disable n/no-sync -- real filesystem fixtures: node:fs/promises is globally mocked in tests/setup.ts (see makeRealTempDir) */
import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stalledResponse } from '../../../../helpers/stalled-response';
import { MediaProcessingError } from '@/errors';
import { isHlsUrl, downloadVideo } from '@/utils/media/video/downloader';
import type { SpawnRunner } from '@/utils/media/video/types';

const originalFetch = globalThis.fetch;

/**
 * Creates a real, process-unique temp dir. Not `mkdtemp`/`rm` from node:fs/promises: tests/setup.ts mocks
 * that module with an in-memory fake (deterministic `mock<N>` paths, no-op `rm`), so a Date.now() dir
 * was shared by concurrent processes and never really removed (#184).
 * @returns The absolute path of the new directory
 */
function makeRealTempDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'isambard-downloader-test-'));
}

let TEST_DIR = '';

/**
 * Lets one real event-loop turn elapse. `AbortSignal.timeout()` schedules a real, native
 * timer that a microtask-only drain can never observe firing (even at 0ms, its callback
 * still needs a macrotask turn) — so proving "not yet aborted" needs a genuine turn, not
 * just settled promise chains.
 */
function waitForEventLoopCheckpoint(): Promise<void> {
    return new Promise((resolve) => {
        // eslint-disable-next-line no-restricted-syntax -- real macrotask turn required to observe whether a zero-delay AbortSignal.timeout has already fired; a microtask-only drain cannot expose that bug.
        setImmediate(resolve);
    });
}

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
    beforeEach(() => {
        TEST_DIR = makeRealTempDir();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        globalThis.fetch = originalFetch;
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    describe('deadline cleanup', () => {
        it('leaves no deadline timer armed after a successful direct download', async () => {
            jest.useFakeTimers();
            globalThis.fetch = mock(async (): Promise<Response> => new Response(Buffer.from('fake video data'), { status: 200 })) as unknown as typeof fetch;

            await downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/clean-ok`, makeSuccessRunner());

            expect(jest.getTimerCount()).toBe(0);
        });

        it('leaves no deadline timer armed after an HTTP error', async () => {
            jest.useFakeTimers();
            globalThis.fetch = mock(async (): Promise<Response> => new Response(null, { status: 500, statusText: 'Boom' })) as unknown as typeof fetch;

            await expect(downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/clean-http`, makeSuccessRunner())).rejects.toThrow('HTTP download failed');

            expect(jest.getTimerCount()).toBe(0);
        });

        it('cancels an unread stalled error body before the deadline stands down', async () => {
            jest.useFakeTimers();
            const stalled = stalledResponse(503);
            globalThis.fetch = mock(async (): Promise<Response> => stalled.response) as unknown as typeof fetch;

            await expect(downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/stalled-http`, makeSuccessRunner())).rejects.toThrow('HTTP download failed');

            expect(stalled.cancelled()).toBe(true);
            expect(jest.getTimerCount()).toBe(0);
        });

        it('cancels the body when the disk write fails part-way, instead of leaving it stalled', async () => {
            jest.useFakeTimers();
            const stalled = stalledResponse(200);
            globalThis.fetch = mock(async (): Promise<Response> => stalled.response) as unknown as typeof fetch;
            jest.spyOn(Bun, 'write').mockImplementationOnce(async () => {
                throw new Error('ENOSPC');
            });

            await expect(downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/stalled-write`, makeSuccessRunner())).rejects.toThrow('ENOSPC');

            expect(stalled.cancelled()).toBe(true);
        });

        it('leaves no deadline timer armed after a disk-write failure', async () => {
            jest.useFakeTimers();
            globalThis.fetch = mock(async (): Promise<Response> => new Response(Buffer.from('x'), { status: 200 })) as unknown as typeof fetch;
            jest.spyOn(Bun, 'write').mockImplementationOnce(async () => {
                throw new Error('ENOSPC');
            });

            await expect(downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/clean-write`, makeSuccessRunner())).rejects.toThrow('ENOSPC');

            expect(jest.getTimerCount()).toBe(0);
        });
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
        const fakeBuffer = Buffer.from('fake video data');
        const fetchMock = mock(async (_url: string, _options?: RequestInit): Promise<Response> => new Response(fakeBuffer, { status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const resultPath = await downloadVideo('https://example.com/video.mp4', `${TEST_DIR}/direct`, makeSuccessRunner());
        expect(resultPath).toContain('video-original.mp4');
        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

        // The download must be guarded by a minutes-long timeout, not a zero-delay one:
        // a zero-delay signal has aborted by the next event-loop turn, the real one has not.
        await waitForEventLoopCheckpoint();
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
