import { BskyError, BskyRateLimitError } from '@/errors';
import { createHttpStatusClassifier, type ErrorClassification, type ErrorClassifier } from '@/utils';

/**
 * Creates an error classifier for Bluesky client errors.
 *
 * Classification rules:
 * - `BskyRateLimitError` → `rate_limited` (with optional `retryAfterMs` from context)
 * - Any other `BskyError` → `permanent` (domain errors are not transient; auth errors require re-login)
 * - Everything else → delegated to `createHttpStatusClassifier` (handles HTTP 5xx, network errors, etc.)
 */
export function createBskyClassifier(): ErrorClassifier {
    const httpClassifier = createHttpStatusClassifier();

    return (error: unknown): ErrorClassification => {
        if(error instanceof BskyRateLimitError) {
            const retryAfterMs = typeof error.context?.retryAfterMs === 'number'
                ? error.context.retryAfterMs
                : undefined;
            return {
                category: 'rate_limited',
                message:  error.message,
                // Stryker disable next-line ConditionalExpression: ternary spreads retryAfterMs only when defined — undefined spread changes nothing, but presence/absence of the key affects classifier callers
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            };
        }

        if(error instanceof BskyError) {
            // Stryker disable next-line StringLiteral: error message is informational only
            return { category: 'permanent', message: error.message || 'Bluesky error' };
        }

        return httpClassifier(error);
    };
}
