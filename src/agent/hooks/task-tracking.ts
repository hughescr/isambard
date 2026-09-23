/**
 * Task Tracking Hooks
 *
 * Creates SDK hook callbacks that log task lifecycle events (TaskCreated, TaskCompleted).
 * These hooks are observational logging only — they do not maintain any task state
 * themselves. The session ledger (`src/agent/session/ledger.ts`) is what tracks tasks: its
 * `reduceLedger` reducer adds a task on a `task_started` system frame and removes/updates one
 * on a `background_tasks_changed` system frame, reading the raw SDK stream directly rather than
 * this module's hook input.
 */
import type { HookCallbackMatcher, HookEvent, TaskCompletedHookInput, TaskCreatedHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/**
 * Creates hook matchers for task lifecycle logging.
 *
 * Returns a partial hook map with TaskCreated and TaskCompleted entries that log
 * task events. These hooks do NOT mutate the session ledger — task state is tracked
 * entirely by `reduceLedger`'s `task_started`/`background_tasks_changed` handling
 * (`src/agent/session/ledger.ts`).
 *
 * @returns A partial hook map for merging into query options
 */
export function createTaskTrackingHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
        TaskCreated: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const taskInput = input as TaskCreatedHookInput;
                        logger.debug({ taskId: taskInput.task_id, taskSubject: taskInput.task_subject, msg: 'TaskCreated hook fired — task launched by agent' });
                        return { 'continue': true };
                    },
                ],
            },
        ],
        TaskCompleted: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const taskInput = input as TaskCompletedHookInput;
                        logger.debug({ taskId: taskInput.task_id, taskSubject: taskInput.task_subject, msg: 'TaskCompleted hook fired — sub-agent finished' });
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
