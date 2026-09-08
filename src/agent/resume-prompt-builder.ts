/**
 * Resume Prompt Builder Module
 *
 * {@link ResumeContext} is `src/integrations/discord/message-coordinator.ts`'s own
 * interrupted-stream resume-context shape (only its `partialWork` is read, by
 * `setup/conductor-processor.ts`, to render a `[RESUME NOTE]` block via
 * {@link buildResumeNote}); that module builds the long-lived session core's short resume note.
 */
import type { StreamProgress } from './stream-tracker';
import type { MessageContext } from './types';

/**
 * Context needed to build a resume prompt after an interruption.
 */
export interface ResumeContext {
    /** Partial work captured from interrupted stream */
    partialWork: StreamProgress
    /** New messages that arrived during processing */
    newMessages: MessageContext[]
}

/**
 * Builds the short resume note carried by a `resume`-kind envelope (P6) when the long-lived
 * session's human-wait escalation interrupts a running turn: just the partial-work blocks, with
 * no events section and no new-messages section (those already arrive via their own envelopes
 * on the same session).
 * @param progress Partial work captured from the interrupted stream
 * @returns The resume note, or `undefined` when there is no partial work to report
 */
export function buildResumeNote(progress: StreamProgress): string | undefined {
    if(!progress.thinking && !progress.text && !progress.pendingToolUse) {
        return undefined;
    }

    const sections: string[] = ['[RESUME NOTE]'];

    if(progress.thinking) {
        sections.push(`[Your thinking at the point of interruption:]\n${progress.thinking}`);
    }

    if(progress.text) {
        sections.push(`[You were composing this response:]\n${progress.text}`);
    }

    if(progress.pendingToolUse) {
        const toolName = progress.pendingToolUse.name;
        sections.push(`[You were about to use tool "${toolName}" - reconsider if this is still appropriate given the new message]`);
    }

    return sections.join('\n\n');
}
