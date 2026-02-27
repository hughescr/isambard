/**
 * Tests for task directory copier
 *
 * The task directory copier handles copying Claude Agent SDK task directories
 * from a previous session to a new session to maintain task continuity across
 * bot restarts.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { homedir } from 'node:os';
import path from 'node:path';
import { type logger } from '@hughescr/logger';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';
import type { TaskCleanupProcessor, TaskCleanupResult } from '@/agent/task-cleanup-processor';
import { createTaskDirectoryCopier, getTaskDirectoryPath } from '@/agent/task-directory-copier';
import type { SessionId } from '@/storage/task-session/types';

// Use the mocks from setup.ts
const mockAccess = mockFsPromises.access;
const mockCp = mockFsPromises.cp;

// Helper to create SessionId (bypassing Zod validation in tests)
const sessionId = (id: string): SessionId => id as SessionId;

describe('getTaskDirectoryPath', () => {
    test('should construct path from session ID', () => {
        const testSessionId = 'abc-123-def-456';
        const result = getTaskDirectoryPath(testSessionId);

        // Should contain the session ID
        expect(result).toContain(testSessionId);
    });

    test('should use tasks directory structure', () => {
        const testSessionId = 'test-session-id';
        const result = getTaskDirectoryPath(testSessionId);

        // Should be in .claude/tasks/{project-path}/ directory
        expect(result).toContain('.claude/tasks/');
    });

    test('should handle UUID-style session IDs', () => {
        const testSessionId = '550e8400-e29b-41d4-a716-446655440000';
        const result = getTaskDirectoryPath(testSessionId);

        expect(result).toContain(testSessionId);
    });

    test('should use session ID directly without project path prefix', () => {
        const result = getTaskDirectoryPath('test-session');

        // SDK stores tasks at ~/.claude/tasks/{sessionId}/ without project path
        expect(result).toContain('test-session');
        expect(result).toBe(path.join(homedir(), '.claude', 'tasks', 'test-session'));
    });

    test('should match expected path format', () => {
        const testSessionId = 'my-session';
        const result = getTaskDirectoryPath(testSessionId);

        // SDK stores tasks at ~/.claude/tasks/{sessionId}/ (no project path)
        const expectedPath = path.join(homedir(), '.claude', 'tasks', testSessionId);

        expect(result).toBe(expectedPath);
    });
});

describe('copyTaskDirectory', () => {
    beforeEach(() => {
        // Reset all mocks
        mockLogger.debug.mockClear();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockAccess.mockClear();
        mockCp.mockClear();

        // Reset to default successful behavior
        mockAccess.mockImplementation(() => Promise.resolve());
        mockCp.mockImplementation(() => Promise.resolve());
    });

    afterEach(() => {
        resetMockFs();
    });

    test('should copy directory when source exists', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('old-session-123');
        const newSessionId = sessionId('new-session-456');

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(true);
        expect(mockAccess).toHaveBeenCalledTimes(1);
        expect(mockCp).toHaveBeenCalledTimes(1);

        // Verify cp was called with correct paths
        const cpCall = mockCp.mock.calls[0];
        expect(cpCall[0]).toContain('old-session-123');
        expect(cpCall[1]).toContain('new-session-456');
    });

    test('should use COPYFILE_FICLONE mode', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('old-session');
        const newSessionId = sessionId('new-session');

        await copier.copyTaskDirectory(previousSessionId, newSessionId);

        // Verify cp options include COPYFILE_FICLONE
        const cpCall = mockCp.mock.calls[0];
        const options = cpCall[2] as { recursive: boolean, mode: number };
        expect(options.recursive).toBe(true);
        expect(options.mode).toBeDefined();
        // COPYFILE_FICLONE is a constant from fs.constants
        // We just verify the mode is set
    });

    test('should log info on successful copy', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('prev-session');
        const newSessionId = sessionId('new-session');

        await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                previousSessionId,
                newSessionId,
                msg: expect.stringContaining('Copied task directory'),
            })
        );
    });

    test('should return false when source directory does not exist', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('nonexistent-session');
        const newSessionId = sessionId('new-session');

        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';
        mockAccess.mockImplementation(() => Promise.reject(notFoundError));

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(false);
        expect(mockAccess).toHaveBeenCalledTimes(1);
        expect(mockCp).not.toHaveBeenCalled();
    });

    test('should log debug when source does not exist', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('no-source');
        const newSessionId = sessionId('new-session');

        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';
        mockAccess.mockImplementation(() => Promise.reject(notFoundError));

        await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({
                previousSessionId,
                msg: expect.stringContaining('No previous task directory'),
            })
        );
    });

    test('should return false and log warning when cp fails', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('source-session');
        const newSessionId = sessionId('dest-session');

        const copyError = new Error('EPERM: permission denied');
        mockCp.mockImplementation(() => Promise.reject(copyError));

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(false);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                previousSessionId,
                newSessionId,
                error: expect.stringContaining('permission denied'),
                msg:   expect.stringContaining('Failed to copy task directory'),
            })
        );
    });

    test('should not throw on cp failure', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('src');
        const newSessionId = sessionId('dst');

        const copyError = new Error('Disk full');
        mockCp.mockImplementation(() => Promise.reject(copyError));

        // Should complete without throwing
        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);
        expect(result).toBe(false);
    });

    test('should handle non-Error exceptions from cp', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('src');
        const newSessionId = sessionId('dst');

        // Throw a non-Error object
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing error handling
        mockCp.mockImplementation(() => Promise.reject('String error'));

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(false);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                error: 'String error',
                msg:   expect.stringContaining('Failed to copy'),
            })
        );
    });

    test('should handle access errors other than ENOENT', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('src');
        const newSessionId = sessionId('dst');

        const permError = new Error('EPERM') as NodeJS.ErrnoException;
        permError.code = 'EPERM';
        mockAccess.mockImplementation(() => Promise.reject(permError));

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        // Non-ENOENT errors are caught and treated as "source doesn't exist"
        expect(result).toBe(false);
        expect(mockCp).not.toHaveBeenCalled();
    });

    test('should construct correct source and destination paths', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('prev-123');
        const newSessionId = sessionId('new-456');

        await copier.copyTaskDirectory(previousSessionId, newSessionId);

        const cpCall = mockCp.mock.calls[0];
        const sourcePath = cpCall[0];
        const destPath = cpCall[1];

        // SDK stores tasks at ~/.claude/tasks/{sessionId}/ (no project path)
        expect(sourcePath).toBe(path.join(homedir(), '.claude', 'tasks', 'prev-123'));
        expect(destPath).toBe(path.join(homedir(), '.claude', 'tasks', 'new-456'));
    });

    test('should log both paths on successful copy', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('old');
        const newSessionId = sessionId('new');

        await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                sourcePath: expect.stringContaining('old'),
                destPath:   expect.stringContaining('new'),
            })
        );
    });

    test('should log source path on debug when not found', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('missing');
        const newSessionId = sessionId('new');

        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';
        mockAccess.mockImplementation(() => Promise.reject(notFoundError));

        await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({
                sourcePath: expect.stringContaining('missing'),
            })
        );
    });
});

describe('copyTaskDirectory with cleanup processor', () => {
    beforeEach(() => {
        // Reset all mocks
        mockLogger.debug.mockClear();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockAccess.mockClear();
        mockCp.mockClear();

        // Reset to default successful behavior
        mockAccess.mockImplementation(() => Promise.resolve());
        mockCp.mockImplementation(() => Promise.resolve());
    });

    afterEach(() => {
        resetMockFs();
    });

    test('should use cleanup processor when provided and processor succeeds', async () => {
        const mockResult: TaskCleanupResult = { copied: 5, deleted: 3, errors: 0 };
        const mockProcessor: TaskCleanupProcessor = {
            processTaskDirectory: mock(async () => mockResult),
        };

        const copier = createTaskDirectoryCopier({
            logger:           mockLogger as unknown as typeof logger,
            cleanupProcessor: mockProcessor,
        });

        const previousSessionId = sessionId('old-session');
        const newSessionId = sessionId('new-session');

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(true);
        expect(mockProcessor.processTaskDirectory).toHaveBeenCalledTimes(1);
        expect(mockProcessor.processTaskDirectory).toHaveBeenCalledWith(previousSessionId, newSessionId);

        // Should NOT fall back to simple copy
        expect(mockCp).not.toHaveBeenCalled();

        // Should log cleanup success
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                previousSessionId,
                newSessionId,
                copied:  5,
                deleted: 3,
                errors:  0,
                msg:     'Task directory copied with cleanup',
            })
        );
    });

    test('should fallback to simple copy when cleanup processor fails', async () => {
        const processorError = new Error('Cleanup failed: disk error');
        const mockProcessor: TaskCleanupProcessor = {
            processTaskDirectory: mock(async () => {
                throw processorError;
            }),
        };

        const copier = createTaskDirectoryCopier({
            logger:           mockLogger as unknown as typeof logger,
            cleanupProcessor: mockProcessor,
        });

        const previousSessionId = sessionId('old-session');
        const newSessionId = sessionId('new-session');

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(true);
        expect(mockProcessor.processTaskDirectory).toHaveBeenCalledTimes(1);

        // Should log warning about fallback
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                previousSessionId,
                newSessionId,
                error: 'Cleanup failed: disk error',
                msg:   'Task cleanup failed, falling back to simple copy',
            })
        );

        // Should fallback to simple copy
        expect(mockCp).toHaveBeenCalledTimes(1);

        // Should log success of simple copy
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                previousSessionId,
                newSessionId,
                msg: 'Copied task directory to new session',
            })
        );
    });

    test('should use simple copy when cleanup processor not provided', async () => {
        const copier = createTaskDirectoryCopier({ logger: mockLogger as unknown as typeof logger });
        const previousSessionId = sessionId('old-session');
        const newSessionId = sessionId('new-session');

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(true);

        // Should use simple copy
        expect(mockCp).toHaveBeenCalledTimes(1);

        // Should log simple copy success
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                previousSessionId,
                newSessionId,
                msg: 'Copied task directory to new session',
            })
        );
    });

    test('should return false when simple copy fails after cleanup processor fails', async () => {
        const processorError = new Error('Cleanup failed');
        const mockProcessor: TaskCleanupProcessor = {
            processTaskDirectory: mock(async () => {
                throw processorError;
            }),
        };

        const copyError = new Error('EPERM: permission denied');
        mockCp.mockImplementation(() => Promise.reject(copyError));

        const copier = createTaskDirectoryCopier({
            logger:           mockLogger as unknown as typeof logger,
            cleanupProcessor: mockProcessor,
        });

        const previousSessionId = sessionId('old-session');
        const newSessionId = sessionId('new-session');

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(false);

        // Should attempt cleanup first
        expect(mockProcessor.processTaskDirectory).toHaveBeenCalledTimes(1);

        // Should log cleanup failure
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                error: 'Cleanup failed',
                msg:   'Task cleanup failed, falling back to simple copy',
            })
        );

        // Should attempt fallback copy
        expect(mockCp).toHaveBeenCalledTimes(1);

        // Should log copy failure
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                error: 'EPERM: permission denied',
                msg:   'Failed to copy task directory',
            })
        );
    });

    test('should handle non-Error exceptions from cleanup processor', async () => {
        const mockProcessor: TaskCleanupProcessor = {
            processTaskDirectory: mock(async () => { throw 'String error from processor'; }),
        };

        const copier = createTaskDirectoryCopier({
            logger:           mockLogger as unknown as typeof logger,
            cleanupProcessor: mockProcessor,
        });

        const previousSessionId = sessionId('old-session');
        const newSessionId = sessionId('new-session');

        const result = await copier.copyTaskDirectory(previousSessionId, newSessionId);

        expect(result).toBe(true);

        // Should log string error
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                error: 'String error from processor',
                msg:   'Task cleanup failed, falling back to simple copy',
            })
        );

        // Should fallback to simple copy
        expect(mockCp).toHaveBeenCalledTimes(1);
    });
});
