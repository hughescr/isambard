export type {
    VideoMetadata,
    SubtitleTrack,
    SceneInfo,
    TranscriptionSegment,
    TranscriptionResult,
    VideoProcessingResult,
    SpawnResult,
    BinarySpawnResult,
    SpawnRunner,
    BinarySpawnRunner
} from './types';

export { createSpawnRunner, createBinarySpawnRunner } from './spawn-runner';
export { extractMetadata } from './metadata';
export { detectScenes } from './scene-detector';
export {
    extractSceneFrames,
    extractFramesAtTimestamps,
    extractFramesInRange
} from './frame-extractor';
export { downloadVideo, isHlsUrl } from './downloader';
export {
    extractEmbeddedSubtitles,
    transcribeWithWhisperKit,
    getSubtitlesOrTranscription
} from './subtitle-extractor';
export { generateSpectrogram } from './spectrogram';
export { buildMetadataMarkdown, formatDuration } from './markdown-builder';
export { processVideo, type ProcessVideoOptions } from './processor';
