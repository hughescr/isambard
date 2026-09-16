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
    if(discordContentType?.startsWith('image/')) {
        return discordContentType;
    }

    // Try to infer from file extension
    // Stryker disable next-line llm: mrmime's lookup() already lowercases its argument internally, so this .toLowerCase() cannot change the result.
    const ext = filename.toLowerCase().split('.').at(-1);
    if(ext) {
        const mime = lookup(ext);
        if(mime?.startsWith('image/')) {
            return mime;
        }
    }
    return discordContentType ?? 'application/octet-stream';
}
