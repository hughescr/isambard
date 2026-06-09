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
        const outputBuffer = await heicConvert({
            buffer: new Uint8Array(buffer),
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
