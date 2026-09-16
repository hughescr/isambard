import type { VideoMetadata, TranscriptionResult } from './types';

/** Format a duration in seconds to a human-readable string like "1h 2m 34s". */
export function formatDuration(totalSeconds: number): string {
    const hours   = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const parts: string[] = [];
    if(hours > 0) {
        // Stryker disable next-line ArrayMethodSwap: parts is empty, so push and unshift place the first duration component identically.
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
        return '';
    }
    const channelLabel = formatChannels(metadata.audioChannels);
    const rateLabel    = metadata.audioSampleRate === undefined ? '' : `, ${metadata.audioSampleRate} Hz`;
    return ` (${channelLabel}${rateLabel})`;
}

/** Build the technical-details section lines. */
function buildTechnicalLines(metadata: VideoMetadata): string[] {
    const lines: string[] = [
        '## Technical Details',
        `- **Duration**: ${formatDuration(metadata.duration)}`,
        `- **Resolution**: ${metadata.width}x${metadata.height}`,
        `- **Video Codec**: ${metadata.videoCodec}`,
        `- **Frame Rate**: ${Math.round(metadata.frameRate)} fps`,
    ];

    if(metadata.videoBitrate !== undefined) {
        lines.push(`- **Video Bitrate**: ${Math.round(metadata.videoBitrate / 1000)} kbps`);
    }

    if(metadata.audioCodec !== undefined) {
        lines.push(`- **Audio Codec**: ${metadata.audioCodec}${buildAudioDetails(metadata)}`);
    }

    // Stryker disable next-line llm: Array length is a non-negative integer, so `length > 0` and `length >= 1` are the same predicate.
    if(metadata.subtitleTracks.length > 0) {
        const trackList = metadata.subtitleTracks.map((t) => {
            // Stryker disable next-line llm: `x || 0` is a no-op for every producible index value (0 maps to 0, any other number is truthy); only NaN would differ, which the ffprobe schema rejects.
            const parts: string[] = [`Track ${t.index}`];
            if(t.language !== undefined) {
                parts.push(t.language);
            }
            if(t.title !== undefined) {
                parts.push(t.title);
            }
            return parts.join(' — ');
        }).join(', ');
        lines.push(`- **Subtitle Tracks**: ${trackList}`);
    }

    return lines;
}

/** Build the transcription section lines. */
function buildTranscriptionLines(transcription: TranscriptionResult): string[] {
    const lines = ['', '## Transcription', ''];
    if(transcription.segments.length === 0) {
        lines.push(transcription.fullText);
        return lines;
    }
    for(const seg of transcription.segments) {
        const timeLabel = formatSegmentTime(seg.startTime);
        const speaker   = seg.speaker === undefined ? '' : `**${seg.speaker}**: `;
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
    const lines: string[] = ['# Video Metadata', '', ...buildTechnicalLines(metadata)];

    if(alt !== undefined) {
        lines.push('', '## Description', '', alt);
    }

    if(subtitles !== undefined) {
        lines.push('', '## Subtitles', '', subtitles.trim());
    }

    if(transcription !== undefined) {
        lines.push(...buildTranscriptionLines(transcription));
    }

    return lines.join('\n');
}
