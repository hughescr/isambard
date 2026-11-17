import { describe, test, expect } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import { EmailError, EmailPreviewError } from '@/errors/email';

describe('EmailPreviewError', () => {
    test('is an EmailError with its own name and code', () => {
        const error = new EmailPreviewError('preview failed');
        expect(error).toBeInstanceOf(EmailPreviewError);
        expect(error).toBeInstanceOf(EmailError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error.name).toBe('EmailPreviewError');
        expect(error.code).toBe(ErrorCode.EMAIL_PREVIEW_ERROR);
        expect(error.message).toBe('preview failed');
    });

    test('has no cause unless one is given', () => {
        expect('cause' in new EmailPreviewError('preview failed')).toBe(false);
    });

    test('keeps the cause it is given, falsy values included', () => {
        const cause = new Error('spawn failed');
        expect(new EmailPreviewError('preview failed', cause).cause).toBe(cause);
        expect(new EmailPreviewError('preview failed', 0).cause).toBe(0);
    });
});
