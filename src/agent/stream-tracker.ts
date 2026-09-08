/**
 * Stream Tracker Module
 *
 * Tracks partial work during agent streaming so that when processing is interrupted
 * by a new message, we can capture what work was in progress: the latest thinking/text
 * content, the last pending tool_use block, and the session id captured from the
 * system/init event.
 */
import { extractSessionId } from './session-cleanup';
import { type ToolUseBlock, extractAssistantText, extractThinkingContent, extractToolUses } from './stream-extractors';
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
                this.pendingToolUse = toolUses.at(-1) ?? null;
            } else if(message.message?.content !== undefined) {
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
