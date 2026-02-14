/**
 * Stream Tracker Module
 *
 * Tracks partial work during agent streaming so that when processing is interrupted
 * by a new message, we can capture what work was in progress. Also tracks background
 * task launches and result collections to detect uncollected background tasks.
 */

import _ from 'lodash';
import type { AgentStreamEvent } from './types';
import type { ToolUseBlock } from './agent';
import { extractThinkingContent, extractToolUses } from './agent';
import { extractSessionId } from './session-cleanup';

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
    /** Whether there are background tasks launched but not yet collected via TaskOutput */
    uncollectedBackgroundTasks: boolean
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
    // Stryker disable next-line ArrayDeclaration: Equivalent mutant - _.filter on strings returns [] same as on []
    const textBlocks = _.filter(content ?? [], { type: 'text' });
    const text = _.chain(textBlocks).map('text').compact().join('\n').trim().value();
    return text;
}

/**
 * StreamTracker for tracking agent stream progress.
 */
export class StreamTracker {
    private thinking = '';
    private text = '';
    private pendingToolUse: ToolUseBlock | null = null;
    private sessionId:      string | undefined;
    private backgroundTaskLaunches = 0;
    private taskOutputCalls = 0;

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
                this.pendingToolUse = _.last(toolUses) ?? null;

                // Track background task launches and TaskOutput calls
                this.trackBackgroundTasks(toolUses);
            } else if(message.message?.content !== undefined) {
                // If there's content but no tool_use, clear pendingToolUse
                this.pendingToolUse = null;
            }
        }
    }

    /**
     * Track background task launches and TaskOutput collection calls.
     * @param toolUses Array of tool_use blocks to inspect
     */
    private trackBackgroundTasks(toolUses: ToolUseBlock[]): void {
        for(const toolUse of toolUses) {
            if(toolUse.name === 'Task' && (toolUse.input as Record<string, unknown>)?.run_in_background === true) {
                this.backgroundTaskLaunches++;
            }
            if(toolUse.name === 'TaskOutput') {
                this.taskOutputCalls++;
            }
        }
    }

    /**
     * Check if there are background tasks that have been launched but not yet collected.
     * @returns true if there are uncollected background tasks
     */
    hasUncollectedBackgroundTasks(): boolean {
        return this.backgroundTaskLaunches > this.taskOutputCalls;
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
            uncollectedBackgroundTasks: this.hasUncollectedBackgroundTasks(),
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
        this.backgroundTaskLaunches = 0;
        this.taskOutputCalls = 0;
    }
}
