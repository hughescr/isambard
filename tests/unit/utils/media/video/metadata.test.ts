import { describe, it, expect, afterEach, jest } from 'bun:test';
import { mockLogger } from '../../../../setup';
import { extractMetadata, parseFfprobeOutput } from '@/utils/media/video/metadata';
import { MediaProcessingError } from '@/errors';
import type { SpawnRunner } from '@/utils/media/video/types';

function makeRunner(stdout: string, exitCode = 0): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({
        stdout,
        stderr: '',
        exitCode,
    });
}

function makeFailingRunner(stderr: string, exitCode = 1): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({
        stdout: '',
        stderr,
        exitCode,
    });
}

const FULL_FFPROBE_OUTPUT = JSON.stringify({
    streams: [
        {
            codec_type:     'video',
            codec_name:     'h264',
            width:          1920,
            height:         1080,
            bit_rate:       '4000000',
            avg_frame_rate: '30/1',
            r_frame_rate:   '30/1',
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
    format: {
        duration: '154.3',
        bit_rate: '4500000',
    },
});

const NO_AUDIO_OUTPUT = JSON.stringify({
    streams: [
        {
            codec_type:     'video',
            codec_name:     'h264',
            width:          1280,
            height:         720,
            avg_frame_rate: '24000/1001',
            index:          0,
        },
    ],
    format: {
        duration: '60.0',
    },
});

const WITH_SUBTITLES_OUTPUT = JSON.stringify({
    streams: [
        {
            codec_type:     'video',
            codec_name:     'hevc',
            width:          3840,
            height:         2160,
            avg_frame_rate: '60/1',
            index:          0,
        },
        {
            codec_type: 'subtitle',
            codec_name: 'subrip',
            index:      1,
            tags:       { language: 'eng', title: 'English' },
        },
        {
            codec_type: 'subtitle',
            codec_name: 'subrip',
            index:      2,
            tags:       { language: 'fra' },
        },
    ],
    format: { duration: '300.0' },
});

describe('extractMetadata', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        mockLogger.warn.mockClear();
    });

    it('parses full metadata with video and audio streams', async () => {
        const metadata = await extractMetadata('/test/video.mp4', makeRunner(FULL_FFPROBE_OUTPUT));
        expect(metadata.duration).toBe(154.3);
        expect(metadata.width).toBe(1920);
        expect(metadata.height).toBe(1080);
        expect(metadata.videoCodec).toBe('h264');
        expect(metadata.frameRate).toBe(30);
        expect(metadata.videoBitrate).toBe(4_000_000);
        expect(metadata.audioCodec).toBe('aac');
        expect(metadata.audioChannels).toBe(2);
        expect(metadata.audioSampleRate).toBe(44_100);
        expect(metadata.subtitleTracks).toHaveLength(0);
    });

    it('parses metadata with no audio stream', async () => {
        const metadata = await extractMetadata('/test/video.mp4', makeRunner(NO_AUDIO_OUTPUT));
        expect(metadata.audioCodec).toBeUndefined();
        expect(metadata.audioChannels).toBeUndefined();
        expect(metadata.audioSampleRate).toBeUndefined();
        expect(metadata.videoBitrate).toBeUndefined();
        // 24000/1001 ≈ 23.976
        expect(metadata.frameRate).toBeCloseTo(23.976, 2);
    });

    it('parses audio stream without sample_rate field', async () => {
        const output = JSON.stringify({
            streams: [
                { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', index: 0 },
                { codec_type: 'audio', codec_name: 'mp3', channels: 2, index: 1 },  // no sample_rate
            ],
            format: { duration: '10.0' },
        });
        const metadata = await extractMetadata('/test/video.mp4', makeRunner(output));
        expect(metadata.audioCodec).toBe('mp3');
        expect(metadata.audioChannels).toBe(2);
        expect(metadata.audioSampleRate).toBeUndefined();
    });

    it('returns 0 for frameRate when denominator is 0', async () => {
        const output = JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/0', index: 0 }],
            format:  { duration: '10.0' },
        });
        const metadata = await extractMetadata('/test/video.mp4', makeRunner(output));
        expect(metadata.frameRate).toBe(0);
    });

    it('parses plain number frame rate (not fraction)', async () => {
        const output = JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '25', index: 0 }],
            format:  { duration: '10.0' },
        });
        const metadata = await extractMetadata('/test/video.mp4', makeRunner(output));
        expect(metadata.frameRate).toBe(25);
    });

    it('parses subtitle tracks with language and title', async () => {
        const metadata = await extractMetadata('/test/video.mp4', makeRunner(WITH_SUBTITLES_OUTPUT));
        expect(metadata.subtitleTracks).toHaveLength(2);
        expect(metadata.subtitleTracks[0]).toMatchObject({ index: 1, language: 'eng', title: 'English' });
        expect(metadata.subtitleTracks[1]).toMatchObject({ index: 2, language: 'fra' });
        expect(metadata.subtitleTracks[1]?.title).toBeUndefined();
    });

    it('throws MediaProcessingError when ffprobe exits with non-zero code', async () => {
        const runner = makeFailingRunner('file not found', 1);
        let caught: unknown;
        try {
            await extractMetadata('/test/video.mp4', runner);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).message).toContain('ffprobe failed');
        expect((caught as MediaProcessingError).context.operation).toBe('ffprobe');
    });

    it('throws on malformed JSON output', async () => {
        const runner = makeRunner('not json');
        expect(extractMetadata('/test/video.mp4', runner)).rejects.toThrow('Failed to parse ffprobe output');
    });

    it('throws MediaProcessingError with cause on malformed JSON', async () => {
        const runner = makeRunner('not json');
        let caught: unknown;
        try {
            await extractMetadata('/test/video.mp4', runner);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).context.operation).toBe('ffprobe');
        expect((caught as MediaProcessingError).cause).toBeInstanceOf(SyntaxError);
    });

    it('logs warn before throwing on malformed JSON output', async () => {
        const runner = makeRunner('not json');
        expect(extractMetadata('/test/video.mp4', runner)).rejects.toThrow('Failed to parse ffprobe output');
        await Promise.resolve();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ msg: 'Failed to parse ffprobe output', stdout: 'not json' })
        );
    });

    it('throws on valid JSON with invalid schema (streams is not an array)', async () => {
        // Valid JSON but wrong structure — streams must be array if present
        const runner = makeRunner(JSON.stringify({ streams: 'not-an-array', format: { duration: '10.0' } }));
        expect(extractMetadata('/test/video.mp4', runner)).rejects.toThrow('Invalid ffprobe output schema');
    });

    it('logs warn before throwing on invalid schema', async () => {
        const runner = makeRunner(JSON.stringify({ streams: 'not-an-array', format: { duration: '10.0' } }));
        expect(extractMetadata('/test/video.mp4', runner)).rejects.toThrow('Invalid ffprobe output schema');
        await Promise.resolve();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ msg: 'Invalid ffprobe output schema', issues: expect.arrayContaining([expect.anything()]) })
        );
    });

    it('throws MediaProcessingError when no video stream found', async () => {
        const outputWithNoVideo = JSON.stringify({
            streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '44100', index: 0 }],
            format:  { duration: '10.0' },
        });
        const runner = makeRunner(outputWithNoVideo);
        let caught: unknown;
        try {
            await extractMetadata('/test/video.mp4', runner);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).message).toContain('No video stream found');
        expect((caught as MediaProcessingError).context.operation).toBe('ffprobe');
    });

    it('uses format bit_rate when video stream has no bit_rate', async () => {
        const output = JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, avg_frame_rate: '30/1', index: 0 }],
            format:  { duration: '10.0', bit_rate: '2000000' },
        });
        const metadata = await extractMetadata('/test/video.mp4', makeRunner(output));
        expect(metadata.videoBitrate).toBe(2_000_000);
    });
});

describe('parseFfprobeOutput', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        mockLogger.warn.mockClear();
    });

    it('parses valid JSON with streams and format', () => {
        const input = JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', index: 0 }],
            format:  { duration: '10.0', bit_rate: '4000000' },
        });
        const result = parseFfprobeOutput(input);
        expect(result.streams).toHaveLength(1);
        expect(result.format?.duration).toBe('10.0');
    });

    it('returns empty streams and format when JSON has no streams/format fields', () => {
        const input = JSON.stringify({});
        const result = parseFfprobeOutput(input);
        expect(result.streams).toBeUndefined();
        expect(result.format).toBeUndefined();
    });

    it('throws MediaProcessingError on invalid JSON', () => {
        let caught: unknown;
        try {
            parseFfprobeOutput('not json');
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).context.operation).toBe('ffprobe');
    });

    it('throws MediaProcessingError on valid JSON with invalid schema', () => {
        let caught: unknown;
        try {
            parseFfprobeOutput(JSON.stringify({ streams: 'not-an-array' }));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).context.operation).toBe('ffprobe');
    });

    it('parses optional stream fields correctly', () => {
        const input = JSON.stringify({
            streams: [{ codec_type: 'video' }], // minimal stream, no optional fields
            format:  {},
        });
        const result = parseFfprobeOutput(input);
        expect(result.streams).toHaveLength(1);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length asserted above
        expect(result.streams![0]!.codec_name).toBeUndefined();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length asserted above
        expect(result.streams![0]!.width).toBeUndefined();
    });
});
