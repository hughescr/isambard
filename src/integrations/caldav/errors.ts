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

export class CaldavTimeoutError extends CaldavError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CALDAV_TIMEOUT_ERROR, context);
        this.name = 'CaldavTimeoutError';
    }
}

export class AmbiguousCalendarMatchError extends CaldavError {
    constructor(
        public readonly entityType: 'server' | 'calendar',
        public readonly input: string,
        public readonly matches: { id: string, label: string }[]
    ) {
        const matchList = matches.map(m => `"${m.label}" (${m.id})`).join(', ');
        super(
            `Multiple ${entityType}s match "${input}": ${matchList}. Please use the exact ID.`,
            ErrorCode.CALDAV_AMBIGUOUS_MATCH,
            { entityType, input, matches }
        );
        this.name = 'AmbiguousCalendarMatchError';
    }
}
