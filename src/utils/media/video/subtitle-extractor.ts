import type { VideoMetadata, VideoTextSource, TranscriptionOutcome, TranscriptionSegment, SpawnRunner } from './types';
import { MediaProcessingError } from '@/errors';

/** Parse an HH:MM:SS.mmm timestamp string to seconds. */
function parseTimestamp(ts: string): number {
    const parts   = ts.split(':');
    // Stryker disable next-line StringLiteral: matched timestamp components cannot use this fallback
    const hours   = Number(parts[0] ?? '0');
    // Stryker disable next-line StringLiteral: matched timestamp components cannot use this fallback
    const minutes = Number(parts[1] ?? '0');
    // Stryker disable next-line StringLiteral: fallback default — never reached for well-formed timestamps
    const rawSeconds = parts[2] ?? '0';
    const seconds = Number(rawSeconds.replace(',', '.'));
    return hours * 3600 + minutes * 60 + seconds;
}

/** Parse WhisperKit CLI output into a discriminated transcription outcome. */
function parseWhisperKitOutput(output: string): TranscriptionOutcome {
    const segmentRe = /\[(\d{2}:\d{2}:\d{2}[.,]\d+) *--> *(\d{2}:\d{2}:\d{2}[.,]\d+)\] *(.*)/gu;
    const segments: TranscriptionSegment[] = [];

    let match = segmentRe.exec(output);
    while(match !== null) {
        // Stryker disable next-line StringLiteral: destructuring defaults — never reached for valid regex matches
        const [, startStr = '', endStr = '', rawSegment = ''] = match;
        const rawText = rawSegment.trim();
        // A nonempty word/space prefix followed by ": " is a speaker label.
        const speakerMatch = /^([\w ]+): /u.exec(rawText);
        const text = speakerMatch ? rawText.slice(speakerMatch[0].length) : rawText;
        segments.push({
            startTime: parseTimestamp(startStr),
            endTime:   parseTimestamp(endStr),
            ...(speakerMatch ? { speaker: speakerMatch[1] } : {}),
            text,
        });
        match = segmentRe.exec(output);
    }

    return segments.length === 0 ? { kind: 'empty' } : { kind: 'transcribed', segments };
}

/** Extract subtitle stream ordinal N as SRT text via ffmpeg's `0:s:N` selector. */
export async function extractEmbeddedSubtitles(
    videoPath:        string,
    subtitleOrdinal:  number,
    run:              SpawnRunner
): Promise<string> {
    const result = await run([
        'ffmpeg',
        '-i', videoPath,
        '-map', `0:s:${subtitleOrdinal}`,
        '-f', 'srt',
        'pipe:1',
    ]);

    if(result.exitCode !== 0) {
        const detail = result.stderr === '' ? `ffmpeg exited with code ${result.exitCode}` : result.stderr;
        throw new MediaProcessingError(
            `Subtitle extraction failed with exit code ${result.exitCode}: ${detail}`,
            'ffmpeg-subtitle',
            detail
        );
    }

    return result.stdout;
}

/**
 * Transcribe audio from a video using WhisperKit CLI with speaker diarization.
 * Returns a graceful unavailable outcome if whisperkit-cli cannot produce a transcript.
 */
export async function transcribeWithWhisperKit(
    videoPath:  string,
    outputDir:  string,
    run:        SpawnRunner
): Promise<TranscriptionOutcome> {
    const result = await run([
        'whisperkit-cli',
        'transcribe',
        '--audio-path', videoPath,
        '--diarization',
        '--report',
        '--report-path', outputDir,
    ]);

    if(result.exitCode !== 0) {
        const reason = result.stderr === '' ? `whisperkit-cli exited with code ${result.exitCode}` : result.stderr;
        return { kind: 'unavailable', reason };
    }

    return parseWhisperKitOutput(result.stdout);
}

/**
 * Determine and retrieve the textual source for a video.
 *
 * Embedded subtitle extraction failures are represented as subtitle outcomes so
 * callers can degrade gracefully; unexpected errors still propagate.
 */
export async function getSubtitlesOrTranscription(
    videoPath: string,
    metadata:  VideoMetadata,
    outputDir: string,
    run:       SpawnRunner
): Promise<VideoTextSource> {
    const subtitleTrack = metadata.subtitleTracks[0];
    if(subtitleTrack !== undefined) {
        try {
            const text = await extractEmbeddedSubtitles(videoPath, subtitleTrack.subtitleOrdinal, run);
            return { kind: 'subtitles', subtitleOrdinal: subtitleTrack.subtitleOrdinal, outcome: { kind: 'extracted', text } };
        } catch (error) {
            if(!(error instanceof MediaProcessingError)) {
                throw error;
            }
            const detail = error.context.detail;
            const reason = detail === undefined || detail === '' ? error.message : detail;
            return { kind: 'subtitles', subtitleOrdinal: subtitleTrack.subtitleOrdinal, outcome: { kind: 'unavailable', reason } };
        }
    }

    const outcome = await transcribeWithWhisperKit(videoPath, outputDir, run);
    return { kind: 'transcription', outcome };
}
