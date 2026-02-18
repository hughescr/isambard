import { describe, test, expect, spyOn } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import {
    EmailError,
    ImapConnectionError,
    ClassifierError,
    EmailProcessingError
} from '@/integrations/email/errors';

describe.concurrent('EmailError', () => {
    test('should have correct inheritance chain', () => {
        const error = new EmailError('Test error');
        expect(error).toBeInstanceOf(EmailError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and default code', () => {
        const error = new EmailError('Test error');
        expect(error.name).toBe('EmailError');
        expect(error.code).toBe(ErrorCode.EMAIL_ERROR);
    });

    test('should preserve message', () => {
        const error = new EmailError('Something went wrong');
        expect(error.message).toBe('Something went wrong');
    });

    test('should support custom error code', () => {
        const error = new EmailError('Custom code', ErrorCode.IMAP_CONNECTION_ERROR);
        expect(error.code).toBe(ErrorCode.IMAP_CONNECTION_ERROR);
    });

    test('should support context', () => {
        const context = { host: 'imap.example.com', port: 993 };
        const error = new EmailError('Connection failed', ErrorCode.EMAIL_ERROR, context);
        expect(error.context).toEqual(context);
    });

    test('should have stack trace defined', () => {
        const error = new EmailError('Test error');
        expect(error.stack).toBeDefined();
    });
});

describe.concurrent('ImapConnectionError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ImapConnectionError('Connection refused');
        expect(error).toBeInstanceOf(ImapConnectionError);
        expect(error).toBeInstanceOf(EmailError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new ImapConnectionError('Connection refused');
        expect(error.name).toBe('ImapConnectionError');
        expect(error.code).toBe(ErrorCode.IMAP_CONNECTION_ERROR);
    });

    test('should preserve message', () => {
        const error = new ImapConnectionError('Failed to connect to imap.example.com:993');
        expect(error.message).toBe('Failed to connect to imap.example.com:993');
    });

    test('should support context', () => {
        const context = { host: 'imap.example.com', port: 993 };
        const error = new ImapConnectionError('Connection failed', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new ImapConnectionError('Connection refused');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('ClassifierError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ClassifierError('Classification failed');
        expect(error).toBeInstanceOf(ClassifierError);
        expect(error).toBeInstanceOf(EmailError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new ClassifierError('Classification failed');
        expect(error.name).toBe('ClassifierError');
        expect(error.code).toBe(ErrorCode.CLASSIFIER_ERROR);
    });

    test('should preserve message', () => {
        const error = new ClassifierError('LLM API timed out');
        expect(error.message).toBe('LLM API timed out');
    });

    test('should support context', () => {
        const context = { model: 'claude-haiku', uid: 42 };
        const error = new ClassifierError('Classification failed', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new ClassifierError('Classification failed');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('EmailProcessingError', () => {
    test('should have correct inheritance chain', () => {
        const error = new EmailProcessingError('Processing failed');
        expect(error).toBeInstanceOf(EmailProcessingError);
        expect(error).toBeInstanceOf(EmailError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and code', () => {
        const error = new EmailProcessingError('Processing failed');
        expect(error.name).toBe('EmailProcessingError');
        expect(error.code).toBe(ErrorCode.EMAIL_PROCESSING_ERROR);
    });

    test('should preserve message', () => {
        const error = new EmailProcessingError('Failed to move email to CleanInbox');
        expect(error.message).toBe('Failed to move email to CleanInbox');
    });

    test('should support context', () => {
        const context = { uid: 42, folder: 'INBOX' };
        const error = new EmailProcessingError('Move failed', context);
        expect(error.context).toEqual(context);
    });

    test('should have no context when not provided', () => {
        const error = new EmailProcessingError('Processing failed');
        expect(error.context).toBeUndefined();
    });
});

describe.concurrent('Error instanceof cross-checks', () => {
    test('ImapConnectionError is not ClassifierError', () => {
        const error = new ImapConnectionError('Connection refused');
        expect(error instanceof ClassifierError).toBe(false);
    });

    test('ClassifierError is not ImapConnectionError', () => {
        const error = new ClassifierError('Classification failed');
        expect(error instanceof ImapConnectionError).toBe(false);
    });

    test('EmailProcessingError is not ImapConnectionError', () => {
        const error = new EmailProcessingError('Processing failed');
        expect(error instanceof ImapConnectionError).toBe(false);
    });

    test('EmailError is not ImapConnectionError', () => {
        const error = new EmailError('Base error');
        expect(error instanceof ImapConnectionError).toBe(false);
    });
});

describe.concurrent('Error.captureStackTrace handling', () => {
    test('should call captureStackTrace for subclass', () => {
        const spy = spyOn(Error, 'captureStackTrace');
        const error = new ImapConnectionError('test');
        expect(spy).toHaveBeenCalledWith(error, ImapConnectionError);
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
            const error = new EmailError('No captureStackTrace');
            expect(error.message).toBe('No captureStackTrace');
            expect(error.name).toBe('EmailError');
        } finally {
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });
});
