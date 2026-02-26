import heicConvert from 'heic-convert';
import _ from 'lodash';
import { isConvertibleImageType } from './types';

export interface ConversionResult {
    buffer:    Buffer
    mediaType: 'image/png'
}

export function needsConversion(contentType: string): boolean {
    return isConvertibleImageType(contentType);
}

export async function convert(buffer: Buffer, contentType: string): Promise<ConversionResult> {
    if(!isConvertibleImageType(contentType)) {
        throw new Error(`Unsupported content type for conversion: ${contentType}`);
    }

    try {
        // heic-convert expects Buffer or Uint8Array (both have .slice() and Symbol.iterator)
        // The heic-decode library internally calls .slice() on the buffer, which requires
        // an actual typed array, not just an ArrayBuffer.
        // TypeScript types say ArrayBufferLike, but runtime requires Buffer/Uint8Array.
        const outputBuffer = await heicConvert({
            buffer: new Uint8Array(buffer) as unknown as ArrayBufferLike,
            format: 'PNG',
        });

        return {
            buffer:    Buffer.from(outputBuffer),
            mediaType: 'image/png',
        };
    } catch (error) {
        const message = _.isError(error) ? error.message : String(error);
        throw new Error(`HEIC conversion failed: ${message}`);
    }
}
