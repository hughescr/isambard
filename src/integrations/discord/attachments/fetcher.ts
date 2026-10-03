import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type AttachmentMetadata, type StoredAttachment } from './types';
import { sanitizeFilename, MediaFetchTimeoutMs, createDeadline } from '@/utils';

// Delegate to generic media fetcher — AttachmentMetadata is structurally compatible with MediaFetchMetadata
export { fetchMediaImage as fetchImage, fetchMediaImages as fetchImages } from '@/utils';

export async function saveNonImageAttachment(
    metadata: AttachmentMetadata,
    scratchDir: string,
    messageId: string
): Promise<StoredAttachment | null> {
    // One deadline for the whole save (directory, download, write), stood down on every exit path
    const deadline = createDeadline(MediaFetchTimeoutMs);
    try {
        const dir = path.join(scratchDir, 'attachments', `discord-${messageId}`);
        await mkdir(dir, { recursive: true });

        const response = await fetch(metadata.url, {
            signal: deadline.signal,
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
    } finally {
        deadline.clear();
    }
}
