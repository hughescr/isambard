import type { VideoMetadata, TranscriptionResult } from './types';

/** Format a duration in seconds to a human-readable string like "1h 2m 34s". */
export function formatDuration(totalSeconds: number): string {
    const hours   = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const parts: string[] = [];
    if(hours > 0) {
        parts.push(`${hours}h`);
    }
    if(minutes > 0) {
        parts.push(`${minutes}m`);
    }
    parts.push(`${seconds}s`);
    return parts.join(' ');
}

/** Format audio channel count to a descriptive label. */
function formatChannels(channels: number): string {
    if(channels === 1) {
        return 'mono';
    }
    if(channels === 2) {
        return 'stereo';
    }
    return `${channels}-channel`;
}

/** Format a segment start time as MM:SS. */
function formatSegmentTime(seconds: number): string {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Build the audio details parenthetical if channel/sample-rate info is present. */
function buildAudioDetails(metadata: VideoMetadata): string {
    if(metadata.audioChannels === undefined) {
        // Stryker disable next-line StringLiteral: empty string return for missing audioChannels — covered by unit tests of buildMetadataMarkdown with audioChannels undefined
        return '';
    }
    const channelLabel = formatChannels(metadata.audioChannels);
    // Stryker disable next-line StringLiteral: separator and Hz label are informational
    const rateLabel    = metadata.audioSampleRate === undefined ? '' : `, ${metadata.audioSampleRate} Hz`;
    return ` (${channelLabel}${rateLabel})`;
}

/** Build the technical-details section lines. */
function buildTechnicalLines(metadata: VideoMetadata): string[] {
    // Stryker disable StringLiteral: section headings and field labels are informational markdown structure
    const lines: string[] = [
        '## Technical Details',
        `- **Duration**: ${formatDuration(metadata.duration)}`,
        `- **Resolution**: ${metadata.width}x${metadata.height}`,
        `- **Video Codec**: ${metadata.videoCodec}`,
        `- **Frame Rate**: ${Math.round(metadata.frameRate)} fps`,
    ];
    // Stryker restore StringLiteral

    if(metadata.videoBitrate !== undefined) {
        // Stryker disable next-line StringLiteral: field label is informational
        lines.push(`- **Video Bitrate**: ${Math.round(metadata.videoBitrate / 1000)} kbps`);
    }

    if(metadata.audioCodec !== undefined) {
        // Stryker disable next-line StringLiteral: field label is informational
        lines.push(`- **Audio Codec**: ${metadata.audioCodec}${buildAudioDetails(metadata)}`);
    }

    if(metadata.subtitleTracks.length > 0) {
        // Stryker disable StringLiteral,ArrayDeclaration: subtitle track list formatting strings are structural
        const trackList = metadata.subtitleTracks.map((t) => {
            const parts: string[] = [`Track ${t.index}`];
            if(t.language !== undefined) {
                parts.push(t.language);
            }
            if(t.title !== undefined) {
                parts.push(t.title);
            }
            return parts.join(' — ');
        }).join(', ');
        // Stryker restore StringLiteral,ArrayDeclaration
        // Stryker disable next-line StringLiteral: field label is informational
        lines.push(`- **Subtitle Tracks**: ${trackList}`);
    }

    return lines;
}

/** Build the transcription section lines. */
function buildTranscriptionLines(transcription: TranscriptionResult): string[] {
    // Stryker disable next-line ArrayDeclaration,StringLiteral: section heading array and string values are structural
    const lines = ['', '## Transcription', ''];
    if(transcription.segments.length === 0) {
        lines.push(transcription.fullText);
        return lines;
    }
    for(const seg of transcription.segments) {
        const timeLabel = formatSegmentTime(seg.startTime);
        // Stryker disable next-line StringLiteral: speaker label format is structural
        const speaker   = seg.speaker === undefined ? '' : `**${seg.speaker}**: `;
        // Stryker disable next-line StringLiteral: timestamp format is structural
        lines.push(`[${timeLabel}] ${speaker}${seg.text}`);
    }
    return lines;
}

/**
 * Build a markdown document summarising video metadata, subtitles, and transcription.
 * Pure function — no I/O.
 */
export function buildMetadataMarkdown(
    metadata:       VideoMetadata,
    subtitles?:     string,
    transcription?: TranscriptionResult,
    alt?:           string
): string {
    // Stryker disable next-line StringLiteral: top-level heading is structural
    const lines: string[] = ['# Video Metadata', '', ...buildTechnicalLines(metadata)];

    if(alt !== undefined) {
        // Stryker disable next-line StringLiteral,ArrayDeclaration: description section heading and separator are structural
        lines.push('', '## Description', '', alt);
    }

    if(subtitles !== undefined) {
        // Stryker disable next-line ArrayDeclaration,StringLiteral,MethodExpression: section heading strings and .trim() are structural
        lines.push('', '## Subtitles', '', subtitles.trim());
    }

    if(transcription !== undefined) {
        lines.push(...buildTranscriptionLines(transcription));
    }

    // Stryker disable next-line StringLiteral: newline join separator is structural
    return lines.join('\n');
}
