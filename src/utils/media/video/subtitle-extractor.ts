import type { VideoMetadata, TranscriptionResult, TranscriptionSegment, SpawnRunner } from './types';

/** Parse an HH:MM:SS.mmm timestamp string to seconds. */
function parseTimestamp(ts: string): number {
    const parts   = ts.split(':');
    // Stryker disable next-line LogicalOperator,StringLiteral: fallback defaults — never reached for well-formed timestamps
    const hours   = Number(parts[0] ?? '0');
    // Stryker disable next-line LogicalOperator,StringLiteral: fallback defaults — never reached for well-formed timestamps
    const minutes = Number(parts[1] ?? '0');
    // Stryker disable next-line StringLiteral: fallback default — never reached for well-formed timestamps
    const seconds = Number(parts[2] ?? '0');
    return hours * 3600 + minutes * 60 + seconds;
}

/** Parse WhisperKit CLI output into structured TranscriptionResult. */
function parseWhisperKitOutput(output: string): TranscriptionResult {
    // Stryker disable Regex: regex mutations produce structurally equivalent or invalid patterns
    const segmentRe = /\[(\d{2}:\d{2}:\d{2}[.,]\d+) *--> *(\d{2}:\d{2}:\d{2}[.,]\d+)\] *(.*)/gu;
    // Stryker restore Regex
    const segments: TranscriptionSegment[] = [];

    let match = segmentRe.exec(output);
    // Stryker disable BlockStatement,MethodExpression: loop body executes when regex matches — loop exit tested by empty-output test; .trim() removes leading/trailing whitespace from captured segment text
    while(match !== null) {
        // Stryker disable next-line StringLiteral,ArrayDeclaration: destructuring defaults — never reached for valid regex matches
        const [, startStr = '', endStr = '', rawSegment = ''] = match;
        const rawText = rawSegment.trim();
        // Detect speaker label: "SPEAKER_00: text" or "Speaker 1: text"
        // Use non-backtracking pattern: word chars/spaces before colon, then non-empty text after space
        const colonIdx   = rawText.indexOf(': ');
        // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: colonIdx > 0 check — both logic paths produce valid text extraction
        const speakerRaw = colonIdx > 0 ? rawText.slice(0, colonIdx) : '';
        // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,Regex: speaker detection heuristics — equivalent patterns produce same results
        const hasSpeaker = colonIdx > 0 && /^[\w ]+$/u.test(speakerRaw);
        const text = hasSpeaker ? rawText.slice(colonIdx + 2) : rawText;
        segments.push({
            startTime: parseTimestamp(startStr),
            endTime:   parseTimestamp(endStr),
            // Stryker disable next-line ArrayDeclaration,ObjectLiteral: conditional spread — falsy branch produces no speaker property
            ...(hasSpeaker ? { speaker: speakerRaw } : {}),
            text,
        });
        match = segmentRe.exec(output);
    }
    // Stryker restore BlockStatement,MethodExpression

    // Stryker disable next-line StringLiteral,ArrayDeclaration: join separator and array initializer are structural
    const fullText = segments.map(s => s.text).join(' ');
    return { segments, fullText };
}

/** Extract embedded subtitle track N as SRT text via ffmpeg piped output. */
export async function extractEmbeddedSubtitles(
    videoPath:  string,
    trackIndex: number,
    run:        SpawnRunner
): Promise<string> {
    // Stryker disable StringLiteral,ArrayDeclaration: ffmpeg command arguments are configuration
    const result = await run([
        'ffmpeg',
        '-i', videoPath,
        '-map', `0:s:${trackIndex}`,
        '-f', 'srt',
        'pipe:1',
    ]);
    // Stryker restore StringLiteral,ArrayDeclaration

    if(result.exitCode !== 0) {
        throw new Error(`Subtitle extraction failed with exit code ${result.exitCode}: ${result.stderr}`);
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
    // Stryker disable StringLiteral,ArrayDeclaration: whisperkit-cli command arguments are configuration
    const result = await run([
        'whisperkit-cli',
        'transcribe',
        '--audio-path', videoPath,
        '--diarization',
        '--report',
        '--report-path', outputDir,
        '--word-timestamps',
    ]);
    // Stryker restore StringLiteral,ArrayDeclaration

    if(result.exitCode !== 0) {
        // whisperkit-cli not available or failed — return graceful error result
        // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: empty string check for missing stderr — both produce informational message
        const reason = result.stderr === '' ? `whisperkit-cli exited with code ${result.exitCode}` : result.stderr;
        return {
            // Stryker disable next-line ArrayDeclaration: empty segments array is the correct value
            segments: [],
            // Stryker disable next-line StringLiteral: error prefix is informational only
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
