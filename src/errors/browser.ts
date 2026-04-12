/**
 * Browser Error Classes
 *
 * Hierarchical error classes for browser automation operations.
 * All errors extend IsambardError.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

// ============================================================================
// Navigate Errors
// ============================================================================

/**
 * Error thrown when navigate() times out after all retry attempts.
 * The view is closed; the next call will lazy-reinit.
 */
export class BrowserNavigateTimeoutError extends IsambardError {
    declare public readonly context: { url: string, attempts: number };

    constructor(url: string, attempts: number) {
        super(
            // Stryker disable next-line StringLiteral: error message is informational only
            `navigate(${url}) timed out after ${attempts} attempts; view closed, next call will lazy-reinit`,
            ErrorCode.BROWSER_NAVIGATE_TIMEOUT,
            { url, attempts }
        );
        // Stryker disable next-line StringLiteral: error name is informational only
        this.name = 'BrowserNavigateTimeoutError';
    }
}
