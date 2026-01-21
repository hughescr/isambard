import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    type AttachmentMetadata,
    type FetchedImage,
    type StoredAttachment,
    MAX_IMAGE_SIZE_BYTES,
    isNativeImageType,
    isSupportedImageType
} from './types';
import { needsConversion, convert } from './converter';

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchImage(
    metadata: AttachmentMetadata
): Promise<FetchedImage | null> {
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
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun runtime supports fetch and AbortSignal.timeout
        const response = await fetch(metadata.url, {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun runtime supports AbortSignal.timeout
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if(!response.ok) {
            return null;
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
            filename:     metadata.filename,
            mediaType,
            base64Data,
            originalSize: metadata.size,
            width:        metadata.width,
            height:       metadata.height,
        };
    } catch{
        return null;
    }
}

export async function fetchImages(
    attachments: AttachmentMetadata[]
): Promise<FetchedImage[]> {
    const results = await Promise.all(
        // eslint-disable-next-line lodash/prefer-lodash-method -- Native array methods preferred for simplicity
        attachments.map(fetchImage)
    );
    // eslint-disable-next-line lodash/prefer-lodash-method -- Native array methods preferred for simplicity
    return results.filter((r): r is FetchedImage => r !== null);
}

export async function saveNonImageAttachment(
    metadata: AttachmentMetadata,
    scratchDir: string,
    messageId: string
): Promise<StoredAttachment | null> {
    try {
        const dir = join(scratchDir, 'attachments', messageId);
        await mkdir(dir, { recursive: true });

        // Stryker disable next-line ObjectLiteral: Fetch timeout options are not unit-testable without flaky timing dependencies
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun runtime supports fetch and AbortSignal.timeout
        const response = await fetch(metadata.url, {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun runtime supports AbortSignal.timeout
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if(!response.ok) {
            return null;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const localPath = join(dir, metadata.filename);
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
