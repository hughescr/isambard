/**
 * Stream Tracker Module
 *
 * Tracks partial work during agent streaming so that when processing is interrupted
 * by a new message, we can capture what work was in progress: the latest thinking/text
 * content, the last pending tool_use block, and the session id captured from the
 * system/init event.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { extractSessionId } from './session-cleanup';
import { type ToolUseBlock } from './stream-extractors';
import type { AgentStreamEvent } from './types';

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
 * StreamTracker for tracking agent stream progress.
 */
export class StreamTracker {
    private thinking = '';
    private text = '';
    private pendingToolUse: ToolUseBlock | null = null;
    private sessionId:      string | undefined;

    /**
     * Update the tracker with a new stream event.
     * @param message The stream event to process
     */
    update(message: SDKMessage | AgentStreamEvent): void {
        // Extract session ID from system init events
        const extractedSessionId = extractSessionId(message);
        if(extractedSessionId) {
            this.sessionId = extractedSessionId;
        }

        // Process assistant events
        if(message.type === 'assistant') {
            const content = message.message?.content;

            // Extract thinking content (replaces previous thinking)
            // Stryker disable MethodExpression: Removing the thinking type filter makes map yield undefined for non-thinking blocks, and filter(Boolean) removes those values before joining.
            const thinkingBlocks = (content ?? [])
                .filter(block => block.type === 'thinking');
            // Stryker restore MethodExpression
            const thinkingContent = thinkingBlocks
                .map(block => block.thinking)
                .filter(Boolean)
                .join('\n')
                .trim();
            if(thinkingContent) {
                this.thinking = thinkingContent;
            } else if(content !== undefined) {
                // If there's content but no thinking, clear thinking
                this.thinking = '';
            }

            // Extract text content (replaces previous text)
            // Stryker disable MethodExpression: Removing the text type filter makes map yield undefined for non-text blocks, and filter(Boolean) removes those values before joining.
            const textBlocks = (content ?? [])
                .filter(block => block.type === 'text');
            // Stryker restore MethodExpression
            const textContent = textBlocks
                .map(block => block.text)
                .filter(Boolean)
                .join('\n')
                .trim();
            if(textContent) {
                this.text = textContent;
            } else if(content !== undefined) {
                // If there's content but no text, clear text
                this.text = '';
            }

            // Extract tool_use blocks (capture the last one)
            const toolUses = (content ?? []).filter(block => block.type === 'tool_use');
            // Stryker disable next-line llm: array length is a nonnegative integer, so > 0 and >= 1 are equivalent
            if(toolUses.length > 0) {
                // Get the last tool_use block
                // Stryker disable next-line llm: every filtered ToolUseBlock is a non-null object, so at(-1) is always truthy here and ?? and || agree
                this.pendingToolUse = toolUses.at(-1) ?? null;
            } else if(content !== undefined) {
                // If there's content but no tool_use, clear pendingToolUse
                this.pendingToolUse = null;
            }
        }
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
            thinking:       this.thinking,
            text:           this.text,
            pendingToolUse: this.pendingToolUse,
            sessionId:      this.sessionId,
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
    }
}
