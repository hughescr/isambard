import { describe, test, expect } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import { PathSecurityError, MediaProcessingError } from '@/errors/utils';

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

describe.concurrent('MediaProcessingError', () => {
    test('should have correct inheritance chain', () => {
        const error = new MediaProcessingError('failed', 'ffprobe');
        expect(error).toBeInstanceOf(MediaProcessingError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new MediaProcessingError('failed', 'ffprobe');
        expect(error.name).toBe('MediaProcessingError');
    });

    test('should have correct code', () => {
        const error = new MediaProcessingError('failed', 'ffprobe');
        expect(error.code).toBe(ErrorCode.MEDIA_PROCESSING_ERROR);
    });

    test('should store operation in context', () => {
        const error = new MediaProcessingError('failed', 'ffmpeg-spectrogram');
        expect(error.context.operation).toBe('ffmpeg-spectrogram');
    });

    test('should store detail in context when provided', () => {
        const error = new MediaProcessingError('failed', 'ffprobe', 'stderr output');
        expect(error.context.detail).toBe('stderr output');
    });

    test('should omit detail from context when not provided', () => {
        const error = new MediaProcessingError('failed', 'ffprobe');
        expect(error.context.detail).toBeUndefined();
        expect(Object.keys(error.context)).not.toContain('detail');
    });

    test('should set cause when provided', () => {
        const originalError = new Error('underlying failure');
        const error = new MediaProcessingError('failed', 'heic-convert', 'detail', originalError);
        expect(error.cause).toBe(originalError);
    });

    test('should not set cause when not provided', () => {
        const error = new MediaProcessingError('failed', 'ffprobe', 'detail');
        expect(error.cause).toBeUndefined();
    });
});
