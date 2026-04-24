import { describe, test, expect, spyOn } from 'bun:test';
import {
    AmbiguousCalendarMatchError,
    CaldavError,
    CaldavAuthError,
    CaldavFetchError,
    CaldavTimeoutError
} from '@/errors';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';

describe.concurrent('CaldavError', () => {
    test('should have correct inheritance chain', () => {
        const error = new CaldavError('Test error');
        expect(error).toBeInstanceOf(CaldavError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and default code', () => {
        const error = new CaldavError('Test error');
        expect(error.name).toBe('CaldavError');
        expect(error.code).toBe(ErrorCode.CALDAV_ERROR);
    });

    test('should preserve message', () => {
        const error = new CaldavError('Something went wrong');
        expect(error.message).toBe('Something went wrong');
    });

    test('should support custom error code', () => {
        const error = new CaldavError('Custom code', ErrorCode.CALDAV_AUTH_ERROR);
        expect(error.code).toBe(ErrorCode.CALDAV_AUTH_ERROR);
    });

    test('should support context', () => {
        const context = { url: 'https://caldav.example.com', status: 401 };
        const error = new CaldavError('Fetch failed', ErrorCode.CALDAV_ERROR, context);
        expect(error.context).toEqual(context);
    });

    test('should have stack trace defined', () => {
        const error = new CaldavError('Test error');
        expect(error.stack).toBeDefined();
    });
});

describe.concurrent('CaldavAuthError', () => {
    test('should have correct inheritance chain', () => {
        const error = new CaldavAuthError('Auth failed');
        expect(error).toBeInstanceOf(CaldavAuthError);
        expect(error).toBeInstanceOf(CaldavError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new CaldavAuthError('Auth failed');
        expect(error.name).toBe('CaldavAuthError');
        expect(error.code).toBe(ErrorCode.CALDAV_AUTH_ERROR);
    });

    test('should preserve message', () => {
        const error = new CaldavAuthError('Invalid credentials');
        expect(error.message).toBe('Invalid credentials');
    });

    test('should support context', () => {
        const context = { url: 'https://caldav.example.com', originalMessage: 'Unauthorized' };
        const error = new CaldavAuthError('Auth failed', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new CaldavAuthError('Auth failed');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('CaldavFetchError', () => {
    test('should have correct inheritance chain', () => {
        const error = new CaldavFetchError('Fetch failed');
        expect(error).toBeInstanceOf(CaldavFetchError);
        expect(error).toBeInstanceOf(CaldavError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new CaldavFetchError('Fetch failed');
        expect(error.name).toBe('CaldavFetchError');
        expect(error.code).toBe(ErrorCode.CALDAV_FETCH_ERROR);
    });

    test('should preserve message', () => {
        const error = new CaldavFetchError('Failed to fetch calendar events');
        expect(error.message).toBe('Failed to fetch calendar events');
    });

    test('should support context', () => {
        const context = { calendarPath: '/calendars/user/default/', status: 500 };
        const error = new CaldavFetchError('Fetch failed', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new CaldavFetchError('Fetch failed');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('CaldavTimeoutError', () => {
    test('should have correct inheritance chain', () => {
        const error = new CaldavTimeoutError('Timeout');
        expect(error).toBeInstanceOf(CaldavTimeoutError);
        expect(error).toBeInstanceOf(CaldavError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new CaldavTimeoutError('Timeout');
        expect(error.name).toBe('CaldavTimeoutError');
        expect(error.code).toBe(ErrorCode.CALDAV_TIMEOUT_ERROR);
    });

    test('should preserve message', () => {
        const error = new CaldavTimeoutError('CalDAV operation timed out after 15000ms: connect');
        expect(error.message).toBe('CalDAV operation timed out after 15000ms: connect');
    });

    test('should support context', () => {
        const context = { timeoutMs: 15_000, operation: 'connect' };
        const error = new CaldavTimeoutError('Timed out', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new CaldavTimeoutError('Timed out');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('Error instanceof cross-checks', () => {
    test('CaldavAuthError is not CaldavFetchError', () => {
        const error = new CaldavAuthError('Auth failed');
        expect(error instanceof CaldavFetchError).toBe(false);
    });

    test('CaldavFetchError is not CaldavAuthError', () => {
        const error = new CaldavFetchError('Fetch failed');
        expect(error instanceof CaldavAuthError).toBe(false);
    });

    test('CaldavError is not CaldavAuthError', () => {
        const error = new CaldavError('Base error');
        expect(error instanceof CaldavAuthError).toBe(false);
    });

    test('CaldavError is not CaldavFetchError', () => {
        const error = new CaldavError('Base error');
        expect(error instanceof CaldavFetchError).toBe(false);
    });

    test('CaldavTimeoutError is not CaldavAuthError', () => {
        const error = new CaldavTimeoutError('Timed out');
        expect(error instanceof CaldavAuthError).toBe(false);
    });

    test('CaldavTimeoutError is not CaldavFetchError', () => {
        const error = new CaldavTimeoutError('Timed out');
        expect(error instanceof CaldavFetchError).toBe(false);
    });

    test('CaldavAuthError is not CaldavTimeoutError', () => {
        const error = new CaldavAuthError('Auth failed');
        expect(error instanceof CaldavTimeoutError).toBe(false);
    });

    test('CaldavFetchError is not CaldavTimeoutError', () => {
        const error = new CaldavFetchError('Fetch failed');
        expect(error instanceof CaldavTimeoutError).toBe(false);
    });
});

describe.concurrent('AmbiguousCalendarMatchError', () => {
    test('should have correct inheritance chain', () => {
        const error = new AmbiguousCalendarMatchError('server', 'apple', []);
        expect(error).toBeInstanceOf(AmbiguousCalendarMatchError);
        expect(error).toBeInstanceOf(CaldavError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new AmbiguousCalendarMatchError('server', 'apple', []);
        expect(error.name).toBe('AmbiguousCalendarMatchError');
        expect(error.code).toBe(ErrorCode.CALDAV_AMBIGUOUS_MATCH);
    });

    test('should format message with server entity type and match list', () => {
        const matches = [
            { id: 'uuid-1', label: 'Apple iCloud' },
            { id: 'uuid-2', label: 'Apple Work' },
        ];
        const error = new AmbiguousCalendarMatchError('server', 'apple', matches);
        expect(error.message).toBe(
            'Multiple servers match "apple": "Apple iCloud" (uuid-1), "Apple Work" (uuid-2). Please use the exact ID.'
        );
    });

    test('should format message with calendar entity type', () => {
        const matches = [
            { id: '/cal/home', label: 'Home Calendar' },
            { id: '/cal/home2', label: 'Home Work' },
        ];
        const error = new AmbiguousCalendarMatchError('calendar', 'home', matches);
        expect(error.message).toBe(
            'Multiple calendars match "home": "Home Calendar" (/cal/home), "Home Work" (/cal/home2). Please use the exact ID.'
        );
    });

    test('should store entityType, input, and matches in context', () => {
        const matches = [{ id: 'uuid-1', label: 'Apple' }];
        const error = new AmbiguousCalendarMatchError('server', 'apple', matches);
        expect(error.context.entityType).toBe('server');
        expect(error.context.input).toBe('apple');
        expect(error.context.matches).toEqual(matches);
    });

    test('should store context with entityType, input, and matches', () => {
        const matches = [{ id: 'uuid-1', label: 'Apple' }];
        const error = new AmbiguousCalendarMatchError('server', 'apple', matches);
        expect(error.context).toEqual({ entityType: 'server', input: 'apple', matches });
    });

    test('should handle empty matches array', () => {
        const error = new AmbiguousCalendarMatchError('server', 'test', []);
        expect(error.message).toBe('Multiple servers match "test": . Please use the exact ID.');
        expect(error.context.matches).toEqual([]);
    });

    test('should not be instanceof CaldavAuthError', () => {
        const error = new AmbiguousCalendarMatchError('server', 'x', []);
        expect(error instanceof CaldavAuthError).toBe(false);
    });
});

describe.concurrent('Error.captureStackTrace handling', () => {
    test('should call captureStackTrace for subclass', () => {
        const spy = spyOn(Error, 'captureStackTrace');
        const error = new CaldavAuthError('test');
        expect(spy).toHaveBeenCalledWith(error, CaldavAuthError);
        spy.mockRestore();
    });

    test('should handle missing captureStackTrace gracefully', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Error, 'captureStackTrace');
        Object.defineProperty(Error, 'captureStackTrace', {
            value:        undefined,
            writable:     true,
            configurable: true,
        });

        try {
            const error = new CaldavError('No captureStackTrace');
            expect(error.message).toBe('No captureStackTrace');
            expect(error.name).toBe('CaldavError');
        } finally {
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });
});
