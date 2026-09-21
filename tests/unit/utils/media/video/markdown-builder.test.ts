import { describe, it, expect } from 'bun:test';
import { buildMetadataMarkdown, formatDuration } from '@/utils/media/video/markdown-builder';
import type { VideoMetadata, VideoTextSource, TranscriptionOutcome } from '@/utils/media/video/types';

const FULL_METADATA: VideoMetadata = {
    duration:        154,
    width:           1920,
    height:          1080,
    videoCodec:      'h264',
    frameRate:       29.97,
    videoBitrate:    4_000_000,
    audioCodec:      'aac',
    audioChannels:   2,
    audioSampleRate: 44_100,
    subtitleTracks:  [
        { streamIndex: 2, subtitleOrdinal: 0, language: 'eng', title: 'English' },
        { streamIndex: 3, subtitleOrdinal: 1, language: 'fra' },
    ],
};

const MINIMAL_METADATA: VideoMetadata = {
    duration:       60,
    width:          1280,
    height:         720,
    videoCodec:     'h264',
    frameRate:      30,
    subtitleTracks: [],
};

const TRANSCRIBED: TranscriptionOutcome = {
    kind:     'transcribed',
    segments: [
        { startTime: 5,   endTime: 8,   speaker: 'SPEAKER_00', text: 'Hello world' },
        { startTime: 65,  endTime: 68,  speaker: 'SPEAKER_01', text: 'How are you' },
        { startTime: 118, endTime: 119, text: 'Minute divisor boundary' },
        { startTime: 120, endTime: 121, text: 'Minute rollover boundary' },
        { startTime: 130, endTime: 133, text: 'No speaker label here' },
    ],
};

const TRANSCRIPTION_SOURCE: VideoTextSource = { kind: 'transcription', outcome: TRANSCRIBED };

type LegacyMarkdownBuilder = (metadata: VideoMetadata, subtitles?: string, transcription?: never) => string;

describe('formatDuration', () => {
    it('formats seconds, minutes, and hours', () => {
        expect(formatDuration(45)).toBe('45s');
        expect(formatDuration(154)).toBe('2m 34s');
        expect(formatDuration(3661)).toBe('1h 1m 1s');
        expect(formatDuration(3600)).toBe('1h 0s');
    });

    it('floors fractional seconds and handles zero', () => {
        expect(formatDuration(154.25)).toBe('2m 34s');
        expect(formatDuration(0)).toBe('0s');
    });
});

describe('buildMetadataMarkdown', () => {
    it('does not accept subtitles and transcription as positional optionals', () => {
        // @ts-expect-error buildMetadataMarkdown accepts one text-source argument, not subtitles and transcription optionals
        const legacyMarkdownBuilder: LegacyMarkdownBuilder = buildMetadataMarkdown;
        expect(legacyMarkdownBuilder).toBeDefined();
    });

    it('renders extracted subtitles and trims their text', () => {
        const source: VideoTextSource = {
            kind:            'subtitles',
            subtitleOrdinal: 0,
            outcome:         { kind: 'extracted', text: '  subtitle line  ' },
        };

        const md = buildMetadataMarkdown(MINIMAL_METADATA, source, 'Description');

        expect(md).toContain('## Description\n\nDescription');
        expect(md).toContain('## Subtitles\n\nsubtitle line');
        expect(md).not.toContain('## Transcription');
    });

    it('renders unavailable subtitles under the subtitle source', () => {
        const source: VideoTextSource = {
            kind:            'subtitles',
            subtitleOrdinal: 0,
            outcome:         { kind: 'unavailable', reason: 'ffmpeg exited with code 7' },
        };

        const md = buildMetadataMarkdown(MINIMAL_METADATA, source);

        expect(md).toContain('## Subtitles\n\n_Unavailable: ffmpeg exited with code 7_');
        expect(md).not.toContain('## Transcription');
    });

    it('renders transcription segments in source order', () => {
        const md = buildMetadataMarkdown(FULL_METADATA, TRANSCRIPTION_SOURCE);

        expect(md).toContain('- **Subtitle Tracks**: Track 0 (stream 2) — eng — English, Track 1 (stream 3) — fra');
        expect(md).toContain('## Transcription');
        expect(md).toContain('[00:05] **SPEAKER_00**: Hello world');
        expect(md).toContain('[01:05] **SPEAKER_01**: How are you');
        expect(md).toContain('[01:58] Minute divisor boundary');
        expect(md).toContain('[02:00] Minute rollover boundary');
        expect(md).toContain('[02:10] No speaker label here');
    });

    it('omits a stream label when ffprobe did not report a stream index', () => {
        const metadata: VideoMetadata = {
            ...MINIMAL_METADATA,
            subtitleTracks: [{ subtitleOrdinal: 0, language: 'eng' }],
        };

        const md = buildMetadataMarkdown(metadata, { kind: 'transcription', outcome: { kind: 'empty' } });

        expect(md).toContain('- **Subtitle Tracks**: Track 0 — eng');
        expect(md).not.toContain('stream undefined');
    });

    it('floors fractional segment-time remainders', () => {
        const source: VideoTextSource = {
            kind:    'transcription',
            outcome: { kind: 'transcribed', segments: [{ startTime: 65.7, endTime: 66, text: 'fractional boundary' }] },
        };
        expect(buildMetadataMarkdown(MINIMAL_METADATA, source)).toContain('[01:05] fractional boundary');
    });

    it('renders an explicit empty transcription outcome', () => {
        const source: VideoTextSource = { kind: 'transcription', outcome: { kind: 'empty' } };
        const md = buildMetadataMarkdown(MINIMAL_METADATA, source);
        expect(md).toContain('## Transcription\n\n_No transcription segments_');
    });

    it('renders an unavailable transcription diagnostic distinctly', () => {
        const source: VideoTextSource = { kind: 'transcription', outcome: { kind: 'unavailable', reason: 'model unavailable' } };
        const md = buildMetadataMarkdown(MINIMAL_METADATA, source);
        expect(md).toContain('## Transcription\n\n_Unavailable: model unavailable_');
    });

    it('includes optional technical details and description only when present', () => {
        const md = buildMetadataMarkdown({ ...MINIMAL_METADATA, videoBitrate: 4_000_501, audioCodec: 'aac' }, TRANSCRIPTION_SOURCE, '');
        expect(md).toContain('- **Video Bitrate**: 4001 kbps');
        expect(md).toContain('- **Audio Codec**: aac');
        expect(md).toContain('## Description');
        expect(md).not.toContain('Subtitle Tracks');
    });
});
