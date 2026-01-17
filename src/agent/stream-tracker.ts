/**
 * Stream Tracker Module
 *
 * Tracks partial work during agent streaming so that when processing is interrupted
 * by a new message, we can capture what work was in progress.
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
    thinking:       string
    /** Latest text content from the most recent assistant event */
    text:           string
    /** The last tool_use block from the most recent assistant event that had tool_use blocks */
    pendingToolUse: ToolUseBlock | null
    /** Session ID captured from system init event */
    sessionId:      string | undefined
}

/**
 * StreamTracker interface for tracking agent stream progress.
 */
export interface StreamTracker {
    /**
     * Update the tracker with a new stream event.
     * @param message The stream event to process
     */
    update(message: AgentStreamEvent): void

    /**
     * Get the current accumulated progress.
     * @returns A copy of the current progress (immutable)
     */
    getProgress(): StreamProgress

    /**
     * Reset all accumulated state back to initial values.
     */
    reset(): void
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
 * Creates a StreamTracker instance for tracking agent stream progress.
 * @returns A new StreamTracker instance
 */
export function createStreamTracker(): StreamTracker {
    // Internal state
    let thinking = '';
    let text = '';
    let pendingToolUse: ToolUseBlock | null = null;
    let sessionId: string | undefined;

    return {
        update(message: AgentStreamEvent): void {
            // Extract session ID from system init events
            const extractedSessionId = extractSessionId(message);
            if(extractedSessionId) {
                sessionId = extractedSessionId;
            }

            // Process assistant events
            if(message.type === 'assistant') {
                // Extract thinking content (replaces previous thinking)
                const thinkingContent = extractThinkingContent(message);
                if(thinkingContent) {
                    thinking = thinkingContent;
                } else if(message.message?.content !== undefined) {
                    // If there's content but no thinking, clear thinking
                    thinking = '';
                }

                // Extract text content (replaces previous text)
                const textContent = extractAssistantText(message);
                if(textContent) {
                    text = textContent;
                } else if(message.message?.content !== undefined) {
                    // If there's content but no text, clear text
                    text = '';
                }

                // Extract tool_use blocks (capture the last one)
                const toolUses = extractToolUses(message);
                if(toolUses.length > 0) {
                    // Get the last tool_use block
                    pendingToolUse = _.last(toolUses) ?? null;
                } else if(message.message?.content !== undefined) {
                    // If there's content but no tool_use, clear pendingToolUse
                    pendingToolUse = null;
                }
            }
        },

        getProgress(): StreamProgress {
            // Return a copy to prevent external mutation
            return {
                thinking,
                text,
                pendingToolUse,
                sessionId,
            };
        },

        reset(): void {
            thinking = '';
            text = '';
            pendingToolUse = null;
            sessionId = undefined;
        },
    };
}
