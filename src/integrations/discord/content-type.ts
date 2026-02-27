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
    if((discordContentType ?? '').startsWith('image/')) {
        return discordContentType!;
    }

    // Try to infer from file extension
    const ext = filename.toLowerCase().split('.').at(-1);
    switch(ext) {
        case 'heic': {
            return 'image/heic';
        }
        case 'heif': {
            return 'image/heif';
        }
        case 'jpg':
        case 'jpeg': {
            return 'image/jpeg';
        }
        case 'png': {
            return 'image/png';
        }
        case 'gif': {
            return 'image/gif';
        }
        case 'webp': {
            return 'image/webp';
        }
        // eslint-disable-next-line unicorn/no-useless-switch-case -- needed for switch exhaustiveness check: extension may be undefined
        case undefined:
        default: {
            // Fall back to Discord's content type or octet-stream when extension is unknown or missing
            return discordContentType ?? 'application/octet-stream';
        }
    }
}
