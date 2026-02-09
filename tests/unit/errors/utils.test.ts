import { describe, test, expect } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import { PathSecurityError } from '@/errors/utils';

describe.concurrent('PathSecurityError', () => {
    test('should have correct inheritance chain', () => {
        const error = new PathSecurityError('test', '/path', 'outside_cwd');
        expect(error).toBeInstanceOf(PathSecurityError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new PathSecurityError('test', '/path', 'outside_cwd');
        expect(error.name).toBe('PathSecurityError');
    });

    test('should have correct code', () => {
        const error = new PathSecurityError('test', '/path', 'outside_cwd');
        expect(error.code).toBe(ErrorCode.PATH_SECURITY_ERROR);
    });

    test('should store path and reason in context', () => {
        const error = new PathSecurityError('test message', '/some/path', 'is_symlink');
        expect(error.context.path).toBe('/some/path');
        expect(error.context.reason).toBe('is_symlink');
    });

    test.each([
        'outside_cwd' as const,
        'is_symlink' as const,
        'not_found' as const,
        'not_file' as const,
    ])('should handle reason: %s', (reason) => {
        const error = new PathSecurityError('test', '/path', reason);
        expect(error.context.reason).toBe(reason);
    });
});
