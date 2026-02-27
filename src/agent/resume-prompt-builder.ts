/**
 * Resume Prompt Builder Module
 *
 * Builds a special "resume prompt" that tells the LLM what happened during an interruption
 * and provides context for continuing processing after new messages arrive.
 */

import map from 'lodash/map';
import type { StreamProgress } from './stream-tracker';
import type { MessageContext } from './types';

/**
 * Context needed to build a resume prompt after an interruption.
 */
export interface ResumeContext {
    /** Partial work captured from interrupted stream */
    partialWork: StreamProgress
    /** Events that occurred during processing (formatted strings from EventDeltaTracker) */
    newEvents:   string[]
    /** New messages that arrived during processing */
    newMessages: MessageContext[]
}

/**
 * Builds a resume prompt from the given context.
 * @param context Resume context with partial work, events, and new messages
 * @returns Formatted resume prompt string
 */
export function buildResumePrompt(context: ResumeContext): string {
    const sections: string[] = [
        '[CONTEXT UPDATE]\n'
        + 'A new message arrived while you were processing. Consider it in relation to your original task - it might add information, provide clarification, be a new request, or something else entirely. Incorporate it appropriately and continue.'
    ];

    // 1. Context Update Header (always included)

    // 2. Partial Thinking (only if non-empty)
    if(context.partialWork.thinking) {
        sections.push(
            `[Your thinking at the point of interruption:]\n${
                context.partialWork.thinking}`
        );
    }

    // 3. Partial Response (only if non-empty)
    if(context.partialWork.text) {
        sections.push(
            `[You were composing this response:]\n${
                context.partialWork.text}`
        );
    }

    // 4. Pending Tool (only if present)
    if(context.partialWork.pendingToolUse) {
        const toolName = context.partialWork.pendingToolUse.name;
        sections.push(
            `[You were about to use tool "${toolName}" - reconsider if this is still appropriate given the new message]`
        );
    }

    // 5. New Events (only if non-empty)
    if(context.newEvents.length > 0) {
        sections.push(
            `[Events that occurred during your processing:]\n${
                context.newEvents.join('\n')}`
        );
    }

    // 6. New Messages (always included)
    const messageBlocks = map(context.newMessages, msg =>
        `Time: ${msg.timestamp}\n`
        + `Channel: #${msg.channelId}\n`
        + `User: @${msg.userId}\n`
        + `Content: ${msg.content}`
    );

    sections.push(
        `[New message(s) received:]\n${
            messageBlocks.join('\n\n')}`
    );

    // Join all sections with double newlines
    return sections.join('\n\n');
}
