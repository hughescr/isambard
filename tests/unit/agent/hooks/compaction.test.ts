import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { HookCallback, PostCompactHookInput, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createCompactionHooks, type CompactionStateManager } from '../../../../src/agent/hooks/compaction';

const makeSignal = (): AbortSignal => new AbortController().signal;

const BASE_HOOK_FIELDS = {
    session_id:      'sess-compact-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

function makeMockStateManager(): {
    stashAndSetCompacting: ReturnType<typeof mock>
    restoreFromCompacting: ReturnType<typeof mock>
} & CompactionStateManager {
    return {
        stashAndSetCompacting: mock((_trigger?: 'manual' | 'auto') => undefined),
        restoreFromCompacting: mock(() => undefined),
    };
}

function getHook(hooks: ReturnType<typeof createCompactionHooks>, event: 'PreCompact' | 'PostCompact'): HookCallback {
    const matchers = hooks[event];
    if(!matchers?.[0]?.hooks[0]) {
        throw new Error(`No hook found for ${event}`);
    }
    return matchers[0].hooks[0];
}

describe('createCompactionHooks', () => {
    let stateManager: ReturnType<typeof makeMockStateManager>;

    beforeEach(() => {
        stateManager = makeMockStateManager();
    });

    describe('return shape', () => {
        test('returns PreCompact and PostCompact keys', () => {
            const hooks = createCompactionHooks(stateManager);
            expect(hooks).toHaveProperty('PreCompact');
            expect(hooks).toHaveProperty('PostCompact');
        });

        test('each event has one matcher with one hook', () => {
            const hooks = createCompactionHooks(stateManager);
            expect(hooks.PreCompact).toHaveLength(1);
            expect(hooks.PostCompact).toHaveLength(1);
            expect(hooks.PreCompact?.[0]?.hooks).toHaveLength(1);
            expect(hooks.PostCompact?.[0]?.hooks).toHaveLength(1);
        });
    });

    describe('PreCompact hook', () => {
        test('returns { continue: true }', async () => {
            const hooks = createCompactionHooks(stateManager);
            const fn = getHook(hooks, 'PreCompact');
            const input: PreCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:     'PreCompact',
                trigger:             'auto',
                custom_instructions: null,
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });

        test('calls stashAndSetCompacting with the trigger', async () => {
            const hooks = createCompactionHooks(stateManager);
            const fn = getHook(hooks, 'PreCompact');
            const input: PreCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:     'PreCompact',
                trigger:             'auto',
                custom_instructions: null,
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(stateManager.stashAndSetCompacting).toHaveBeenCalledTimes(1);
            expect(stateManager.stashAndSetCompacting).toHaveBeenCalledWith('auto');
        });

        test('passes manual trigger through', async () => {
            const hooks = createCompactionHooks(stateManager);
            const fn = getHook(hooks, 'PreCompact');
            const input: PreCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:     'PreCompact',
                trigger:             'manual',
                custom_instructions: null,
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(stateManager.stashAndSetCompacting).toHaveBeenCalledWith('manual');
        });

        test('does not throw if stashAndSetCompacting throws', async () => {
            stateManager.stashAndSetCompacting.mockImplementation(() => {
                throw new Error('state error');
            });
            const hooks = createCompactionHooks(stateManager);
            const fn = getHook(hooks, 'PreCompact');
            const input: PreCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:     'PreCompact',
                trigger:             'auto',
                custom_instructions: null,
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });
    });

    describe('PostCompact hook', () => {
        test('returns { continue: true }', async () => {
            const hooks = createCompactionHooks(stateManager);
            const fn = getHook(hooks, 'PostCompact');
            const input: PostCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'PostCompact',
                trigger:         'auto',
                compact_summary: 'Summary of context...',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });

        test('calls restoreFromCompacting', async () => {
            const hooks = createCompactionHooks(stateManager);
            const fn = getHook(hooks, 'PostCompact');
            const input: PostCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'PostCompact',
                trigger:         'auto',
                compact_summary: 'Summary',
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(stateManager.restoreFromCompacting).toHaveBeenCalledTimes(1);
        });

        test('does not throw if restoreFromCompacting throws', async () => {
            stateManager.restoreFromCompacting.mockImplementation(() => {
                throw new Error('state error');
            });
            const hooks = createCompactionHooks(stateManager);
            const fn = getHook(hooks, 'PostCompact');
            const input: PostCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'PostCompact',
                trigger:         'auto',
                compact_summary: 'Summary',
            };
            const result = await fn(input, undefined, { signal: makeSignal() });
            expect(result).toEqual({ 'continue': true });
        });
    });
});
