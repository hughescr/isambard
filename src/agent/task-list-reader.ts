/**
 * Task List Reader
 *
 * Reads Claude Agent SDK task JSON files from a session directory
 * and builds a compact summary for idle status generation.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';

/**
 * Gets the full path to a session's task directory.
 * Note: SDK stores tasks at ~/.claude/tasks/{sessionId}/ (no project path prefix, unlike
 * session transcripts).
 * @param sessionId The UUID of the session
 * @returns Full path to the session's task directory
 */
export const getTaskDirectoryPath = (sessionId: string): string => {
    return path.join(homedir(), '.claude', 'tasks', sessionId);
};

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
 * Validates a parsed task value and returns a Task, or undefined if invalid.
 */

function validateTaskFile(parsed: unknown): Task | undefined {
    // Validate task shape - check parsed is non-null and has required fields
    if(typeof parsed !== 'object' || parsed === null
      || !('id' in parsed) || typeof parsed.id !== 'string'
      || !('subject' in parsed) || typeof parsed.subject !== 'string'
      || !('status' in parsed) || typeof parsed.status !== 'string'
      || !['pending', 'in_progress', 'completed'].includes(parsed.status)) {
        return undefined;
    }
    // Stryker restore OptionalChaining,ConditionalExpression,LogicalOperator

    return parsed as Task;
}

/**
 * Builds the summary sections array from a capped task list.
 */
function buildSummarySections(cappedTasks: Task[]): string[] {
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
                    // Silent: ENOENT means no task directory for this session (no tasks created
                    // yet) or the session was cleaned up. Either way there is nothing to show.
                    return undefined;
                }

                // Filter for JSON files only
                const jsonFiles = files.filter(file => file.isFile() && file.name.endsWith('.json'));
                // Read and parse all task files
                const limit = pLimit(8);
                // A corrupt or vanishing file does not prevent the other admitted reads
                // from completing or contributing to the summary.
                const parsedTasks = await Promise.allSettled(jsonFiles.map(file => limit(async () => {
                    const content = await readFileFn(path.join(taskDir, file.name), 'utf8');
                    try {
                        return validateTaskFile(JSON.parse(content));
                    } catch(error) {
                        logger.debug({ error, file: file.name, msg: 'Failed to parse task file' });
                        return undefined;
                    }
                })));
                const tasks: Task[] = parsedTasks.flatMap(result => (result.status === 'fulfilled' && result.value !== undefined ? [result.value] : []));

                // Filter tasks: all non-completed + recently completed (last 2 hours)
                const now = Date.now();
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

                // Hard cap at 10 tasks
                const cappedTasks = relevantTasks.slice(0, 10);

                const sections = buildSummarySections(cappedTasks);

                return sections.length > 0 ? sections.join('\n') : undefined;
            } catch (error) {
                // Log error and return undefined
                logger.debug({
                    error,
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
    if(subject.length <= 50) {
        return subject;
    }
    return `${subject.slice(0, 47)}...`;
}
