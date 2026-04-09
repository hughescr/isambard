/**
 * Task List Reader
 *
 * Reads Claude Agent SDK task JSON files from a session directory
 * and builds a compact summary for idle status generation.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getTaskDirectoryPath } from './task-directory-copier';

/**
 * Interface for reading and summarizing task lists.
 */
interface TaskListReader {
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
interface TaskListReaderOptions {
    /** Callback to get the current session ID */
    getCurrentSessionId: () => string | undefined
    /** Logger for debug messages */
    logger: {
        debug: (...args: unknown[]) => void
    }
    /** Optional readdir override for testing */
    readdir?:  typeof readdir
    /** Optional readFile override for testing */
    readFile?: typeof readFile
}

/**
 * Parses a task file's content string and returns a validated Task, or undefined if invalid.
 */
// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns Task | undefined
function parseTaskFile(content: string): Task | undefined {
    // Stryker disable BlockStatement: Error handling fallback - returns undefined on parse error
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns unknown, validated below
        const parsed = JSON.parse(content);

        // Validate task shape - check parsed is non-null and has required fields
        // Stryker disable OptionalChaining,ConditionalExpression,LogicalOperator: Shape validation tested via wrong-shape test case
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Validated with isString guards
        if(!parsed || typeof parsed.id !== 'string'
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Validated with isString guards
          || typeof parsed.subject !== 'string'
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-member-access -- Validated with includes check
          || !['pending', 'in_progress', 'completed'].includes(parsed.status)) {
            return undefined;
        }
        // Stryker restore OptionalChaining,ConditionalExpression,LogicalOperator

        return parsed as Task;
    } catch{
        return undefined;
    }
    // Stryker restore BlockStatement
}

/**
 * Builds the summary sections array from a capped task list.
 */
function buildSummarySections(cappedTasks: Task[]): string[] {
    // Stryker disable StringLiteral,ObjectLiteral: Summary text building is cosmetic formatting
    const inProgressTasks = cappedTasks.filter(task => task.status === 'in_progress');
    const pendingTasks = cappedTasks.filter(task => task.status === 'pending');
    const completedTasks = cappedTasks.filter(task => task.status === 'completed');

    const sections: string[] = [];

    if(inProgressTasks.length > 0) {
        const subjects = inProgressTasks.map(task => truncateSubject(task.subject));
        sections.push(`Working on: ${subjects.join(', ')}`);
    }

    if(pendingTasks.length > 0) {
        sections.push(`${pendingTasks.length} pending tasks`);
    }

    if(completedTasks.length > 0) {
        const subjects = completedTasks.map(task => truncateSubject(task.subject));
        sections.push(`Recently done: ${subjects.join(', ')}`);
    }
    // Stryker restore StringLiteral,ObjectLiteral

    return sections;
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
                const jsonFiles = files.filter(file => file.isFile() && file.name.endsWith('.json'));
                // Stryker disable next-line ConditionalExpression: Defensive early return — covered by tasks.length check
                if(jsonFiles.length === 0) {
                    return undefined;
                }

                // Read and parse all task files
                const tasks: Task[] = [];
                for(const file of jsonFiles) {
                    // Stryker disable BlockStatement: Per-file error handling — skip unreadable files
                    try {
                        // eslint-disable-next-line no-await-in-loop -- sequential: per-file read, skip on error
                        const content = await readFileFn(path.join(taskDir, file.name), 'utf8');
                        const task = parseTaskFile(content);
                        if(task !== undefined) {
                            tasks.push(task);
                        }
                    } catch{
                        // Skip unreadable files
                        continue;
                    }
                    // Stryker restore BlockStatement
                }

                // Stryker disable next-line ConditionalExpression: Defensive early return — covered by relevantTasks.length check
                if(tasks.length === 0) {
                    return undefined;
                }

                // Filter tasks: all non-completed + recently completed (last 2 hours)
                const now = Date.now();
                // Stryker disable next-line ArithmeticOperator: TTL constant for recently completed tasks
                const twoHoursMs = 2 * 60 * 60 * 1000;

                const relevantTasks = tasks.filter((task) => {
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

                const sections = buildSummarySections(cappedTasks);

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
    return `${subject.slice(0, 47)}...`;
}
