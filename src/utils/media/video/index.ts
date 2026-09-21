export type {
    VideoMetadata,
    TranscriptionOutcome,
    VideoTextSource,
    VideoProcessingResult,
    SpawnRunner,
    BinarySpawnRunner
} from './types';

export { createSpawnRunner, createBinarySpawnRunner } from './spawn-runner';
export { extractFramesInRange } from './frame-extractor';
export { generateSpectrogram } from './spectrogram';
export { processVideo, processLocalVideo } from './processor';
