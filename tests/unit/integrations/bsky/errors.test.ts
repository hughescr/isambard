import { describe, test, expect, spyOn } from 'bun:test';
import {
    BskyError,
    BskyAuthError,
    BskyRateLimitError,
    BskyValidationError
} from '@/errors';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';

describe.concurrent('BskyError', () => {
    test('should have correct inheritance chain', () => {
        const error = new BskyError('Test error');
        expect(error).toBeInstanceOf(BskyError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and default code', () => {
        const error = new BskyError('Test error');
        expect(error.name).toBe('BskyError');
        expect(error.code).toBe(ErrorCode.BSKY_ERROR);
    });

    test('should preserve message', () => {
        const error = new BskyError('Something went wrong');
        expect(error.message).toBe('Something went wrong');
    });

    test('should support custom error code', () => {
        const error = new BskyError('Custom code', ErrorCode.BSKY_AUTH_ERROR);
        expect(error.code).toBe(ErrorCode.BSKY_AUTH_ERROR);
    });

    test('should support context', () => {
        const context = { handle: 'user.bsky.social', status: 401 };
        const error = new BskyError('Auth failed', ErrorCode.BSKY_ERROR, context);
        expect(error.context).toEqual(context);
    });

    test('should have stack trace defined', () => {
        const error = new BskyError('Test error');
        expect(error.stack).toBeDefined();
    });
});

describe.concurrent('BskyAuthError', () => {
    test('should have correct inheritance chain', () => {
        const error = new BskyAuthError('Auth failed');
        expect(error).toBeInstanceOf(BskyAuthError);
        expect(error).toBeInstanceOf(BskyError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new BskyAuthError('Auth failed');
        expect(error.name).toBe('BskyAuthError');
        expect(error.code).toBe(ErrorCode.BSKY_AUTH_ERROR);
    });

    test('should preserve message', () => {
        const error = new BskyAuthError('Invalid app password');
        expect(error.message).toBe('Invalid app password');
    });

    test('should support context', () => {
        const context = { handle: 'user.bsky.social', originalMessage: 'Invalid credentials' };
        const error = new BskyAuthError('Auth failed', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new BskyAuthError('Auth failed');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('BskyRateLimitError', () => {
    test('should have correct inheritance chain', () => {
        const error = new BskyRateLimitError('Rate limited');
        expect(error).toBeInstanceOf(BskyRateLimitError);
        expect(error).toBeInstanceOf(BskyError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new BskyRateLimitError('Rate limited');
        expect(error.name).toBe('BskyRateLimitError');
        expect(error.code).toBe(ErrorCode.BSKY_RATE_LIMIT_ERROR);
    });

    test('should preserve message', () => {
        const error = new BskyRateLimitError('Too many requests');
        expect(error.message).toBe('Too many requests');
    });

    test('should support context', () => {
        const context = { error: 'RateLimitExceeded', status: 429 };
        const error = new BskyRateLimitError('Rate limited', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new BskyRateLimitError('Rate limited');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('Error instanceof cross-checks', () => {
    test('BskyAuthError is not BskyRateLimitError', () => {
        const error = new BskyAuthError('Auth failed');
        expect(error).not.toBeInstanceOf(BskyRateLimitError);
    });

    test('BskyRateLimitError is not BskyAuthError', () => {
        const error = new BskyRateLimitError('Rate limited');
        expect(error).not.toBeInstanceOf(BskyAuthError);
    });

    test('BskyError is not BskyAuthError', () => {
        const error = new BskyError('Base error');
        expect(error).not.toBeInstanceOf(BskyAuthError);
    });

    test('BskyError is not BskyRateLimitError', () => {
        const error = new BskyError('Base error');
        expect(error).not.toBeInstanceOf(BskyRateLimitError);
    });
});

describe.concurrent('BskyValidationError', () => {
    test('should have correct inheritance chain', () => {
        const error = new BskyValidationError('Post too long');
        expect(error).toBeInstanceOf(BskyValidationError);
        expect(error).toBeInstanceOf(BskyError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new BskyValidationError('Post too long');
        expect(error.name).toBe('BskyValidationError');
        expect(error.code).toBe(ErrorCode.BSKY_VALIDATION_ERROR);
    });

    test('should preserve message', () => {
        const error = new BskyValidationError('Post exceeds 300 graphemes');
        expect(error.message).toBe('Post exceeds 300 graphemes');
    });

    test('should support context', () => {
        const context = { graphemeLength: 350 };
        const error = new BskyValidationError('Too long', context);
        expect(error.context).toEqual(context);
    });

    test('BskyValidationError is not BskyAuthError', () => {
        const error = new BskyValidationError('Validation failed');
        expect(error).not.toBeInstanceOf(BskyAuthError);
    });
});

describe.concurrent('Error.captureStackTrace handling', () => {
    test('should call captureStackTrace for subclass', () => {
        const spy = spyOn(Error, 'captureStackTrace');
        const error = new BskyAuthError('test');
        expect(spy).toHaveBeenCalledWith(error, BskyAuthError);
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
            const error = new BskyError('No captureStackTrace');
            expect(error.message).toBe('No captureStackTrace');
            expect(error.name).toBe('BskyError');
        } finally {
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });
});
