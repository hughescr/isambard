/**
 * Bluesky Error Classes
 *
 * Hierarchical error classes for Bluesky AT Protocol integration.
 * All errors extend BskyError which extends IsambardError.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

// ============================================================================
// Base Bluesky Error
// ============================================================================

/**
 * Base error class for all Bluesky integration errors.
 */
export class BskyError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.BSKY_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'BskyError';
    }
}

// ============================================================================
// Bluesky Subclass Errors
// ============================================================================

/**
 * Error thrown when Bluesky authentication fails.
 */
export class BskyAuthError extends BskyError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.BSKY_AUTH_ERROR, context);
        this.name = 'BskyAuthError';
    }
}

/**
 * Error thrown when Bluesky rate limits are exceeded.
 */
export class BskyRateLimitError extends BskyError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.BSKY_RATE_LIMIT_ERROR, context);
        this.name = 'BskyRateLimitError';
    }
}

/**
 * Error thrown when Bluesky content validation fails.
 */
export class BskyValidationError extends BskyError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.BSKY_VALIDATION_ERROR, context);
        this.name = 'BskyValidationError';
    }
}
