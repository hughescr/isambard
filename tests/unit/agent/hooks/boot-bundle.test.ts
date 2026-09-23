import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { HookCallback, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createBootBundleHooks } from '../../../../src/agent/hooks/boot-bundle';
import * as frames from '../../../helpers/sdk-frames';
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

    test('injects the compact bundle as additionalContext for source=compact', async () => {
        const build = mock(async () => 'compact bundle');
        const fn = getSessionStartHook(createBootBundleHooks(build));

        const result = await fn(sessionStartInput('compact'), undefined, { signal: makeSignal() });

        expect(build).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            'continue':         true,
            hookSpecificOutput: {
                hookEventName:     'SessionStart',
                additionalContext: 'compact bundle',
            },
        });
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    // The startup input is the hand-authored fixture: under anthropics/claude-agent-sdk-typescript#465
    // the real SDK never invokes this callback for startup, so no recorded input exists (#98).
    test.each([
        ['startup', frames.sessionStartInput('startup')],
        ['resume', sessionStartInput('resume')],
    ] as const)('source=%s is the #465 tripwire: it builds nothing, adds nothing, and logs a warning', async (source, input) => {
        const build = mock(async () => 'should not be built');
        const fn = getSessionStartHook(createBootBundleHooks(build));

        const result = await fn(input, undefined, { signal: makeSignal() });

        expect(build).not.toHaveBeenCalled();
        expect(result).toEqual({ 'continue': true });
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            source,
            msg: `SessionStart ${source} callback fired: upstream claude-agent-sdk-typescript#465 appears fixed. The boot bundle already went in the [BOOT] handshake, so this hook adds nothing; re-evaluate delivering it here (#98).`,
        });
    });

    test.each(['clear', 'fork'] as const)('returns bare { continue: true } for source=%s without calling the builder or warning', async (source) => {
        const build = mock(async () => 'should not be called');
        const fn = getSessionStartHook(createBootBundleHooks(build));

        const result = await fn(sessionStartInput(source), undefined, { signal: makeSignal() });

        expect(result).toEqual({ 'continue': true });
        expect(build).not.toHaveBeenCalled();
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('adds NO additionalContext when the compact builder resolves to an empty string', async () => {
        const build = mock(async () => '');
        const fn = getSessionStartHook(createBootBundleHooks(build));

        const result = await fn(sessionStartInput('compact'), undefined, { signal: makeSignal() });

        expect(build).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ 'continue': true });
        expect(result).not.toHaveProperty('hookSpecificOutput');
    });

    test('returns { continue: true } and logs a warning when the compact builder rejects', async () => {
        const failure = new Error('boot bundle assembly failed');
        const build = mock(async (): Promise<string> => {
            throw failure;
        });
        const fn = getSessionStartHook(createBootBundleHooks(build));

        const result = await fn(sessionStartInput('compact'), undefined, { signal: makeSignal() });

        expect(result).toEqual({ 'continue': true });
        expect(mockLogger.warn).toHaveBeenCalledWith({
            error:  failure,
            source: 'compact',
            msg:    'Boot bundle builder rejected; starting session without it',
        });
    });
});
