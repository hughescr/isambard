/**
 * Task Directory Copier
 *
 * Copies task directories between Claude Agent SDK sessions to maintain
 * task continuity across bot restarts.
 *
 * The SDK stores task lists in ~/.claude/tasks/{sessionId}/
 * (Note: Unlike session transcripts, tasks do NOT include the project path)
 * This module copies from a previous session's directory to a new session's directory.
 */

import { constants } from 'node:fs';
import { cp, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@hughescr/logger';
import _ from 'lodash';
import type { TaskCleanupProcessor } from './task-cleanup-processor';
import type { SessionId } from '@/storage';

export interface TaskDirectoryCopierOptions {
    logger:            Logger
    cleanupProcessor?: TaskCleanupProcessor
}

export interface TaskDirectoryCopier {
    /**
     * Copy task directory from previous session to new session.
     *
     * @param previousSessionId - The source session ID
     * @param newSessionId - The destination session ID
     * @returns true if copied, false if skipped (no source directory)
     */
    copyTaskDirectory: (previousSessionId: SessionId, newSessionId: SessionId) => Promise<boolean>
}

/**
 * Gets the base tasks directory path.
 */
const getTasksBasePath = (): string => {
    return join(homedir(), '.claude', 'tasks');
};

/**
 * Gets the full path to a session's task directory.
 * Note: SDK stores tasks at ~/.claude/tasks/{sessionId}/ (no project path prefix)
 */
export const getTaskDirectoryPath = (sessionId: string): string => {
    return join(getTasksBasePath(), sessionId);
};

/**
 * Creates a task directory copier instance.
 *
 * @param options - Copier configuration
 * @returns TaskDirectoryCopier instance
 */
export function createTaskDirectoryCopier(options: TaskDirectoryCopierOptions): TaskDirectoryCopier {
    const { logger, cleanupProcessor } = options;

    return {
        copyTaskDirectory: async (previousSessionId: SessionId, newSessionId: SessionId): Promise<boolean> => {
            const sourcePath = getTaskDirectoryPath(previousSessionId);
            const destPath = getTaskDirectoryPath(newSessionId);

            // Check if source directory exists
            try {
                await access(sourcePath, constants.R_OK);
            } catch{
                // Source doesn't exist - nothing to copy
                // Stryker disable next-line ObjectLiteral: Logger debug object for observability
                logger.debug({
                    previousSessionId,
                    sourcePath,
                    // Stryker disable next-line StringLiteral: Log message for observability only
                    msg: 'No previous task directory to copy',
                });
                return false;
            }

            // If cleanup processor provided, try smart copy with TTL cleanup
            if(cleanupProcessor) {
                try {
                    const result = await cleanupProcessor.processTaskDirectory(previousSessionId, newSessionId);
                    // Stryker disable next-line ObjectLiteral: Logger info object for observability
                    logger.info({
                        previousSessionId,
                        newSessionId,
                        ...result,
                        // Stryker disable next-line StringLiteral: Log message for observability only
                        msg: 'Task directory copied with cleanup',
                    });
                    return true;
                } catch (error) {
                    const errorMsg = _.isError(error) ? error.message : String(error);
                    // Stryker disable next-line ObjectLiteral: Logger warn object for observability
                    logger.warn({
                        previousSessionId,
                        newSessionId,
                        error: errorMsg,
                        // Stryker disable next-line StringLiteral: Log message for observability only
                        msg:   'Task cleanup failed, falling back to simple copy',
                    });
                    // Fall through to simple copy
                }
            }

            // Simple recursive copy (fallback or default)
            try {
                await cp(sourcePath, destPath, {
                    recursive: true,
                    mode:      constants.COPYFILE_FICLONE,
                });

                // Stryker disable next-line ObjectLiteral: Logger info object for observability
                logger.info({
                    previousSessionId,
                    newSessionId,
                    sourcePath,
                    destPath,
                    // Stryker disable next-line StringLiteral: Log message for observability only
                    msg: 'Copied task directory to new session',
                });

                return true;
            } catch (error) {
                const errorMsg = _.isError(error) ? error.message : String(error);
                logger.warn({
                    previousSessionId,
                    newSessionId,
                    sourcePath,
                    destPath,
                    error: errorMsg,
                    // Stryker disable next-line StringLiteral: Log message for observability only
                    msg:   'Failed to copy task directory',
                });
                return false;
            }
        },
    };
}
