/**
 * Tests for task cleanup processor
 *
 * The task cleanup processor handles cleaning up old completed tasks during
 * session migration. It evaluates which tasks can be safely deleted based on:
 * - Task status (only completed tasks are candidates)
 * - Age (retention period, default 1 day)
 * - Dependencies (tasks that block active tasks must be retained)
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { homedir } from 'node:os';
import path from 'node:path';
import { type logger } from '@hughescr/logger';
import { mockLogger } from '../../setup';
import { createTaskCleanupProcessor, getTaskDirectoryPath, type TaskCleanupDeps } from '@/agent/task-cleanup-processor';
import type { SessionId } from '@/storage/task-session/types';

// Create local mocks for fs operations
const mockReaddir = mock((_path: string) => Promise.resolve([] as string[]));
const mockReadFile = mock((_path: string, _encoding?: string) => Promise.resolve(''));
const mockWriteFile = mock((_path: string, _content: string) => Promise.resolve());
const mockStat = mock((_path: string) => Promise.resolve({ mtime: new Date(), isDirectory: () => false, isFile: () => true }));
const mockMkdir = mock((_path: string, _options?: object) => Promise.resolve());

// Create a deps object that can be used in tests with proper type cast
const createTestDeps = (now: () => number): TaskCleanupDeps => ({
    readdir:   mockReaddir as unknown as TaskCleanupDeps['readdir'],
    readFile:  mockReadFile as unknown as TaskCleanupDeps['readFile'],
    writeFile: mockWriteFile as unknown as TaskCleanupDeps['writeFile'],
    stat:      mockStat as unknown as TaskCleanupDeps['stat'],
    mkdir:     mockMkdir as unknown as TaskCleanupDeps['mkdir'],
    now,
});

// Helper to create SessionId (bypassing Zod validation in tests)
const sessionId = (id: string): SessionId => id as SessionId;

// Helper to create task JSON
interface TaskJson {
    id:          string
    subject:     string
    description: string
    status:      'pending' | 'in_progress' | 'completed'
    blocks:      string[]
    blockedBy:   string[]
    metadata?: {
        completedAt?:  string
        [key: string]: unknown
    }
}

const createTask = (overrides: Partial<TaskJson>): TaskJson => ({
    id:          '1',
    subject:     'Test task',
    description: 'Test description',
    status:      'completed',
    blocks:      [],
    blockedBy:   [],
    metadata:    {},
    ...overrides,
});

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

        // Should be in .claude/tasks/ directory
        expect(result).toContain('.claude/tasks/');
    });

    test('should match expected path format', () => {
        const testSessionId = 'my-session';
        const result = getTaskDirectoryPath(testSessionId);

        // SDK stores tasks at ~/.claude/tasks/{sessionId}/
        const expectedPath = path.join(homedir(), '.claude', 'tasks', testSessionId);

        expect(result).toBe(expectedPath);
    });
});

describe('processTaskDirectory', () => {
    // Use a fixed timestamp for deterministic tests
    const NOW = new Date('2025-01-29T00:00:00.000Z').getTime();
    const ONE_DAY_AGO = new Date('2025-01-28T00:00:00.000Z').toISOString();
    const TWO_DAYS_AGO = new Date('2025-01-27T00:00:00.000Z').toISOString();
    const TWELVE_HOURS_AGO = new Date('2025-01-28T12:00:00.000Z').toISOString();

    beforeEach(() => {
        // Reset all mocks
        mockLogger.debug.mockClear();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockReaddir.mockClear();
        mockReadFile.mockClear();
        mockWriteFile.mockClear();
        mockStat.mockClear();
        mockMkdir.mockClear();
    });

    describe('Basic Deletion', () => {
        test('should delete old completed task (>1 day old)', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Create old completed task
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be deleted (not copied)
            expect(result.deleted).toBe(1);
            expect(result.copied).toBe(0);
            expect(result.errors).toBe(0);
            expect(mockWriteFile).not.toHaveBeenCalled();
        });

        test('should retain pending task', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');
            const destDir = getTaskDirectoryPath(newSessionId);

            // Create pending task
            const task1 = createTask({
                id:     '1',
                status: 'pending',
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be retained
            expect(result.copied).toBe(1);
            expect(result.deleted).toBe(0);
            expect(result.errors).toBe(0);
            expect(mockWriteFile).toHaveBeenCalledWith(
                path.join(destDir, '1.json'),
                JSON.stringify(task1, null, 2)
            );
        });

        test('should retain in_progress task', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');
            const destDir = getTaskDirectoryPath(newSessionId);

            // Create in_progress task
            const task1 = createTask({
                id:     '1',
                status: 'in_progress',
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be retained
            expect(result.copied).toBe(1);
            expect(result.deleted).toBe(0);
            expect(mockWriteFile).toHaveBeenCalledWith(
                path.join(destDir, '1.json'),
                JSON.stringify(task1, null, 2)
            );
        });

        test('should retain recently completed task (<1 day old)', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');
            const destDir = getTaskDirectoryPath(newSessionId);

            // Create recently completed task
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWELVE_HOURS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be retained (within 1 day)
            expect(result.copied).toBe(1);
            expect(result.deleted).toBe(0);
            expect(mockWriteFile).toHaveBeenCalledWith(
                path.join(destDir, '1.json'),
                JSON.stringify(task1, null, 2)
            );
        });

        test('should retain task exactly at 1 day boundary', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Create task completed exactly 1 day ago
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: ONE_DAY_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task at exactly 1 day should be retained (< not <=)
            expect(result.copied).toBe(1);
            expect(result.deleted).toBe(0);
        });
    });

    describe('Dependency Blocking (task.blocks)', () => {
        test('should retain completed task that blocks active task', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Task 1 blocks task 2
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                blocks:   ['2'],
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            const task2 = createTask({
                id:        '2',
                status:    'pending',
                blockedBy: ['1'],
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                if(filePath.includes('2.json')) {
                    return JSON.stringify(task2);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Both tasks should be retained (task 1 blocks active task 2)
            expect(result.copied).toBe(2);
            expect(result.deleted).toBe(0);
        });

        test('should delete completed task that only blocks deletable tasks', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Task 1 blocks task 2, both old and completed
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                blocks:   ['2'],
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            const task2 = createTask({
                id:        '2',
                status:    'completed',
                blockedBy: ['1'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                if(filePath.includes('2.json')) {
                    return JSON.stringify(task2);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Both tasks should be deleted
            expect(result.copied).toBe(0);
            expect(result.deleted).toBe(2);
        });

        test('should handle transitive blocking: A blocks B blocks C (C active) - all retained', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // A blocks B, B blocks C, C is pending
            const taskA = createTask({
                id:       'A',
                status:   'completed',
                blocks:   ['B'],
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            const taskB = createTask({
                id:        'B',
                status:    'completed',
                blocks:    ['C'],
                blockedBy: ['A'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            const taskC = createTask({
                id:        'C',
                status:    'pending',
                blockedBy: ['B'],
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['A.json', 'B.json', 'C.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('A.json')) {
                    return JSON.stringify(taskA);
                }
                if(filePath.includes('B.json')) {
                    return JSON.stringify(taskB);
                }
                if(filePath.includes('C.json')) {
                    return JSON.stringify(taskC);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // All tasks should be retained (transitive blocking)
            expect(result.copied).toBe(3);
            expect(result.deleted).toBe(0);
        });

        test('should handle transitive deletion: A blocks B blocks C (C deletable) - all deleted', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // A blocks B, B blocks C, all old and completed
            const taskA = createTask({
                id:       'A',
                status:   'completed',
                blocks:   ['B'],
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            const taskB = createTask({
                id:        'B',
                status:    'completed',
                blocks:    ['C'],
                blockedBy: ['A'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            const taskC = createTask({
                id:        'C',
                status:    'completed',
                blockedBy: ['B'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['A.json', 'B.json', 'C.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('A.json')) {
                    return JSON.stringify(taskA);
                }
                if(filePath.includes('B.json')) {
                    return JSON.stringify(taskB);
                }
                if(filePath.includes('C.json')) {
                    return JSON.stringify(taskC);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // All tasks should be deleted
            expect(result.copied).toBe(0);
            expect(result.deleted).toBe(3);
        });
    });

    describe('Circular Dependencies', () => {
        test('should retain all tasks in a circular dependency cycle', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // A blocks B, B blocks A (circular)
            const taskA = createTask({
                id:        'A',
                status:    'completed',
                blocks:    ['B'],
                blockedBy: ['B'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            const taskB = createTask({
                id:        'B',
                status:    'completed',
                blocks:    ['A'],
                blockedBy: ['A'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['A.json', 'B.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('A.json')) {
                    return JSON.stringify(taskA);
                }
                if(filePath.includes('B.json')) {
                    return JSON.stringify(taskB);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Both tasks should be retained (circular dependency protection)
            expect(result.copied).toBe(2);
            expect(result.deleted).toBe(0);
        });

        test('should handle three-way circular dependency', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // A blocks B, B blocks C, C blocks A (3-way circular)
            const taskA = createTask({
                id:        'A',
                status:    'completed',
                blocks:    ['B'],
                blockedBy: ['C'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            const taskB = createTask({
                id:        'B',
                status:    'completed',
                blocks:    ['C'],
                blockedBy: ['A'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            const taskC = createTask({
                id:        'C',
                status:    'completed',
                blocks:    ['A'],
                blockedBy: ['B'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['A.json', 'B.json', 'C.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('A.json')) {
                    return JSON.stringify(taskA);
                }
                if(filePath.includes('B.json')) {
                    return JSON.stringify(taskB);
                }
                if(filePath.includes('C.json')) {
                    return JSON.stringify(taskC);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // All tasks should be retained (circular dependency protection)
            expect(result.copied).toBe(3);
            expect(result.deleted).toBe(0);
        });
    });

    describe('Edge Cases', () => {
        test('should ignore dangling reference and allow deletion', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Task 1 blocks non-existent task 999
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                blocks:   ['999'],
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be deleted (dangling reference ignored)
            expect(result.copied).toBe(0);
            expect(result.deleted).toBe(1);
        });

        test('should handle JSON parse error on one task and continue with others', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                if(filePath.includes('2.json')) {
                    return 'invalid json{{{';
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task 1 processed, task 2 error logged
            expect(result.deleted).toBe(1);
            expect(result.errors).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskFile: '2.json',
                    msg:      expect.stringContaining('Failed to process task'),
                })
            );
        });

        test('should handle schema validation failure on one task and continue with others', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks - task2.json is valid JSON but missing required fields (id, status, etc.)
            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                if(filePath.includes('2.json')) {
                    // Valid JSON but wrong schema: status has invalid value
                    return JSON.stringify({ id: '2', status: 'invalid_status', subject: 'x', description: 'y', blocks: [], blockedBy: [] });
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task 1 processed, task 2 error logged (schema failure)
            expect(result.deleted).toBe(1);
            expect(result.errors).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskFile: '2.json',
                    msg:      expect.stringContaining('Invalid task schema'),
                })
            );
        });

        test('should handle empty directory', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Setup mocks - empty directory
            mockReaddir.mockResolvedValue([]);
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // No tasks to process
            expect(result.copied).toBe(0);
            expect(result.deleted).toBe(0);
            expect(result.errors).toBe(0);
        });

        test('should add completedAt from file mtime when missing', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Completed task without completedAt
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: {},
            });

            const fileStats = {
                isDirectory: () => false,
                isFile:      () => true,
                mtime:       new Date(TWO_DAYS_AGO),
            };

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockStat.mockResolvedValue(fileStats as { mtime: Date, isDirectory: () => false, isFile: () => true });
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be retained (just completed, added timestamp)
            expect(result.copied).toBe(1);
            expect(result.deleted).toBe(0);

            // Verify completedAt was added
            const writeCall = mockWriteFile.mock.calls[0];
            const writtenTask = JSON.parse(writeCall[1]);
            expect(writtenTask.metadata.completedAt).toBe(TWO_DAYS_AGO);
        });

        test('should preserve existing completedAt', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWELVE_HOURS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be retained
            expect(result.copied).toBe(1);

            // Verify completedAt was preserved
            const writeCall = mockWriteFile.mock.calls[0];
            const writtenTask = JSON.parse(writeCall[1]);
            expect(writtenTask.metadata.completedAt).toBe(TWELVE_HOURS_AGO);
        });

        test('should filter out non-JSON files', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks - directory contains .json and other files
            mockReaddir.mockResolvedValue(['1.json', '.DS_Store', 'readme.txt', '2.json.bak']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                throw new Error('Should not read non-JSON files');
            });
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Only 1.json should be processed
            expect(result.deleted).toBe(1);
            expect(result.errors).toBe(0);
        });
    });

    describe('Filesystem Operations', () => {
        test('should create destination directory', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');
            const destDir = getTaskDirectoryPath(newSessionId);

            const task1 = createTask({
                id:       '1',
                status:   'pending',
                metadata: {},
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Verify mkdir was called with recursive option
            expect(mockMkdir).toHaveBeenCalledWith(destDir, { recursive: true });
        });

        test('should write retained tasks to destination', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');
            const destDir = getTaskDirectoryPath(newSessionId);

            const task1 = createTask({
                id:     '1',
                status: 'pending',
            });

            const task2 = createTask({
                id:     '2',
                status: 'in_progress',
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                if(filePath.includes('2.json')) {
                    return JSON.stringify(task2);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Both tasks should be written
            expect(mockWriteFile).toHaveBeenCalledTimes(2);
            expect(mockWriteFile).toHaveBeenCalledWith(
                path.join(destDir, '1.json'),
                JSON.stringify(task1, null, 2)
            );
            expect(mockWriteFile).toHaveBeenCalledWith(
                path.join(destDir, '2.json'),
                JSON.stringify(task2, null, 2)
            );
        });

        test('should not write deleted tasks', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be deleted, not written
            expect(mockWriteFile).not.toHaveBeenCalled();
        });

        test('should handle writeFile error gracefully', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:     '1',
                status: 'pending',
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockRejectedValue(new Error('Disk full'));

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Should log error and continue
            expect(result.errors).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: '1',
                    msg:    expect.stringContaining('Failed to write task'),
                })
            );
        });

        test('should handle readFile throwing an unexpected error and count it as an error', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                // Simulate an unexpected I/O error (not a parse error) — triggers catch block
                throw new Error('ENOENT: no such file or directory');
            });
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task 1 deleted (old completed), task 2 failed with I/O error
            expect(result.errors).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskFile: '2.json',
                    msg:      'Failed to process task file',
                })
            );
        });

        test('should count only fulfilled writes as copied when some writeFile calls fail (allSettled filter)', async () => {
            // This test kills the `writeResults.filter(r => r.status === 'fulfilled').length`
            // mutant: with two tasks to retain and one failing, copied must be 1 not 2.
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({ id: '1', status: 'pending' });
            const task2 = createTask({ id: '2', status: 'pending' });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                if(filePath.includes('2.json')) {
                    return JSON.stringify(task2);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);
            // task1 writes successfully, task2 fails
            let writeCallCount = 0;
            mockWriteFile.mockImplementation(async () => {
                writeCallCount++;
                if(writeCallCount === 2) {
                    throw new Error('Write failed for task 2');
                }
                return undefined;
            });

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Only 1 succeeded (task1), 1 failed (task2)
            expect(result.copied).toBe(1);
            expect(result.errors).toBe(1);
        });
    });

    describe('Custom Retention Period', () => {
        test('should respect custom retention period', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Task completed 8 days ago
            const EIGHT_DAYS_AGO = new Date('2025-01-21T00:00:00.000Z').toISOString();
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: EIGHT_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);

            // Use 7-day retention instead of default 14
            const processor = createTaskCleanupProcessor({
                logger:        mockLogger as unknown as typeof logger,
                retentionDays: 7,
                deps:          createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be deleted (8 days > 7 day retention)
            expect(result.copied).toBe(0);
            expect(result.deleted).toBe(1);
        });

        test('should retain task within custom retention period', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Task completed 8 days ago
            const EIGHT_DAYS_AGO = new Date('2025-01-21T00:00:00.000Z').toISOString();
            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: EIGHT_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            // Use 30-day retention
            const processor = createTaskCleanupProcessor({
                logger:        mockLogger as unknown as typeof logger,
                retentionDays: 30,
                deps:          createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Task should be retained (8 days < 30 day retention)
            expect(result.copied).toBe(1);
            expect(result.deleted).toBe(0);
        });
    });

    describe('Logging', () => {
        test('should log summary info on completion', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:     '1',
                status: 'pending',
            });

            const task2 = createTask({
                id:       '2',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json', '2.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('1.json')) {
                    return JSON.stringify(task1);
                }
                if(filePath.includes('2.json')) {
                    return JSON.stringify(task2);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Should log summary
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    previousSessionId,
                    newSessionId,
                    copied:  1,
                    deleted: 1,
                    errors:  0,
                    msg:     expect.stringContaining('Task cleanup completed'),
                })
            );
        });

        test('should log debug when task is retained', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:     '1',
                status: 'pending',
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Should log debug for retained task
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: '1',
                    reason: expect.any(String),
                    msg:    expect.stringContaining('Retaining task'),
                })
            );
        });

        test('should log debug when task is deleted', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            const task1 = createTask({
                id:       '1',
                status:   'completed',
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['1.json']);
            mockReadFile.mockResolvedValue(JSON.stringify(task1));
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            await processor.processTaskDirectory(previousSessionId, newSessionId);

            // Should log debug for deleted task
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: '1',
                    msg:    expect.stringContaining('Deleting task'),
                })
            );
        });
    });

    describe('Memoization', () => {
        test('should not re-evaluate tasks multiple times', async () => {
            const previousSessionId = sessionId('old-session');
            const newSessionId = sessionId('new-session');

            // Diamond dependency: A blocks B and C, both B and C block D
            const taskA = createTask({
                id:       'A',
                status:   'completed',
                blocks:   ['B', 'C'],
                metadata: { completedAt: TWO_DAYS_AGO },
            });

            const taskB = createTask({
                id:        'B',
                status:    'completed',
                blocks:    ['D'],
                blockedBy: ['A'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            const taskC = createTask({
                id:        'C',
                status:    'completed',
                blocks:    ['D'],
                blockedBy: ['A'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            const taskD = createTask({
                id:        'D',
                status:    'completed',
                blockedBy: ['B', 'C'],
                metadata:  { completedAt: TWO_DAYS_AGO },
            });

            // Setup mocks
            mockReaddir.mockResolvedValue(['A.json', 'B.json', 'C.json', 'D.json']);
            mockReadFile.mockImplementation(async (filePath: string) => {
                if(filePath.includes('A.json')) {
                    return JSON.stringify(taskA);
                }
                if(filePath.includes('B.json')) {
                    return JSON.stringify(taskB);
                }
                if(filePath.includes('C.json')) {
                    return JSON.stringify(taskC);
                }
                if(filePath.includes('D.json')) {
                    return JSON.stringify(taskD);
                }
                throw new Error('Unexpected file');
            });
            mockMkdir.mockResolvedValue(undefined);

            const processor = createTaskCleanupProcessor({
                logger: mockLogger as unknown as typeof logger,
                deps:   createTestDeps(() => NOW),
            });

            const result = await processor.processTaskDirectory(previousSessionId, newSessionId);

            // All tasks should be deleted
            expect(result.deleted).toBe(4);

            // With memoization, should evaluate each task only once
            // Without memoization, D would be evaluated twice (via B and C)
            // We can verify this by checking debug logs
            const debugCalls = mockLogger.debug.mock.calls;
            const taskDCalls = debugCalls.filter((call: unknown[]) => {
                const arg = call[0] as { taskId?: string };
                return arg.taskId === 'D';
            });

            // Should only evaluate D once due to memoization
            expect(taskDCalls.length).toBe(1);
        });
    });
});
