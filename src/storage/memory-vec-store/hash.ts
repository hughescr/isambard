/**
 * SHA-256 hex digest utility for the memory-vec-store module.
 *
 * Shared by AsyncIndexer and the backfill CLI to avoid duplicate implementations.
 */

/**
 * Computes the SHA-256 hex digest of the given text string.
 *
 * @param text - Input string to hash
 * @returns Lowercase hex string of the SHA-256 digest (64 characters)
 */
export async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hashBuffer)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
