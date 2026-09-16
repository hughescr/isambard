import { logger } from '@hughescr/logger';
import { needsConversion, convert } from './converters';
import {
    type MediaFetchMetadata,
    type FetchedImage,
    type FailedMedia,
    MAX_IMAGE_SIZE_BYTES,
    isSupportedImageType
} from './types';

export const FETCH_TIMEOUT_MS = 30_000;

type FetchImageResult = {
    success: true
    image:   FetchedImage
} | {
    success: false
    failure: FailedMedia
};

interface FetchImagesResult {
    images:   FetchedImage[]
    failures: FailedMedia[]
}

export async function fetchImage(
    metadata: MediaFetchMetadata
): Promise<FetchImageResult | null> {
    // Skip if too large
    if(metadata.size > MAX_IMAGE_SIZE_BYTES) {
        return null;
    }

    // Skip if not a supported image type
    if(!isSupportedImageType(metadata.contentType)) {
        return null;
    }

    try {
        const response = await fetch(metadata.url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if(!response.ok) {
            const errorMessage = `HTTP ${response.status} ${response.statusText}`;
            logger.error({
                filename:    metadata.filename,
                contentType: metadata.contentType,
                size:        metadata.size,
                error:       errorMessage,
                msg:         `Failed to fetch image: ${metadata.filename}`,
            });
            return {
                success: false,
                failure: {
                    filename:    metadata.filename,
                    contentType: metadata.contentType,
                    size:        metadata.size,
                    error:       errorMessage,
                },
            };
        }

        const arrayBuffer = await response.arrayBuffer();
        const initialBuffer = Buffer.from(arrayBuffer);

        let base64Data: string;
        let mediaType: FetchedImage['mediaType'];

        if(needsConversion(metadata.contentType)) {
            const result = await convert(initialBuffer, metadata.contentType);
            base64Data = result.buffer.toString('base64');
            mediaType = result.mediaType;
        } else {
            base64Data = initialBuffer.toString('base64');
            mediaType = metadata.contentType as FetchedImage['mediaType'];
        }

        return {
            success: true,
            image:   {
                filename:     metadata.filename,
                mediaType,
                base64Data,
                originalSize: metadata.size,
                width:        metadata.width,
                height:       metadata.height,
            },
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({
            filename:    metadata.filename,
            contentType: metadata.contentType,
            size:        metadata.size,
            error:       errorMessage,
            msg:         `Failed to fetch/convert image: ${metadata.filename}`,
        });
        return {
            success: false,
            failure: {
                filename:    metadata.filename,
                contentType: metadata.contentType,
                size:        metadata.size,
                error:       errorMessage,
            },
        };
    }
}

export async function fetchImages(
    attachments: MediaFetchMetadata[]
): Promise<FetchImagesResult> {
    const results = await Promise.all(
        // Stryker disable next-line llm: fetchImage is async, so map yields Promise objects, which are always truthy; a filter(Boolean) on them removes nothing and null results are already skipped below
        attachments.map(attachment => fetchImage(attachment))
    );

    const images: FetchedImage[] = [];
    const failures: FailedMedia[] = [];

    for(const result of results) {
        if(result === null) {
            continue;  // Skipped (too large, unsupported type)
        }
        if(result.success) {
            // Stryker disable next-line llm: fetchImage builds image as an object literal on every success path, so result.image is always truthy and a `|| null` fallback is unreachable
            images.push(result.image);
        } else {
            // Stryker disable next-line llm: fetchImage builds failure as an object literal on both failure paths, so result.failure is always truthy and a `|| {}` fallback is unreachable
            failures.push(result.failure);
        }
    }

    return { images, failures };
}
