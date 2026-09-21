import { describe, it, expect } from 'bun:test';
import { MediaProcessingError } from '@/errors';
import {
    extractEmbeddedSubtitles,
    transcribeWithWhisperKit,
    getSubtitlesOrTranscription
} from '@/utils/media/video/subtitle-extractor';
import type { VideoMetadata, SpawnRunner } from '@/utils/media/video/types';

function makeTextRunner(stdout: string, exitCode = 0): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({ stdout, stderr: '', exitCode });
}

function makeFailRunner(stderr: string, exitCode = 1): SpawnRunner {
    return async (): Promise<{ stdout: string, stderr: string, exitCode: number }> => ({ stdout: '', stderr, exitCode });
}

const SAMPLE_SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello world\n';
const SAMPLE_WHISPERKIT_OUTPUT = '[00:00:01.000 --> 00:00:03.500]  SPEAKER_00: Hello world\n';

const MINIMAL_METADATA: VideoMetadata = {
    duration: 60, width: 1920, height: 1080, videoCodec: 'h264', frameRate: 30, subtitleTracks: [],
};

const METADATA_WITH_SUBTITLES: VideoMetadata = {
    ...MINIMAL_METADATA,
    subtitleTracks: [{ streamIndex: 2, subtitleOrdinal: 0, language: 'eng', title: 'English' }],
};

describe('extractEmbeddedSubtitles', () => {
    it('maps ffmpeg using the subtitle ordinal, not the container stream index', async () => {
        const calls: string[][] = [];
        const run: SpawnRunner = async (args) => {
            calls.push(args);
            return { stdout: SAMPLE_SRT, stderr: '', exitCode: 0 };
        };

        await extractEmbeddedSubtitles('/test/video.mp4', 0, run);
        expect(calls).toEqual([['ffmpeg', '-i', '/test/video.mp4', '-map', '0:s:0', '-f', 'srt', 'pipe:1']]);
    });

    it('returns SRT text from ffmpeg stdout', async () => {
        await expect(extractEmbeddedSubtitles('/test/video.mp4', 0, makeTextRunner(SAMPLE_SRT))).resolves.toBe(SAMPLE_SRT);
    });

    it('throws MediaProcessingError when ffmpeg exits with non-zero code', async () => {
        await expect(extractEmbeddedSubtitles('/test/video.mp4', 0, makeFailRunner('no subtitle track'))).rejects.toBeInstanceOf(MediaProcessingError);
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

    it('returns a transcribed outcome with parsed segments', async () => {
        const result = await transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner(SAMPLE_WHISPERKIT_OUTPUT));
        expect(result).toEqual({
            kind:     'transcribed',
            segments: [{ startTime: 1, endTime: 3.5, speaker: 'SPEAKER_00', text: 'Hello world' }],
        });
    });

    it('returns an empty outcome when no timestamped segments are parsed', async () => {
        await expect(transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeTextRunner('Processing audio...'))).resolves.toEqual({ kind: 'empty' });
    });

    it('returns an unavailable outcome with the command diagnostic', async () => {
        await expect(transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeFailRunner('model unavailable', 7))).resolves.toEqual({
            kind: 'unavailable', reason: 'model unavailable',
        });
    });

    it('reports the exit code when WhisperKit fails with empty stderr', async () => {
        await expect(transcribeWithWhisperKit('/test/video.mp4', '/tmp/out', makeFailRunner('', 7))).resolves.toEqual({
            kind: 'unavailable', reason: 'whisperkit-cli exited with code 7',
        });
    });
});

describe('getSubtitlesOrTranscription', () => {
    it('returns subtitles as the selected source and passes its ordinal to ffmpeg', async () => {
        const calls: string[][] = [];
        const run: SpawnRunner = async (args) => {
            calls.push(args);
            return { stdout: SAMPLE_SRT, stderr: '', exitCode: 0 };
        };

        await expect(getSubtitlesOrTranscription('/test/video.mp4', METADATA_WITH_SUBTITLES, '/tmp/out', run)).resolves.toEqual({
            kind: 'subtitles', subtitleOrdinal: 0, outcome: { kind: 'extracted', text: SAMPLE_SRT },
        });
        expect(calls).toEqual([['ffmpeg', '-i', '/test/video.mp4', '-map', '0:s:0', '-f', 'srt', 'pipe:1']]);
    });

    it('keeps an empty-stderr subtitle failure as a diagnostic value', async () => {
        await expect(getSubtitlesOrTranscription('/test/video.mp4', METADATA_WITH_SUBTITLES, '/tmp/out', makeFailRunner('', 7))).resolves.toEqual({
            kind:            'subtitles',
            subtitleOrdinal: 0,
            outcome:         { kind: 'unavailable', reason: 'ffmpeg exited with code 7' },
        });
    });

    it('only converts MediaProcessingError subtitle failures to an unavailable outcome', async () => {
        const unexpected = new Error('runner invariant failed');
        const run: SpawnRunner = async () => {
            throw unexpected;
        };
        await expect(getSubtitlesOrTranscription('/test/video.mp4', METADATA_WITH_SUBTITLES, '/tmp/out', run)).rejects.toBe(unexpected);
    });

    it('returns transcription as the selected source when no subtitles exist', async () => {
        await expect(getSubtitlesOrTranscription('/test/video.mp4', MINIMAL_METADATA, '/tmp/out', makeTextRunner(SAMPLE_WHISPERKIT_OUTPUT))).resolves.toEqual({
            kind:    'transcription',
            outcome: {
                kind:     'transcribed',
                segments: [{ startTime: 1, endTime: 3.5, speaker: 'SPEAKER_00', text: 'Hello world' }],
            },
        });
    });
});
