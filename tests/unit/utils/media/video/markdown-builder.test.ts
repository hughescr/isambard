import { describe, it, expect } from 'bun:test';
import { buildMetadataMarkdown, formatDuration } from '@/utils/media/video/markdown-builder';
import type { VideoMetadata, TranscriptionResult } from '@/utils/media/video/types';

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
        { index: 0, language: 'eng', title: 'English' },
        { index: 1, language: 'fra' },
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

const SAMPLE_TRANSCRIPTION: TranscriptionResult = {
    segments: [
        { startTime: 5,   endTime: 8,   speaker: 'SPEAKER_00', text: 'Hello world' },
        { startTime: 65,  endTime: 68,  speaker: 'SPEAKER_01', text: 'How are you' },
        { startTime: 118, endTime: 119, text: 'Minute divisor boundary' },
        { startTime: 120, endTime: 121, text: 'Minute rollover boundary' },
        { startTime: 130, endTime: 133, text: 'No speaker label here' },
    ],
    fullText: 'Hello world How are you No speaker label here',
};

describe('formatDuration', () => {
    it('formats seconds only', () => {
        expect(formatDuration(45)).toBe('45s');
    });

    it('formats minutes and seconds', () => {
        expect(formatDuration(154)).toBe('2m 34s');
    });

    it('formats hours, minutes, and seconds', () => {
        expect(formatDuration(3661)).toBe('1h 1m 1s');
    });

    it('formats exactly one hour', () => {
        expect(formatDuration(3600)).toBe('1h 0s');
    });

    it('floors hours and seconds for ordinary video durations', () => {
        expect(formatDuration(1800)).toBe('30m 0s');
        expect(formatDuration(154.25)).toBe('2m 34s');
        expect(formatDuration(7198)).toBe('1h 59m 58s');
    });

    it('formats zero seconds', () => {
        expect(formatDuration(0)).toBe('0s');
    });
});

describe('buildMetadataMarkdown', () => {
    it('keeps technical details and transcription segments in source order', () => {
        const md = buildMetadataMarkdown(FULL_METADATA, undefined, SAMPLE_TRANSCRIPTION);

        expect(md).toBe([
            '# Video Metadata',
            '',
            '## Technical Details',
            '- **Duration**: 2m 34s',
            '- **Resolution**: 1920x1080',
            '- **Video Codec**: h264',
            '- **Frame Rate**: 30 fps',
            '- **Video Bitrate**: 4000 kbps',
            '- **Audio Codec**: aac (stereo, 44100 Hz)',
            '- **Subtitle Tracks**: Track 0 — eng — English, Track 1 — fra',
            '',
            '## Transcription',
            '',
            '[00:05] **SPEAKER_00**: Hello world',
            '[01:05] **SPEAKER_01**: How are you',
            '[01:58] Minute divisor boundary',
            '[02:00] Minute rollover boundary',
            '[02:10] No speaker label here',
        ].join('\n'));
    });

    it('formats track labels and separators without losing track identity', () => {
        const md = buildMetadataMarkdown(FULL_METADATA);
        expect(md).toContain('- **Subtitle Tracks**: Track 0 — eng — English, Track 1 — fra');
    });

    it('renders the technical-details row when there is exactly one subtitle track', () => {
        const md = buildMetadataMarkdown({
            ...MINIMAL_METADATA,
            subtitleTracks: [{ index: 4, language: 'eng', title: 'English' }],
        });

        expect(md).toContain('- **Subtitle Tracks**: Track 4 — eng — English');
    });

    it('preserves section spacing and trims embedded subtitle text', () => {
        const md = buildMetadataMarkdown(MINIMAL_METADATA, '  subtitle line  ', { segments: [], fullText: 'Transcript' }, 'Description');
        expect(md).toContain('## Description\n\nDescription\n\n## Subtitles\n\nsubtitle line\n\n## Transcription\n\nTranscript');
        expect(md).toEndWith('Transcript');
        expect(md).toStartWith('# Video Metadata\n\n## Technical Details');
        expect(md).toContain('fps\n\n## Description');
    });
    it('includes all technical details for full metadata', () => {
        const md = buildMetadataMarkdown(FULL_METADATA);
        expect(md).toContain('# Video Metadata');
        expect(md).toContain('## Technical Details');
        expect(md).toContain('**Duration**: 2m 34s');
        expect(md).toContain('**Resolution**: 1920x1080');
        expect(md).toContain('**Video Codec**: h264');
        expect(md).toContain('**Frame Rate**: 30 fps');
        expect(md).toContain('**Video Bitrate**: 4000 kbps');
        expect(md).toContain('**Audio Codec**: aac (stereo, 44100 Hz)');
        expect(md).toContain('**Subtitle Tracks**:');
        expect(md).toContain('eng');
        expect(md).toContain('English');
        expect(md).toContain('fra');
    });

    it('rounds the video bitrate to the nearest kbps rather than truncating', () => {
        const md = buildMetadataMarkdown({ ...MINIMAL_METADATA, videoBitrate: 4_000_501 });
        expect(md).toContain('- **Video Bitrate**: 4001 kbps');
    });

    it('floors (rather than rounds or ceils) a fractional segment-time remainder', () => {
        // Kills the llm mutants swapping Math.floor for Math.ceil/Math.round on the
        // seconds-within-minute remainder: 65.7s is minute 1, second floor(5.7)=5 — a
        // ceil or round would both yield 6, producing "01:06" instead of "01:05".
        const transcription: TranscriptionResult = {
            segments: [{ startTime: 65.7, endTime: 66, text: 'fractional boundary' }],
            fullText: 'fractional boundary',
        };
        const md = buildMetadataMarkdown(MINIMAL_METADATA, undefined, transcription);
        expect(md).toContain('[01:05] fractional boundary');
    });

    it('renders segment text verbatim, preserving its surrounding whitespace', () => {
        const transcription: TranscriptionResult = {
            segments: [{ startTime: 5, endTime: 8, text: '  padded  ' }],
            fullText: '  padded  ',
        };
        const md = buildMetadataMarkdown(MINIMAL_METADATA, undefined, transcription);
        expect(md).toContain('[00:05]   padded  ');
    });

    it('omits optional fields when not present', () => {
        const md = buildMetadataMarkdown(MINIMAL_METADATA);
        expect(md).not.toContain('Video Bitrate');
        expect(md).not.toContain('Audio Codec');
        expect(md).not.toContain('Subtitle Tracks');
    });

    it('includes embedded subtitles section', () => {
        const md = buildMetadataMarkdown(MINIMAL_METADATA, 'some SRT content here');
        expect(md).toContain('## Subtitles');
        expect(md).toContain('some SRT content here');
    });

    it('includes transcription section with speaker labels and timestamps', () => {
        const md = buildMetadataMarkdown(MINIMAL_METADATA, undefined, SAMPLE_TRANSCRIPTION);
        expect(md).toContain('## Transcription');
        expect(md).toContain('[00:05] **SPEAKER_00**: Hello world');
        expect(md).toContain('[01:05] **SPEAKER_01**: How are you');
        expect(md).toContain('[01:58] Minute divisor boundary');
        expect(md).toContain('[02:00] Minute rollover boundary');
        expect(md).toContain('[02:10] No speaker label here');
    });

    it('includes description section when alt text is provided', () => {
        const md = buildMetadataMarkdown(MINIMAL_METADATA, undefined, undefined, 'A video showing a sunset over the ocean');
        expect(md).toContain('## Description');
        expect(md).toContain('A video showing a sunset over the ocean');
    });

    it('omits description section when alt is not provided', () => {
        const md = buildMetadataMarkdown(MINIMAL_METADATA);
        expect(md).not.toContain('## Description');
    });

    it('includes the description section for an empty-string alt (presence, not truthiness, gates it)', () => {
        // Kills the llm mutant `alt !== undefined` → `alt`: an empty string is
        // defined-but-falsy, so a truthiness check would wrongly skip the section.
        const md = buildMetadataMarkdown(MINIMAL_METADATA, undefined, undefined, '');
        expect(md).toContain('## Description');
    });

    it('includes the subtitles section for an empty-string subtitles value (presence, not truthiness, gates it)', () => {
        // Kills the llm mutant `subtitles !== undefined` → `subtitles`: an empty string is
        // defined-but-falsy, so a truthiness check would wrongly skip the section.
        const md = buildMetadataMarkdown(MINIMAL_METADATA, '');
        expect(md).toContain('## Subtitles');
    });

    it('shows full text for transcription with no segments', () => {
        const emptyTranscription: TranscriptionResult = {
            segments: [],
            fullText: 'Transcription unavailable: error',
        };
        const md = buildMetadataMarkdown(MINIMAL_METADATA, undefined, emptyTranscription);
        expect(md).toContain('## Transcription');
        expect(md).toContain('Transcription unavailable: error');
    });

    it('formats mono audio correctly', () => {
        const monoMetadata: VideoMetadata = {
            ...MINIMAL_METADATA,
            audioCodec:    'mp3',
            audioChannels: 1,
        };
        const md = buildMetadataMarkdown(monoMetadata);
        expect(md).toContain('mp3 (mono)');
        expect(md).toContain('mono');
    });

    it('formats multi-channel audio correctly', () => {
        const surround: VideoMetadata = {
            ...MINIMAL_METADATA,
            audioCodec:      'ac3',
            audioChannels:   6,
            audioSampleRate: 48_000,
        };
        const md = buildMetadataMarkdown(surround);
        expect(md).toContain('6-channel');
        expect(md).toContain('48000 Hz');
    });

    it('does not append channel details when audio codec exists without channel count', () => {
        const md = buildMetadataMarkdown({ ...MINIMAL_METADATA, audioCodec: 'aac' });
        expect(md).toEndWith('- **Audio Codec**: aac');
    });
});
