/**
 * Task Persistence Coordinator
 *
 * Orchestrates task directory persistence across Claude Agent SDK sessions.
 * Coordinates between DynamoDB session tracking and filesystem task directory copying.
 *
 * Flow:
 * 1. Load previous session ID from DynamoDB
 * 2. Copy task directory from previous session to new session
 * 3. Update DynamoDB with new session ID
 *
 * Note: Task directory cleanup is handled by user's hooks, not this module.
 */

import type { Logger } from '@hughescr/logger';
import type { TaskDirectoryCopier } from './task-directory-copier';
import { type TaskSessionBackend, createSessionId  } from '@/storage';

export interface TaskPersistenceCoordinatorOptions {
    backend: TaskSessionBackend
    copier:  TaskDirectoryCopier
    logger:  Logger
}

export interface TaskPersistenceCoordinator {
    /**
     * Prepare a new session by copying tasks from the previous session.
     *
     * This method:
     * 1. Loads the previous session ID from DynamoDB
     * 2. Copies task directory from previous to new session (if previous exists)
     * 3. Updates DynamoDB with the new session ID
     *
     * Errors are logged but never thrown - the agent continues with a fresh session if persistence fails.
     *
     * @param newSessionId - The UUID string for the new session
     * @returns true if tasks were copied, false if not (no previous session or copy failed)
     */
    prepareNewSession: (newSessionId: string) => Promise<boolean>
}

/**
 * Creates a task persistence coordinator instance.
 *
 * @param options - Coordinator configuration
 * @returns TaskPersistenceCoordinator instance
 */
export function createTaskPersistenceCoordinator(
    options: TaskPersistenceCoordinatorOptions
): TaskPersistenceCoordinator {
    const { backend, copier, logger } = options;

    return {
        prepareNewSession: async (newSessionId: string): Promise<boolean> => {
            try {
                // Validate and create branded SessionId
                const validatedNewSessionId = createSessionId(newSessionId);

                // 1. Load previous session ID from DynamoDB
                const previousSessionId = await backend.getCurrentSessionId();

                if(!previousSessionId) {
                    // No previous session - just store the new one
                    /* istanbul ignore next - logging only */ // Stryker disable all: logging only — object literal and string values not logic to test
                    logger.debug({
                        newSessionId,
                        msg: 'No previous session found, starting fresh',
                    });
                    // Stryker restore all
                    await backend.setCurrentSessionId(validatedNewSessionId);
                    return false;
                }

                // 2. Copy task directory from previous session to new session
                const copied = await copier.copyTaskDirectory(previousSessionId, validatedNewSessionId);

                // 3. Update DynamoDB with new session ID
                await backend.setCurrentSessionId(validatedNewSessionId);

                if(copied) {
                    /* istanbul ignore next - logging only */ // Stryker disable all: logging only — object literal and string values not logic to test
                    logger.info({
                        previousSessionId,
                        newSessionId,
                        msg: 'Task persistence complete - tasks copied to new session',
                    });
                    // Stryker restore all
                } else {
                    /* istanbul ignore next - logging only */ // Stryker disable all: logging only — object literal and string values not logic to test
                    logger.debug({
                        previousSessionId,
                        newSessionId,
                        msg: 'Task persistence complete - no tasks to copy',
                    });
                    // Stryker restore all
                }

                return copied;
            } catch (error) {
                // Task persistence is optional - log and continue
                const errorMsg = error instanceof Error ? error.message : String(error);
                /* istanbul ignore next - logging only */ // Stryker disable all: logging only — object literal and string values not logic to test
                logger.warn({
                    newSessionId,
                    error: errorMsg,
                    msg:   'Task persistence failed (continuing with fresh session)',
                });
                // Stryker restore all
                return false;
            }
        },
    };
}
