/**
 * Email Error Classes
 *
 * Hierarchical error classes for email integration and WildDuck HTTP API operations.
 * All errors extend EmailError which extends IsambardError.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

// ============================================================================
// Base Email Error
// ============================================================================

/**
 * Base error class for all email integration errors.
 */
export class EmailError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.EMAIL_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'EmailError';
    }
}

// ============================================================================
// Email Processing Errors
// ============================================================================

/**
 * Error thrown when email classification fails.
 */
export class ClassifierError extends EmailError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CLASSIFIER_ERROR, context);
        this.name = 'ClassifierError';
    }
}

/**
 * Error thrown when email processing fails.
 */
export class EmailProcessingError extends EmailError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.EMAIL_PROCESSING_ERROR, context);
        this.name = 'EmailProcessingError';
    }
}

/**
 * Error thrown when the draft-preview setup (the Tailscale CLI, its status and serve config)
 * cannot publish a preview, or refuses to because publishing would be unsafe.
 */
export class EmailPreviewError extends EmailError {
    constructor(message: string, cause?: unknown) {
        super(message, ErrorCode.EMAIL_PREVIEW_ERROR);
        this.name = 'EmailPreviewError';
        if(cause !== undefined) {
            this.cause = cause;
        }
    }
}

// ============================================================================
// WildDuck Errors
// ============================================================================

/**
 * Base error class for WildDuck HTTP API errors.
 */
export class WildDuckError extends EmailError {
    constructor(message: string, code: ErrorCode = ErrorCode.WILDDUCK_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'WildDuckError';
    }
}

/**
 * Error thrown when WildDuck authentication fails.
 */
export class WildDuckAuthError extends WildDuckError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.WILDDUCK_AUTH_ERROR, context);
        this.name = 'WildDuckAuthError';
    }
}
