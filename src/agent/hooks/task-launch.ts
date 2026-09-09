/**
 * Task-launch hooks (R2, `docs/plans/long-lived-session-phase2-4.md`): PostToolUse records a
 * background-work launch (Agent/Workflow/Bash `run_in_background`) into the {@link
 * import('../session').TaskLaunchRegistry} using the launching turn's own context (channel,
 * author, envelope), and UserPromptSubmit adopts the conductor's pending wake turn once the SDK
 * wakes the session with a `<task-notification>` prompt (real-SDK facts, probe
 * `probe-task-wake.ts`, SDK 0.3.258) — see {@link import('../session').Conductor.adoptWakeTurn}.
 *
 * Both hooks always return `{ continue: true }` and never throw: a malformed tool response or
 * prompt degrades to a no-op (logged), never blocks the turn.
 *
 * @module agent/hooks/task-launch
 */
import type { HookCallbackMatcher, HookEvent, PostToolUseHookInput, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';
import {
    launchIdFromToolResponse,
    parseTaskNotification,
    type Clock,
    type Conductor,
    type TaskLaunchRegistry
} from '@/agent/session';

/** Caps a recorded launch's description — mirrors the plan's `tool_input.description ?? tool_input.prompt?.slice(0,120)`. */
const DESCRIPTION_CAP = 120;

/** Caps the summary text handed to `adoptWakeTurn` — mirrors the plan's cap of 500 chars. */
const SUMMARY_CAP = 500;

/** Dependencies for {@link createTaskLaunchHooks}. */
export interface CreateTaskLaunchHooksParams {
    registry:  Pick<TaskLaunchRegistry, 'record'>
    conductor: Pick<Conductor, 'status' | 'adoptWakeTurn'>
    /** Only `warn` is ever called — a malformed tool response or prompt degrades to a logged no-op, never a `debug`/`error` line. */
    logger:    Pick<Logger, 'warn'>
    /** Sources `task_launched`'s `launchedAt`, like every other session-subsystem timestamp — never the wall clock (`new Date()`), so it stays fake-timer-testable and consistent with the conductor's own injected `now()`. */
    clock:     Pick<Clock, 'now'>
}

/** `tool_input.description`, else `tool_input.prompt` capped to {@link DESCRIPTION_CAP}, else `undefined`. */
function describeToolInput(toolInput: unknown): string | undefined {
    if(toolInput === null || typeof toolInput !== 'object') {
        return undefined;
    }
    const input = toolInput as Record<string, unknown>;
    if(typeof input.description === 'string') {
        return input.description;
    }
    if(typeof input.prompt === 'string') {
        return input.prompt.slice(0, DESCRIPTION_CAP);
    }
    return undefined;
}

/**
 * True when the PostToolUse hook input itself carries a top-level `agent_id` — the SDK stamps
 * it on every hook fired from inside a subagent (verified against SDK 0.3.258 with the
 * probe-task-wake.ts script on 2026-09-08: `{"agent_id":"aba171…","agent_type":"general-purpose",
 * "hook_event_name":"PostToolUse","tool_name":"Bash",…}`). A subagent's own internal launch never
 * fires a UserPromptSubmit wake, so it must not be recorded here. `tool_input` is the tool's
 * arguments and never carries this field.
 */
function isSubagentInternal(input: PostToolUseHookInput): boolean {
    const { agent_id: agentId } = input as { agent_id?: unknown };
    return agentId !== undefined;
}

/** The text after `</output-file>` up to the `<task-notification>` closing tag, trimmed and capped to {@link SUMMARY_CAP}. */
function extractSummary(prompt: string): string {
    const afterOutputFile = prompt.split('</output-file>')[1] ?? '';
    const closingIndex = afterOutputFile.indexOf('</task-notification>');
    const body = closingIndex === -1 ? afterOutputFile : afterOutputFile.slice(0, closingIndex);
    return body.trim().slice(0, SUMMARY_CAP);
}

/**
 * Creates the PostToolUse/UserPromptSubmit hook matchers for R2's task-launch tracking.
 * @param params See {@link CreateTaskLaunchHooksParams}.
 * @returns A partial hook map with `PostToolUse` and `UserPromptSubmit` entries.
 */
export function createTaskLaunchHooks(params: CreateTaskLaunchHooksParams): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const { registry, conductor, logger, clock } = params;

    return {
        PostToolUse: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        try {
                            const toolInput = input as PostToolUseHookInput;
                            if(isSubagentInternal(toolInput)) {
                                return { 'continue': true };
                            }
                            const taskId = launchIdFromToolResponse(toolInput.tool_name, toolInput.tool_response);
                            if(taskId === undefined) {
                                return { 'continue': true };
                            }
                            const { turn } = conductor.status();
                            if(turn?.envelopeId === undefined) {
                                return { 'continue': true };
                            }
                            registry.record({
                                taskId,
                                toolUseId:   toolInput.tool_use_id,
                                toolName:    toolInput.tool_name,
                                envelopeId:  turn.envelopeId,
                                kind:        turn.kind,
                                channelId:   turn.channelId,
                                authorId:    turn.authorId,
                                description: describeToolInput(toolInput.tool_input),
                                launchedAt:  new Date(clock.now()),
                            });
                        } catch (error) {
                            logger.warn({ error }, 'task-launch PostToolUse hook failed');
                        }
                        return { 'continue': true };
                    },
                ],
            },
        ],
        UserPromptSubmit: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        try {
                            const promptInput = input as UserPromptSubmitHookInput;
                            const parsed = parseTaskNotification(promptInput.prompt);
                            if(parsed === undefined) {
                                return { 'continue': true };
                            }
                            conductor.adoptWakeTurn({ taskId: parsed.taskId, toolUseId: parsed.toolUseId, summary: extractSummary(promptInput.prompt) });
                        } catch (error) {
                            logger.warn({ error }, 'task-launch UserPromptSubmit hook failed');
                        }
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
