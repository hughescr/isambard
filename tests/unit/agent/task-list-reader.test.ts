/**
 * Tests for task list reader
 *
 * The task list reader reads Claude Agent SDK task JSON files from a session
 * directory and builds a compact summary for idle status generation.
 */
import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { mockLogger } from '../../setup';
import { createTaskListReader, getTaskDirectoryPath } from '@/agent/task-list-reader';

describe('getTaskDirectoryPath', () => {
    test('should use session ID directly without project path prefix', () => {
        const result = getTaskDirectoryPath('test-session');

        // SDK stores tasks at ~/.claude/tasks/{sessionId}/ without project path
        expect(result).toBe(nodePath.join(homedir(), '.claude', 'tasks', 'test-session'));
    });

    test('should match expected path format for a UUID-style session ID', () => {
        const testSessionId = '550e8400-e29b-41d4-a716-446655440000';
        const result = getTaskDirectoryPath(testSessionId);

        expect(result).toBe(nodePath.join(homedir(), '.claude', 'tasks', testSessionId));
    });
});

describe('createTaskListReader', () => {
    let mockReaddir: ReturnType<typeof mock>;
    let mockReadFile: ReturnType<typeof mock>;
    let mockGetCurrentSessionId: ReturnType<typeof mock>;

    beforeEach(() => {
        mockReaddir = mock(() => Promise.resolve([]));
        mockReadFile = mock(() => Promise.resolve('{}'));
        mockGetCurrentSessionId = mock(() => 'test-session-id');

        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        setSystemTime();
    });

    test('should return undefined when no session ID', async () => {
        mockGetCurrentSessionId = mock(() => undefined);
        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
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
        mockReaddir = mock(() => Promise.reject(enoentError));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
        expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    test('should return undefined when directory is empty', async () => {
        mockReaddir = mock(() => Promise.resolve([]));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should return undefined when directory has no JSON files', async () => {
        const mockFiles: Dirent[] = [
            { name: 'not-json.txt', isFile: () => true } as Dirent,
            { name: 'README.md', isFile: () => true } as Dirent,
            { name: 'task.json.backup', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
        expect(mockReadFile).not.toHaveBeenCalled();
    });

    test('should filter out non-JSON files and directories', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
            { name: 'not-json.txt', isFile: () => true } as Dirent,
            { name: 'subdir', isFile: () => false } as Dirent,
            { name: 'README.md', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: 'Valid task',
            status:  'pending',
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
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
            { name: 'task1.json', isFile: () => true } as Dirent,
            { name: 'task2.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve('invalid JSON {{{'));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should exclude completed tasks from exactly 2 hours ago', async () => {
        const frozenNow = new Date('2026-01-01T12:00:00.000Z');
        setSystemTime(frozenNow);
        const exactlyTwoHoursAgo = new Date(frozenNow.getTime() - 2 * 60 * 60 * 1000);

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:       'task1',
            subject:  'Completed at boundary',
            status:   'completed',
            metadata: { completedAt: exactlyTwoHoursAgo.toISOString() },
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should be excluded: (now - completedTime) < twoHoursMs → twoHoursMs < twoHoursMs → false
        // Mutant (<=) would include it: twoHoursMs <= twoHoursMs → true → result would not be undefined
        expect(result).toBeUndefined();
    });

    test('should return undefined when all tasks are old completed tasks', async () => {
        const now = new Date();
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
        const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
            { name: 'task2.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
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
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should return summary with in_progress tasks', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: 'Fix the bug',
            status:  'in_progress',
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('Working on: Fix the bug');
    });

    test('should return summary with pending tasks count', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
            { name: 'task2.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
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
            logger:              mockLogger,
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
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:       'task1',
            subject:  'Completed task',
            status:   'completed',
            metadata: { completedAt: oneHourAgo.toISOString() },
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
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
            { name: 'task1.json', isFile: () => true } as Dirent,
            { name: 'task2.json', isFile: () => true } as Dirent,
            { name: 'task3.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
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
            logger:              mockLogger,
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
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:       'task1',
            subject:  'Old completed task',
            status:   'completed',
            metadata: { completedAt: threeHoursAgo.toISOString() },
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
    });

    test('should filter out completed tasks without completedAt metadata', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: 'Completed task without timestamp',
            status:  'completed',
            // No metadata field
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should be filtered out - no tasks to show
        expect(result).toBeUndefined();
    });

    test('should skip unparseable JSON files', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
            { name: 'task2.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
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
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('1 pending tasks');
        expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({
            error: expect.any(SyntaxError),
            file:  'task1.json',
            msg:   'Failed to parse task file',
        }));
    });

    test('should skip files with valid JSON but wrong shape', async () => {
        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
            { name: 'task2.json', isFile: () => true } as Dirent,
            { name: 'task3.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
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
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should only process task3 (valid shape)
        expect(result).toBe('1 pending tasks');
    });

    test.each([
        [{ id: 7, subject: 'Invalid id', status: 'pending' }],
        [{ id: 'task', subject: 7, status: 'pending' }],
    ])('rejects a task with a non-string required field', async (invalid) => {
        mockReaddir = mock(() => Promise.resolve([{ name: 'invalid.json', isFile: () => true } as Dirent]));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify(invalid)));
        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });
        expect(await reader.buildTaskListSummary()).toBeUndefined();
    });

    test('joins multiple active subjects with a comma and space', async () => {
        mockReaddir = mock(() => Promise.resolve([
            { name: 'one.json', isFile: () => true } as Dirent,
            { name: 'two.json', isFile: () => true } as Dirent,
        ]));
        mockReadFile = mock((file: string) => Promise.resolve(JSON.stringify({
            id:      file,
            subject: file.endsWith('one.json') ? 'First' : 'Second',
            status:  'in_progress',
        })));
        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });
        expect(await reader.buildTaskListSummary()).toBe('Working on: First, Second');
    });

    test('joins multiple recently completed subjects with a comma and space', async () => {
        mockReaddir = mock(() => Promise.resolve([
            { name: 'one.json', isFile: () => true } as Dirent,
            { name: 'two.json', isFile: () => true } as Dirent,
        ]));
        mockReadFile = mock((file: string) => Promise.resolve(JSON.stringify({
            id:       file,
            subject:  file.endsWith('one.json') ? 'First' : 'Second',
            status:   'completed',
            metadata: { completedAt: new Date().toISOString() },
        })));
        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });
        expect(await reader.buildTaskListSummary()).toBe('Recently done: First, Second');
    });

    test('should limit to top 10 tasks', async () => {
        const mockFiles: Dirent[] = Array.from({ length: 15 }, (_, i) => ({
            name:   `task${i}.json`,
            isFile: () => true,
        } as Dirent));
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:      'task',
            subject: 'Task',
            status:  'pending',
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
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
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: longSubject,
            status:  'in_progress',
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
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
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: exactlyFiftyChars,
            status:  'in_progress',
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
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
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:      'task1',
            subject: fiftyOneChars,
            status:  'in_progress',
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        // Should truncate to 47 + '...' = 50 chars total
        expect(result).toContain('...');
        const truncatedSubject = result!.replace('Working on: ', '');
        expect(truncatedSubject).toBe('12345678901234567890123456789012345678901234567...');
        expect(truncatedSubject).toHaveLength(50);
    });

    test('includes a completed task finished just under two hours ago', async () => {
        const frozenNow = new Date('2026-01-01T12:00:00.000Z');
        setSystemTime(frozenNow);
        // 1ms under the 2-hour cutoff: catches the twoHoursMs literals (2 * 60 * 60 * 1000)
        // being shrunk, since a shrunk threshold would wrongly exclude this task.
        const justUnderTwoHoursAgo = new Date(frozenNow.getTime() - (2 * 60 * 60 * 1000 - 1));

        const mockFiles: Dirent[] = [
            { name: 'task1.json', isFile: () => true } as Dirent,
        ];
        mockReaddir = mock(() => Promise.resolve(mockFiles));
        mockReadFile = mock(() => Promise.resolve(JSON.stringify({
            id:       'task1',
            subject:  'Completed just under cutoff',
            status:   'completed',
            metadata: { completedAt: justUnderTwoHoursAgo.toISOString() },
        })));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBe('Recently done: Completed just under cutoff');
    });

    test('reads up to 8 task files concurrently', async () => {
        const fileCount = 8;
        const mockFiles: Dirent[] = Array.from({ length: fileCount }, (_, i) => ({
            name:   `task${i}.json`,
            isFile: () => true,
        } as Dirent));
        mockReaddir = mock(() => Promise.resolve(mockFiles));

        const resolvers: ((value: string) => void)[] = [];
        mockReadFile = mock(() => new Promise<string>((resolve) => {
            resolvers.push(resolve);
        }));

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const resultPromise = reader.buildTaskListSummary();

        // Give p-limit's microtask chain room to dispatch every initially-admitted read.
        // With concurrency capped below 8, only that many calls would ever appear here,
        // since none of the reads below are resolved yet to free up a queue slot.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(mockReadFile).toHaveBeenCalledTimes(fileCount);

        for(const [i, resolve] of resolvers.entries()) {
            resolve(JSON.stringify({
                id:      `task${i}`,
                subject: `Task ${i}`,
                status:  'pending',
            }));
        }

        const result = await resultPromise;

        expect(result).toBe(`${fileCount} pending tasks`);
    });

    test('should return undefined on error', async () => {
        mockGetCurrentSessionId = mock(() => {
            throw new Error('Unexpected error');
        });

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });

        const result = await reader.buildTaskListSummary();

        expect(result).toBeUndefined();
        expect(mockLogger.debug).toHaveBeenCalledWith({
            error: expect.any(Error),
            msg:   'Failed to build task list summary',
        });
    });

    test('bounds file reads while retaining directory order in the summary', async () => {
        const names = Array.from({ length: 12 }, (_, index) => `task-${String(index).padStart(2, '0')}.json`);
        let active = 0;
        let peak = 0;
        mockReaddir = mock(async () => names.map(name => ({ name, isFile: () => true } as Dirent)));
        mockReadFile = mock(async (filePath: string) => {
            active++;
            peak = Math.max(peak, active);
            await Bun.sleep(2);
            active--;
            const name = nodePath.basename(filePath);
            return JSON.stringify({ id: name, subject: name, status: 'in_progress' });
        });

        const reader = createTaskListReader({
            getCurrentSessionId: mockGetCurrentSessionId,
            logger:              mockLogger,
            readdir:             mockReaddir,
            readFile:            mockReadFile,
        });
        const result = await reader.buildTaskListSummary();

        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(8);
        expect(result).toBe(`Working on: ${names.slice(0, 10).join(', ')}`);
    });
});
