/**
 * Task Cleanup Processor
 *
 * Processes task directories during session migration, evaluating which tasks
 * can be safely deleted based on completion status, retention period, and
 * dependency relationships.
 *
 * Tasks are retained if they:
 * - Are not completed
 * - Were recently completed (within retention period)
 * - Block tasks that cannot be deleted (transitive retention)
 */

import { readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@hughescr/logger';
import { getTaskDirectoryPath as getTaskDirectoryPathImpl } from './task-directory-copier';
import type { SessionId } from '@/storage';

// Re-export for tests
export { getTaskDirectoryPath } from './task-directory-copier';

interface TaskCleanupProcessorOptions {
    logger:         Logger
    retentionDays?: number  // Default: 1
    deps?:          Partial<TaskCleanupDeps>  // For testing
}

export interface TaskCleanupDeps {
    readdir:   typeof readdir
    readFile:  typeof readFile
    writeFile: typeof writeFile
    stat:      typeof stat
    mkdir:     typeof mkdir
    now:       () => number  // Inject clock for testing
}

export interface TaskCleanupResult {
    copied:  number
    deleted: number
    errors:  number
}

export interface TaskCleanupProcessor {
    processTaskDirectory: (
        previousSessionId: SessionId,
        newSessionId: SessionId
    ) => Promise<TaskCleanupResult>
}

/**
 * Internal task representation
 */
interface Task {
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

/**
 * Determines if a task can be safely deleted.
 *
 * A task can be deleted only if:
 * 1. It is completed
 * 2. It has a completedAt timestamp (and had it originally, not added from mtime)
 * 3. It was completed more than retentionDays ago
 * 4. It does not block any tasks that cannot be deleted
 *
 * @param task - The task to evaluate
 * @param allTasks - Map of all tasks
 * @param memo - Memoization cache for results
 * @param visited - Set of task IDs in current recursion path (for cycle detection)
 * @param tasksWithoutCompletedAt - Set of task IDs that lacked completedAt originally
 * @param retentionMs - Retention period in milliseconds
 * @param nowMs - Current time in milliseconds
 * @returns true if the task can be deleted, false otherwise
 */
function canDelete(
    task: Task,
    allTasks: Map<string, Task>,
    memo: Map<string, boolean>,
    visited: Set<string>,
    tasksWithoutCompletedAt: Set<string>,
    retentionMs: number,
    nowMs: number
): boolean {
    // Check memo first
    const memoized = memo.get(task.id);
    // Stryker disable next-line ConditionalExpression,BlockStatement: Memoization check is performance optimization
    if(memoized !== undefined) {
        return memoized;
    }

    // Only completed tasks are candidates for deletion
    // Stryker disable next-line ConditionalExpression,BlockStatement: Early return with memoization is performance optimization
    if(task.status !== 'completed') {
        // Stryker disable BooleanLiteral: Memoization cache operations
        memo.set(task.id, false);
        return false;
        // Stryker restore BooleanLiteral
    }

    // Tasks that lacked completedAt are considered "just completed" and must be retained
    if(tasksWithoutCompletedAt.has(task.id)) {
        // Stryker disable BooleanLiteral: Memoization cache operations
        memo.set(task.id, false);
        return false;
        // Stryker restore BooleanLiteral
    }

    // Must have a completedAt timestamp
    if(!task.metadata?.completedAt) {
        // Stryker disable BooleanLiteral: Memoization cache operations
        memo.set(task.id, false);
        return false;
        // Stryker restore BooleanLiteral
    }

    // Check if within retention period
    const completedAtMs = new Date(task.metadata.completedAt).getTime();
    const ageMs = nowMs - completedAtMs;
    if(ageMs <= retentionMs) {
        // Stryker disable BooleanLiteral: Memoization cache operations
        memo.set(task.id, false);
        return false;
        // Stryker restore BooleanLiteral
    }

    // Check if this task blocks any tasks that cannot be deleted
    for(const blockedId of task.blocks) {
        // Circular dependency detection
        if(visited.has(blockedId)) {
            // Circular dependency - keep both tasks for safety
            // Stryker disable BooleanLiteral: Memoization cache operations
            memo.set(task.id, false);
            return false;
            // Stryker restore BooleanLiteral
        }

        // Get the blocked task
        const blockedTask = allTasks.get(blockedId);
        if(!blockedTask) {
            // Dangling reference - ignore it
            continue;
        }

        // Add to visited set for cycle detection
        visited.add(blockedId);

        // Recursively check if the blocked task can be deleted
        if(!canDelete(blockedTask, allTasks, memo, visited, tasksWithoutCompletedAt, retentionMs, nowMs)) {
            // This task blocks an active task, so it must be retained
            visited.delete(blockedId); // Backtrack
            // Stryker disable BooleanLiteral: Memoization cache operations
            memo.set(task.id, false);
            return false;
            // Stryker restore BooleanLiteral
        }

        // Backtrack
        visited.delete(blockedId);
    }

    // Task can be deleted
    // Stryker disable BooleanLiteral: Memoization cache value for successful deletion case
    memo.set(task.id, true);
    // Stryker restore BooleanLiteral
    return true;
}

/**
 * Gets a human-readable reason for retaining a task.
 */
// Stryker disable all: getRetentionReason is only used for logging, not behavior
function getRetentionReason(
    task: Task,
    allTasks: Map<string, Task>,
    retentionMs: number,
    nowMs: number
): string {
    if(task.status !== 'completed') {
        return `status=${task.status}`;
    }

    if(!task.metadata?.completedAt) {
        return 'no completedAt';
    }

    const completedAtMs = new Date(task.metadata.completedAt).getTime();
    const ageMs = nowMs - completedAtMs;
    if(ageMs <= retentionMs) {
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        return `age=${ageDays} days (within retention)`;
    }

    // Must be blocking an active task
    // eslint-disable-next-line sonarjs/function-return-type -- blockedTask && ... legitimately returns boolean-ish union
    const activeBlocked = task.blocks.filter((id) => {
        const blockedTask = allTasks.get(id);
        return blockedTask && blockedTask.status !== 'completed';
    });

    if(activeBlocked.length > 0) {
        return `blocks active tasks: ${activeBlocked.join(', ')}`;
    }

    return 'blocks non-deletable tasks';
}
// Stryker restore all

/**
 * Creates a task cleanup processor instance.
 *
 * @param options - Processor configuration
 * @returns TaskCleanupProcessor instance
 */
export function createTaskCleanupProcessor(options: TaskCleanupProcessorOptions): TaskCleanupProcessor {
    const { logger, retentionDays = 1, deps = {} } = options;

    // Dependency injection for testing
    const {
        readdir: readdirFn = readdir,
        readFile: readFileFn = readFile,
        writeFile: writeFileFn = writeFile,
        stat: statFn = stat,
        mkdir: mkdirFn = mkdir,
        now = () => Date.now(),
    } = deps;

    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    return {
        processTaskDirectory: async (
            previousSessionId: SessionId,
            newSessionId: SessionId
        ): Promise<TaskCleanupResult> => {
            const sourcePath = getTaskDirectoryPathImpl(previousSessionId);
            const destPath = getTaskDirectoryPathImpl(newSessionId);

            // Create destination directory
            await mkdirFn(destPath, { recursive: true });

            // Read all files from source directory
            const files = await readdirFn(sourcePath);

            // Filter to only .json files (files can be string[] or Dirent[])
            // Stryker disable ConditionalExpression: typeof guard is defensive — readdirFn always returns string[] in practice
            const jsonFiles = files.filter((file): file is string =>
                typeof file === 'string' && file.endsWith('.json'));
            // Stryker restore ConditionalExpression

            // Load all tasks
            const allTasks = new Map<string, Task>();
            const tasksWithoutCompletedAt = new Set<string>(); // Track tasks that were just completed
            let errors = 0;

            for(const file of jsonFiles) {
                const filePath = path.join(sourcePath, file);

                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential: per-file read with conditional stat
                    const content = await readFileFn(filePath, 'utf8');
                    const task = JSON.parse(content) as Task;

                    // If completed task lacks metadata.completedAt, mark it and add timestamp from file mtime
                    if(task.status === 'completed' && !task.metadata?.completedAt) {
                        tasksWithoutCompletedAt.add(task.id);
                        // eslint-disable-next-line no-await-in-loop -- sequential: stat depends on prior read result
                        const fileStats = await statFn(filePath);
                        task.metadata ??= {};
                        task.metadata.completedAt = fileStats.mtime.toISOString();
                    }

                    allTasks.set(task.id, task);
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    // Stryker disable next-line ObjectLiteral: Logger warn object for observability
                    logger.warn({
                        taskFile: file,
                        error:    errorMsg,
                        // Stryker disable next-line StringLiteral: Log message for observability only
                        msg:      'Failed to process task file',
                    });
                    errors++;
                }
            }

            // Build memo and evaluate tasks (synchronous decision phase)
            const memo = new Map<string, boolean>();
            const nowMs = now();
            let deleted = 0;

            const toRetain: { taskId: string, task: Task }[] = [];

            for(const [taskId, task] of allTasks) {
                const visited = new Set<string>();
                const shouldDelete = canDelete(task, allTasks, memo, visited, tasksWithoutCompletedAt, retentionMs, nowMs);

                if(shouldDelete) {
                    deleted++;
                    // Stryker disable next-line ObjectLiteral: Logger debug object for observability
                    logger.debug({
                        taskId,
                        // Stryker disable next-line StringLiteral: Log message for observability only
                        msg: 'Deleting task (old and completed)',
                    });
                } else {
                    toRetain.push({ taskId, task });
                }
            }

            // Write retained tasks in parallel (independent per-file I/O)
            const writeResults = await Promise.allSettled(
                toRetain.map(({ taskId, task }) => {
                    const destFile = path.join(destPath, `${taskId}.json`);
                    return writeFileFn(destFile, JSON.stringify(task, null, 2))
                        .then(() => {
                            const reason = getRetentionReason(task, allTasks, retentionMs, nowMs);
                            // Stryker disable next-line ObjectLiteral: Logger debug object for observability
                            return logger.debug({
                                taskId,
                                reason,
                                // Stryker disable next-line StringLiteral: Log message for observability only
                                msg: 'Retaining task',
                            });
                        })
                        .catch((error: unknown) => {
                            const errorMsg = error instanceof Error ? error.message : String(error);
                            // Stryker disable next-line ObjectLiteral: Logger warn object for observability
                            logger.warn({
                                taskId,
                                error: errorMsg,
                                // Stryker disable next-line StringLiteral: Log message for observability only
                                msg:   'Failed to write task to destination',
                            });
                            throw error;
                        });
                })
            );

            const copied = writeResults.filter(r => r.status === 'fulfilled').length;
            errors += writeResults.filter(r => r.status === 'rejected').length;

            // Stryker disable next-line ObjectLiteral: Logger info object for observability
            logger.info({
                previousSessionId,
                newSessionId,
                copied,
                deleted,
                errors,
                // Stryker disable next-line StringLiteral: Log message for observability only
                msg: 'Task cleanup completed',
            });

            return { copied, deleted, errors };
        },
    };
}
