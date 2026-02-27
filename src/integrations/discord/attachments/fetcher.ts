import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@hughescr/logger';
import isError from 'lodash/isError';
import { needsConversion, convert } from './converter';
import {
    type AttachmentMetadata,
    type FetchedImage,
    type FailedAttachment,
    type StoredAttachment,
    MAX_IMAGE_SIZE_BYTES,
    isNativeImageType,
    isSupportedImageType
} from './types';
import { sanitizeFilename } from '@/utils';

const FETCH_TIMEOUT_MS = 30_000;

export type FetchImageResult = {
    success: true
    image:   FetchedImage
} | {
    success: false
    failure: FailedAttachment
};

export interface FetchImagesResult {
    images:   FetchedImage[]
    failures: FailedAttachment[]
}

export async function fetchImage(
    metadata: AttachmentMetadata
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
        // Stryker disable next-line ObjectLiteral: Fetch timeout options are not unit-testable without flaky timing dependencies

        const response = await fetch(metadata.url, {

            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if(!response.ok) {
            const errorMessage = `HTTP ${response.status} ${response.statusText}`;
            // Stryker disable all: logging statement
            logger.error({
                filename:    metadata.filename,
                contentType: metadata.contentType,
                size:        metadata.size,
                error:       errorMessage,
                msg:         `Failed to fetch image: ${metadata.filename}`,
            });
            // Stryker restore all
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
        } else if(isNativeImageType(metadata.contentType)) {
            base64Data = initialBuffer.toString('base64');
            mediaType = metadata.contentType;
        } else {
            return null;
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
        const errorMessage = isError(error) ? error.message : String(error);
        // Stryker disable all: logging statement
        logger.error({
            filename:    metadata.filename,
            contentType: metadata.contentType,
            size:        metadata.size,
            error:       errorMessage,
            msg:         `Failed to fetch/convert image: ${metadata.filename}`,
        });
        // Stryker restore all
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
    attachments: AttachmentMetadata[]
): Promise<FetchImagesResult> {
    const results = await Promise.all(
        // eslint-disable-next-line lodash/prefer-lodash-method -- Native array methods preferred for simplicity
        attachments.map(attachment => fetchImage(attachment))
    );

    const images: FetchedImage[] = [];
    const failures: FailedAttachment[] = [];

    for(const result of results) {
        if(result === null) {
            continue;  // Skipped (too large, unsupported type)
        }
        if(result.success) {
            images.push(result.image);
        } else {
            failures.push(result.failure);
        }
    }

    return { images, failures };
}

export async function saveNonImageAttachment(
    metadata: AttachmentMetadata,
    scratchDir: string,
    messageId: string
): Promise<StoredAttachment | null> {
    try {
        const dir = path.join(scratchDir, 'attachments', `discord-${messageId}`);
        await mkdir(dir, { recursive: true });

        // Stryker disable next-line ObjectLiteral: Fetch timeout options are not unit-testable without flaky timing dependencies

        const response = await fetch(metadata.url, {

            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if(!response.ok) {
            return null;
        }

        const buffer    = Buffer.from(await response.arrayBuffer());
        const safeFilename = sanitizeFilename(metadata.filename);
        const localPath = path.join(dir, safeFilename);
        await writeFile(localPath, buffer);

        return {
            localPath,
            originalFilename: metadata.filename,
            contentType:      metadata.contentType,
            size:             metadata.size,
        };
    } catch{
        return null;
    }
}
