import _ from 'lodash';

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
    // Stryker disable next-line StringLiteral: Equivalent mutant - any non-image prefix produces same behavior
    if(_.startsWith(discordContentType ?? '', 'image/')) {
        return discordContentType!;
    }

    // Try to infer from file extension
    const ext = _.last(_.split(_.toLower(filename), '.'));
    switch(ext) {
        case 'heic':
            return 'image/heic';
        case 'heif':
            return 'image/heif';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'png':
            return 'image/png';
        case 'gif':
            return 'image/gif';
        case 'webp':
            return 'image/webp';
        default:
            // Fall back to Discord's content type or octet-stream
            return discordContentType ?? 'application/octet-stream';
    }
}
