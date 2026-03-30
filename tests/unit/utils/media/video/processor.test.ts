import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { processVideo, processLocalVideo } from '@/utils/media/video/processor';
import type { SpawnRunner, BinarySpawnRunner } from '@/utils/media/video/types';

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

const FFPROBE_OUTPUT = JSON.stringify({
    streams: [
        {
            codec_type:     'video',
            codec_name:     'h264',
            width:          1920,
            height:         1080,
            avg_frame_rate: '30/1',
            bit_rate:       '4000000',
            index:          0,
        },
        {
            codec_type:  'audio',
            codec_name:  'aac',
            channels:    2,
            sample_rate: '44100',
            index:       1,
        },
    ],
    format: { duration: '20.0', bit_rate: '4500000' },
});

const FFPROBE_WITH_SUBTITLES = JSON.stringify({
    streams: [
        {
            codec_type:     'video',
            codec_name:     'h264',
            width:          1280,
            height:         720,
            avg_frame_rate: '25/1',
            index:          0,
        },
        {
            codec_type: 'subtitle',
            codec_name: 'subrip',
            index:      1,
            tags:       { language: 'eng' },
        },
    ],
    format: { duration: '30.0' },
});

const SCDET_STDERR = `
[scdet @ 0x7f] lavfi.scd.score=45.0 lavfi.scd.time=5.000
[scdet @ 0x7f] lavfi.scd.score=50.0 lavfi.scd.time=12.000
[scdet @ 0x7f] lavfi.scd.score=38.0 lavfi.scd.time=17.000
`;

const WHISPERKIT_OUTPUT = '[00:00:01.000 --> 00:00:03.000]  SPEAKER_00: Hello world\n';

const SRT_OUTPUT = `1
00:00:01,000 --> 00:00:03,000
Test subtitle
`;

/** A runner that returns appropriate responses based on the command. */
function makeOrchestrationRunner(ffprobeOutput: string, transcription: string): SpawnRunner {
    return async (cmd: string[]): Promise<{ stdout: string, stderr: string, exitCode: number }> => {
        const exe = cmd[0] ?? '';
        if(exe.includes('ffprobe')) {
            return { stdout: ffprobeOutput, stderr: '', exitCode: 0 };
        }
        // eslint-disable-next-line sonarjs/argument-type -- string literal is valid for string[] includes
        if(exe.includes('ffmpeg') && cmd.includes('null')) {
            // scdet detection
            return { stdout: '', stderr: SCDET_STDERR, exitCode: 1 };
        }
        // eslint-disable-next-line sonarjs/argument-type -- string literal is valid for string[] includes
        if(exe.includes('ffmpeg') && cmd.includes('srt')) {
            // subtitle extraction
            return { stdout: SRT_OUTPUT, stderr: '', exitCode: 0 };
        }
        // eslint-disable-next-line sonarjs/argument-type -- string literal is valid for string[] includes
        if(exe.includes('ffmpeg') && cmd.includes('copy')) {
            // HLS download
            return { stdout: '', stderr: '', exitCode: 0 };
        }
        if(exe.includes('whisperkit-cli')) {
            return { stdout: transcription, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
    };
}

function makeBinaryRunner(): BinarySpawnRunner {
    return async (): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => ({
        stdout:   FAKE_PNG,
        stderr:   '',
        exitCode: 0,
    });
}

describe('processLocalVideo', () => {
    const TEST_DIR = `${process.env.TMPDIR ?? '/tmp'}/isambard-local-processor-test-${Date.now()}`;

    afterEach(async () => {
        mock.restore();
        try {
            await rm(TEST_DIR, { recursive: true });
        } catch{
            // ignore cleanup errors
        }
    });

    it('creates the output directory before processing', async () => {
        const mkdirSpy = spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
        // Mock writeFile too so the test doesn't fail on missing dir
        spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);

        const run = makeOrchestrationRunner(FFPROBE_OUTPUT, WHISPERKIT_OUTPUT);
        const outputDir = `${TEST_DIR}/mkdir-test-output`;
        await processLocalVideo(`${TEST_DIR}/input/video.mp4`, outputDir, {
            run,
            binaryRun: makeBinaryRunner(),
        });

        expect(mkdirSpy).toHaveBeenCalledWith(outputDir, { recursive: true });
    });

    it('processes a video file that already exists locally (no download step)', async () => {
        // processLocalVideo takes a file path, not a URL — no fetch should be needed
        const run = makeOrchestrationRunner(FFPROBE_OUTPUT, WHISPERKIT_OUTPUT);
        const result = await processLocalVideo(`${TEST_DIR}/input/video.mp4`, `${TEST_DIR}/output`, {
            run,
            binaryRun: makeBinaryRunner(),
        });

        expect(result.metadata.videoCodec).toBe('h264');
        expect(result.metadata.width).toBe(1920);
        expect(result.frames.length).toBeGreaterThan(0);
        expect(result.metadataMarkdown).toContain('# Video Metadata');
        expect(result.outputDir).toBe(`${TEST_DIR}/output`);
    });

    it('includes alt text in metadata markdown when provided', async () => {
        const run = makeOrchestrationRunner(FFPROBE_OUTPUT, WHISPERKIT_OUTPUT);
        const result = await processLocalVideo(`${TEST_DIR}/input/video.mp4`, `${TEST_DIR}/output-alt`, {
            run,
            binaryRun: makeBinaryRunner(),
            alt:       'A documentary about ocean life',
        });

        expect(result.metadataMarkdown).toContain('## Description');
        expect(result.metadataMarkdown).toContain('A documentary about ocean life');
    });

    it('extracts subtitles from embedded subtitle tracks', async () => {
        const run = makeOrchestrationRunner(FFPROBE_WITH_SUBTITLES, WHISPERKIT_OUTPUT);
        const result = await processLocalVideo(`${TEST_DIR}/input/video.mp4`, `${TEST_DIR}/output-subs`, {
            run,
            binaryRun: makeBinaryRunner(),
        });

        expect(result.subtitles).toBeDefined();
        expect(result.transcription).toBeUndefined();
        expect(result.metadataMarkdown).toContain('## Subtitles');
    });
});

describe('processVideo', () => {
    const TEST_DIR = `${process.env.TMPDIR ?? '/tmp'}/isambard-processor-test-${Date.now()}`;

    afterEach(async () => {
        mock.restore();
        // Clean up the test output directory
        try {
            await rm(TEST_DIR, { recursive: true });
        } catch{
            // ignore cleanup errors
        }
    });

    it('runs the full pipeline for a direct URL', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => new Response(Buffer.from('fake video'), { status: 200 })) as unknown as typeof fetch;

        const run = makeOrchestrationRunner(FFPROBE_OUTPUT, WHISPERKIT_OUTPUT);
        const result = await processVideo('https://example.com/video.mp4', `${TEST_DIR}/test1`, {
            run,
            binaryRun: makeBinaryRunner(),
        });

        expect(result.metadata.videoCodec).toBe('h264');
        expect(result.metadata.width).toBe(1920);
        expect(result.frames.length).toBeGreaterThan(0);
        expect(result.metadataMarkdown).toContain('# Video Metadata');
        expect(result.outputDir).toBe(`${TEST_DIR}/test1`);
    });

    it('includes alt text in metadata markdown when provided', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => new Response(Buffer.from('fake video'), { status: 200 })) as unknown as typeof fetch;

        const run = makeOrchestrationRunner(FFPROBE_OUTPUT, WHISPERKIT_OUTPUT);
        const result = await processVideo('https://example.com/video.mp4', `${TEST_DIR}/test-alt`, {
            run,
            binaryRun: makeBinaryRunner(),
            alt:       'A beautiful sunset timelapse',
        });

        expect(result.metadataMarkdown).toContain('## Description');
        expect(result.metadataMarkdown).toContain('A beautiful sunset timelapse');
    });

    it('uses HLS download for .m3u8 URLs', async () => {
        const capturedCmds: string[][] = [];
        const trackingRun: SpawnRunner = async (cmd): Promise<{ stdout: string, stderr: string, exitCode: number }> => {
            capturedCmds.push(cmd);
            const exe = cmd[0] ?? '';
            if(exe.includes('ffprobe')) {
                return { stdout: FFPROBE_OUTPUT, stderr: '', exitCode: 0 };
            }
            // eslint-disable-next-line sonarjs/argument-type -- string literal is valid for string[] includes
            if(exe.includes('ffmpeg') && cmd.includes('null')) {
                return { stdout: '', stderr: SCDET_STDERR, exitCode: 1 };
            }
            if(exe.includes('whisperkit-cli')) {
                return { stdout: WHISPERKIT_OUTPUT, stderr: '', exitCode: 0 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        };

        await processVideo('https://example.com/stream.m3u8', `${TEST_DIR}/test2`, {
            run:       trackingRun,
            binaryRun: makeBinaryRunner(),
        });

        // eslint-disable-next-line sonarjs/argument-type -- string literal is valid for string[] includes
        const ffmpegCopyCmd = capturedCmds.find(c => c.includes('copy'));
        expect(ffmpegCopyCmd).toBeDefined();
    });

    it('returns subtitles when video has embedded subtitle tracks', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => new Response(Buffer.from('fake video'), { status: 200 })) as unknown as typeof fetch;

        const run = makeOrchestrationRunner(FFPROBE_WITH_SUBTITLES, WHISPERKIT_OUTPUT);
        const result = await processVideo('https://example.com/video.mp4', `${TEST_DIR}/test3`, {
            run,
            binaryRun: makeBinaryRunner(),
        });

        expect(result.subtitles).toBeDefined();
        expect(result.transcription).toBeUndefined();
        expect(result.metadataMarkdown).toContain('## Subtitles');
    });
});
