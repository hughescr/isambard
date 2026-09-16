/**
 * Task Tracking Hooks
 *
 * Creates SDK hook callbacks that log task lifecycle events (TaskCreated, TaskCompleted).
 * Task state tracking is fully stream-driven: the StreamTracker.update() method parses
 * Task tool_use blocks (run_in_background:true → add) and TaskOutput tool_use blocks
 * (→ remove) directly from the agent stream. Hooks here are observational logging only.
 */
import type { HookCallbackMatcher, HookEvent, TaskCompletedHookInput, TaskCreatedHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/**
 * Creates hook matchers for task lifecycle logging.
 *
 * Returns a partial hook map with TaskCreated and TaskCompleted entries that log
 * task events. These hooks do NOT mutate the StreamTracker — task state is tracked
 * entirely via stream-parsing in StreamTracker.update().
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
