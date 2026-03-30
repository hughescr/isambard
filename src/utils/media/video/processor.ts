import { mkdir, writeFile } from 'node:fs/promises';
import { downloadVideo } from './downloader';
import { extractSceneFrames } from './frame-extractor';
import { buildMetadataMarkdown } from './markdown-builder';
import { extractMetadata } from './metadata';
import { detectScenes } from './scene-detector';
import { createSpawnRunner, createBinarySpawnRunner } from './spawn-runner';
import { getSubtitlesOrTranscription } from './subtitle-extractor';
import type { VideoProcessingResult, SpawnRunner, BinarySpawnRunner } from './types';

// Stryker disable next-line StringLiteral: output filename is configuration
const METADATA_FILENAME = 'video-metadata.md';

export interface ProcessVideoOptions {
    run?:       SpawnRunner
    binaryRun?: BinarySpawnRunner
}

/**
 * Full video processing pipeline.
 *
 * 1. Creates output directory
 * 2. Downloads video (HLS or direct HTTP)
 * 3. Extracts ffprobe metadata
 * 4. Detects scene boundaries (ffmpeg scdet)
 * 5. Extracts 3 frames per scene (begin/mid/end)
 * 6. Gets subtitles (embedded) or transcription (WhisperKit)
 * 7. Builds metadata markdown and writes it to disk
 * 8. Returns VideoProcessingResult
 */
export async function processVideo(
    url:       string,
    outputDir: string,
    options?:  ProcessVideoOptions
): Promise<VideoProcessingResult> {
    const run       = options?.run       ?? createSpawnRunner();
    const binaryRun = options?.binaryRun ?? createBinarySpawnRunner();

    // 1. Create output directory
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: mkdir options — recursive:true is required behavior
    await mkdir(outputDir, { recursive: true });

    // 2. Download video
    const videoPath = await downloadVideo(url, outputDir, run);

    // 3. Extract metadata
    const metadata = await extractMetadata(videoPath, run);

    // 4. Detect scenes
    const scenes = await detectScenes(videoPath, metadata.duration, run);

    // 5. Extract frames
    const frames = await extractSceneFrames(videoPath, scenes, metadata.frameRate, binaryRun);

    // 6. Get subtitles or transcription
    const { subtitles, transcription } = await getSubtitlesOrTranscription(videoPath, metadata, outputDir, run);

    // 7. Build metadata markdown
    const metadataMarkdown = buildMetadataMarkdown(metadata, subtitles, transcription);

    // 8. Write markdown to disk
    // Stryker disable next-line StringLiteral: encoding option is configuration
    await writeFile(`${outputDir}/${METADATA_FILENAME}`, metadataMarkdown, 'utf8');

    return {
        metadata,
        frames,
        // Stryker disable next-line ConditionalExpression,ObjectLiteral: conditional spread — falsy branch produces no subtitles property
        ...(subtitles === undefined ? {} : { subtitles }),
        // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: conditional spread — falsy branch produces no transcription property
        ...(transcription === undefined ? {} : { transcription }),
        metadataMarkdown,
        outputDir,
    };
}
