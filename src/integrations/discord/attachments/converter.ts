import heicConvert from 'heic-convert';
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

    const outputBuffer = await heicConvert({
        buffer: new Uint8Array(buffer).buffer,
        format: 'PNG',
    });

    return {
        buffer:    Buffer.from(outputBuffer),
        mediaType: 'image/png',
    };
}
