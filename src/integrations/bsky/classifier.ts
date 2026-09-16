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
            // Stryker disable next-line llm: error.context is proven defined by the typeof guard above; optional chaining here is a no-op
            const retryAfterMs = typeof error.context?.retryAfterMs === 'number'
                ? error.context.retryAfterMs
                : undefined;
            return {
                category: 'rate_limited',
                message:  error.message,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            };
        }

        if(error instanceof BskyError) {
            return { category: 'permanent', message: error.message || 'Bluesky error' };
        }

        return httpClassifier(error);
    };
}
