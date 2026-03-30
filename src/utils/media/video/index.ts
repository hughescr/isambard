export type {
    VideoMetadata,
    TranscriptionResult,
    VideoProcessingResult,
    SpawnRunner,
    BinarySpawnRunner
} from './types';

export { createSpawnRunner, createBinarySpawnRunner } from './spawn-runner';
export { extractFramesInRange } from './frame-extractor';
export { generateSpectrogram } from './spectrogram';
export { processVideo, type ProcessVideoOptions } from './processor';
