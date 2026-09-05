/**
 * Compaction Hooks
 *
 * Creates SDK hook callbacks for context compaction lifecycle events, sink-style: the hooks
 * report onCompactionStart/onCompactionEnd to whatever {@link CompactionSink} they were built
 * with, with no knowledge of what that sink does. `createBotStateCompactionSink` is the one
 * adapter onto BotStateManagerImpl, applied once at the composition root (src/index.ts) so the
 * one-shot path keeps its existing presence behaviour (PreCompact enters 'compacting'
 * ActivityPhase, PostCompact restores the prior phase — the ActivityPhase change triggers the
 * existing subscriber mechanism, so presence updates flow automatically).
 */
import type { HookCallbackMatcher, HookEvent, PostCompactHookInput, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/**
 * Compaction lifecycle sink. `createCompactionHooks` reports to this and nothing else — it has
 * no knowledge of BotStateManager, ledgers, or any other consumer.
 */
export interface CompactionSink {
    /** Called by the PreCompact hook, before the SDK compacts context. */
    onCompactionStart(trigger?: 'manual' | 'auto'): void
    /** Called by the PostCompact hook, with the SDK's compaction summary. */
    onCompactionEnd(summary: string): void
}

/**
 * Minimal interface for the one-shot path's presence-phase compaction dependency.
 * Satisfied by BotStateManagerImpl (and any test double). Adapted onto {@link CompactionSink}
 * by {@link createBotStateCompactionSink}.
 */
export interface CompactionStateManager {
    /**
     * Stash the current activity phase and set phase to 'compacting'.
     * Called by the PreCompact hook so the prior phase can be restored after compaction.
     */
    stashAndSetCompacting(trigger?: 'manual' | 'auto'): void
    /**
     * Restore the phase that was stashed by stashAndSetCompacting().
     * Called by the PostCompact hook to bring presence back to the pre-compaction state.
     */
    restoreFromCompacting(): void
}

/**
 * Adapts a {@link CompactionStateManager} (BotStateManagerImpl's narrow view) onto the
 * sink-style {@link CompactionSink} interface, so the one-shot path's existing presence
 * behaviour is unchanged under the sink consolidation. Only captures the reference — it does
 * not call either state-manager method at construction time.
 *
 * @param stateManager - State manager to update activity phase on
 * @returns A CompactionSink that stashes/restores the activity phase
 */
export function createBotStateCompactionSink(stateManager: CompactionStateManager): CompactionSink {
    return {
        onCompactionStart: (trigger) => {
            stateManager.stashAndSetCompacting(trigger);
        },
        onCompactionEnd: () => {
            stateManager.restoreFromCompacting();
        },
    };
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
                        // Stryker disable StringLiteral,ObjectLiteral: Observability — logging only
                        logger.info({
                            session_id:      preInput.session_id,
                            hook_event_name: preInput.hook_event_name,
                            trigger:         preInput.trigger,
                            msg:             'Context compaction starting',
                        });
                        // Stryker restore StringLiteral,ObjectLiteral

                        // Report to the sink so it can do whatever it does (e.g. stash the prior
                        // activity phase; see createBotStateCompactionSink).
                        // Stryker disable BlockStatement: Sink side effect — outcome doesn't affect return value
                        try {
                            sink.onCompactionStart(preInput.trigger);
                        } catch{
                            // Silent: sink side effects are best-effort observability/presence
                            // hooks. Failure here means a downstream consumer may briefly show
                            // stale state, but compaction must continue — stalling compaction to
                            // surface a sink error would be worse than the silent degradation.
                        }
                        // Stryker restore BlockStatement
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
                        // already logged by logSystemEvent() in agent.ts. No token logging here.
                        // Stryker disable StringLiteral,ObjectLiteral: Observability — logging only
                        logger.info({
                            session_id:      postInput.session_id,
                            hook_event_name: postInput.hook_event_name,
                            trigger:         postInput.trigger,
                            summaryLength:   postInput.compact_summary.length,
                            msg:             'Context compaction completed',
                        });
                        // Stryker restore StringLiteral,ObjectLiteral

                        // Report to the sink (e.g. restore the phase stashed before compaction
                        // started; see createBotStateCompactionSink).
                        // Stryker disable BlockStatement: Sink side effect — outcome doesn't affect return value
                        try {
                            sink.onCompactionEnd(postInput.compact_summary);
                        } catch{
                            // Silent: sink side effects are best-effort observability/presence
                            // hooks. Failure here means a downstream consumer may remain stuck
                            // showing stale state, but the agent session must continue — a stale
                            // cosmetic phase is preferable to blocking post-compaction processing.
                        }
                        // Stryker restore BlockStatement
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
