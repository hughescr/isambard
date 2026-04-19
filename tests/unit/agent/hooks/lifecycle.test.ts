import { describe, test, expect, mock, spyOn } from 'bun:test';
import type { HookCallback, SessionEndHookInput, SessionStartHookInput, StopFailureHookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import * as loggerModule from '@hughescr/logger';
import { createLifecycleHooks } from '../../../../src/agent/hooks/lifecycle';
import * as sessionCleanup from '../../../../src/agent/session-cleanup';

const makeSignal = (): AbortSignal => new AbortController().signal;

const BASE_HOOK_FIELDS = {
    session_id:      'sess-lifecycle-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

function getHook(hooks: ReturnType<typeof createLifecycleHooks>, event: keyof ReturnType<typeof createLifecycleHooks>): HookCallback {
    const matchers = hooks[event];
    if(!matchers?.[0]?.hooks[0]) {
        throw new Error(`No hook found for ${String(event)}`);
    }
    return matchers[0].hooks[0];
}

describe('createLifecycleHooks', () => {
    describe('return shape', () => {
        test('returns an object with Stop, StopFailure, SessionStart, and SessionEnd keys', () => {
            const hooks = createLifecycleHooks();
            expect(hooks).toHaveProperty('Stop');
            expect(hooks).toHaveProperty('StopFailure');
            expect(hooks).toHaveProperty('SessionStart');
            expect(hooks).toHaveProperty('SessionEnd');
        });

        test('each event has an array with one matcher', () => {
            const hooks = createLifecycleHooks();
            for(const event of ['Stop', 'StopFailure', 'SessionStart', 'SessionEnd'] as const) {
                expect(Array.isArray(hooks[event])).toBe(true);
                expect(hooks[event]).toHaveLength(1);
                expect(hooks[event]?.[0]?.hooks).toHaveLength(1);
            }
        });
    });

    describe('Stop hook', () => {
        test('returns { continue: true }', async () => {
            const hooks = createLifecycleHooks();
            const fn = getHook(hooks, 'Stop');
            const input: StopHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:  'Stop',
                stop_hook_active: false,
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });

        test('invokes onStop callback with the stop input', async () => {
            const onStop = mock((_input: StopHookInput) => undefined);
            const hooks = createLifecycleHooks(undefined, onStop);
            const fn = getHook(hooks, 'Stop');
            const input: StopHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:  'Stop',
                stop_hook_active: false,
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(onStop).toHaveBeenCalledTimes(1);
            expect(onStop).toHaveBeenCalledWith(input);
        });

        test('does not invoke onStop when not provided', async () => {
            // Should not throw when onStop is omitted
            const hooks = createLifecycleHooks();
            const fn = getHook(hooks, 'Stop');
            const input: StopHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:  'Stop',
                stop_hook_active: false,
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });
    });

    describe('StopFailure hook', () => {
        test('returns { continue: true }', async () => {
            const hooks = createLifecycleHooks();
            const fn = getHook(hooks, 'StopFailure');
            const input: StopFailureHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'StopFailure',
                error:           'server_error',
                error_details:   'Something went wrong',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });

        test('invokes onStopFailure callback with the failure input', async () => {
            const onStopFailure = mock((_input: StopFailureHookInput) => undefined);
            const hooks = createLifecycleHooks(undefined, undefined, onStopFailure);
            const fn = getHook(hooks, 'StopFailure');
            const input: StopFailureHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'StopFailure',
                error:           'server_error',
                error_details:   'Something went wrong',
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(onStopFailure).toHaveBeenCalledTimes(1);
            expect(onStopFailure).toHaveBeenCalledWith(input);
        });

        test('does not invoke onStopFailure when not provided', async () => {
            // Should not throw when onStopFailure is omitted
            const hooks = createLifecycleHooks();
            const fn = getHook(hooks, 'StopFailure');
            const input: StopFailureHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'StopFailure',
                error:           'server_error',
                error_details:   'Something went wrong',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });
    });

    describe('SessionStart hook', () => {
        test('returns { continue: true }', async () => {
            const hooks = createLifecycleHooks();
            const fn = getHook(hooks, 'SessionStart');
            const input: SessionStartHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'SessionStart',
                source:          'startup',
                model:           'claude-sonnet-4-5',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });

        test('handles resume source', async () => {
            const hooks = createLifecycleHooks();
            const fn = getHook(hooks, 'SessionStart');
            const input: SessionStartHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'SessionStart',
                source:          'resume',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });
    });

    describe('SessionEnd hook', () => {
        test('returns { continue: true }', async () => {
            const spy = spyOn(sessionCleanup, 'cleanupSession').mockResolvedValue(undefined);
            const hooks = createLifecycleHooks();
            const fn = getHook(hooks, 'SessionEnd');
            const input: SessionEndHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'SessionEnd',
                reason:          'other',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
            spy.mockRestore();
        });

        test('calls cleanupSession with the session_id when no deferral', async () => {
            const spy = spyOn(sessionCleanup, 'cleanupSession').mockResolvedValue(undefined);
            const hooks = createLifecycleHooks(); // no shouldDeferCleanup → always cleans up
            const fn = getHook(hooks, 'SessionEnd');
            const input: SessionEndHookInput = {
                ...BASE_HOOK_FIELDS,
                session_id:      'sess-to-clean',
                hook_event_name: 'SessionEnd',
                reason:          'other',
            };
            await fn(input, undefined, { signal: makeSignal() });
            // Allow the void promise to settle
            await Promise.resolve();
            expect(spy).toHaveBeenCalledWith('sess-to-clean');
            spy.mockRestore();
        });

        test('defers cleanupSession when shouldDeferCleanup returns true', async () => {
            const spy = spyOn(sessionCleanup, 'cleanupSession').mockResolvedValue(undefined);
            const hooks = createLifecycleHooks(() => true); // always defer
            const fn = getHook(hooks, 'SessionEnd');
            const input: SessionEndHookInput = {
                ...BASE_HOOK_FIELDS,
                session_id:      'sess-deferred',
                hook_event_name: 'SessionEnd',
                reason:          'other',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            await Promise.resolve();
            expect(result).toEqual({ 'continue': true });
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        test('calls cleanupSession when shouldDeferCleanup returns false', async () => {
            const spy = spyOn(sessionCleanup, 'cleanupSession').mockResolvedValue(undefined);
            const hooks = createLifecycleHooks(() => false); // never defer
            const fn = getHook(hooks, 'SessionEnd');
            const input: SessionEndHookInput = {
                ...BASE_HOOK_FIELDS,
                session_id:      'sess-not-deferred',
                hook_event_name: 'SessionEnd',
                reason:          'other',
            };
            await fn(input, undefined, { signal: makeSignal() });
            await Promise.resolve();
            expect(spy).toHaveBeenCalledWith('sess-not-deferred');
            spy.mockRestore();
        });

        test('calls cleanupSession when shouldDeferCleanup predicate throws (safe default)', async () => {
            const spy = spyOn(sessionCleanup, 'cleanupSession').mockResolvedValue(undefined);
            // Predicate that throws — should fall through to cleanup (safe default)
            const hooks = createLifecycleHooks(() => {
                throw new Error('predicate-boom');
            });
            const fn = getHook(hooks, 'SessionEnd');
            const input: SessionEndHookInput = {
                ...BASE_HOOK_FIELDS,
                session_id:      'sess-throwing-predicate',
                hook_event_name: 'SessionEnd',
                reason:          'other',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            await Promise.resolve();
            expect(result).toEqual({ 'continue': true });
            expect(spy).toHaveBeenCalledWith('sess-throwing-predicate');
            spy.mockRestore();
        });

        test('M-R7: logs at warn level when shouldDeferCleanup predicate throws', async () => {
            const spy = spyOn(sessionCleanup, 'cleanupSession').mockResolvedValue(undefined);
            const warnSpy = spyOn(loggerModule.logger, 'warn');
            warnSpy.mockClear(); // Clear accumulated calls from other tests in the suite
            const hooks = createLifecycleHooks(() => {
                throw new Error('predicate-warn-test');
            });
            const fn = getHook(hooks, 'SessionEnd');
            const input: SessionEndHookInput = {
                ...BASE_HOOK_FIELDS,
                session_id:      'sess-warn-log',
                hook_event_name: 'SessionEnd',
                reason:          'other',
            };
            await fn(input, undefined, { signal: makeSignal() });
            await Promise.resolve();
            // Should have logged at warn (not info/debug/error)
            expect(warnSpy).toHaveBeenCalled();
            const warnCall = warnSpy.mock.calls.find(
                (call: unknown[]) => typeof (call[0] as Record<string, unknown>).msg === 'string'
                  && ((call[0] as Record<string, unknown>).msg as string).includes('shouldDeferCleanup')
            );
            expect(warnCall).toBeDefined();
            const logPayload = warnCall?.[0] as Record<string, unknown>;
            expect(logPayload.session_id).toBe('sess-warn-log');
            expect(logPayload.error).toBeInstanceOf(Error);
            warnSpy.mockRestore();
            spy.mockRestore();
        });
    });
});
