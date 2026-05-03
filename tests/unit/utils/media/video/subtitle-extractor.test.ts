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

describe('extractEmbeddedSubtitles', () => {
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

    it('parses segments without speaker labels', async () => {
        const noSpeakerOutput = '[00:00:10.000 --> 00:00:12.000]  Just plain text\n';
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(noSpeakerOutput));
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0]).toMatchObject({ text: 'Just plain text' });
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

    it('falls back to WhisperKit transcription when no subtitle tracks', async () => {
        const runner = makeTextRunner(SAMPLE_WHISPERKIT_OUTPUT);
        const result = await getSubtitlesOrTranscription('/test/video.mp4', MINIMAL_METADATA, '/tmp/out', runner);
        expect(result.transcription).toBeDefined();
        expect(result.transcription?.segments).toHaveLength(2);
        expect(result.subtitles).toBeUndefined();
    });
});
