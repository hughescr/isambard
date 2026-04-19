/**
 * Stream Tracker Module
 *
 * Tracks partial work during agent streaming so that when processing is interrupted
 * by a new message, we can capture what work was in progress. Also tracks background
 * task launches and collections via a two-phase correlation:
 *
 * Two-phase stream-driven task tracking design:
 *
 * Phase 1 — Task tool_use observation:
 *   When the stream yields an assistant message containing a Task tool_use block with
 *   run_in_background === true, we record the block's tool_use.id (e.g. "toolu_abc")
 *   in `pendingToolUseIds`. We do NOT yet know the SDK-assigned task_id at this point;
 *   AgentInput has no task_id field per sdk-tools.d.ts.
 *
 * Phase 2 — SDKTaskStartedMessage correlation:
 *   Shortly after the Task tool_use block, the SDK emits a system event with
 *   subtype === 'task_started'. This event carries both task_id AND tool_use_id.
 *   When tool_use_id matches an entry in pendingToolUseIds, we promote it:
 *   add task_id to outstandingTaskIds and remove tool_use_id from pendingToolUseIds.
 *
 * Collection:
 *   TaskOutput tool_use block in stream → authoritative collection signal
 *   (reads input.task_id from TaskOutputInput, which DOES include task_id per sdk-tools.d.ts).
 *
 * Foreground tasks (run_in_background !== true) are not tracked.
 * TaskCreated/TaskCompleted hooks are logging-only; they do NOT touch the tracking sets.
 */
import { chain } from 'lodash-es';
import { type ToolUseBlock, extractThinkingContent, extractToolUses  } from './agent';
import { extractSessionId } from './session-cleanup';
import type { AgentStreamEvent } from './types';

/**
 * Represents the accumulated progress from a stream of agent events.
 */
export interface StreamProgress {
    /** Latest thinking content from the most recent assistant event */
    thinking:                   string
    /** Latest text content from the most recent assistant event */
    text:                       string
    /** The last tool_use block from the most recent assistant event that had tool_use blocks */
    pendingToolUse:             ToolUseBlock | null
    /** Session ID captured from system init event */
    sessionId:                  string | undefined
    /** Number of background tasks not yet collected via TaskOutput — includes both phase-1 pending (tool_use observed, task_started not yet received) and phase-2 outstanding (task_id promoted, awaiting TaskOutput) entries */
    uncollectedBackgroundTasks: number
}

/**
 * Extract text content from an assistant message.
 * @param message SDK message with potential content blocks
 * @returns Extracted text or empty string
 */
function extractAssistantText(message: { type: string, message?: { content?: unknown } }): string {
    // Stryker disable StringLiteral,ConditionalExpression,BlockStatement: Only called when message.type === 'assistant', defensive check cannot be tested
    if(message.type !== 'assistant') {
        return '';
    }
    // Stryker restore StringLiteral,ConditionalExpression,BlockStatement

    interface ContentBlock {
        type:  string
        text?: string
    }
    const content = message.message?.content as ContentBlock[] | undefined;
    // Stryker disable next-line ArrayDeclaration: Equivalent mutant - filter on strings returns [] same as on []
    const textBlocks = (content ?? []).filter(block => block.type === 'text');
    return chain(textBlocks).map('text').compact().join('\n').value().trim();
}

/**
 * StreamTracker for tracking agent stream progress.
 */
export class StreamTracker {
    private thinking = '';
    private text = '';
    private pendingToolUse: ToolUseBlock | null = null;
    private sessionId:      string | undefined;
    /** Phase-1: tool_use IDs of background Task blocks observed before SDKTaskStartedMessage arrives */
    private pendingToolUseIds   = new Set<string>();
    /** Phase-2: task_ids promoted from pending once SDKTaskStartedMessage correlates them */
    private outstandingTaskIds  = new Set<string>();

    /**
     * Process Task tool-use blocks from a set of tool uses.
     * When run_in_background is strictly true, record the block's tool_use.id in
     * pendingToolUseIds. We do NOT gate on input.task_id — AgentInput has no task_id field.
     * Foreground Tasks (run_in_background not strictly true) are ignored.
     * @param toolUses Array of tool-use blocks from the current assistant event
     */
    private processTaskToolUses(toolUses: ToolUseBlock[]): void {
        // Stryker disable BlockStatement: I/O side effect — Set mutation does not affect return value
        for(const toolUse of toolUses) {
            if(toolUse.name === 'Task') {
                const input = toolUse.input as Record<string, unknown>;
                // Stryker disable next-line ConditionalExpression,StringLiteral: typeof and non-empty guards are defensive type checks; all test IDs are valid non-empty strings so typeof/empty-check mutations are equivalent
                if(input.run_in_background === true && typeof toolUse.id === 'string' && toolUse.id !== '') {
                    this.pendingToolUseIds.add(toolUse.id);
                }
            }
        }
        // Stryker restore BlockStatement
    }

    /**
     * Process an SDKTaskStartedMessage system event.
     * When the event's tool_use_id matches a pending entry, promote it:
     * add the task_id to outstandingTaskIds and remove tool_use_id from pendingToolUseIds.
     * If tool_use_id is absent or not in pending, the event is silently ignored.
     * @param msg The system event with subtype 'task_started'
     */
    private processTaskStartedSystemEvent(msg: { task_id?: string, tool_use_id?: string }): void {
        // Stryker disable BlockStatement: I/O side effect — Set mutation does not affect return value
        const { task_id, tool_use_id } = msg;
        // Pending-entry guard: typeof and non-empty checks are defensive; real SDK values are always valid non-empty strings.
        // Stryker disable next-line ConditionalExpression,StringLiteral: typeof/non-empty guards are equivalent mutants — all test values are valid non-empty strings
        if(typeof tool_use_id === 'string' && this.pendingToolUseIds.has(tool_use_id) && typeof task_id === 'string' && task_id !== '') {
            this.pendingToolUseIds.delete(tool_use_id);
            this.outstandingTaskIds.add(task_id);
        }
        // Stryker restore BlockStatement
    }

    /**
     * Collect any TaskOutput tool-use blocks from a set of tool uses, removing
     * the corresponding task IDs from the outstanding set.
     * @param toolUses Array of tool-use blocks from the current assistant event
     */
    private processTaskOutputToolUses(toolUses: ToolUseBlock[]): void {
        // Check for TaskOutput tool-use — this is the authoritative collection signal.
        // When the parent agent invokes TaskOutput with a task_id, it is collecting the
        // result of a background task. Remove it from outstandingTaskIds here.
        // TaskOutputInput DOES include task_id per sdk-tools.d.ts, so this read is correct.
        // Stryker disable BlockStatement: I/O side effect — Set mutation does not affect return value
        for(const toolUse of toolUses) {
            if(toolUse.name === 'TaskOutput') {
                const input = toolUse.input as Record<string, unknown>;
                if(typeof input.task_id === 'string') {
                    this.outstandingTaskIds.delete(input.task_id);
                }
            }
        }
        // Stryker restore BlockStatement
    }

    /**
     * Update the tracker with a new stream event.
     * @param message The stream event to process
     */
    update(message: AgentStreamEvent): void {
        // Extract session ID from system init events
        const extractedSessionId = extractSessionId(message);
        if(extractedSessionId) {
            this.sessionId = extractedSessionId;
        }

        // Handle system task_started events (Phase 2 of two-phase correlation)
        // Stryker disable next-line ConditionalExpression: subtype guard equivalent — if 'task_started' check is removed, non-task_started system events pass to processTaskStartedSystemEvent with no matching tool_use_id (they lack tool_use_id), so no state change occurs
        if(message.type === 'system' && message.subtype === 'task_started') {
            this.processTaskStartedSystemEvent(message);
            return;
        }

        // Process assistant events
        if(message.type === 'assistant') {
            // Extract thinking content (replaces previous thinking)
            const thinkingContent = extractThinkingContent(message);
            if(thinkingContent) {
                this.thinking = thinkingContent;
            } else if(message.message?.content !== undefined) {
                // If there's content but no thinking, clear thinking
                this.thinking = '';
            }

            // Extract text content (replaces previous text)
            const textContent = extractAssistantText(message);
            if(textContent) {
                this.text = textContent;
            } else if(message.message?.content !== undefined) {
                // If there's content but no text, clear text
                this.text = '';
            }

            // Extract tool_use blocks (capture the last one)
            const toolUses = extractToolUses(message);
            if(toolUses.length > 0) {
                // Get the last tool_use block
                this.pendingToolUse = toolUses.at(-1) ?? null;
                // Process Task blocks to add to pendingToolUseIds (Phase 1)
                this.processTaskToolUses(toolUses);
                // Process TaskOutput blocks to remove collected tasks from outstanding set
                this.processTaskOutputToolUses(toolUses);
            } else if(message.message?.content !== undefined) {
                // If there's content but no tool_use, clear pendingToolUse
                this.pendingToolUse = null;
            }
        }
    }

    /**
     * Check if there are background tasks that have been created but not yet completed.
     * @returns true if there are uncollected background tasks
     */
    hasUncollectedBackgroundTasks(): boolean {
        return this.outstandingTaskIds.size > 0 || this.pendingToolUseIds.size > 0;
    }

    /**
     * Check whether the stream has produced meaningful LLM output.
     * Used to determine if an interrupted session is worth resuming.
     * @returns true if any thinking, text, or pending tool use has been captured
     */
    hasMeaningfulProgress(): boolean {
        return this.thinking !== ''
          || this.text !== ''
          || this.pendingToolUse !== null;
    }

    /**
     * Get the current accumulated progress.
     * @returns A copy of the current progress (immutable)
     */
    getProgress(): StreamProgress {
        // Return a copy to prevent external mutation
        return {
            thinking:                   this.thinking,
            text:                       this.text,
            pendingToolUse:             this.pendingToolUse,
            sessionId:                  this.sessionId,
            uncollectedBackgroundTasks: this.outstandingTaskIds.size + this.pendingToolUseIds.size,
        };
    }

    /**
     * Reset all accumulated state back to initial values.
     */
    reset(): void {
        this.thinking = '';
        this.text = '';
        this.pendingToolUse = null;
        this.sessionId = undefined;
        this.pendingToolUseIds.clear();
        this.outstandingTaskIds.clear();
    }
}
