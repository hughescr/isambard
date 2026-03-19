import { describe, test, expect, spyOn } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import {
    CaldavError,
    CaldavAuthError,
    CaldavFetchError
} from '@/integrations/caldav/errors';

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
