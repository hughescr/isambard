// Stryker disable next-line ArrayDeclaration: well-known names are configuration
const WELL_KNOWN_FEEDS = ['following', 'for-you', 'discover'] as const;

/**
 * Sanitizes a feed name for use in memory paths.
 * Well-known names pass through; AT URIs are normalized to path-safe strings.
 *
 * @param feedName - Feed name or AT URI to sanitize
 * @returns Path-safe feed name
 */
export function sanitizeFeedName(feedName: string): string {
    // Stryker disable BlockStatement,ConditionalExpression: well-known feed names don't contain :// or / — replace path produces identical output, making guard an optimization
    if((WELL_KNOWN_FEEDS as readonly string[]).includes(feedName)) {
        return feedName;
    }
    // Stryker restore BlockStatement,ConditionalExpression

    return feedName.replace('://', '-').replaceAll('/', '-');
}
