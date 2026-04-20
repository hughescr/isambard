/**
 * CalDAV Error Classes
 *
 * Hierarchical error classes for CalDAV calendar integration.
 * All errors extend CaldavError which extends IsambardError.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

// ============================================================================
// Base CalDAV Error
// ============================================================================

/**
 * Base error class for all CalDAV integration errors.
 */
export class CaldavError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.CALDAV_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'CaldavError';
    }
}

// ============================================================================
// CalDAV Subclass Errors
// ============================================================================

/**
 * Error thrown when CalDAV authentication fails.
 */
export class CaldavAuthError extends CaldavError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CALDAV_AUTH_ERROR, context);
        this.name = 'CaldavAuthError';
    }
}

/**
 * Error thrown when a CalDAV fetch operation fails.
 */
export class CaldavFetchError extends CaldavError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CALDAV_FETCH_ERROR, context);
        this.name = 'CaldavFetchError';
    }
}

/**
 * Error thrown when a CalDAV operation times out.
 */
export class CaldavTimeoutError extends CaldavError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CALDAV_TIMEOUT_ERROR, context);
        this.name = 'CaldavTimeoutError';
    }
}

/**
 * Error thrown when multiple CalDAV servers or calendars match the given input.
 * Prompts the user to use an exact ID.
 */
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
