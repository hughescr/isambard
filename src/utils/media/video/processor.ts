import { mkdir, writeFile } from 'node:fs/promises';
import { downloadVideo } from './downloader';
import { extractSceneFrames } from './frame-extractor';
import { buildMetadataMarkdown } from './markdown-builder';
import { extractMetadata } from './metadata';
import { detectScenes } from './scene-detector';
import { createSpawnRunner, createBinarySpawnRunner } from './spawn-runner';
import { getSubtitlesOrTranscription } from './subtitle-extractor';
import type { VideoProcessingResult, SpawnRunner, BinarySpawnRunner } from './types';

const METADATA_FILENAME = 'video-metadata.md';

interface ProcessVideoOptions {
    run?:       SpawnRunner
    binaryRun?: BinarySpawnRunner
    alt?:       string
}

/**
 * Post-download video processing pipeline (steps 3–8).
 *
 * 3. Extracts ffprobe metadata
 * 4. Detects scene boundaries (ffmpeg scdet)
 * 5. Extracts 3 frames per scene (begin/mid/end)
 * 6. Gets subtitles (embedded) or transcription (WhisperKit)
 * 7. Builds metadata markdown and writes it to disk
 * 8. Returns VideoProcessingResult
 *
 * Use this when the video has already been downloaded to disk.
 * Use {@link processVideo} when starting from a URL.
 */
export async function processLocalVideo(
    videoPath: string,
    outputDir: string,
    options?:  ProcessVideoOptions
): Promise<VideoProcessingResult> {
    const run       = options?.run       ?? createSpawnRunner();
    const binaryRun = options?.binaryRun ?? createBinarySpawnRunner();
    const alt       = options?.alt;

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // 3. Extract metadata
    const metadata = await extractMetadata(videoPath, run);

    // 4. Detect scenes
    const scenes = await detectScenes(videoPath, metadata.duration, run);

    // 5. Extract frames
    const frames = await extractSceneFrames(videoPath, scenes, metadata.frameRate, binaryRun);

    // 6. Get subtitles or transcription
    const text = await getSubtitlesOrTranscription(videoPath, metadata, outputDir, run);

    // 7. Build metadata markdown
    const metadataMarkdown = buildMetadataMarkdown(metadata, text, alt);

    // 8. Write markdown to disk
    await writeFile(`${outputDir}/${METADATA_FILENAME}`, metadataMarkdown, 'utf8');

    return {
        metadata,
        frames,
        text,
        metadataMarkdown,
        outputDir,
    };
}

/**
 * Full video processing pipeline.
 *
 * 1. Downloads video (HLS or direct HTTP)
 * 2–7. Delegates to {@link processLocalVideo} (which creates outputDir and runs steps 3–8)
 */
export async function processVideo(
    url:       string,
    outputDir: string,
    options?:  ProcessVideoOptions
): Promise<VideoProcessingResult> {
    const run = options?.run ?? createSpawnRunner();

    // 2. Download video
    const videoPath = await downloadVideo(url, outputDir, run);

    // 3–8. Process the local file
    return processLocalVideo(videoPath, outputDir, options);
}
