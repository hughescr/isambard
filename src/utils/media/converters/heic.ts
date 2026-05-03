import heicConvert from 'heic-convert';
import { isConvertibleImageType } from '../types';
import { MediaProcessingError } from '@/errors';

interface ConversionResult {
    buffer:    Buffer
    mediaType: 'image/png'
}

export function needsConversion(contentType: string): boolean {
    return isConvertibleImageType(contentType);
}

export async function convert(buffer: Buffer, contentType: string): Promise<ConversionResult> {
    if(!isConvertibleImageType(contentType)) {
        throw new MediaProcessingError(
            `Unsupported content type for conversion: ${contentType}`,
            'heic-convert',
            contentType
        );
    }

    try {
        // heic-convert expects Buffer or Uint8Array (both have .slice() and Symbol.iterator)
        // The heic-decode library internally calls .slice() on the buffer, which requires
        // an actual typed array, not just an ArrayBuffer.
        // TypeScript types say ArrayBufferLike, but runtime requires Buffer/Uint8Array.
        // boundary cast: heic-convert declares `buffer: ArrayBufferLike` but heic-decode internally calls .slice(); Uint8Array satisfies the runtime contract, ArrayBufferLike is the declared type
        const outputBuffer = await heicConvert({
            buffer: new Uint8Array(buffer) as unknown as ArrayBufferLike,
            format: 'PNG',
        });

        return {
            buffer:    Buffer.from(outputBuffer),
            mediaType: 'image/png',
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new MediaProcessingError(
            `HEIC conversion failed: ${message}`,
            'heic-convert',
            message,
            error
        );
    }
}
