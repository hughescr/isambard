import { describe, test, expect, mock } from 'bun:test';
import type { HookCallback, HookCallbackMatcher, HookEvent, StopFailureHookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createSessionLifecycleHooks } from '../../../../src/agent/hooks/lifecycle';
import { mockLogger } from '../../../setup';

const makeSignal = (): AbortSignal => new AbortController().signal;

const BASE_HOOK_FIELDS = {
    session_id:      'sess-lifecycle-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

function getHook(hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>, event: HookEvent): HookCallback {
    const matchers = hooks[event];
    if(!matchers?.[0]?.hooks[0]) {
        throw new Error(`No hook found for ${String(event)}`);
    }
    return matchers[0].hooks[0];
}

describe('createSessionLifecycleHooks', () => {
    test('returns an object with only Stop and StopFailure keys', () => {
        const hooks = createSessionLifecycleHooks({});
        expect(Object.keys(hooks).toSorted((a, b) => a.localeCompare(b))).toEqual(['Stop', 'StopFailure']);
    });

    test('Stop hook returns { continue: true } and invokes onStop', async () => {
        const onStop = mock((_input: StopHookInput) => undefined);
        const hooks = createSessionLifecycleHooks({ onStop });
        const fn = getHook(hooks, 'Stop');
        const input: StopHookInput = {
            ...BASE_HOOK_FIELDS,
            hook_event_name:  'Stop',
            stop_hook_active: false,
        };

        const result = await fn(input, undefined, { signal: makeSignal() });

        expect(result).toEqual({ 'continue': true });
        expect(onStop).toHaveBeenCalledWith(input);
        expect(mockLogger.info).toHaveBeenCalledWith({
            session_id:             'sess-lifecycle-1',
            hook_event_name:        'Stop',
            stop_hook_active:       false,
            last_assistant_message: undefined,
            msg:                    'Agent session stopped normally',
        });
    });

    test('Stop hook works with no onStop callback given', async () => {
        const hooks = createSessionLifecycleHooks({});
        const fn = getHook(hooks, 'Stop');
        const input: StopHookInput = {
            ...BASE_HOOK_FIELDS,
            hook_event_name:  'Stop',
            stop_hook_active: false,
        };

        await expect(fn(input, undefined, { signal: makeSignal() })).resolves.toEqual({ 'continue': true });
    });

    test('Stop hook logs only the first 100 characters of the last assistant message', async () => {
        const fn = getHook(createSessionLifecycleHooks({}), 'Stop');
        const message = `${'x'.repeat(100)}private trailing text`;
        const input: StopHookInput = {
            ...BASE_HOOK_FIELDS,
            hook_event_name:        'Stop',
            stop_hook_active:       false,
            last_assistant_message: message,
        };
        await fn(input, undefined, { signal: makeSignal() });
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
            last_assistant_message: 'x'.repeat(100),
        }));
    });

    test('StopFailure hook returns { continue: true } and invokes onStopFailure', async () => {
        const onStopFailure = mock((_input: StopFailureHookInput) => undefined);
        const hooks = createSessionLifecycleHooks({ onStopFailure });
        const fn = getHook(hooks, 'StopFailure');
        const input: StopFailureHookInput = {
            ...BASE_HOOK_FIELDS,
            hook_event_name: 'StopFailure',
            error:           'server_error',
        };

        const result = await fn(input, undefined, { signal: makeSignal() });

        expect(result).toEqual({ 'continue': true });
        expect(onStopFailure).toHaveBeenCalledWith(input);
        expect(mockLogger.error).toHaveBeenCalledWith({
            session_id:      'sess-lifecycle-1',
            hook_event_name: 'StopFailure',
            error:           'server_error',
            error_details:   undefined,
            msg:             'Agent session stopped with failure',
        });
    });
});
