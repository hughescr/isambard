import { describe, test, expect } from 'bun:test';
import { sanitizeFilename, deduplicateFilename } from '@/utils/filename';

describe('sanitizeFilename', () => {
    test('should return the filename unchanged when already safe', () => {
        expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    });

    test('should return safe name for a normal filename with extension', () => {
        const result = sanitizeFilename('document.txt');
        expect(result).toBe('document.txt');
        expect(result).not.toBe('');
    });

    test('should replace path separator / with _', () => {
        const result = sanitizeFilename('some/path/file.txt');
        expect(result).not.toContain('/');
    });

    test('should replace path separator \\ with _', () => {
        const result = sanitizeFilename('some\\path\\file.txt');
        expect(result).not.toContain('\\');
    });

    test('should replace dotdot sequences to prevent path traversal', () => {
        const result = sanitizeFilename('../../../etc/passwd');
        expect(result).not.toContain('..');
        expect(result).not.toContain('/');
    });

    test('should strip leading dots', () => {
        const result = sanitizeFilename('...hidden');
        expect(result[0]).not.toBe('.');
    });

    test('should fall back to attachment for empty string', () => {
        expect(sanitizeFilename('')).toBe('attachment');
    });

    test('should replace dotdot sequences (not fall back to attachment)', () => {
        // '...' → dotdot regex replaces with '_', then trim leaves '_' which is truthy
        const result = sanitizeFilename('...');
        expect(result).not.toContain('..');
        expect(result).not.toBe('');
    });

    test('should produce a non-empty result for all-dots string', () => {
        const result = sanitizeFilename('......');
        expect(result).not.toBe('');
        expect(result).not.toContain('..');
    });

    test('should strip leading and trailing spaces', () => {
        const result = sanitizeFilename('  report.pdf  ');
        expect(result).toBe('report.pdf');
    });

    test('should replace null bytes', () => {
        const result = sanitizeFilename('file\x00name.txt');
        expect(result).not.toContain('\x00');
    });

    test('should replace control characters', () => {
        const result = sanitizeFilename('file\x01\x1fname.txt');
        expect(result).not.toMatch(/[\x00-\x1F]/);
    });

    test('should handle filename with spaces in the middle', () => {
        expect(sanitizeFilename('my report.pdf')).toBe('my report.pdf');
    });
});

describe('deduplicateFilename', () => {
    test('should return the filename unchanged when not in the used set', () => {
        const used = new Set<string>();
        expect(deduplicateFilename('report.pdf', used)).toBe('report.pdf');
    });

    test('should return original filename when used set is empty', () => {
        expect(deduplicateFilename('file.txt', new Set())).toBe('file.txt');
    });

    test('should append -(1) when filename is already used', () => {
        const used = new Set(['report.pdf']);
        expect(deduplicateFilename('report.pdf', used)).toBe('report-(1).pdf');
    });

    test('should append -(2) when -(1) variant is also used', () => {
        const used = new Set(['report.pdf', 'report-(1).pdf']);
        expect(deduplicateFilename('report.pdf', used)).toBe('report-(2).pdf');
    });

    test('should handle filenames without extension', () => {
        const used = new Set(['README']);
        expect(deduplicateFilename('README', used)).toBe('README-(1)');
    });

    test('should not modify filename when similar names with -(N) exist but original is free', () => {
        const used = new Set(['report-(1).pdf']);
        expect(deduplicateFilename('report.pdf', used)).toBe('report.pdf');
    });

    test('should skip over multiple taken variants', () => {
        const used = new Set(['data.csv', 'data-(1).csv', 'data-(2).csv']);
        expect(deduplicateFilename('data.csv', used)).toBe('data-(3).csv');
    });

    test('should handle filename with multiple dots correctly (uses last dot for extension)', () => {
        const used = new Set(['archive.tar.gz']);
        const result = deduplicateFilename('archive.tar.gz', used);
        expect(result).toBe('archive.tar-(1).gz');
    });
});
