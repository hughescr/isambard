import { describe, expect, it } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import packageJson from '../../../package.json';
import assistantTextFixture from '../../fixtures/sdk-frames/frames/assistant_text.json';
import assistantToolUseFixture from '../../fixtures/sdk-frames/frames/assistant_tool_use.json';
import backgroundTasksChangedFixture from '../../fixtures/sdk-frames/frames/background_tasks_changed.json';
import bareResultFixture from '../../fixtures/sdk-frames/frames/bare_result_should_query_false.json';
import compactBoundaryFixture from '../../fixtures/sdk-frames/frames/compact_boundary.json';
import hookResponseFixture from '../../fixtures/sdk-frames/frames/hook_response.json';
import hookStartedFixture from '../../fixtures/sdk-frames/frames/hook_started.json';
import initFixture from '../../fixtures/sdk-frames/frames/init.json';
import resultInterruptedFixture from '../../fixtures/sdk-frames/frames/result_interrupted.json';
import resultSuccessFixture from '../../fixtures/sdk-frames/frames/result_success.json';
import taskNotificationFixture from '../../fixtures/sdk-frames/frames/task_notification.json';
import taskProgressFixture from '../../fixtures/sdk-frames/frames/task_progress.json';
import taskStartedFixture from '../../fixtures/sdk-frames/frames/task_started.json';
import hookSessionStartCompactFixture from '../../fixtures/sdk-frames/hook-inputs/hook_session_start_compact.json';
import hookSessionStartStartupFixture from '../../fixtures/sdk-frames/hook-inputs/hook_session_start_startup.json';
import postCompactFixture from '../../fixtures/sdk-frames/hook-inputs/post_compact.json';
import preCompactFixture from '../../fixtures/sdk-frames/hook-inputs/pre_compact.json';
import {
    assistantText,
    assistantToolUse,
    backgroundTasksChanged,
    bareResult,
    compactBoundary,
    contextUsage,
    hookResponse,
    hookStarted,
    init,
    postCompactInput,
    preCompactInput,
    resultInterrupted,
    resultSuccess,
    sessionStartInput,
    taskNotification,
    taskProgress,
    taskStarted
} from '../../helpers/sdk-frames';

// @anthropic-ai/claude-agent-sdk is deliberately pinned to an EXACT version in package.json (no
// ^/~ range): the SDK package does not export ./package.json for a static import of the
// installed version, so a range here would let `bun update` silently resolve a newer SDK while
// every fixture keeps asserting the old declared range and this guard stays green. Pinning makes
// the declared version and the installed version the same fact.
const DECLARED_SDK_VERSION = packageJson.dependencies['@anthropic-ai/claude-agent-sdk'];

/**
 * Asserts `built` carries every key of `fixtureFrame` with an equal value, except the keys in
 * `excludeKeys` (fields the builder call under test deliberately overrides). Closes the gap a
 * single spot-checked field or two leaves open: a refactor that turns a builder's `{ ...fixture }`
 * spread into an explicit field-by-field projection can silently drop a fixture field, and every
 * spot-check assertion keeps passing because none of them happens to name the dropped field.
 */
function assertCarriesFixtureFields(built: Record<string, unknown>, fixtureFrame: Record<string, unknown>, excludeKeys: string[] = []): void {
    for(const key of Object.keys(fixtureFrame)) {
        if(excludeKeys.includes(key)) {
            continue;
        }
        expect(built[key]).toEqual(fixtureFrame[key]);
    }
}

const FRAME_FIXTURES: [string, { sdkVersion: string }][] = [
    ['frames/assistant_text.json', assistantTextFixture],
    ['frames/assistant_tool_use.json', assistantToolUseFixture],
    ['frames/background_tasks_changed.json', backgroundTasksChangedFixture],
    ['frames/bare_result_should_query_false.json', bareResultFixture],
    ['frames/compact_boundary.json', compactBoundaryFixture],
    ['frames/hook_response.json', hookResponseFixture],
    ['frames/hook_started.json', hookStartedFixture],
    ['frames/init.json', initFixture],
    ['frames/result_interrupted.json', resultInterruptedFixture],
    ['frames/result_success.json', resultSuccessFixture],
    ['frames/task_notification.json', taskNotificationFixture],
    ['frames/task_progress.json', taskProgressFixture],
    ['frames/task_started.json', taskStartedFixture],
    ['hook-inputs/hook_session_start_compact.json', hookSessionStartCompactFixture],
    ['hook-inputs/hook_session_start_startup.json', hookSessionStartStartupFixture],
    ['hook-inputs/post_compact.json', postCompactFixture],
    ['hook-inputs/pre_compact.json', preCompactFixture],
];

describe('sdk-frames fixture drift guard', () => {
    it('pins @anthropic-ai/claude-agent-sdk to an exact version, not a ^/~ range', () => {
        expect(DECLARED_SDK_VERSION, 'a ^/~ range lets `bun update` silently install a newer SDK than every fixture was recorded against while this guard keeps comparing against the unchanged declared range').toMatch(/^\d+\.\d+\.\d+$/);
    });

    it.each(FRAME_FIXTURES)('%s was recorded against the installed SDK version', (path, fixture) => {
        expect(fixture.sdkVersion, `${path} says sdkVersion ${fixture.sdkVersion}, but the installed @anthropic-ai/claude-agent-sdk is ${DECLARED_SDK_VERSION}. Re-record the sdk-frames fixtures (bun scripts/spike-long-lived-session.ts q1,q2,q3 --record) after an SDK bump.`).toBe(DECLARED_SDK_VERSION);
    });
});

describe('init', () => {
    it('matches the fixture type/subtype and carries every fixture field, with sessionId overriding session_id', () => {
        const frame: SDKMessage = init('sess-123');

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('init');
        expect(frame.session_id).toBe('sess-123');
        expect(frame.cwd).toBe(initFixture.frames[0].cwd);
        expect(frame.model).toBe(initFixture.frames[0].model);
        assertCarriesFixtureFields(frame, initFixture.frames[0], ['session_id']);
    });

    it('lets overrides win over both the fixture and the positional sessionId', () => {
        const frame = init('sess-123', { session_id: 'sess-456' });

        expect(frame.session_id).toBe('sess-456');
    });
});

describe('assistantText', () => {
    it('matches the fixture type and carries the given text in a single text content block', () => {
        const frame: SDKMessage = assistantText('hello there');

        expect(frame.type).toBe('assistant');
        expect(frame.message.content).toHaveLength(1);
        expect(frame.message.content[0]).toMatchObject({ type: 'text', text: 'hello there' });
        expect(frame.session_id).toBe(assistantTextFixture.frames[0].session_id);
        assertCarriesFixtureFields(frame, assistantTextFixture.frames[0], ['message']);
    });

    it('lets overrides win over the fixture', () => {
        const frame = assistantText('hi', { session_id: 'sess-override' });

        expect(frame.session_id).toBe('sess-override');
    });
});

describe('assistantToolUse', () => {
    it('matches the fixture type and carries the given name/input/id in a single tool_use content block', () => {
        const frame: SDKMessage = assistantToolUse('Bash', { command: 'echo hi' }, 'toolu_1');

        expect(frame.type).toBe('assistant');
        expect(frame.message.content).toEqual([{
            type:   'tool_use',
            id:     'toolu_1',
            name:   'Bash',
            input:  { command: 'echo hi' },
            caller: { type: 'direct' },
        }]);
        assertCarriesFixtureFields(frame, assistantToolUseFixture.frames[0], ['message']);
    });

    it('lets overrides win over the fixture', () => {
        const frame = assistantToolUse('Bash', {}, 'toolu_1', { session_id: 'sess-override' });

        expect(frame.session_id).toBe('sess-override');
    });
});

describe('resultSuccess', () => {
    it('matches the fixture type/subtype and carries every fixture field', () => {
        const frame: SDKMessage = resultSuccess();

        expect(frame.type).toBe('result');
        expect(frame.subtype).toBe('success');
        expect(frame.total_cost_usd).toBe(resultSuccessFixture.frames[0].total_cost_usd);
        expect(frame.num_turns).toBe(resultSuccessFixture.frames[0].num_turns);
        assertCarriesFixtureFields(frame, resultSuccessFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = resultSuccess({ total_cost_usd: 1.23, is_error: false, queued_turn_count: 2 });

        expect(frame.total_cost_usd).toBeCloseTo(1.23);
        expect(frame.queued_turn_count).toBe(2);
    });
});

describe('resultInterrupted', () => {
    it('carries the real recorded subtype (error_during_execution, not a nonexistent "interrupted" subtype)', () => {
        const frame: SDKMessage = resultInterrupted();

        expect(frame.type).toBe('result');
        expect(frame.subtype).toBe('error_during_execution');
        expect(frame.terminal_reason).toBe('aborted_streaming');
        assertCarriesFixtureFields(frame, resultInterruptedFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = resultInterrupted({ total_cost_usd: 9.99 });

        expect(frame.total_cost_usd).toBeCloseTo(9.99);
    });
});

describe('bareResult', () => {
    it('is a zero-turn success result with no model call', () => {
        const frame: SDKMessage = bareResult();

        expect(frame.type).toBe('result');
        expect(frame.subtype).toBe('success');
        expect(frame.num_turns).toBe(0);
        expect(frame.result).toBe('');
        assertCarriesFixtureFields(frame, bareResultFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = bareResult({ session_id: 'sess-override' });

        expect(frame.session_id).toBe('sess-override');
    });
});

describe('taskStarted', () => {
    it('matches the fixture type/subtype and carries every fixture field', () => {
        const frame: SDKMessage = taskStarted();

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('task_started');
        expect(frame.description).toBe(taskStartedFixture.frames[0].description);
        expect(frame.is_backgrounded).toBe(taskStartedFixture.frames[0].is_backgrounded);
        assertCarriesFixtureFields(frame, taskStartedFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = taskStarted({ task_id: 'task-override', description: 'do the thing', is_backgrounded: false });

        expect(frame.task_id).toBe('task-override');
        expect(frame.description).toBe('do the thing');
        expect(frame.is_backgrounded).toBe(false);
    });
});

describe('taskProgress', () => {
    it('matches the fixture type/subtype and carries every fixture field', () => {
        const frame: SDKMessage = taskProgress();

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('task_progress');
        expect(frame.last_tool_name).toBe(taskProgressFixture.frames[0].last_tool_name);
        assertCarriesFixtureFields(frame, taskProgressFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = taskProgress({ last_tool_name: 'Read' });

        expect(frame.last_tool_name).toBe('Read');
    });
});

describe('taskNotification', () => {
    it('matches the fixture type/subtype and sets the given status', () => {
        const frame: SDKMessage = taskNotification('completed');

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('task_notification');
        expect(frame.status).toBe('completed');
        expect(frame.task_id).toBe(taskNotificationFixture.frames[0].task_id);
        assertCarriesFixtureFields(frame, taskNotificationFixture.frames[0], ['status']);
    });

    it('carries a non-fixture status through, and lets overrides win', () => {
        const frame = taskNotification('failed', { summary: 'it broke' });

        expect(frame.status).toBe('failed');
        expect(frame.summary).toBe('it broke');
    });
});

describe('backgroundTasksChanged', () => {
    it('matches the fixture type/subtype and sets the given tasks wholesale', () => {
        const tasks = [{ task_id: 't1', task_type: 'local_agent', description: 'one task' }];
        const frame: SDKMessage = backgroundTasksChanged(tasks);

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('background_tasks_changed');
        expect(frame.tasks).toEqual(tasks);
        assertCarriesFixtureFields(frame, backgroundTasksChangedFixture.frames[0], ['tasks']);
    });

    it('lets overrides win over the fixture', () => {
        const frame = backgroundTasksChanged([], { session_id: 'sess-override' });

        expect(frame.session_id).toBe('sess-override');
        expect(frame.tasks).toEqual([]);
    });
});

describe('compactBoundary', () => {
    it('matches the fixture type/subtype and carries every fixture field', () => {
        const frame: SDKMessage = compactBoundary();

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('compact_boundary');
        expect(frame.compact_metadata.trigger).toBe('manual');
        assertCarriesFixtureFields(frame, compactBoundaryFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = compactBoundary({ session_id: 'sess-override' });

        expect(frame.session_id).toBe('sess-override');
    });
});

describe('hookStarted', () => {
    it('matches the fixture type/subtype and carries every fixture field', () => {
        const frame: SDKMessage = hookStarted();

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('hook_started');
        expect(frame.hook_event).toBe(hookStartedFixture.frames[0].hook_event);
        assertCarriesFixtureFields(frame, hookStartedFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = hookStarted({ hook_name: 'PreCompact' });

        expect(frame.hook_name).toBe('PreCompact');
    });
});

describe('hookResponse', () => {
    it('matches the fixture type/subtype and carries every fixture field', () => {
        const frame: SDKMessage = hookResponse();

        expect(frame.type).toBe('system');
        expect(frame.subtype).toBe('hook_response');
        expect(frame.outcome).toBe('success');
        assertCarriesFixtureFields(frame, hookResponseFixture.frames[0]);
    });

    it('lets overrides win over the fixture', () => {
        const frame = hookResponse({ outcome: 'error' });

        expect(frame.outcome).toBe('error');
    });
});

describe('sessionStartInput', () => {
    it("returns the startup fixture with source 'startup'", () => {
        const input = sessionStartInput('startup');

        expect(input.hook_event_name).toBe('SessionStart');
        expect(input.source).toBe('startup');
        assertCarriesFixtureFields(input, hookSessionStartStartupFixture.inputs[0], ['source']);
    });

    it("returns the compact fixture with source 'compact'", () => {
        const input = sessionStartInput('compact');

        expect(input.hook_event_name).toBe('SessionStart');
        expect(input.source).toBe('compact');
        expect(input.session_id).toBe(hookSessionStartCompactFixture.inputs[0].session_id);
        assertCarriesFixtureFields(input, hookSessionStartCompactFixture.inputs[0], ['source']);
    });

    it('lets overrides win over the fixture', () => {
        const input = sessionStartInput('compact', { session_id: 'sess-override' });

        expect(input.session_id).toBe('sess-override');
    });
});

describe('preCompactInput', () => {
    it('matches the fixture hook_event_name/trigger', () => {
        const input = preCompactInput();

        expect(input.hook_event_name).toBe('PreCompact');
        expect(input.trigger).toBe('manual');
        assertCarriesFixtureFields(input, preCompactFixture.inputs[0]);
    });

    it('lets overrides win over the fixture', () => {
        const input = preCompactInput({ trigger: 'auto' });

        expect(input.trigger).toBe('auto');
    });
});

describe('postCompactInput', () => {
    it('matches the fixture hook_event_name/compact_summary', () => {
        const input = postCompactInput();

        expect(input.hook_event_name).toBe('PostCompact');
        expect(input.compact_summary).toBe(postCompactFixture.inputs[0].compact_summary);
        assertCarriesFixtureFields(input, postCompactFixture.inputs[0]);
    });

    it('lets overrides win over the fixture', () => {
        const input = postCompactInput({ trigger: 'auto' });

        expect(input.trigger).toBe('auto');
    });
});

describe('contextUsage', () => {
    it('defaults to a zeroed summary', () => {
        expect(contextUsage()).toEqual({ percentage: 0, totalTokens: 0, maxTokens: 0 });
    });

    it('lets overrides win over the defaults', () => {
        expect(contextUsage({ percentage: 50, totalTokens: 1000, maxTokens: 2000 })).toEqual({ percentage: 50, totalTokens: 1000, maxTokens: 2000 });
    });
});
