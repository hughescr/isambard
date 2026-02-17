/**
 * Text utility functions.
 */

export const HARD_MAX_STATUS_LENGTH = 80;

/**
 * Truncates text to a maximum length, respecting word boundaries.
 *
 * If the text fits within maxLength, returns it unchanged.
 * Otherwise, finds the last space before maxLength and truncates there,
 * appending a unicode ellipsis (…).
 * If no space is found (single long word), hard truncates at maxLength-1
 * and appends the ellipsis.
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum allowed length for the result
 * @returns Truncated text with ellipsis if needed
 */
export function truncateToWordBoundary(text: string, maxLength: number): string {
    if(text.length <= maxLength) {
        return text;
    }

    // Find the last space before maxLength
    const lastSpaceIndex = text.lastIndexOf(' ', maxLength - 1);

    if(lastSpaceIndex > 0) {
        // Truncate at word boundary and add ellipsis
        return `${text.slice(0, lastSpaceIndex)}\u2026`;
    }

    // No space found - hard truncate at maxLength-1 + ellipsis
    return `${text.slice(0, maxLength - 1)}\u2026`;
}
