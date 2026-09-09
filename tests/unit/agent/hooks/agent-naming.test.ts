/**
 * Behavioural tests for {@link createAgentNamingHooks} (session-peers block 1).
 *
 * Every sub-agent and workflow Izzy launches registers itself in the same machine-wide peer
 * registry the sessions do, so their names have to carry the `Izzy-` prefix that the system
 * prompt's peer rule keys on ("a listed session without the `Izzy-` prefix is most likely one
 * of Craig's own sessions").
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createAgentNamingHooks, type CreateAgentNamingHooksParams } from '@/agent/hooks/agent-naming';

const BASE_HOOK_FIELDS = {
    session_id:      'sess-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

const makeSignal = (): AbortSignal => new AbortController().signal;

function preToolUseInput(overrides: Partial<PreToolUseHookInput> = {}): PreToolUseHookInput {
    return {
        ...BASE_HOOK_FIELDS,
        hook_event_name: 'PreToolUse',
        tool_name:       'Agent',
        tool_input:      { name: 'reviewer', subagent_type: 'sonnet-high', prompt: 'go' },
        tool_use_id:     'tool-T',
        ...overrides,
    };
}

interface Harness {
    hooks:  ReturnType<typeof createAgentNamingHooks>
    logger: { warn: ReturnType<typeof jest.fn> }
}

function build(overrides: Partial<CreateAgentNamingHooksParams> = {}): Harness {
    const logger = { warn: jest.fn() };
    return { hooks: createAgentNamingHooks({ logger, ...overrides }), logger };
}

/** Extract the PreToolUse hook callback from the first matcher. */
function getHook(hooks: ReturnType<typeof createAgentNamingHooks>): HookCallback {
    const callback = hooks.PreToolUse?.[0]?.hooks[0];
    if(!callback) {
        throw new Error('No PreToolUse hook found');
    }
    return callback;
}

/**
 * Runs the hook and returns its `updatedInput`, or `undefined` when the hook declined to
 * rewrite. Asserts the two invariants every ordinary call must hold: nothing was logged (a
 * warn means the hook swallowed a crash rather than deciding), and a "no rewrite" answer is a
 * bare `{ continue: true }` with no `hookSpecificOutput` at all — an empty `hookSpecificOutput`
 * would make the SDK see a rewrite request with no new input.
 */
async function run(h: Harness, input: PreToolUseHookInput): Promise<Record<string, unknown> | undefined> {
    const result = await getHook(h.hooks)(input, undefined, { signal: makeSignal() });
    expect(h.logger.warn).not.toHaveBeenCalled();
    const output = (result as { hookSpecificOutput?: { hookEventName?: string, updatedInput?: Record<string, unknown> } }).hookSpecificOutput;
    if(output === undefined) {
        expect(result).toEqual({ 'continue': true });
        return undefined;
    }
    expect(result).toMatchObject({ 'continue': true });
    expect(output.hookEventName).toBe('PreToolUse');
    expect(output.updatedInput).toBeDefined();
    return output.updatedInput;
}

/** A workflow script whose `meta` block carries a plain, unprefixed name. */
const WORKFLOW_SCRIPT = `export const meta = {
  name: 'nightly-triage',
  description: 'triage the inbox',
}

const out = await agent({ prompt: 'go' })
`;

describe('createAgentNamingHooks', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Agent', () => {
        it('prefixes an existing name with Izzy-', async () => {
            const h = build();

            const updated = await run(h, preToolUseInput());

            expect(updated).toEqual({ name: 'Izzy-reviewer', subagent_type: 'sonnet-high', prompt: 'go' });
        });

        it('leaves a name that already starts with Izzy- alone, rewriting nothing', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_input: { name: 'Izzy-reviewer' } }))).toBeUndefined();
        });

        it('invents Izzy-<subagent_type>-<n> when no name was given', async () => {
            const h = build();

            const updated = await run(h, preToolUseInput({ tool_input: { subagent_type: 'opus-high', prompt: 'go' } }));

            expect(updated).toEqual({ subagent_type: 'opus-high', prompt: 'go', name: 'Izzy-opus-high-1' });
        });

        it('falls back to Izzy-agent-<n> when neither name nor subagent_type is given', async () => {
            const h = build();

            const updated = await run(h, preToolUseInput({ tool_input: { prompt: 'go' } }));

            expect(updated).toEqual({ prompt: 'go', name: 'Izzy-agent-1' });
        });

        it('treats an empty name and a non-string name as no name at all', async () => {
            const h = build();

            const empty = await run(h, preToolUseInput({ tool_input: { name: '', subagent_type: 'x' } }));
            const numeric = await run(h, preToolUseInput({ tool_input: { name: 7, subagent_type: 'x' } }));

            expect(empty).toMatchObject({ name: 'Izzy-x-1' });
            expect(numeric).toMatchObject({ name: 'Izzy-x-2' });
        });

        it('treats an empty and a non-string subagent_type as absent', async () => {
            const h = build();

            const empty = await run(h, preToolUseInput({ tool_input: { subagent_type: '' } }));
            const numeric = await run(h, preToolUseInput({ tool_input: { subagent_type: 3 } }));

            expect(empty).toMatchObject({ name: 'Izzy-agent-1' });
            expect(numeric).toMatchObject({ name: 'Izzy-agent-2' });
        });

        it('counts invented names up from 1, per hook instance, and never reuses a number', async () => {
            const first = build();

            expect(await run(first, preToolUseInput({ tool_input: {} }))).toMatchObject({ name: 'Izzy-agent-1' });
            expect(await run(first, preToolUseInput({ tool_input: {} }))).toMatchObject({ name: 'Izzy-agent-2' });
            expect(await run(first, preToolUseInput({ tool_input: {} }))).toMatchObject({ name: 'Izzy-agent-3' });

            const second = build();
            expect(await run(second, preToolUseInput({ tool_input: {} }))).toMatchObject({ name: 'Izzy-agent-1' });
        });

        it('does not burn a counter number on a launch that already had a name', async () => {
            const h = build();

            await run(h, preToolUseInput({ tool_input: { name: 'reviewer' } }));

            expect(await run(h, preToolUseInput({ tool_input: {} }))).toMatchObject({ name: 'Izzy-agent-1' });
        });
    });

    describe('Workflow', () => {
        it('prefixes the meta.name literal inside the script with Izzy-workflow-, leaving the rest of the script byte-identical', async () => {
            const h = build();

            const updated = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: WORKFLOW_SCRIPT, args: { a: 1 } } }));

            expect(updated?.script).toBe(WORKFLOW_SCRIPT.replace('\'nightly-triage\'', '\'Izzy-workflow-nightly-triage\''));
            expect(updated?.args).toEqual({ a: 1 });
        });

        it('rewrites a double-quoted literal and a bare `meta = {` (no `export const`) too', async () => {
            const h = build();

            const updated = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'meta = { name: "triage" }' } }));

            expect(updated?.script).toBe('meta = { name: "Izzy-workflow-triage" }');
        });

        it('tolerates missing whitespace around the assignment and after the name colon', async () => {
            // Guards the `\s*` quantifiers in META_NAME_PATTERN: `meta={` and `name:'t'` are
            // both valid JS a model may well emit, and must still be renamed.
            const h = build();

            const tightAssignment = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'meta={ name: "t" }' } }));
            const tightColon = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'export const meta = { name:\'t\' }' } }));

            expect(tightAssignment?.script).toBe('meta={ name: "Izzy-workflow-t" }');
            expect(tightColon?.script).toBe('export const meta = { name:\'Izzy-workflow-t\' }');
        });

        it('renames the `name` key, never a longer key that merely starts with "name"', async () => {
            const h = build();

            const updated = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'export const meta = { nameish: \'x\', name: \'triage\' }' } }));

            expect(updated?.script).toBe('export const meta = { nameish: \'x\', name: \'Izzy-workflow-triage\' }');
        });

        it('leaves a meta.name that already starts with Izzy- alone', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'export const meta = { name: \'Izzy-workflow-triage\' }' } }))).toBeUndefined();
        });

        it('is a no-op when the script has no meta name literal, or no meta block at all', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'export const meta = { description: \'x\' }' } }))).toBeUndefined();
            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'const name = \'x\'' } }))).toBeUndefined();
        });

        it('does not reach past a nested closing brace for the name key', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'export const meta = { phases: [{ title: \'a\' }], name: \'triage\' }' } }))).toBeUndefined();
        });

        it('does not reach past a nested OPENING brace either, so a nested object\'s own name key is never rewritten in place of meta.name', async () => {
            // The real meta.name is `nightly`; `worker` belongs to a nested object. Rewriting
            // `worker` would leave the workflow registered as `nightly` — unprefixed, i.e.
            // indistinguishable from one of Craig's own sessions. A no-op is the safe answer.
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'export const meta = { agent: { name: \'worker\' }, name: \'nightly\' };' } }))).toBeUndefined();
        });

        it('anchors `meta =` to the start of a line, so a commented-out meta block cannot steal the rename from the real one', async () => {
            const h = build();

            const updated = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: '// meta = { name: \'example\' }\nexport const meta = { name: \'nightly\' };' } }));

            expect(updated?.script).toBe('// meta = { name: \'example\' }\nexport const meta = { name: \'Izzy-workflow-nightly\' };');
        });

        it('allows the meta declaration to be indented, and to be spaced out between its keywords', async () => {
            // Guards both quantifiers in the anchored lead-in: the leading `[ \t]*` indentation
            // and the `[ \t]+` gap between each keyword and the next.
            const h = build();

            const indented = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: '\t  export const meta = { name: \'t\' }' } }));
            const spacedOut = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 'export   const\tmeta = { name: \'t\' }' } }));

            expect(indented?.script).toBe('\t  export const meta = { name: \'Izzy-workflow-t\' }');
            expect(spacedOut?.script).toBe('export   const\tmeta = { name: \'Izzy-workflow-t\' }');
        });

        it('rewrites the literal AT the matched position, not an identical earlier substring elsewhere in the script', async () => {
            // The first textual occurrence of the matched text is inside a string on line 1,
            // which the anchored pattern deliberately did not match; a substring replace would
            // rewrite that one and leave the real meta.name untouched.
            const h = build();
            const script = 'const doc = \'meta = { name: "a" }\';\nmeta = { name: "a" }';

            const updated = await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script } }));

            expect(updated?.script).toBe('const doc = \'meta = { name: "a" }\';\nmeta = { name: "Izzy-workflow-a" }');
        });

        it('is a no-op when script is missing or not a string', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: {} }))).toBeUndefined();
            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { script: 42 } }))).toBeUndefined();
        });

        it('does not rename a Workflow through the Agent branch even when the input carries a name field', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Workflow', tool_input: { name: 'triage', script: 'no meta here' } }))).toBeUndefined();
        });
    });

    describe('everything else', () => {
        it('ignores any other tool', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls', name: 'x' } }))).toBeUndefined();
        });

        it('only Agent and Workflow are rewritten — another tool carrying a workflow-shaped script is left alone', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_name: 'Task', tool_input: { script: WORKFLOW_SCRIPT } }))).toBeUndefined();
        });

        it('ignores a tool_input that is not an object', async () => {
            const h = build();

            expect(await run(h, preToolUseInput({ tool_input: null }))).toBeUndefined();
            expect(await run(h, preToolUseInput({ tool_input: 'reviewer' }))).toBeUndefined();
        });

        it('degrades to a logged no-op when reading the tool input throws, never blocking the turn', async () => {
            const h = build();
            const exploding = {
                get name(): string {
                    throw new Error('boom');
                },
            };

            const result = await getHook(h.hooks)(preToolUseInput({ tool_input: exploding }), undefined, { signal: makeSignal() });

            expect(result).toEqual({ 'continue': true });
            expect(h.logger.warn).toHaveBeenCalledTimes(1);
            expect(h.logger.warn.mock.calls[0][0]).toEqual({ error: new Error('boom') });
            expect(h.logger.warn.mock.calls[0][1]).toBe('agent-naming PreToolUse hook failed');
        });

        it('registers exactly one PreToolUse matcher and no other hook events', () => {
            const { hooks } = build();

            expect(Object.keys(hooks)).toEqual(['PreToolUse']);
            expect(hooks.PreToolUse).toHaveLength(1);
            expect(hooks.PreToolUse?.[0]?.hooks).toHaveLength(1);
        });
    });
});
