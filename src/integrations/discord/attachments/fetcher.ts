import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type AttachmentMetadata, type StoredAttachment } from './types';
import { sanitizeFilename, MediaFetchTimeoutMs, type MediaFetchImageResult, type MediaFetchImagesResult } from '@/utils';

// Re-export generic types under Discord-familiar names for backward compatibility
export type FetchImageResult = MediaFetchImageResult;
export type FetchImagesResult = MediaFetchImagesResult;

// Delegate to generic media fetcher — AttachmentMetadata is structurally compatible with MediaFetchMetadata
export { fetchMediaImage as fetchImage, fetchMediaImages as fetchImages } from '@/utils';

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

            signal: AbortSignal.timeout(MediaFetchTimeoutMs),
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
