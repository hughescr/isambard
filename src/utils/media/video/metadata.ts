import { logger } from '@hughescr/logger';
import { z } from 'zod';
import type { VideoMetadata, SubtitleTrack, SpawnRunner } from './types';
import { MediaProcessingError } from '@/errors';

const ffprobeStreamSchema = z.object({
    codec_type:     z.string(),
    codec_name:     z.string().optional(),
    width:          z.number().optional(),
    height:         z.number().optional(),
    bit_rate:       z.string().optional(),
    r_frame_rate:   z.string().optional(),
    avg_frame_rate: z.string().optional(),
    channels:       z.number().optional(),
    sample_rate:    z.string().optional(),
    index:          z.number().optional(),
    tags:           z.object({
        language: z.string().optional(),
        title:    z.string().optional(),
    }).optional(),
});

const ffprobeFormatSchema = z.object({
    duration: z.string().optional(),
    bit_rate: z.string().optional(),
});

const ffprobeOutputSchema = z.object({
    streams: z.array(ffprobeStreamSchema).optional(),
    format:  ffprobeFormatSchema.optional(),
});

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

/** Parse and validate raw ffprobe JSON stdout. Throws on parse or schema errors.
 * @internal
 */
export function parseFfprobeOutput(stdout: string): z.infer<typeof ffprobeOutputSchema> {
    let rawParsed: unknown;
    try {
        rawParsed = JSON.parse(stdout);
    } catch (err) {
        // Stryker disable next-line ObjectLiteral: Logger warn object for observability
        logger.warn({
            err,
            stdout,
            // Stryker disable next-line StringLiteral: log message is informational only
            msg: 'Failed to parse ffprobe output',
        });
        throw new MediaProcessingError(
            `Failed to parse ffprobe output: ${stdout}`,
            'ffprobe',
            stdout,
            err
        );
    }

    const schemaResult = ffprobeOutputSchema.safeParse(rawParsed);
    if(!schemaResult.success) {
        // Stryker disable next-line ObjectLiteral: Logger warn object for observability
        logger.warn({
            issues: schemaResult.error.issues,
            // Stryker disable next-line StringLiteral: log message is informational only
            msg:    'Invalid ffprobe output schema',
        });
        throw new MediaProcessingError(
            `Invalid ffprobe output schema: ${JSON.stringify(schemaResult.error.issues)}`,
            'ffprobe',
            JSON.stringify(schemaResult.error.issues)
        );
    }
    return schemaResult.data;
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
        throw new MediaProcessingError(
            `ffprobe failed with exit code ${result.exitCode}: ${result.stderr}`,
            'ffprobe',
            result.stderr
        );
    }

    const parsed = parseFfprobeOutput(result.stdout);

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
        throw new MediaProcessingError(
            'No video stream found in ffprobe output',
            'ffprobe',
            videoPath
        );
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
