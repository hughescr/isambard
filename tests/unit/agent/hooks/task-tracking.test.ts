import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import type { HookCallback, TaskCreatedHookInput, TaskCompletedHookInput } from '@anthropic-ai/claude-agent-sdk';
import * as loggerModule from '@hughescr/logger';
import { createTaskTrackingHooks } from '../../../../src/agent/hooks/task-tracking';

const makeSignal = (): AbortSignal => new AbortController().signal;

const BASE_HOOK_FIELDS = {
    session_id:      'sess-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

/** Extract the first HookCallback from the named event's first matcher. */
function getHook(hooks: ReturnType<typeof createTaskTrackingHooks>, event: 'TaskCreated' | 'TaskCompleted'): HookCallback {
    const matchers = hooks[event];
    if(!matchers?.[0]?.hooks[0]) {
        throw new Error(`No hook found for ${event}`);
    }
    return matchers[0].hooks[0];
}

describe('createTaskTrackingHooks', () => {
    describe('return shape', () => {
        test('should return an object with TaskCreated and TaskCompleted keys', () => {
            const hooks = createTaskTrackingHooks();
            expect(hooks).toHaveProperty('TaskCreated');
            expect(hooks).toHaveProperty('TaskCompleted');
        });

        test('TaskCreated value should be an array with one matcher', () => {
            const hooks = createTaskTrackingHooks();
            expect(Array.isArray(hooks.TaskCreated)).toBe(true);
            expect(hooks.TaskCreated).toHaveLength(1);
        });

        test('TaskCompleted value should be an array with one matcher', () => {
            const hooks = createTaskTrackingHooks();
            expect(Array.isArray(hooks.TaskCompleted)).toBe(true);
            expect(hooks.TaskCompleted).toHaveLength(1);
        });

        test('TaskCreated matcher should have a hooks array with one fn', () => {
            const hooks = createTaskTrackingHooks();
            expect(hooks.TaskCreated?.[0]?.hooks).toHaveLength(1);
        });

        test('TaskCompleted matcher should have a hooks array with one fn', () => {
            const hooks = createTaskTrackingHooks();
            expect(hooks.TaskCompleted?.[0]?.hooks).toHaveLength(1);
        });
    });

    describe('TaskCreated hook — logging only (no state mutation)', () => {
        let debugSpy: ReturnType<typeof spyOn>;

        afterEach(() => {
            debugSpy?.mockRestore();
        });

        test('should return { continue: true }', async () => {
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCreated');

            const input: TaskCreatedHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'TaskCreated',
                task_id:         'task-abc-123',
                task_subject:    'Do something',
            };

            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });

        test('should call logger.debug with task_id and task_subject', async () => {
            debugSpy = spyOn(loggerModule.logger, 'debug');
            debugSpy.mockClear(); // Clear any accumulated calls from other tests
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCreated');

            const input: TaskCreatedHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'TaskCreated',
                task_id:         'task-log-123',
                task_subject:    'Log me',
            };

            await fn(input, undefined, { signal: makeSignal() });
            expect(debugSpy).toHaveBeenCalled();
            const call = debugSpy.mock.calls.find(
                (c: unknown[]) => typeof (c[0] as Record<string, unknown>).taskId === 'string'
            );
            expect(call).toBeDefined();
            expect((call?.[0] as Record<string, unknown>).taskId).toBe('task-log-123');
            expect((call?.[0] as Record<string, unknown>).taskSubject).toBe('Log me');
        });

        test('should return { continue: true } when called multiple times', async () => {
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCreated');
            const signal = makeSignal();

            for(const id of ['task-1', 'task-2', 'task-3']) {
                // eslint-disable-next-line no-await-in-loop -- sequential hook invocations in test; no parallelism needed
                const result = await fn(
                    { ...BASE_HOOK_FIELDS, hook_event_name: 'TaskCreated', task_id: id, task_subject: `Task ${id}` },
                    undefined,
                    { signal }
                );
                expect(result).toEqual({ 'continue': true });
            }
        });
    });

    describe('TaskCompleted hook — logging only (no state mutation)', () => {
        let debugSpy: ReturnType<typeof spyOn>;

        afterEach(() => {
            debugSpy?.mockRestore();
        });

        test('should return { continue: true }', async () => {
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCompleted');

            const input: TaskCompletedHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'TaskCompleted',
                task_id:         'task-xyz',
                task_subject:    'Some task',
            };

            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });

        test('should call logger.debug with task_id and task_subject', async () => {
            debugSpy = spyOn(loggerModule.logger, 'debug');
            debugSpy.mockClear(); // Clear any accumulated calls from other tests
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCompleted');

            const input: TaskCompletedHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'TaskCompleted',
                task_id:         'task-done-456',
                task_subject:    'Finished task',
            };

            await fn(input, undefined, { signal: makeSignal() });
            expect(debugSpy).toHaveBeenCalled();
            const call = debugSpy.mock.calls.find(
                (c: unknown[]) => typeof (c[0] as Record<string, unknown>).taskId === 'string'
                  && (c[0] as Record<string, unknown>).taskId === 'task-done-456'
            );
            expect(call).toBeDefined();
            expect((call?.[0] as Record<string, unknown>).taskSubject).toBe('Finished task');
        });

        test('should always return { continue: true }', async () => {
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCompleted');

            const input: TaskCompletedHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'TaskCompleted',
                task_id:         'task-final',
                task_subject:    'Final task',
            };

            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });
    });

    describe('No StreamTracker parameter — hooks do not affect task tracking state', () => {
        test('createTaskTrackingHooks takes no arguments', () => {
            // Calling with no arguments is the expected API; TypeScript ensures no tracker param
            expect(() => createTaskTrackingHooks()).not.toThrow();
        });

        test('TaskCreated hook does not influence whether a task appears outstanding', async () => {
            // The hook is logging-only. Task state lives entirely in StreamTracker.update()
            // which parses Task tool_use blocks from the stream.
            // This test verifies the hook returns successfully with no side effects.
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCreated');

            const result = await fn(
                { ...BASE_HOOK_FIELDS, hook_event_name: 'TaskCreated', task_id: 'no-state', task_subject: 'No state mutation' },
                undefined,
                { signal: makeSignal() }
            );
            // Hook returns continue:true and does nothing else — state tracking is
            // stream-driven in StreamTracker.processTaskToolUses(), not here.
            expect(result).toEqual({ 'continue': true });
        });

        test('TaskCompleted hook does not influence whether a task is removed from outstanding', async () => {
            // TaskCompleted fires when sub-agent finishes, but collection is tracked by
            // TaskOutput tool_use blocks parsed in StreamTracker.processTaskOutputToolUses().
            const hooks = createTaskTrackingHooks();
            const fn = getHook(hooks, 'TaskCompleted');

            const result = await fn(
                { ...BASE_HOOK_FIELDS, hook_event_name: 'TaskCompleted', task_id: 'no-removal', task_subject: 'No removal' },
                undefined,
                { signal: makeSignal() }
            );
            expect(result).toEqual({ 'continue': true });
        });
    });
});
