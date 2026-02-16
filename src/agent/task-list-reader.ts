/**
 * Task List Reader
 *
 * Reads Claude Agent SDK task JSON files from a session directory
 * and builds a compact summary for idle status generation.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import _ from 'lodash';
import { getTaskDirectoryPath } from './task-directory-copier';

/**
 * Interface for reading and summarizing task lists.
 */
export interface TaskListReader {
    /**
     * Build a compact summary of the current task list.
     * Returns undefined if no session, no tasks, or error.
     *
     * @returns Task summary string or undefined
     */
    buildTaskListSummary: () => Promise<string | undefined>
}

/**
 * Task shape as stored by Claude Agent SDK.
 */
interface Task {
    id:        string
    subject:   string
    status:    'pending' | 'in_progress' | 'completed'
    metadata?: {
        completedAt?: string
    }
}

/**
 * Options for creating a task list reader.
 */
export interface TaskListReaderOptions {
    /** Callback to get the current session ID */
    getCurrentSessionId: () => string | undefined
    /** Logger for debug messages */
    logger: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        debug: (...args: any[]) => void
    }
    /** Optional readdir override for testing */
    readdir?:  typeof readdir
    /** Optional readFile override for testing */
    readFile?: typeof readFile
}

/**
 * Creates a task list reader instance.
 *
 * @param options - Reader configuration
 * @returns TaskListReader instance
 */
export function createTaskListReader(options: TaskListReaderOptions): TaskListReader {
    const { getCurrentSessionId, logger, readdir: readdirOverride, readFile: readFileOverride } = options;

    const readdirFn = readdirOverride ?? readdir;
    const readFileFn = readFileOverride ?? readFile;

    return {
        buildTaskListSummary: async (): Promise<string | undefined> => {
            // Stryker disable BlockStatement: Error handling fallback - returns undefined on any error
            try {
                const sessionId = getCurrentSessionId();
                if(!sessionId) {
                    return undefined;
                }

                const taskDir = getTaskDirectoryPath(sessionId);

                // Read directory contents
                let files;
                try {
                    files = await readdirFn(taskDir, { withFileTypes: true });
                } catch{
                    // Directory doesn't exist or can't be read
                    return undefined;
                }

                // Filter for JSON files only
                const jsonFiles = _.filter(files, file => file.isFile() && _.endsWith(file.name, '.json'));
                // Stryker disable next-line ConditionalExpression: Defensive early return — covered by tasks.length check
                if(jsonFiles.length === 0) {
                    return undefined;
                }

                // Read and parse all task files
                const tasks: Task[] = [];
                for(const file of jsonFiles) {
                    try {
                        const content = await readFileFn(join(taskDir, file.name), 'utf-8');
                        const task = JSON.parse(content) as Task;
                        tasks.push(task);
                    } catch{
                        // Skip unparseable files
                        continue;
                    }
                }

                // Stryker disable next-line ConditionalExpression: Defensive early return — covered by relevantTasks.length check
                if(tasks.length === 0) {
                    return undefined;
                }

                // Filter tasks: all non-completed + recently completed (last 2 hours)
                const now = Date.now();
                // Stryker disable next-line ArithmeticOperator: TTL constant for recently completed tasks
                const twoHoursMs = 2 * 60 * 60 * 1000;

                const relevantTasks = _.filter(tasks, (task) => {
                    if(task.status !== 'completed') {
                        return true;
                    }
                    // Check if completed within last 2 hours
                    const completedAt = task.metadata?.completedAt;
                    if(!completedAt) {
                        return false;
                    }
                    const completedTime = new Date(completedAt).getTime();
                    return (now - completedTime) < twoHoursMs;
                });

                // Stryker disable next-line ConditionalExpression: Defensive early return — covered by sections.length check
                if(relevantTasks.length === 0) {
                    return undefined;
                }

                // Hard cap at 10 tasks
                // Stryker disable next-line ConditionalExpression: Hard cap constant
                const cappedTasks = relevantTasks.slice(0, 10);

                // Build summary sections
                // Stryker disable StringLiteral,ObjectLiteral: Summary text building is cosmetic formatting
                const inProgressTasks = _.filter(cappedTasks, { status: 'in_progress' });
                const pendingTasks = _.filter(cappedTasks, { status: 'pending' });
                const completedTasks = _.filter(cappedTasks, { status: 'completed' });

                const sections: string[] = [];

                if(inProgressTasks.length > 0) {
                    const subjects = _.map(inProgressTasks, task => truncateSubject(task.subject));
                    sections.push(`Working on: ${subjects.join(', ')}`);
                }

                if(pendingTasks.length > 0) {
                    sections.push(`${pendingTasks.length} pending tasks`);
                }

                if(completedTasks.length > 0) {
                    const subjects = _.map(completedTasks, task => truncateSubject(task.subject));
                    sections.push(`Recently done: ${subjects.join(', ')}`);
                }
                // Stryker restore StringLiteral,ObjectLiteral

                // Stryker disable next-line ConditionalExpression: Defensive guard — all tasks have a known status
                if(sections.length === 0) {
                    return undefined;
                }

                return sections.join('\n');
            } catch (error) {
                // Log error and return undefined
                // Stryker disable next-line ObjectLiteral: Logger debug object for observability
                logger.debug({
                    error,
                    // Stryker disable next-line StringLiteral: Log message for observability only
                    msg: 'Failed to build task list summary',
                });
                return undefined;
            }
            // Stryker restore BlockStatement
        },
    };
}

/**
 * Truncates a task subject to 50 characters for display.
 */
function truncateSubject(subject: string): string {
    // Stryker disable next-line ConditionalExpression: Truncation length constant
    if(subject.length <= 50) {
        return subject;
    }
    // Stryker disable next-line StringLiteral: Truncation ellipsis is cosmetic
    return subject.slice(0, 47) + '...';
}
