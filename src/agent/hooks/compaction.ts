/**
 * Compaction Hooks
 *
 * Creates SDK hook callbacks for context compaction lifecycle events:
 * - PreCompact: enters 'compacting' ActivityPhase on BotStateManager
 * - PostCompact: clears the 'compacting' ActivityPhase and logs completion
 *
 * The ActivityPhase change triggers the existing subscriber mechanism
 * (presence updates flow automatically once the phase changes).
 */
import type { HookCallbackMatcher, HookEvent, PostCompactHookInput, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/**
 * Minimal interface for the compaction hooks dependency.
 * Satisfied by BotStateManagerImpl (and any test double).
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
 * Creates hook matchers for compaction lifecycle observability.
 *
 * PreCompact sets a 'compacting' activity phase so presence can reflect the
 * compaction in progress. PostCompact clears it and logs token counts.
 *
 * @param botStateManager - State manager to update activity phase on
 * @returns A partial hook map for merging into query options
 */
export function createCompactionHooks(botStateManager: CompactionStateManager): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
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

                        // Stash prior phase and enter compacting so presence can reflect this.
                        // The prior phase is restored by PostCompact via restoreFromCompacting().
                        // Stryker disable BlockStatement: State update side effect — outcome doesn't affect return value
                        try {
                            botStateManager.stashAndSetCompacting(preInput.trigger);
                        } catch{
                            // Silent: stashAndSetCompacting updates in-memory presence state only.
                            // Failure here means the bot status may briefly show a stale phase
                            // but compaction must continue — stalling compaction to surface a
                            // cosmetic presence error would be worse than the silent degradation.
                            // Persistent presence failures surface via the health registry.
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

                        // Restore the phase stashed before compaction started.
                        // Stryker disable BlockStatement: State update side effect — outcome doesn't affect return value
                        try {
                            botStateManager.restoreFromCompacting();
                        } catch{
                            // Silent: restoreFromCompacting updates in-memory presence state only.
                            // Failure here means the bot may remain stuck showing 'compacting'
                            // status but the agent session must continue — a stale cosmetic phase
                            // is preferable to blocking post-compaction processing. Persistent
                            // presence failures surface via the health registry.
                        }
                        // Stryker restore BlockStatement
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
