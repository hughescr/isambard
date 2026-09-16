import type { VideoMetadata, TranscriptionResult, TranscriptionSegment, SpawnRunner } from './types';
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

/** Parse WhisperKit CLI output into structured TranscriptionResult. */
function parseWhisperKitOutput(output: string): TranscriptionResult {
    const segmentRe = /\[(\d{2}:\d{2}:\d{2}[.,]\d+) *--> *(\d{2}:\d{2}:\d{2}[.,]\d+)\] *(.*)/gu;
    // Stryker restore Regex
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
    // Stryker restore BlockStatement,MethodExpression

    const fullText = segments.map(s => s.text).join(' ');
    return { segments, fullText };
}

/** Extract embedded subtitle track N as SRT text via ffmpeg piped output. */
export async function extractEmbeddedSubtitles(
    videoPath:  string,
    trackIndex: number,
    run:        SpawnRunner
): Promise<string> {
    const result = await run([
        'ffmpeg',
        '-i', videoPath,
        '-map', `0:s:${trackIndex}`,
        '-f', 'srt',
        'pipe:1',
    ]);
    // Stryker restore StringLiteral,ArrayDeclaration

    if(result.exitCode !== 0) {
        throw new MediaProcessingError(
            `Subtitle extraction failed with exit code ${result.exitCode}: ${result.stderr}`,
            'ffmpeg-subtitle',
            result.stderr
        );
    }

    return result.stdout;
}

/**
 * Transcribe audio from a video using WhisperKit CLI with speaker diarization.
 * Returns a graceful error result if whisperkit-cli is not found.
 */
export async function transcribeWithWhisperKit(
    videoPath:  string,
    outputDir:  string,
    run:        SpawnRunner
): Promise<TranscriptionResult> {
    const result = await run([
        'whisperkit-cli',
        'transcribe',
        '--audio-path', videoPath,
        '--diarization',
        '--report',
        '--report-path', outputDir,
    ]);
    // Stryker restore StringLiteral,ArrayDeclaration

    if(result.exitCode !== 0) {
        // whisperkit-cli not available or failed — return graceful error result
        const reason = result.stderr === '' ? `whisperkit-cli exited with code ${result.exitCode}` : result.stderr;
        return {
            segments: [],
            fullText: `Transcription unavailable: ${reason}`,
        };
    }

    return parseWhisperKitOutput(result.stdout);
}

/**
 * Determine and retrieve subtitles or transcription for a video.
 * Prefers embedded subtitles; falls back to WhisperKit transcription.
 */
export async function getSubtitlesOrTranscription(
    videoPath: string,
    metadata:  VideoMetadata,
    outputDir: string,
    run:       SpawnRunner
): Promise<{ subtitles?: string, transcription?: TranscriptionResult }> {
    if(metadata.subtitleTracks.length > 0) {
        const subtitles = await extractEmbeddedSubtitles(videoPath, 0, run);
        return { subtitles };
    }

    const transcription = await transcribeWithWhisperKit(videoPath, outputDir, run);
    return { transcription };
}
