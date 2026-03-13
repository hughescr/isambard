import { IsambardError, ErrorCode } from '@/errors';

export class BskyError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.BSKY_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'BskyError';
    }
}

export class BskyAuthError extends BskyError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.BSKY_AUTH_ERROR, context);
        this.name = 'BskyAuthError';
    }
}

export class BskyRateLimitError extends BskyError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.BSKY_RATE_LIMIT_ERROR, context);
        this.name = 'BskyRateLimitError';
    }
}

export class BskyValidationError extends BskyError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.BSKY_VALIDATION_ERROR, context);
        this.name = 'BskyValidationError';
    }
}
