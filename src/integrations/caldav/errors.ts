import { IsambardError, ErrorCode } from '@/errors';

export class CaldavError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.CALDAV_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'CaldavError';
    }
}

export class CaldavAuthError extends CaldavError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CALDAV_AUTH_ERROR, context);
        this.name = 'CaldavAuthError';
    }
}

export class CaldavFetchError extends CaldavError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CALDAV_FETCH_ERROR, context);
        this.name = 'CaldavFetchError';
    }
}
