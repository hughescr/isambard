import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn, jest } from 'bun:test';
import { constants } from 'node:fs';
import path from 'node:path';
import { mockFsPromises, resetMockFs } from '../../setup';
import { validateFilePath, validateFilePaths, PathSecurityError } from '@/utils/path-validator';

// Setup test fixtures in a temp directory inside CWD
const testDir = path.join(process.cwd(), 'test-fixtures-path-validator');
const validFile = path.join(testDir, 'valid.txt');
const subDir = path.join(testDir, 'subdir');
const subDirFile = path.join(subDir, 'nested.txt');
const dotDotPrefixedFile = path.join(process.cwd(), '..safe-file.txt');

afterEach(() => {
    jest.restoreAllMocks();
});

describe('path-validator', () => {
    beforeAll(() => {
        resetMockFs();
        // Create test structure using mock filesystem
        void mockFsPromises.mkdir(testDir, { recursive: true });
        void mockFsPromises.mkdir(subDir, { recursive: true });
        void mockFsPromises.writeFile(validFile, 'test content\n');
        void mockFsPromises.writeFile(subDirFile, 'nested content\n');
        void mockFsPromises.writeFile(dotDotPrefixedFile, 'safe content\n');
    });

    afterAll(() => {
        resetMockFs();
    });

    describe('validateFilePath', () => {
        test('should accept file inside CWD', async () => {
            const result = await validateFilePath(validFile);
            expect(result).toBe(validFile);
        });

        test('should accept file in subdirectory', async () => {
            const result = await validateFilePath(subDirFile);
            expect(result).toBe(subDirFile);
        });

        test('should accept relative path inside CWD', async () => {
            const relativePath = 'test-fixtures-path-validator/valid.txt';
            const result = await validateFilePath(relativePath);
            expect(result).toBe(validFile);
        });

        test('accepts an in-CWD filename that begins with two dots', async () => {
            expect(await validateFilePath('..safe-file.txt')).toBe(dotDotPrefixedFile);
        });

        test('should reject path outside CWD with ..', async () => {
            await expect(validateFilePath('../etc/passwd')).rejects.toThrow(PathSecurityError);
            await expect(validateFilePath('../etc/passwd')).rejects.toThrow('SECURITY');
            await expect(validateFilePath('../etc/passwd')).rejects.toThrow('outside the working directory');
        });

        test('classifies the parent directory itself as outside the working directory', async () => {
            await expect(validateFilePath('..')).rejects.toMatchObject({
                context: { path: '..', reason: 'outside_cwd' },
            });
        });

        test('should reject absolute path outside CWD', async () => {
            await expect(validateFilePath('/etc/passwd')).rejects.toThrow(PathSecurityError);
            await expect(validateFilePath('/etc/passwd')).rejects.toThrow('SECURITY');
        });

        test('should reject non-existent files', async () => {
            await expect(validateFilePath(path.join(testDir, 'nonexistent.txt'))).rejects.toThrow(PathSecurityError);
            await expect(validateFilePath(path.join(testDir, 'nonexistent.txt'))).rejects.toThrow('not found');
        });

        test('should reject directories', async () => {
            await expect(validateFilePath(subDir)).rejects.toThrow(PathSecurityError);
            await expect(validateFilePath(subDir)).rejects.toThrow('Not a file');
        });

        test('should include "Do NOT circumvent" in security errors', async () => {
            await expect(validateFilePath('../etc/passwd')).rejects.toThrow('Do NOT circumvent');
        });

        test('resolves the target against the cwd captured once, not a fresh process.cwd() read', async () => {
            // path.resolve(cwd, filePath) must not re-read process.cwd(): if it did, a cwd()
            // that changes between the initial capture and the resolve call would let the
            // resolved path drift onto a different root than the one used for the
            // inside-CWD check below it, defeating the security guard via a TOCTOU-style gap.
            const cwdSpy = spyOn(process, 'cwd');
            cwdSpy.mockReturnValueOnce('/mock-cwd-a').mockReturnValueOnce('/mock-cwd-b');

            await expect(validateFilePath('foo.txt')).rejects.toMatchObject({
                context: { reason: 'not_found' },
            });
        });

        test('rejects when path.relative resolves to an absolute path that is neither ".." nor "..<sep>"-prefixed', async () => {
            const relativeSpy = spyOn(path, 'relative').mockReturnValue('/definitely/elsewhere');

            await expect(validateFilePath(validFile)).rejects.toMatchObject({
                context: { reason: 'outside_cwd' },
            });
            expect(relativeSpy).toHaveBeenCalled();
        });

        test('accepts a relativePath containing ".."+sep only in the middle, not as a prefix', async () => {
            const relativeSpy = spyOn(path, 'relative').mockReturnValue(`safe${path.sep}..${path.sep}inner.txt`);

            const result = await validateFilePath(validFile);
            expect(result).toBe(validFile);
            expect(relativeSpy).toHaveBeenCalled();
        });

        test('checks file access with read permission (R_OK), not mere existence (F_OK)', async () => {
            await validateFilePath(validFile);

            const lastCall = mockFsPromises.access.mock.calls.at(-1);
            expect(lastCall).toEqual([validFile, constants.R_OK]);
        });

        test('should reject symlinks', async () => {
            const symlinkPath = path.join(testDir, 'link.txt');
            // Create a symlink in the mock filesystem
            void mockFsPromises.symlink(validFile, symlinkPath);

            await expect(validateFilePath(symlinkPath)).rejects.toThrow(PathSecurityError);
            await expect(validateFilePath(symlinkPath)).rejects.toThrow('SECURITY');
            await expect(validateFilePath(symlinkPath)).rejects.toThrow('Symlinks not allowed');
        });
    });

    describe('validateFilePaths', () => {
        test('should accept array of valid paths', async () => {
            const result = await validateFilePaths([validFile, subDirFile]);
            expect(result).toEqual([validFile, subDirFile]);
        });

        test('should accept single string', async () => {
            const result = await validateFilePaths(validFile);
            expect(result).toEqual([validFile]);
        });

        test('should reject if any path is invalid', async () => {
            await expect(validateFilePaths([validFile, '../etc/passwd'])).rejects.toThrow(PathSecurityError);
        });
    });

    describe('PathSecurityError', () => {
        test('should have path and reason properties', async () => {
            try {
                await validateFilePath('../etc/passwd');
                throw new Error('Should have thrown PathSecurityError');
            } catch (error) {
                expect(error).toBeInstanceOf(PathSecurityError);
                expect((error as PathSecurityError).context.path).toBe('../etc/passwd');
                expect((error as PathSecurityError).context.reason).toBe('outside_cwd');
            }
        });

        test('should have name property set to PathSecurityError', async () => {
            try {
                await validateFilePath('../etc/passwd');
                throw new Error('Should have thrown PathSecurityError');
            } catch (error) {
                expect(error).toBeInstanceOf(PathSecurityError);
                expect((error as PathSecurityError).name).toBe('PathSecurityError');
            }
        });
    });
});
