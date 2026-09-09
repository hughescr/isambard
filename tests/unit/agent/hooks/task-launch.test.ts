/**
 * Behavioural tests for {@link createTaskLaunchHooks} (R2).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { HookCallback, PostToolUseHookInput, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createTaskLaunchHooks, type CreateTaskLaunchHooksParams } from '@/agent/hooks/task-launch';
import type { Conductor, ConductorStatus } from '@/agent/session';

const BASE_HOOK_FIELDS = {
    session_id:      'sess-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

const makeSignal = (): AbortSignal => new AbortController().signal;

function postToolUseInput(overrides: Partial<PostToolUseHookInput> = {}): PostToolUseHookInput {
    return {
        ...BASE_HOOK_FIELDS,
        hook_event_name: 'PostToolUse',
        tool_name:       'Agent',
        tool_input:      { description: 'run a background thing' },
        tool_response:   { agentId: 'agent-X', status: 'async_launched' },
        tool_use_id:     'tool-T',
        ...overrides,
    };
}

function userPromptSubmitInput(overrides: Partial<UserPromptSubmitHookInput> = {}): UserPromptSubmitHookInput {
    return {
        ...BASE_HOOK_FIELDS,
        hook_event_name: 'UserPromptSubmit',
        prompt:          '<task-notification>\n<task-id>agent-X</task-id>\n<tool-use-id>tool-T</tool-use-id>\n<status>completed</status>\n<output-file></output-file>\nBG-AGENT-DONE\n</task-notification>',
        ...overrides,
    };
}

function statusWithTurn(turn: ConductorStatus['turn']): ConductorStatus {
    return {
        role: 'conversation', sessionId: 'sess-1', opened: true, shuttingDown: false, queueLength: 0, turn,
    };
}

interface Harness {
    hooks:         ReturnType<typeof createTaskLaunchHooks>
    record:        ReturnType<typeof jest.fn>
    status:        ReturnType<typeof jest.fn>
    adoptWakeTurn: ReturnType<typeof jest.fn>
    logger:        { debug: ReturnType<typeof jest.fn>, warn: ReturnType<typeof jest.fn>, error: ReturnType<typeof jest.fn> }
    clock:         { now: ReturnType<typeof jest.fn> }
}

/** Fixed instant the fake `clock` reports by default — distinct from `new Date()`'s wall-clock value so a test can tell the two apart. */
const FAKE_NOW_MS = 1_757_000_000_000;

function build(overrides: Partial<CreateTaskLaunchHooksParams> = {}): Harness {
    const record = jest.fn();
    const status = jest.fn(() => statusWithTurn({ kind: 'discord', channelId: 'chan-1', envelopeId: 'env-1', authorId: 'user-1' }));
    const adoptWakeTurn = jest.fn();
    const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const clock = { now: jest.fn(() => FAKE_NOW_MS) };

    const conductor = { status, adoptWakeTurn } as unknown as Pick<Conductor, 'status' | 'adoptWakeTurn'>;
    const registry = { record } as unknown as CreateTaskLaunchHooksParams['registry'];

    const hooks = createTaskLaunchHooks({
        registry, conductor, logger, clock, ...overrides,
    });

    return {
        hooks, record, status, adoptWakeTurn, logger, clock,
    };
}

/** Extract the first HookCallback from the named event's first matcher. */
function getHook(hooks: ReturnType<typeof createTaskLaunchHooks>, event: 'PostToolUse' | 'UserPromptSubmit'): HookCallback {
    const matchers = hooks[event];
    if(!matchers?.[0]?.hooks[0]) {
        throw new Error(`No hook found for ${event}`);
    }
    return matchers[0].hooks[0];
}

describe('createTaskLaunchHooks', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('PostToolUse', () => {
        it('records an Agent launch using the launching turn\'s own status().turn context', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput(), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).toHaveBeenCalledTimes(1);
            expect(h.record.mock.calls[0][0]).toMatchObject({
                taskId: 'agent-X', toolUseId: 'tool-T', toolName: 'Agent', envelopeId: 'env-1', kind: 'discord', channelId: 'chan-1', authorId: 'user-1', description: 'run a background thing',
            });
            expect(h.record.mock.calls[0][0].launchedAt).toEqual(new Date(FAKE_NOW_MS));
        });

        it('records a Workflow launch, falling back to tool_input.prompt (capped) for the description when there is no description field', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');
            const longPrompt = 'x'.repeat(200);

            await fn(
                postToolUseInput({
                    tool_name: 'Workflow', tool_input: { prompt: longPrompt }, tool_response: { taskId: 'wf-1', runId: 'run-1', status: 'async_launched' },
                }),
                undefined,
                { signal: makeSignal() }
            );

            expect(h.record.mock.calls[0][0]).toMatchObject({ taskId: 'wf-1', toolName: 'Workflow' });
            expect(h.record.mock.calls[0][0].description).toBe(longPrompt.slice(0, 120));
        });

        it('records a Bash run_in_background launch', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            await fn(
                postToolUseInput({
                    tool_name: 'Bash', tool_input: { command: 'sleep 5', run_in_background: true }, tool_response: { backgroundTaskId: 'bg-1' },
                }),
                undefined,
                { signal: makeSignal() }
            );

            expect(h.record.mock.calls[0][0]).toMatchObject({ taskId: 'bg-1', toolName: 'Bash' });
        });

        it('records with no description when tool_input has neither description nor prompt', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            await fn(postToolUseInput({ tool_input: { some_other_field: true } }), undefined, { signal: makeSignal() });

            expect(h.record.mock.calls[0][0].description).toBeUndefined();
        });

        it('ignores a hook input carrying a top-level agent_id (subagent-internal launch, real SDK shape) — never records', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            const subagentInput = { ...postToolUseInput({ tool_name: 'Bash', tool_response: { stdout: '', backgroundTaskId: 'bg-nested' } }), agent_id: 'aba171b4a617c9d26', agent_type: 'general-purpose' } as PostToolUseHookInput;
            const result = await fn(subagentInput, undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).not.toHaveBeenCalled();
        });

        it('does not record when the tool_response does not describe a background-work launch', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput({ tool_name: 'Read', tool_response: { content: 'file text' } }), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).not.toHaveBeenCalled();
        });

        it('does not record when there is no running turn (status().turn is null)', async () => {
            const h = build({ conductor: { status: jest.fn(() => statusWithTurn(null)), adoptWakeTurn: jest.fn() } });
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput(), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).not.toHaveBeenCalled();
        });

        it('does not record when the running turn carries no envelopeId', async () => {
            const h = build({
                conductor: { status: jest.fn(() => statusWithTurn({ kind: 'notification' })), adoptWakeTurn: jest.fn() },
            });
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput(), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).not.toHaveBeenCalled();
        });

        it('records with no description when tool_input is null (non-object)', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput({ tool_input: null }), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).toHaveBeenCalledTimes(1);
            expect(h.record.mock.calls[0][0].description).toBeUndefined();
        });

        it('records with no description when tool_input is undefined (non-object)', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput({ tool_input: undefined }), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).toHaveBeenCalledTimes(1);
            expect(h.record.mock.calls[0][0].description).toBeUndefined();
        });

        it('records with no description when tool_input is a primitive (non-object)', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput({ tool_input: 'not an object' }), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.record).toHaveBeenCalledTimes(1);
            expect(h.record.mock.calls[0][0].description).toBeUndefined();
        });

        it('does not ignore-as-subagent-internal when tool_input is null (non-object) — still records normally', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            await fn(postToolUseInput({ tool_input: null }), undefined, { signal: makeSignal() });

            expect(h.record).toHaveBeenCalledTimes(1);
        });

        it('an agent_id inside tool_input (not the hook input) is just a tool argument — still records', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'PostToolUse');

            await fn(postToolUseInput({ tool_input: { agent_id: 'not-a-subagent-marker', description: 'd' } }), undefined, { signal: makeSignal() });

            expect(h.record).toHaveBeenCalledTimes(1);
        });

        it('a launch made from a task-kind turn inherits that turn\'s own channel/author (chained background work)', async () => {
            const h = build({
                conductor: {
                    status: jest.fn(() => statusWithTurn({
                        kind: 'task', channelId: 'chan-task', envelopeId: 'env-task', authorId: 'user-task',
                    })),
                    adoptWakeTurn: jest.fn(),
                },
            });
            const fn = getHook(h.hooks, 'PostToolUse');

            await fn(postToolUseInput(), undefined, { signal: makeSignal() });

            expect(h.record.mock.calls[0][0]).toMatchObject({ kind: 'task', channelId: 'chan-task', authorId: 'user-task' });
        });

        it('never throws: a registry.record throw is caught and logged, still returning continue:true', async () => {
            const h = build();
            (h.record as unknown as { mockImplementation: (fn: () => void) => void }).mockImplementation(() => {
                throw new Error('registry boom');
            });
            const fn = getHook(h.hooks, 'PostToolUse');

            const result = await fn(postToolUseInput(), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.logger.warn).toHaveBeenCalledWith({ error: expect.any(Error) }, 'task-launch PostToolUse hook failed');
        });
    });

    describe('UserPromptSubmit', () => {
        it('adopts the wake turn for a <task-notification> prompt, extracting the summary after </output-file>', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'UserPromptSubmit');

            const result = await fn(userPromptSubmitInput(), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.adoptWakeTurn).toHaveBeenCalledWith({ taskId: 'agent-X', toolUseId: 'tool-T', summary: 'BG-AGENT-DONE' });
        });

        it('caps the summary at 500 characters', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'UserPromptSubmit');
            const longSummary = 'y'.repeat(600);

            await fn(userPromptSubmitInput({ prompt: `<task-notification>\n<task-id>agent-X</task-id>\n<tool-use-id>tool-T</tool-use-id>\n<output-file></output-file>\n${longSummary}\n</task-notification>` }), undefined, { signal: makeSignal() });

            const [call] = h.adoptWakeTurn.mock.calls;
            expect(call[0].summary).toHaveLength(500);
        });

        it('takes the whole remainder after </output-file> as the summary when the closing </task-notification> tag is missing (e.g. truncated)', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'UserPromptSubmit');

            await fn(userPromptSubmitInput({ prompt: '<task-notification>\n<task-id>agent-X</task-id>\n<tool-use-id>tool-T</tool-use-id>\n<output-file></output-file>\nBG-AGENT-DONE-BUT-TRUNCATED' }), undefined, { signal: makeSignal() });

            expect(h.adoptWakeTurn).toHaveBeenCalledWith({ taskId: 'agent-X', toolUseId: 'tool-T', summary: 'BG-AGENT-DONE-BUT-TRUNCATED' });
        });

        it('does not adopt for a prompt that is not a task-notification wake', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'UserPromptSubmit');

            const result = await fn(userPromptSubmitInput({ prompt: 'hello, this is an ordinary user message' }), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.adoptWakeTurn).not.toHaveBeenCalled();
        });

        it('never throws: an adoptWakeTurn throw is caught and logged, still returning continue:true', async () => {
            const h = build();
            h.adoptWakeTurn.mockImplementation(() => {
                throw new Error('adopt boom');
            });
            const fn = getHook(h.hooks, 'UserPromptSubmit');

            const result = await fn(userPromptSubmitInput(), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.logger.warn).toHaveBeenCalledWith({ error: expect.any(Error) }, 'task-launch UserPromptSubmit hook failed');
        });

        it('summary is empty when the prompt has no </output-file> tag at all (afterOutputFile\'s ?? \'\' fallback)', async () => {
            const h = build();
            const fn = getHook(h.hooks, 'UserPromptSubmit');

            await fn(
                userPromptSubmitInput({ prompt: '<task-notification>\n<task-id>agent-X</task-id>\n<tool-use-id>tool-T</tool-use-id>\n</task-notification>' }),
                undefined,
                { signal: makeSignal() }
            );

            expect(h.adoptWakeTurn).toHaveBeenCalledWith({ taskId: 'agent-X', toolUseId: 'tool-T', summary: '' });
        });
    });
});
