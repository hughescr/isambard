import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { HookCallback, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createBootBundleHooks } from '../../../../src/agent/hooks/boot-bundle';
import { mockLogger } from '../../../setup';

const makeSignal = (): AbortSignal => new AbortController().signal;

function getSessionStartHook(hooks: ReturnType<typeof createBootBundleHooks>): HookCallback {
    const matchers = hooks.SessionStart;
    if(!matchers?.[0]?.hooks[0]) {
        throw new Error('No SessionStart hook found');
    }
    return matchers[0].hooks[0];
}

function sessionStartInput(source: SessionStartHookInput['source']): SessionStartHookInput {
    return {
        session_id:      'sess-boot-1',
        transcript_path: '/tmp/transcript',
        cwd:             '/tmp',
        hook_event_name: 'SessionStart',
        source,
    };
}

beforeEach(() => {
    mockLogger.warn.mockClear();
});

afterEach(() => {
    mockLogger.warn.mockClear();
});

describe('createBootBundleHooks', () => {
    test('returns a SessionStart matcher only', () => {
        const hooks = createBootBundleHooks(async () => 'bundle text');
        expect(Object.keys(hooks)).toEqual(['SessionStart']);
        expect(hooks.SessionStart).toHaveLength(1);
        expect(hooks.SessionStart?.[0]?.hooks).toHaveLength(1);
    });

    test.each(['startup', 'resume', 'compact'] as const)('injects additionalContext from the builder for source=%s', async (source) => {
        const build = mock(async (s: 'startup' | 'resume' | 'compact') => `bundle for ${s}`);
        const hooks = createBootBundleHooks(build);
        const fn = getSessionStartHook(hooks);

        const result = await fn(sessionStartInput(source), undefined, { signal: makeSignal() });

        expect(build).toHaveBeenCalledWith(source);
        expect(result).toEqual({
            'continue':         true,
            hookSpecificOutput: {
                hookEventName:     'SessionStart',
                additionalContext: `bundle for ${source}`,
            },
        });
    });

    test.each(['clear', 'fork'] as const)('returns bare { continue: true } for source=%s without calling the builder', async (source) => {
        const build = mock(async () => 'should not be called');
        const hooks = createBootBundleHooks(build);
        const fn = getSessionStartHook(hooks);

        const result = await fn(sessionStartInput(source), undefined, { signal: makeSignal() });

        expect(result).toEqual({ 'continue': true });
        expect(build).not.toHaveBeenCalled();
    });

    test('adds NO additionalContext when the builder resolves to an empty string (R1: an empty resume bundle)', async () => {
        const build = mock(async () => '');
        const hooks = createBootBundleHooks(build);
        const fn = getSessionStartHook(hooks);

        const result = await fn(sessionStartInput('resume'), undefined, { signal: makeSignal() });

        expect(build).toHaveBeenCalledWith('resume');
        expect(result).toEqual({ 'continue': true });
        expect(result).not.toHaveProperty('hookSpecificOutput');
    });

    test('returns { continue: true } and logs a warning when the builder rejects', async () => {
        const failure = new Error('boot bundle assembly failed');
        const build = mock(async (): Promise<string> => {
            throw failure;
        });
        const hooks = createBootBundleHooks(build);
        const fn = getSessionStartHook(hooks);

        const result = await fn(sessionStartInput('startup'), undefined, { signal: makeSignal() });

        expect(result).toEqual({ 'continue': true });
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: failure, source: 'startup' }));
    });
});
