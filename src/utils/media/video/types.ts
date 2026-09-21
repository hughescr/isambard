import type { FetchedImage } from '../types';

export interface VideoMetadata {
    duration:         number    // seconds
    width:            number
    height:           number
    videoCodec:       string
    videoBitrate?:    number    // bits/sec
    frameRate:        number
    audioCodec?:      string
    audioChannels?:   number
    audioSampleRate?: number
    subtitleTracks:   SubtitleTrack[]
}

export interface SubtitleTrack {
    /** Container-wide ffprobe stream index, present only when ffprobe reports one. */
    streamIndex?:    number
    /** Zero-based position among subtitle streams, used by ffmpeg's `0:s:N` selector. */
    subtitleOrdinal: number
    language?:       string
    title?:          string
}

export interface SceneInfo {
    index:     number
    startTime: number  // seconds
    endTime:   number  // seconds
}

export interface TranscriptionSegment {
    startTime: number
    endTime:   number
    speaker?:  string
    text:      string
}

export type TranscriptionOutcome
    = | { kind: 'transcribed', segments: TranscriptionSegment[] }
      | { kind: 'empty' }
      | { kind: 'unavailable', reason: string };

export type SubtitleOutcome
    = | { kind: 'extracted', text: string }
      | { kind: 'unavailable', reason: string };

/** The sole textual source selected for a processed video. */
export type VideoTextSource
    = | { kind: 'subtitles', subtitleOrdinal: number, outcome: SubtitleOutcome }
      | { kind: 'transcription', outcome: TranscriptionOutcome };

export interface VideoProcessingResult {
    metadata:         VideoMetadata
    frames:           FetchedImage[]
    text:             VideoTextSource
    metadataMarkdown: string
    outputDir:        string
}

export interface SpawnResult {
    stdout:   string
    stderr:   string
    exitCode: number
}

export interface BinarySpawnResult {
    stdout:   Buffer
    stderr:   string
    exitCode: number
}

export type SpawnRunner = (cmd: string[], options?: { timeout?: number, cwd?: string }) => Promise<SpawnResult>;
export type BinarySpawnRunner = (cmd: string[], options?: { timeout?: number }) => Promise<BinarySpawnResult>;
