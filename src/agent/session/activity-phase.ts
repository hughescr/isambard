/**
 * The within-turn activity phase, and the pure `phaseFromFrame` mapping from raw SDK frames to
 * that phase. Moved from `src/integrations/discord/state/types.ts` (plan amendment A1 / P4):
 * this module is the sole owner of {@link ActivityPhase}, {@link activityPhaseSchema} and
 * {@link isActivityPhase}. `src/integrations/discord/state/types.ts` re-exports them for
 * backwards compatibility.
 *
 * @module agent/session/activity-phase
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Discriminated union representing the current activity phase during message processing.
 * Each phase maps to different Discord presence status and behavior.
 *
 * Phases:
 * - thinking: Bot is processing the user's message and formulating a response
 * - using_tool: Bot is executing a specific tool (memory search, file read, etc.)
 * - responding: Bot is generating and sending the response text
 * - compacting: Bot is compacting its context window (manual or auto-triggered)
 *
 * @example
 * ```typescript
 * const thinkingPhase: ActivityPhase = {
 *   type: 'thinking',
 *   startedAt: new Date(),
 *   userMessage: 'What is the weather?'
 * };
 *
 * const toolPhase: ActivityPhase = {
 *   type: 'using_tool',
 *   toolName: 'memory_tool',
 *   startedAt: new Date(),
 *   generatedStatus: 'Searching memories...'
 * };
 * ```
 */
export type ActivityPhase
    = | { type: 'thinking', startedAt: Date, userMessage?: string, generatedStatus?: string }
      | { type: 'using_tool', toolName: string, startedAt: Date, generatedStatus?: string }
      | { type: 'responding', startedAt: Date, generatedStatus?: string }
      | { type: 'compacting', startedAt: Date, trigger?: 'manual' | 'auto' };

/**
 * Zod schema for validating activity phases.
 * Uses discriminated union for type-safe validation.
 */
export const activityPhaseSchema = z.discriminatedUnion('type', [
    z.object({
        type:            z.literal('thinking'),
        startedAt:       z.date(),
        userMessage:     z.string().optional(),
        generatedStatus: z.string().optional(),
    }),
    z.object({
        type:            z.literal('using_tool'),
        toolName:        z.string(),
        startedAt:       z.date(),
        generatedStatus: z.string().optional(),
    }),
    z.object({
        type:            z.literal('responding'),
        startedAt:       z.date(),
        generatedStatus: z.string().optional(),
    }),
    z.object({
        type:      z.literal('compacting'),
        startedAt: z.date(),
        trigger:   z.enum(['manual', 'auto']).optional(),
    }),
]);

/**
 * Type guard to check if a value is a valid ActivityPhase.
 *
 * @param value - Value to check
 * @returns True if value is an ActivityPhase
 *
 * @example
 * ```typescript
 * if (isActivityPhase(phase)) {
 *   console.log('Phase type:', phase.type);
 * }
 * ```
 */
export function isActivityPhase(value: unknown): value is ActivityPhase {
    const result = activityPhaseSchema.safeParse(value);
    return result.success;
}

type AssistantFrame = Extract<SDKMessage, { type: 'assistant' }>;
type AssistantContentBlock = AssistantFrame['message']['content'][number];
type ToolUseBlock = Extract<AssistantContentBlock, { type: 'tool_use' }>;
type TextBlock = Extract<AssistantContentBlock, { type: 'text' }>;
type StreamEventFrame = Extract<SDKMessage, { type: 'stream_event' }>;
type TaskProgressFrame = Extract<SDKMessage, { type: 'system', subtype: 'task_progress' }>;

/**
 * Shared `using_tool` transition: returns `prev` by reference when it is already `using_tool`
 * for the same tool name, otherwise opens a fresh `using_tool` phase.
 */
function usingToolPhase(toolName: string, prev: ActivityPhase | null, at: Date): ActivityPhase {
    if(prev?.type === 'using_tool' && prev.toolName === toolName) {
        return prev;
    }
    return { type: 'using_tool', toolName, startedAt: at };
}

function phaseFromAssistant(frame: AssistantFrame, prev: ActivityPhase | null, at: Date): ActivityPhase {
    const { content } = frame.message;
    const toolUseBlocks = content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    if(toolUseBlocks.length > 0) {
        return usingToolPhase(toolUseBlocks[toolUseBlocks.length - 1]!.name, prev, at);
    }

    const hasText = content.some((block): block is TextBlock => block.type === 'text' && block.text.length > 0);
    return hasText ? { type: 'responding', startedAt: at } : { type: 'thinking', startedAt: at };
}

function phaseFromStreamEvent(frame: StreamEventFrame, prev: ActivityPhase | null, at: Date): ActivityPhase | null {
    const { event } = frame;
    if(event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        return { type: 'responding', startedAt: at };
    }
    return prev;
}

function phaseFromTaskProgress(frame: TaskProgressFrame, prev: ActivityPhase | null, at: Date): ActivityPhase | null {
    if(!frame.summary) {
        return prev;
    }
    return prev?.type === 'responding' ? { type: 'responding', startedAt: at } : { type: 'thinking', startedAt: at };
}

/**
 * Maps one raw SDK frame ({@link SDKMessage}, not the delta-based `AgentStreamEvent`) to the
 * {@link ActivityPhase} it implies, given the phase in effect before the frame arrived.
 *
 * Pure and clock-free: `at` is stamped by the caller (the ledger) on every event, never read
 * from `Date.now()`/`new Date()` here. Returning `prev` by reference (rather than an
 * equal-but-new object) lets callers detect "nothing changed" with `===`.
 *
 * Rule table (see docs/plans/long-lived-session-phase1.md P4):
 * - `result` (any subtype) -> `null` (turn closed, no phase)
 * - `assistant` with a `tool_use` block -> `using_tool` named after the LAST such block;
 *   returns `prev` by reference when `prev` is already `using_tool` with that same name
 * - `assistant` with a non-empty `text` block (no `tool_use`) -> `responding`
 * - `assistant` with only `thinking` blocks, or empty content -> `thinking`
 * - `stream_event` whose event is `content_block_delta` with `delta.type === 'text_delta'` ->
 *   `responding` (only fires with `includePartialMessages`; harmless otherwise); any other
 *   `stream_event` -> `prev`
 * - `tool_progress` -> `using_tool` named after `tool_name`; same-name returns `prev`
 * - `system`/`task_progress` WITH `summary` -> `responding` if `prev` is `responding`,
 *   else `thinking` (matches `stream-event-handler.ts`'s subagent-summary collapse); WITHOUT
 *   `summary` -> `prev`
 * - every other frame -> `prev`
 *
 * `stream-event-handler.ts` (the delta-based `AgentStreamEvent` consumer) is untouched by this
 * function and stays that way until P11/P14.
 */
export function phaseFromFrame(frame: SDKMessage, prev: ActivityPhase | null, at: Date): ActivityPhase | null {
    if(frame.type === 'result') {
        return null;
    }
    if(frame.type === 'assistant') {
        return phaseFromAssistant(frame, prev, at);
    }
    if(frame.type === 'stream_event') {
        return phaseFromStreamEvent(frame, prev, at);
    }
    if(frame.type === 'tool_progress') {
        return usingToolPhase(frame.tool_name, prev, at);
    }
    if(frame.type === 'system' && frame.subtype === 'task_progress') {
        return phaseFromTaskProgress(frame, prev, at);
    }
    return prev;
}
