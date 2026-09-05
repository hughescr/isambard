/**
 * Builders over the committed SDK-frame fixtures (tests/fixtures/sdk-frames/**), each a thin
 * `{ ...fixture, ...overrides }` spread so the recording stays the single source of truth. See
 * scripts/spike-long-lived-session.ts's `--record` flag for how the frame fixtures were captured
 * and normalised, and the two `"source": "hand-authored: ..."` fixtures for the two labels that
 * flag was never able to observe.
 *
 * Every fixture below is cast to its real recorded SDK type exactly once, at import time: a JSON
 * import's fields are widened to `string`/`number`/`boolean` (no literal or template-literal
 * narrowing — a `UUID` field like `session_id`/`uuid` becomes plain `string`), and the spike's
 * normaliser replaces the elements of several array fields (`tools`, `mcp_servers`,
 * `slash_commands`, ...) with a single placeholder element (the field stays an array, matching
 * the SDK's declared `string[]` types), so no fixture can satisfy its SDK type by structural
 * inference alone. Every builder below only ever spreads and overrides an already-typed value —
 * no casts beyond this binding block.
 *
 * @module tests/helpers/sdk-frames
 */
import type {
    PostCompactHookInput,
    PreCompactHookInput,
    SDKAssistantMessage,
    SDKBackgroundTasksChangedMessage,
    SDKCompactBoundaryMessage,
    SDKHookResponseMessage,
    SDKHookStartedMessage,
    SDKResultError,
    SDKResultSuccess,
    SDKSystemMessage,
    SDKTaskNotificationMessage,
    SDKTaskProgressMessage,
    SDKTaskStartedMessage,
    SessionStartHookInput
} from '@anthropic-ai/claude-agent-sdk';
import assistantTextFixture from '../fixtures/sdk-frames/frames/assistant_text.json';
import assistantToolUseFixture from '../fixtures/sdk-frames/frames/assistant_tool_use.json';
import backgroundTasksChangedFixture from '../fixtures/sdk-frames/frames/background_tasks_changed.json';
import bareResultFixture from '../fixtures/sdk-frames/frames/bare_result_should_query_false.json';
import compactBoundaryFixture from '../fixtures/sdk-frames/frames/compact_boundary.json';
import hookResponseFixture from '../fixtures/sdk-frames/frames/hook_response.json';
import hookStartedFixture from '../fixtures/sdk-frames/frames/hook_started.json';
import initFixture from '../fixtures/sdk-frames/frames/init.json';
import resultInterruptedFixture from '../fixtures/sdk-frames/frames/result_interrupted.json';
import resultSuccessFixture from '../fixtures/sdk-frames/frames/result_success.json';
import taskNotificationFixture from '../fixtures/sdk-frames/frames/task_notification.json';
import taskProgressFixture from '../fixtures/sdk-frames/frames/task_progress.json';
import taskStartedFixture from '../fixtures/sdk-frames/frames/task_started.json';
import hookSessionStartCompactFixture from '../fixtures/sdk-frames/hook-inputs/hook_session_start_compact.json';
import hookSessionStartStartupFixture from '../fixtures/sdk-frames/hook-inputs/hook_session_start_startup.json';
import postCompactFixture from '../fixtures/sdk-frames/hook-inputs/post_compact.json';
import preCompactFixture from '../fixtures/sdk-frames/hook-inputs/pre_compact.json';
import type { ContextUsageSummary } from '@/agent/session/types';

const initFrame = initFixture.frames[0] as unknown as SDKSystemMessage;
const assistantTextFrame = assistantTextFixture.frames[0] as unknown as SDKAssistantMessage;
const assistantToolUseFrame = assistantToolUseFixture.frames[0] as unknown as SDKAssistantMessage;
const resultSuccessFrame = resultSuccessFixture.frames[0] as unknown as SDKResultSuccess;
const resultInterruptedFrame = resultInterruptedFixture.frames[0] as unknown as SDKResultError;
const bareResultFrame = bareResultFixture.frames[0] as unknown as SDKResultSuccess;
const taskStartedFrame = taskStartedFixture.frames[0] as unknown as SDKTaskStartedMessage;
const taskProgressFrame = taskProgressFixture.frames[0] as unknown as SDKTaskProgressMessage;
const taskNotificationFrame = taskNotificationFixture.frames[0] as unknown as SDKTaskNotificationMessage;
const backgroundTasksChangedFrame = backgroundTasksChangedFixture.frames[0] as unknown as SDKBackgroundTasksChangedMessage;
const compactBoundaryFrame = compactBoundaryFixture.frames[0] as unknown as SDKCompactBoundaryMessage;
const hookStartedFrame = hookStartedFixture.frames[0] as unknown as SDKHookStartedMessage;
const hookResponseFrame = hookResponseFixture.frames[0] as unknown as SDKHookResponseMessage;

const hookSessionStartStartupInput = hookSessionStartStartupFixture.inputs[0] as unknown as SessionStartHookInput;
const hookSessionStartCompactInput = hookSessionStartCompactFixture.inputs[0] as unknown as SessionStartHookInput;
const preCompactFrame = preCompactFixture.inputs[0] as unknown as PreCompactHookInput;
const postCompactFrame = postCompactFixture.inputs[0] as unknown as PostCompactHookInput;

type AssistantContentBlock = SDKAssistantMessage['message']['content'][number];
type TextBlock = Extract<AssistantContentBlock, { type: 'text' }>;
type ToolUseBlock = Extract<AssistantContentBlock, { type: 'tool_use' }>;

const assistantTextBlock = assistantTextFrame.message.content[0] as TextBlock;
const assistantToolUseBlock = assistantToolUseFrame.message.content[0] as ToolUseBlock;

/** The recorded `system`/`init` frame, with `session_id` set to `sessionId`. */
export function init(sessionId: string, overrides: Partial<SDKSystemMessage> = {}): SDKSystemMessage {
    return { ...initFrame, session_id: sessionId, ...overrides };
}

/** The recorded `assistant` text frame, with its single text block's text replaced. */
export function assistantText(text: string, overrides: Partial<SDKAssistantMessage> = {}): SDKAssistantMessage {
    return {
        ...assistantTextFrame,
        message: { ...assistantTextFrame.message, content: [{ ...assistantTextBlock, text }] },
        ...overrides,
    };
}

/** The recorded `assistant` tool-use frame, with its single tool_use block's name/input/id replaced. */
export function assistantToolUse(name: string, input: unknown, id: string, overrides: Partial<SDKAssistantMessage> = {}): SDKAssistantMessage {
    return {
        ...assistantToolUseFrame,
        message: { ...assistantToolUseFrame.message, content: [{ ...assistantToolUseBlock, name, input, id }] },
        ...overrides,
    };
}

/** The recorded successful `result` frame. */
export function resultSuccess(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
    return { ...resultSuccessFrame, ...overrides };
}

/** The recorded interrupted-turn `result` frame — real subtype `error_during_execution`, recorded as-is. */
export function resultInterrupted(overrides: Partial<SDKResultError> = {}): SDKResultError {
    return { ...resultInterruptedFrame, ...overrides };
}

/** Hand-authored: a zero-turn success `result` frame, as produced by a `shouldQuery:false` send. */
export function bareResult(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
    return { ...bareResultFrame, ...overrides };
}

/** The recorded `system`/`task_started` frame. */
export function taskStarted(overrides: Partial<SDKTaskStartedMessage> = {}): SDKTaskStartedMessage {
    return { ...taskStartedFrame, ...overrides };
}

/** The recorded `system`/`task_progress` frame. */
export function taskProgress(overrides: Partial<SDKTaskProgressMessage> = {}): SDKTaskProgressMessage {
    return { ...taskProgressFrame, ...overrides };
}

/** The recorded `system`/`task_notification` frame, with `status` set. */
export function taskNotification(status: SDKTaskNotificationMessage['status'], overrides: Partial<SDKTaskNotificationMessage> = {}): SDKTaskNotificationMessage {
    return { ...taskNotificationFrame, status, ...overrides };
}

/** The recorded `system`/`background_tasks_changed` frame, with `tasks` replaced wholesale (REPLACE semantics). */
export function backgroundTasksChanged(tasks: SDKBackgroundTasksChangedMessage['tasks'], overrides: Partial<SDKBackgroundTasksChangedMessage> = {}): SDKBackgroundTasksChangedMessage {
    return { ...backgroundTasksChangedFrame, tasks, ...overrides };
}

/** The recorded `system`/`compact_boundary` frame. */
export function compactBoundary(overrides: Partial<SDKCompactBoundaryMessage> = {}): SDKCompactBoundaryMessage {
    return { ...compactBoundaryFrame, ...overrides };
}

/** The recorded `system`/`hook_started` frame. */
export function hookStarted(overrides: Partial<SDKHookStartedMessage> = {}): SDKHookStartedMessage {
    return { ...hookStartedFrame, ...overrides };
}

/** The recorded `system`/`hook_response` frame. */
export function hookResponse(overrides: Partial<SDKHookResponseMessage> = {}): SDKHookResponseMessage {
    return { ...hookResponseFrame, ...overrides };
}

/** The recorded `SessionStart` hook input for `source`, `'startup'` (hand-authored) or `'compact'` (recorded). */
export function sessionStartInput(source: 'startup' | 'compact', overrides: Partial<SessionStartHookInput> = {}): SessionStartHookInput {
    const base = source === 'compact' ? hookSessionStartCompactInput : hookSessionStartStartupInput;
    return { ...base, source, ...overrides };
}

/** The recorded `PreCompact` hook input. */
export function preCompactInput(overrides: Partial<PreCompactHookInput> = {}): PreCompactHookInput {
    return { ...preCompactFrame, ...overrides };
}

/** The recorded `PostCompact` hook input. */
export function postCompactInput(overrides: Partial<PostCompactHookInput> = {}): PostCompactHookInput {
    return { ...postCompactFrame, ...overrides };
}

/** A zeroed {@link ContextUsageSummary}, for tests that don't care about the exact numbers. */
export function contextUsage(overrides: Partial<ContextUsageSummary> = {}): ContextUsageSummary {
    return { percentage: 0, totalTokens: 0, maxTokens: 0, ...overrides };
}
