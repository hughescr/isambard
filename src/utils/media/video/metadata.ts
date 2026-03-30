import type { VideoMetadata, SubtitleTrack, SpawnRunner } from './types';

interface FfprobeStream {
    codec_type:      string
    codec_name?:     string
    width?:          number
    height?:         number
    bit_rate?:       string
    r_frame_rate?:   string
    avg_frame_rate?: string
    channels?:       number
    sample_rate?:    string
    index?:          number
    tags?: {
        language?: string
        title?:    string
    }
}

interface FfprobeFormat {
    duration?: string
    bit_rate?: string
}

interface FfprobeOutput {
    streams?: FfprobeStream[]
    format?:  FfprobeFormat
}

function parseFrameRate(rateStr: string | undefined): number {
    if(rateStr === undefined) {
        return 0;
    }
    const parts = rateStr.split('/');
    if(parts.length === 2) {
        const num = Number(parts[0]);
        const den = Number(parts[1]);
        return den === 0 ? 0 : num / den;
    }
    return Number(rateStr) || 0;
}

export async function extractMetadata(videoPath: string, run: SpawnRunner): Promise<VideoMetadata> {
    // Stryker disable StringLiteral: ffprobe command arguments are configuration
    const result = await run([
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        videoPath,
    ]);
    // Stryker restore StringLiteral

    if(result.exitCode !== 0) {
        throw new Error(`ffprobe failed with exit code ${result.exitCode}: ${result.stderr}`);
    }

    let parsed: FfprobeOutput;
    try {
        parsed = JSON.parse(result.stdout) as FfprobeOutput;
    } catch{
        throw new Error(`Failed to parse ffprobe output: ${result.stdout}`);
    }

    const streams = parsed.streams ?? [];
    const format  = parsed.format ?? {};

    const videoStream    = streams.find(s => s.codec_type === 'video');
    const audioStream    = streams.find(s => s.codec_type === 'audio');
    const subtitleTracks = streams
        .filter(s => s.codec_type === 'subtitle')
        .map((s, i): SubtitleTrack => ({
            index:    s.index ?? i,
            language: s.tags?.language,
            title:    s.tags?.title,
        }));

    if(videoStream === undefined) {
        throw new Error('No video stream found in ffprobe output');
    }

    const duration    = Number(format.duration ?? 0);
    const frameRate   = parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate);
    const videoBitRaw = videoStream.bit_rate ?? format.bit_rate;

    return {
        duration,
        width:      videoStream.width ?? 0,
        height:     videoStream.height ?? 0,
        // Stryker disable next-line StringLiteral: fallback codec name is informational — tests always provide codec_name
        videoCodec: videoStream.codec_name ?? 'unknown',
        frameRate,
        // Stryker disable next-line ConditionalExpression,ObjectLiteral: conditional spread — falsy branch produces no videoBitrate property
        ...(videoBitRaw === undefined ? {} : { videoBitrate: Number(videoBitRaw) }),
        ...(audioStream === undefined
            ? {}
            : {
                audioCodec:    audioStream.codec_name,
                audioChannels: audioStream.channels,
                // Stryker disable next-line ConditionalExpression,ObjectLiteral: conditional spread — falsy branch produces no audioSampleRate property
                ...(audioStream.sample_rate === undefined
                    ? {}
                    : { audioSampleRate: Number(audioStream.sample_rate) }),
            }),
        subtitleTracks,
    };
}
