/**
 * Compaction Hooks
 *
 * Creates SDK hook callbacks for context compaction lifecycle events, sink-style: the hooks
 * report onCompactionStart/onCompactionEnd to whatever {@link CompactionSink} they were built
 * with, with no knowledge of what that sink does. The session layer's sink (`src/app/sessions.ts`)
 * is the sole consumer: it reports each event to its session's conductor, the sole writer of
 * compaction ledger events.
 */
import type { HookCallbackMatcher, HookEvent, PostCompactHookInput, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/**
 * Compaction lifecycle sink. `createCompactionHooks` reports to this and nothing else — it has
 * no knowledge of the ledger, presence, or any other downstream consumer.
 */
export interface CompactionSink {
    /** Called by the PreCompact hook, before the SDK compacts context. */
    onCompactionStart(trigger?: 'manual' | 'auto'): void
    /** Called by the PostCompact hook, with the SDK's compaction summary. */
    onCompactionEnd(summary: string): void
}

/**
 * Creates hook matchers for compaction lifecycle observability.
 *
 * PreCompact reports onCompactionStart(trigger) to the sink; PostCompact reports
 * onCompactionEnd(summary). Both log unconditionally and swallow sink errors — a compaction
 * must continue even if the sink's downstream side effect fails.
 *
 * @param sink - Compaction lifecycle sink to report to
 * @returns A partial hook map for merging into query options
 */
export function createCompactionHooks(sink: CompactionSink): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
        PreCompact: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const preInput = input as PreCompactHookInput;
                        logger.info({
                            session_id:      preInput.session_id,
                            hook_event_name: preInput.hook_event_name,
                            trigger:         preInput.trigger,
                            msg:             'Context compaction starting',
                        });

                        // Report to the sink so it can do whatever it does (e.g. fold the trigger
                        // into the session ledger).
                        try {
                            sink.onCompactionStart(preInput.trigger);
                        } catch{
                            // Silent: sink side effects are best-effort observability/presence
                            // hooks. Failure here means a downstream consumer may briefly show
                            // stale state, but compaction must continue — stalling compaction to
                            // surface a sink error would be worse than the silent degradation.
                        }
                        return { 'continue': true };
                    },
                ],
            },
        ],
        PostCompact: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const postInput = input as PostCompactHookInput;
                        // Note: token counts (pre_tokens, post_tokens) are NOT available in
                        // PostCompactHookInput — the SDK exposes them only on the stream event
                        // SDKCompactBoundaryMessage (compact_metadata.pre_tokens), which is
                        // already logged by logSystemEvent() in stream-event-logger.ts. No token
                        // logging here.
                        logger.info({
                            session_id:      postInput.session_id,
                            hook_event_name: postInput.hook_event_name,
                            trigger:         postInput.trigger,
                            summaryLength:   postInput.compact_summary.length,
                            msg:             'Context compaction completed',
                        });

                        // Report to the sink (e.g. record the compaction summary in the session
                        // ledger).
                        try {
                            sink.onCompactionEnd(postInput.compact_summary);
                        } catch{
                            // Silent: sink side effects are best-effort observability/presence
                            // hooks. Failure here means a downstream consumer may remain stuck
                            // showing stale state, but the agent session must continue — a stale
                            // cosmetic phase is preferable to blocking post-compaction processing.
                        }
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
