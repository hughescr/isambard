import { describe, it, expect } from 'bun:test';
import { MediaProcessingError } from '@/errors';
import {
    extractEmbeddedSubtitles,
    transcribeWithWhisperKit,
    getSubtitlesOrTranscription
} from '@/utils/media/video/subtitle-extractor';
import type { VideoMetadata, SpawnRunner } from '@/utils/media/video/types';

function makeTextRunner(stdout: string, exitCode = 0): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({
        stdout,
        stderr: '',
        exitCode,
    });
}

function makeFailRunner(stderr: string, exitCode = 1): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({
        stdout: '',
        stderr,
        exitCode,
    });
}

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,000 --> 00:00:06,000
Goodbye world
`;

const SAMPLE_WHISPERKIT_OUTPUT = `
[00:00:01.000 --> 00:00:03.500]  SPEAKER_00: Hello world
[00:00:04.000 --> 00:00:07.000]  SPEAKER_01: How are you doing today
`;

const MINIMAL_METADATA: VideoMetadata = {
    duration:       60,
    width:          1920,
    height:         1080,
    videoCodec:     'h264',
    frameRate:      30,
    subtitleTracks: [],
};

const METADATA_WITH_SUBTITLES: VideoMetadata = {
    ...MINIMAL_METADATA,
    subtitleTracks: [{ index: 0, language: 'eng', title: 'English' }],
};

const METADATA_WITH_TWO_SUBTITLE_TRACKS: VideoMetadata = {
    ...MINIMAL_METADATA,
    subtitleTracks: [
        { index: 0, language: 'eng', title: 'English' },
        { index: 1, language: 'fre', title: 'French' },
    ],
};

describe('extractEmbeddedSubtitles', () => {
    it('passes the selected track and pipe output as exact ffmpeg arguments', async () => {
        const calls: string[][] = [];
        const run: SpawnRunner = async (args) => {
            calls.push(args);
            return { stdout: SAMPLE_SRT, stderr: '', exitCode: 0 };
        };

        await extractEmbeddedSubtitles('/test/video.mp4', 2, run);
        expect(calls).toEqual([['ffmpeg', '-i', '/test/video.mp4', '-map', '0:s:2', '-f', 'srt', 'pipe:1']]);
    });

    it('returns SRT text from ffmpeg stdout', async () => {
        const result = await extractEmbeddedSubtitles('/test/video.mp4', 0, makeTextRunner(SAMPLE_SRT));
        expect(result).toBe(SAMPLE_SRT);
    });

    it('throws MediaProcessingError when ffmpeg exits with non-zero code', async () => {
        let caught: unknown;
        try {
            await extractEmbeddedSubtitles('/test/video.mp4', 0, makeFailRunner('no subtitle track'));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).message).toContain('Subtitle extraction failed');
        expect((caught as MediaProcessingError).context.operation).toBe('ffmpeg-subtitle');
    });
});

describe('transcribeWithWhisperKit', () => {
    it('passes audio and report paths as exact WhisperKit arguments', async () => {
        const calls: string[][] = [];
        const run: SpawnRunner = async (args) => {
            calls.push(args);
            return { stdout: '', stderr: '', exitCode: 0 };
        };

        await transcribeWithWhisperKit('/test/video.mp4', '/tmp/report', run);
        expect(calls).toEqual([['whisperkit-cli', 'transcribe', '--audio-path', '/test/video.mp4', '--diarization', '--report', '--report-path', '/tmp/report']]);
    });

    it('parses timestamped segments from whisperkit output', async () => {
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(SAMPLE_WHISPERKIT_OUTPUT));
        expect(result.segments).toHaveLength(2);
        expect(result.segments[0]).toMatchObject({
            startTime: 1,
            endTime:   3.5,
            speaker:   'SPEAKER_00',
            text:      'Hello world',
        });
        expect(result.segments[1]).toMatchObject({
            speaker: 'SPEAKER_01',
            text:    'How are you doing today',
        });
        expect(result.fullText).toContain('Hello world');
        expect(result.fullText).toContain('How are you doing today');
    });

    it('correctly parses multi-hour timestamps (verifies hours*3600 + minutes*60 arithmetic)', async () => {
        // 01:23:45.000 = 3600 + 23*60 + 45 = 3600 + 1380 + 45 = 5025
        // 01:23:46.500 = 3600 + 1380 + 46.5 = 5026.5
        const multiHourOutput = '[01:23:45.000 --> 01:23:46.500]  SPEAKER_00: Multi-hour test\n';
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(multiHourOutput));
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0]).toMatchObject({
            startTime: 5025,
            endTime:   5026.5,
            text:      'Multi-hour test',
        });
    });

    it('parses comma fractional timestamps as numeric seconds', async () => {
        const commaOutput = '[01:23:45,125 --> 01:23:46,875]  SPEAKER_00: Comma fraction\n';
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(commaOutput));
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0]).toMatchObject({
            startTime: 5025.125,
            endTime:   5026.875,
            text:      'Comma fraction',
        });
    });

    it('parses segments without speaker labels', async () => {
        const noSpeakerOutput = '[00:00:10.000 --> 00:00:12.000]  Just plain text\n';
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(noSpeakerOutput));
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0]).toMatchObject({ text: 'Just plain text' });
        expect(result.segments[0]).not.toHaveProperty('speaker');
    });

    it('accepts timestamp lines without padding around the arrow or after the bracket', async () => {
        const compactOutput = '[00:00:10.000-->00:00:12.000]Compact text\n';
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(compactOutput));
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0]).toMatchObject({ startTime: 10, endTime: 12, text: 'Compact text' });
    });

    it('trims trailing whitespace from unlabelled segment text', async () => {
        const output = '[00:00:10.000 --> 00:00:12.000]  Plain text   \n';
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(output));
        expect(result.segments[0]).toMatchObject({ text: 'Plain text' });
        expect(result.segments[0]).not.toHaveProperty('speaker');
    });

    it.each([
        'UPPER!: body',
        '!UPPER: body',
        ': body',
    ])('does not classify invalid speaker label %s', async (rawText) => {
        const output = `[00:00:10.000 --> 00:00:12.000]  ${rawText}\n`;
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(output));
        expect(result.segments[0]).toMatchObject({ text: rawText });
        expect(result.segments[0]).not.toHaveProperty('speaker');
    });

    it('joins multiple segment texts with space separator', async () => {
        const twoSegments = '[00:00:01.000 --> 00:00:02.000]  First\n[00:00:03.000 --> 00:00:04.000]  Second\n';
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(twoSegments));
        expect(result.fullText).toBe('First Second');
    });

    it('returns graceful error result when whisperkit-cli is not available', async () => {
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeFailRunner('whisperkit-cli: command not found'));
        expect(result.segments).toHaveLength(0);
        expect(result.fullText).toContain('Transcription unavailable');
    });

    it('reports the exit code when WhisperKit fails with empty stderr', async () => {
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeFailRunner('', 7));
        expect(result).toEqual({ segments: [], fullText: 'Transcription unavailable: whisperkit-cli exited with code 7' });
    });

    it('treats negative WhisperKit exit codes as failures', async () => {
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeFailRunner('', -1));
        expect(result).toEqual({ segments: [], fullText: 'Transcription unavailable: whisperkit-cli exited with code -1' });
    });

    it('reports nonempty WhisperKit stderr without replacing it with an exit-code message', async () => {
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeFailRunner('model unavailable', 7));
        expect(result).toEqual({ segments: [], fullText: 'Transcription unavailable: model unavailable' });
    });

    it('returns empty segments for output with no matching timestamp lines', async () => {
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner('Processing audio...'));
        expect(result.segments).toHaveLength(0);
        expect(result.fullText).toBe('');
    });
});

describe('getSubtitlesOrTranscription', () => {
    it('extracts embedded subtitles when subtitle tracks are present', async () => {
        const runner = makeTextRunner(SAMPLE_SRT);
        const result = await getSubtitlesOrTranscription('/test/video.mp4', METADATA_WITH_SUBTITLES, '/tmp/out', runner);
        expect(result.subtitles).toBe(SAMPLE_SRT);
        expect(result.transcription).toBeUndefined();
    });

    it('extracts the first embedded stream for exactly one subtitle track without WhisperKit fallback', async () => {
        const calls: string[][] = [];
        const runner: SpawnRunner = async (args) => {
            calls.push(args);
            return { stdout: SAMPLE_SRT, stderr: '', exitCode: 0 };
        };

        const result = await getSubtitlesOrTranscription('/test/video.mp4', METADATA_WITH_SUBTITLES, '/tmp/out', runner);

        expect(result).toEqual({ subtitles: SAMPLE_SRT });
        expect(calls).toEqual([['ffmpeg', '-i', '/test/video.mp4', '-map', '0:s:0', '-f', 'srt', 'pipe:1']]);
    });

    it('falls back to WhisperKit transcription when no subtitle tracks', async () => {
        const runner = makeTextRunner(SAMPLE_WHISPERKIT_OUTPUT);
        const result = await getSubtitlesOrTranscription('/test/video.mp4', MINIMAL_METADATA, '/tmp/out', runner);
        expect(result.transcription).toBeDefined();
        expect(result.transcription?.segments).toHaveLength(2);
        expect(result.subtitles).toBeUndefined();
    });

    it('always selects track 0 when multiple subtitle tracks are present', async () => {
        const calls: string[][] = [];
        const runner: SpawnRunner = async (args) => {
            calls.push(args);
            return { stdout: SAMPLE_SRT, stderr: '', exitCode: 0 };
        };

        await getSubtitlesOrTranscription('/test/video.mp4', METADATA_WITH_TWO_SUBTITLE_TRACKS, '/tmp/out', runner);

        expect(calls).toEqual([['ffmpeg', '-i', '/test/video.mp4', '-map', '0:s:0', '-f', 'srt', 'pipe:1']]);
    });

    it('omits the transcription key entirely when returning embedded subtitles', async () => {
        const runner = makeTextRunner(SAMPLE_SRT);
        const result = await getSubtitlesOrTranscription('/test/video.mp4', METADATA_WITH_SUBTITLES, '/tmp/out', runner);
        expect(result).toStrictEqual({ subtitles: SAMPLE_SRT });
        expect(Object.keys(result)).toEqual(['subtitles']);
    });
});
