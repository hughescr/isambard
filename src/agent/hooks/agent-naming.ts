/**
 * Agent/Workflow naming hook (session-peers block 1, `docs/plans/session-peers-and-quota.md`).
 *
 * Every Claude Code process on the machine — Izzy's two sessions, Craig's own terminals, and
 * every sub-agent and workflow either of them launches — registers in one shared peer registry
 * that `ListAgents` reads and `SendMessage` addresses. Izzy's system prompt teaches a rule off
 * that registry: a listed name WITHOUT the `Izzy-` prefix is most likely one of Craig's own
 * sessions and should be left alone. That rule is only true if everything Izzy launches wears
 * the prefix, which is what this `PreToolUse` hook enforces:
 *
 * - `Agent`: `name` is prefixed with `Izzy-`; a missing/blank/non-string name becomes
 *   `Izzy-<subagent_type>-<n>` (or `Izzy-agent-<n>`), counting up per hook instance.
 * - `Workflow`: the `name:` string literal inside the script's `meta = { … }` object gains an
 *   `Izzy-workflow-` prefix. Deliberately a narrow regex over the script source — the script is
 *   an opaque string to the host — so anything it does not recognise is left untouched.
 *
 * The rewrite is delivered as `hookSpecificOutput.updatedInput` (SDK 0.3.258). Already-prefixed
 * names and unrecognised shapes return no `hookSpecificOutput` at all, so the SDK runs the tool
 * with the input the model wrote. The hook always returns `{ continue: true }` and never throws:
 * a naming failure must never block a launch.
 *
 * @module agent/hooks/agent-naming
 */
import type { HookCallbackMatcher, HookEvent, PreToolUseHookInput, PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';

/** The prefix that marks a registry entry as Izzy's, rather than one of Craig's own sessions. */
const IZZY_PREFIX = 'Izzy-';

/** Prefix stamped onto a workflow's `meta.name`. Starts with {@link IZZY_PREFIX}, so a re-run is a no-op. */
const IZZY_WORKFLOW_PREFIX = 'Izzy-workflow-';

/** Name stem used when an `Agent` launch names neither itself nor a `subagent_type`. */
const ANONYMOUS_AGENT_STEM = 'agent';

/**
 * Matches the `name:` string literal inside a workflow script's `meta` object:
 * `meta = { … name: '<value>' … }`, with or without a leading `export const`, in single, double
 * or back quotes.
 *
 * Two deliberate narrowings, both in the MISS direction — rewriting the WRONG `name` token is the
 * only failure that matters here, because it leaves the real `meta.name` unprefixed while
 * reporting success, and an unprefixed workflow reads as one of Craig's own sessions:
 *
 * - **Anchored to the start of a line** (`^` with `m`, after optional indentation and any run of
 *   leading lower-case keywords — `export const`, `const`, or nothing), so a `meta = {` inside a
 *   comment, a string or a template literal cannot claim the match ahead of the real declaration.
 * - **The gap before `name` excludes BOTH braces** (`[^{}]*?`), so the match can neither leave the
 *   `meta` literal through a `}` nor descend into a nested object's own `name` key through a `{`.
 *   A `meta` whose `name` key sits after a nested object therefore matches nothing at all, which
 *   is the spec's sanctioned no-op.
 */
const META_NAME_PATTERN = /^([ \t]*(?:[a-z]+[ \t]+)*meta\s*=\s*\{[^{}]*?\bname\s*:\s*)(['"`])([^'"`\n]*)\2/m;

/** Dependencies for {@link createAgentNamingHooks}. */
export interface CreateAgentNamingHooksParams {
    /** Only `warn` is ever called — an unreadable tool input degrades to a logged no-op. */
    logger: Pick<Logger, 'warn'>
}

/** What the hook returns: always `continue`, plus the rewritten input when there was one. */
interface AgentNamingHookResult {
    'continue':          boolean
    hookSpecificOutput?: PreToolUseHookSpecificOutput
}

/** The tool input as a plain record, or `undefined` when it is not an object. */
function asRecord(toolInput: unknown): Record<string, unknown> | undefined {
    if(toolInput === null || typeof toolInput !== 'object') {
        return undefined;
    }
    return toolInput as Record<string, unknown>;
}

/** `value` when it is a non-empty string, else `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
    if(typeof value !== 'string' || value.length === 0) {
        return undefined;
    }
    return value;
}

/**
 * Rewrites the workflow script's `meta.name` literal, or returns `undefined` when there is
 * nothing to do (no `meta` name literal, or one that already carries the prefix).
 */
function renameWorkflowScript(script: string): string | undefined {
    const match = META_NAME_PATTERN.exec(script);
    if(match === null) {
        return undefined;
    }
    const [whole, prefix, quote, name] = match as unknown as [string, string, string, string];
    if(name.startsWith(IZZY_PREFIX)) {
        return undefined;
    }
    // Spliced at `match.index` rather than through `script.replace(whole, …)`: a string pattern
    // rewrites the FIRST TEXTUAL occurrence of `whole`, which — now that the pattern is anchored
    // to a line start — can sit earlier in the script (inside a comment or a string literal) than
    // the declaration actually matched.
    return `${script.slice(0, match.index)}${prefix}${quote}${IZZY_WORKFLOW_PREFIX}${name}${quote}${script.slice(match.index + whole.length)}`;
}

/**
 * Creates the `PreToolUse` hook matcher that stamps the `Izzy-` prefix onto every sub-agent and
 * workflow this session launches.
 * @param params See {@link CreateAgentNamingHooksParams}.
 * @returns A partial hook map with a single `PreToolUse` entry.
 */
export function createAgentNamingHooks(params: CreateAgentNamingHooksParams): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const { logger } = params;
    let anonymousCount = 0;

    /** The name for an `Agent` launch, or `undefined` when the model's own name already fits. */
    function agentName(input: Record<string, unknown>): string | undefined {
        const given = nonEmptyString(input.name);
        if(given === undefined) {
            anonymousCount += 1;
            const stem = nonEmptyString(input.subagent_type) ?? ANONYMOUS_AGENT_STEM;
            return `${IZZY_PREFIX}${stem}-${anonymousCount}`;
        }
        if(given.startsWith(IZZY_PREFIX)) {
            return undefined;
        }
        return `${IZZY_PREFIX}${given}`;
    }

    /** The rewritten tool input for this launch, or `undefined` to leave the input alone. */
    function rewrite(toolName: string, toolInput: unknown): Record<string, unknown> | undefined {
        const input = asRecord(toolInput);
        if(input === undefined) {
            return undefined;
        }
        if(toolName === 'Agent') {
            const name = agentName(input);
            return name === undefined ? undefined : { ...input, name };
        }
        if(toolName === 'Workflow') {
            const script = nonEmptyString(input.script);
            if(script === undefined) {
                return undefined;
            }
            const renamed = renameWorkflowScript(script);
            return renamed === undefined ? undefined : { ...input, script: renamed };
        }
        return undefined;
    }

    return {
        PreToolUse: [
            {
                hooks: [
                    async (hookInput): Promise<AgentNamingHookResult> => {
                        try {
                            const { tool_name: toolName, tool_input: toolInput } = hookInput as PreToolUseHookInput;
                            const updatedInput = rewrite(toolName, toolInput);
                            if(updatedInput === undefined) {
                                return { 'continue': true };
                            }
                            return { 'continue': true, hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
                        } catch (error) {
                            logger.warn({ error }, 'agent-naming PreToolUse hook failed');
                        }
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
