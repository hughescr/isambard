/**
 * Sanitizes a feed name for use in memory paths.
 * Simple names pass through; AT URIs are normalized to path-safe strings.
 *
 * @param feedName - Feed name or AT URI to sanitize
 * @returns Path-safe feed name
 */
export function sanitizeFeedName(feedName: string): string {
    return feedName.replace('://', '-').replaceAll('/', '-');
}
