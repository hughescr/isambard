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
    index:     number
    language?: string
    title?:    string
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

export interface TranscriptionResult {
    segments: TranscriptionSegment[]
    fullText: string
}

export interface VideoProcessingResult {
    metadata:         VideoMetadata
    frames:           FetchedImage[]
    subtitles?:       string
    transcription?:   TranscriptionResult
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
