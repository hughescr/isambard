import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { mockFsPromises, resetMockFs } from '../../setup';
import { validateFilePath, validateFilePaths, PathSecurityError } from '@/utils/path-validator';

// Setup test fixtures in a temp directory inside CWD
const testDir = path.join(process.cwd(), 'test-fixtures-path-validator');
const validFile = path.join(testDir, 'valid.txt');
const subDir = path.join(testDir, 'subdir');
const subDirFile = path.join(subDir, 'nested.txt');

describe('path-validator', () => {
    beforeAll(() => {
        resetMockFs();
        // Create test structure using mock filesystem
        void mockFsPromises.mkdir(testDir, { recursive: true });
        void mockFsPromises.mkdir(subDir, { recursive: true });
        void mockFsPromises.writeFile(validFile, 'test content\n');
        void mockFsPromises.writeFile(subDirFile, 'nested content\n');
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

        test('should reject path outside CWD with ..', async () => {
            expect(validateFilePath('../etc/passwd')).rejects.toThrow(PathSecurityError);
            expect(validateFilePath('../etc/passwd')).rejects.toThrow('SECURITY');
            expect(validateFilePath('../etc/passwd')).rejects.toThrow('outside the working directory');
        });

        test('should reject absolute path outside CWD', async () => {
            expect(validateFilePath('/etc/passwd')).rejects.toThrow(PathSecurityError);
            expect(validateFilePath('/etc/passwd')).rejects.toThrow('SECURITY');
        });

        test('should reject non-existent files', async () => {
            expect(validateFilePath(path.join(testDir, 'nonexistent.txt'))).rejects.toThrow(PathSecurityError);
            expect(validateFilePath(path.join(testDir, 'nonexistent.txt'))).rejects.toThrow('not found');
        });

        test('should reject directories', async () => {
            expect(validateFilePath(subDir)).rejects.toThrow(PathSecurityError);
            expect(validateFilePath(subDir)).rejects.toThrow('Not a file');
        });

        test('should include "Do NOT circumvent" in security errors', async () => {
            expect(validateFilePath('../etc/passwd')).rejects.toThrow('Do NOT circumvent');
        });

        test('should reject symlinks', async () => {
            const symlinkPath = path.join(testDir, 'link.txt');
            // Create a symlink in the mock filesystem
            void mockFsPromises.symlink(validFile, symlinkPath);

            expect(validateFilePath(symlinkPath)).rejects.toThrow(PathSecurityError);
            expect(validateFilePath(symlinkPath)).rejects.toThrow('SECURITY');
            expect(validateFilePath(symlinkPath)).rejects.toThrow('Symlinks not allowed');
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
            expect(validateFilePaths([validFile, '../etc/passwd'])).rejects.toThrow(PathSecurityError);
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
