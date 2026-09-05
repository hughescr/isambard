import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { HookCallback, PostCompactHookInput, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createCompactionHooks, createBotStateCompactionSink, type CompactionSink, type CompactionStateManager } from '../../../../src/agent/hooks/compaction';

const makeSignal = (): AbortSignal => new AbortController().signal;

const BASE_HOOK_FIELDS = {
    session_id:      'sess-compact-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

function makeMockSink(): {
    onCompactionStart: ReturnType<typeof mock>
    onCompactionEnd:   ReturnType<typeof mock>
} & CompactionSink {
    return {
        onCompactionStart: mock((_trigger?: 'manual' | 'auto') => undefined),
        onCompactionEnd:   mock((_summary: string) => undefined),
    };
}

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
    let sink: ReturnType<typeof makeMockSink>;

    beforeEach(() => {
        sink = makeMockSink();
    });

    describe('return shape', () => {
        test('returns PreCompact and PostCompact keys', () => {
            const hooks = createCompactionHooks(sink);
            expect(hooks).toHaveProperty('PreCompact');
            expect(hooks).toHaveProperty('PostCompact');
        });

        test('each event has one matcher with one hook', () => {
            const hooks = createCompactionHooks(sink);
            expect(hooks.PreCompact).toHaveLength(1);
            expect(hooks.PostCompact).toHaveLength(1);
            expect(hooks.PreCompact?.[0]?.hooks).toHaveLength(1);
            expect(hooks.PostCompact?.[0]?.hooks).toHaveLength(1);
        });
    });

    describe('PreCompact hook', () => {
        test('returns { continue: true }', async () => {
            const hooks = createCompactionHooks(sink);
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

        test('calls onCompactionStart with the trigger', async () => {
            const hooks = createCompactionHooks(sink);
            const fn = getHook(hooks, 'PreCompact');
            const input: PreCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:     'PreCompact',
                trigger:             'auto',
                custom_instructions: null,
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(sink.onCompactionStart).toHaveBeenCalledTimes(1);
            expect(sink.onCompactionStart).toHaveBeenCalledWith('auto');
        });

        test('passes manual trigger through', async () => {
            const hooks = createCompactionHooks(sink);
            const fn = getHook(hooks, 'PreCompact');
            const input: PreCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name:     'PreCompact',
                trigger:             'manual',
                custom_instructions: null,
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(sink.onCompactionStart).toHaveBeenCalledWith('manual');
        });

        test('does not throw if onCompactionStart throws', async () => {
            sink.onCompactionStart.mockImplementation(() => {
                throw new Error('sink error');
            });
            const hooks = createCompactionHooks(sink);
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
            const hooks = createCompactionHooks(sink);
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

        test('calls onCompactionEnd with the compact summary', async () => {
            const hooks = createCompactionHooks(sink);
            const fn = getHook(hooks, 'PostCompact');
            const input: PostCompactHookInput = {
                ...BASE_HOOK_FIELDS,
                hook_event_name: 'PostCompact',
                trigger:         'auto',
                compact_summary: 'Summary',
            };
            await fn(input, undefined, { signal: makeSignal() });
            expect(sink.onCompactionEnd).toHaveBeenCalledTimes(1);
            expect(sink.onCompactionEnd).toHaveBeenCalledWith('Summary');
        });

        test('does not throw if onCompactionEnd throws', async () => {
            sink.onCompactionEnd.mockImplementation(() => {
                throw new Error('sink error');
            });
            const hooks = createCompactionHooks(sink);
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

describe('createBotStateCompactionSink', () => {
    let stateManager: ReturnType<typeof makeMockStateManager>;

    beforeEach(() => {
        stateManager = makeMockStateManager();
    });

    test('does not touch the state manager at construction', () => {
        createBotStateCompactionSink(stateManager);
        expect(stateManager.stashAndSetCompacting).not.toHaveBeenCalled();
        expect(stateManager.restoreFromCompacting).not.toHaveBeenCalled();
    });

    test('onCompactionStart maps to stashAndSetCompacting(trigger)', () => {
        const sink = createBotStateCompactionSink(stateManager);
        sink.onCompactionStart('manual');
        expect(stateManager.stashAndSetCompacting).toHaveBeenCalledTimes(1);
        expect(stateManager.stashAndSetCompacting).toHaveBeenCalledWith('manual');
        expect(stateManager.restoreFromCompacting).not.toHaveBeenCalled();
    });

    test('onCompactionStart with no trigger passes undefined through', () => {
        const sink = createBotStateCompactionSink(stateManager);
        sink.onCompactionStart();
        expect(stateManager.stashAndSetCompacting).toHaveBeenCalledWith(undefined);
    });

    test('onCompactionEnd maps to restoreFromCompacting()', () => {
        const sink = createBotStateCompactionSink(stateManager);
        sink.onCompactionEnd('some summary');
        expect(stateManager.restoreFromCompacting).toHaveBeenCalledTimes(1);
        expect(stateManager.restoreFromCompacting).toHaveBeenCalledWith();
        expect(stateManager.stashAndSetCompacting).not.toHaveBeenCalled();
    });

    test('a sink built via the adapter satisfies createCompactionHooks', async () => {
        const sink = createBotStateCompactionSink(stateManager);
        const hooks = createCompactionHooks(sink);
        const fn = getHook(hooks, 'PreCompact');
        const input: PreCompactHookInput = {
            ...BASE_HOOK_FIELDS,
            hook_event_name:     'PreCompact',
            trigger:             'auto',
            custom_instructions: null,
        };
        await fn(input, undefined, { signal: makeSignal() });
        expect(stateManager.stashAndSetCompacting).toHaveBeenCalledWith('auto');
    });
});
