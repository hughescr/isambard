import { lookup } from 'mrmime';

/**
 * Infer content type from file extension for image types Discord doesn't recognize.
 * This is needed because Discord often returns null contentType for HEIC/HEIF files.
 *
 * @param filename - The attachment filename
 * @param discordContentType - The content type provided by Discord (may be null)
 * @returns The inferred or provided content type
 */
export function inferImageContentType(filename: string, discordContentType: string | null): string {
    // If Discord provided a valid image content type, use it
    // Stryker disable next-line StringLiteral: Equivalent — any non-image string ('' or 'Stryker was here!') produces the same false from startsWith; the test uses null which goes through ?? to '' anyway
    if ((discordContentType ?? '').startsWith('image/')) {
        return discordContentType!;
    }

    // Try to infer from file extension
    const ext = filename.toLowerCase().split('.').at(-1);
    if (ext) {
        const mime = lookup(ext);
        if (mime?.startsWith('image/')) return mime;
    }
    return discordContentType ?? 'application/octet-stream';
}
