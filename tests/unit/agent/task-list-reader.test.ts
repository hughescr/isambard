/**
 * Tests for task list reader
 *
 * The task list reader reads Claude Agent SDK task JSON files from a session
 * directory and builds a compact summary for idle status generation.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { constant as _constant, replace as _replace } from 'lodash';
import { mockLogger } from '../../setup';
import { createTaskListReader } from '@/agent/task-list-reader';
import type { Dirent } from 'node:fs';

describe('createTaskListReader', () => {
    let mockReaddir: ReturnType<typeof mock>;
    let mockReadFile: ReturnType<typeof mock>;
    let mockGetCurrentSessionId: ReturnType<typeof mock>;

    beforeEach(() => {
        mockReaddir = mock(_constant(Promise.resolve([])));
        mockReadFile = mock(_constant(Promise.resolve('{}')));
        mockGetCurrentSessionId = mock(_constant('test-session-id'));

        mockLogger.debug.mockClear();
    });

    test('should return undefined when no session ID', async () => {
        mockGetCurrentSessionId = mock(_constant(undefined));
        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
        expect(mockReaddir).not.toHaveBeenCalled();
    });

    test('should return undefined when directory does not exist (ENOENT)', async () => {
        const enoentError = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        enoentError.code = 'ENOENT';
        mockReaddir = mock(_constant(Promise.reject(enoentError)));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
        expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    test('should return undefined when directory is empty', async () => {
        mockReaddir = mock(_constant(Promise.resolve([])));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should return undefined when directory has no JSON files', async () => {
        const mockFiles: Dirent[] = [
            { name: 'not-json.txt', isFile: _constant(true) } as Dirent,
            { name: 'README.md', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should filter out non-JSON files and directories', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
            { name: 'not-json.txt', isFile: _constant(true) } as Dirent,
            { name: 'subdir', isFile: _constant(false) } as Dirent,
            { name: 'README.md', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: 'Valid task',
            status:  'pending',
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should only process task1.json
        expect(result).toBe('1 pending tasks');
        expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    test('should return undefined when all JSON files fail to parse', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
            { name: 'task2.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve('invalid JSON {{{')));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should exclude completed tasks from exactly 2 hours ago', async () => {
        const now = new Date();
        const exactlyTwoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:       'task1',
            subject:  'Completed at boundary',
            status:   'completed',
            metadata: { completedAt: exactlyTwoHoursAgo.toISOString() },
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should be excluded (< 2 hours, not <=)
        expect(result).toBeUndefined();
    });

    test('should return undefined when all tasks are old completed tasks', async () => {
        const now = new Date();
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
        const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
            { name: 'task2.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock((path: string) => {
            if(path.includes('task1.json')) {
                return Promise.resolve(JSON.stringify({
                    id:       'task1',
                    subject:  'Old task 1',
                    status:   'completed',
                    metadata: { completedAt: threeHoursAgo.toISOString() },
                }));
            }
            return Promise.resolve(JSON.stringify({
                id:       'task2',
                subject:  'Old task 2',
                status:   'completed',
                metadata: { completedAt: fourHoursAgo.toISOString() },
            }));
        });

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should return summary with in_progress tasks', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: 'Fix the bug',
            status:  'in_progress',
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('Working on: Fix the bug');
    });

    test('should return summary with pending tasks count', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
            { name: 'task2.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock((path: string) => {
            if(path.includes('task1.json')) {
                return Promise.resolve(JSON.stringify({
                    id:      'task1',
                    subject: 'Task 1',
                    status:  'pending',
                }));
            }
            return Promise.resolve(JSON.stringify({
                id:      'task2',
                subject: 'Task 2',
                status:  'pending',
            }));
        });

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('2 pending tasks');
    });

    test('should return summary with recently completed tasks', async () => {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:       'task1',
            subject:  'Completed task',
            status:   'completed',
            metadata: { completedAt: oneHourAgo.toISOString() },
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('Recently done: Completed task');
    });

    test('should return summary combining all three sections', async () => {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
            { name: 'task2.json', isFile: _constant(true) } as Dirent,
            { name: 'task3.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock((path: string) => {
            if(path.includes('task1.json')) {
                return Promise.resolve(JSON.stringify({
                    id:      'task1',
                    subject: 'Working task',
                    status:  'in_progress',
                }));
            }
            if(path.includes('task2.json')) {
                return Promise.resolve(JSON.stringify({
                    id:      'task2',
                    subject: 'Pending task',
                    status:  'pending',
                }));
            }
            return Promise.resolve(JSON.stringify({
                id:       'task3',
                subject:  'Done task',
                status:   'completed',
                metadata: { completedAt: oneHourAgo.toISOString() },
            }));
        });

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('Working on: Working task\n1 pending tasks\nRecently done: Done task');
    });

    test('should filter out old completed tasks (completed > 2 hours ago)', async () => {
        const now = new Date();
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:       'task1',
            subject:  'Old completed task',
            status:   'completed',
            metadata: { completedAt: threeHoursAgo.toISOString() },
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should filter out completed tasks without completedAt metadata', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: 'Completed task without timestamp',
            status:  'completed',
            // No metadata field
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should be filtered out - no tasks to show
        expect(result).toBeUndefined();
    });

    test('should skip unparseable JSON files', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
            { name: 'task2.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock((path: string) => {
            if(path.includes('task1.json')) {
                return Promise.resolve('invalid JSON {{{');
            }
            return Promise.resolve(JSON.stringify({
                id:      'task2',
                subject: 'Valid task',
                status:  'pending',
            }));
        });

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('1 pending tasks');
    });

    test('should skip files with valid JSON but wrong shape', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
            { name: 'task2.json', isFile: _constant(true) } as Dirent,
            { name: 'task3.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock((path: string) => {
            if(path.includes('task1.json')) {
                // Wrong shape - missing required fields
                return Promise.resolve(JSON.stringify({ foo: 'bar' }));
            }
            if(path.includes('task2.json')) {
                // Wrong shape - invalid status
                return Promise.resolve(JSON.stringify({
                    id:      'task2',
                    subject: 'Task 2',
                    status:  'invalid_status',
                }));
            }
            return Promise.resolve(JSON.stringify({
                id:      'task3',
                subject: 'Valid task',
                status:  'pending',
            }));
        });

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should only process task3 (valid shape)
        expect(result).toBe('1 pending tasks');
    });

    test('should limit to top 10 tasks', async () => {
        const mockFiles: Dirent[] = Array.from({ length: 15 }, (_, i) => ({
            name:   `task${i}.json`,
            isFile: _constant(true),
        } as Dirent));
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:      'task',
            subject: 'Task',
            status:  'pending',
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should cap at 10 tasks
        expect(result).toBe('10 pending tasks');
    });

    test('should truncate long subjects', async () => {
        const longSubject = 'This is a very long task subject that should be truncated because it is way too long for display in a status message and would make the status unreadable';

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: longSubject,
            status:  'in_progress',
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should truncate at 50 chars
        expect(result).toContain('...');
        expect(result!.length).toBeLessThan(longSubject.length + 20);
    });

    test('should not truncate subject with exactly 50 characters', async () => {
        const exactlyFiftyChars = '12345678901234567890123456789012345678901234567890'; // exactly 50 chars

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: exactlyFiftyChars,
            status:  'in_progress',
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should NOT truncate
        expect(result).toBe(`Working on: ${exactlyFiftyChars}`);
        expect(result).not.toContain('...');
    });

    test('should truncate subject with 51 characters', async () => {
        const fiftyOneChars = '123456789012345678901234567890123456789012345678901'; // exactly 51 chars

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: _constant(true) } as Dirent,
        ];
        mockReaddir = mock(_constant(Promise.resolve(mockFiles)));
        mockReadFile = mock(_constant(Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: fiftyOneChars,
            status:  'in_progress',
        }))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should truncate to 47 + '...' = 50 chars total
        expect(result).toContain('...');
        const truncatedSubject = _replace(result!, 'Working on: ', '');
        expect(truncatedSubject).toBe('12345678901234567890123456789012345678901234567...');
        expect(truncatedSubject.length).toBe(50);
    });

    test('should return undefined on error', async () => {
        mockReaddir = mock(_constant(Promise.reject(new Error('Unexpected error'))));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger as unknown as typeof import('@hughescr/logger').logger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });
});
