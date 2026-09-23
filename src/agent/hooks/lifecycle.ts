/**
 * Lifecycle Hooks
 *
 * Creates SDK hook callbacks for the long-lived session core's Stop/StopFailure
 * observability (see {@link createSessionLifecycleHooks}).
 */
import type { HookCallbackMatcher, HookEvent, StopFailureHookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/** Callback invoked when the agent session stops normally (Stop hook). */
export type StopCallback = (input: StopHookInput) => void;

/** Callback invoked when the agent session stops with a failure (StopFailure hook). */
export type StopFailureCallback = (input: StopFailureHookInput) => void;

/** Optional callbacks for {@link createSessionLifecycleHooks}. */
export interface SessionLifecycleHooksDeps {
    /** Invoked when the session's Stop hook fires (the session stopped normally). */
    onStop?:        StopCallback
    /** Invoked when the session's StopFailure hook fires (the session stopped with a failure). */
    onStopFailure?: StopFailureCallback
}

/**
 * Creates hook matchers for the long-lived session core's lifecycle observability: Stop and
 * StopFailure only — no SessionStart (the compaction boot bundle owns that, see ./boot-bundle.ts) and no
 * SessionEnd (the session core has no file-cleanup concept; `openSession`'s `onClosed` callback
 * is how the conductor learns a session ended).
 * @param deps Optional onStop/onStopFailure callbacks
 * @returns A partial hook map with only `Stop` and `StopFailure` entries
 */
export function createSessionLifecycleHooks(deps: SessionLifecycleHooksDeps): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const { onStop, onStopFailure } = deps;
    return {
        Stop: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const stopInput = input as StopHookInput;
                        logger.info({
                            session_id:             stopInput.session_id,
                            hook_event_name:        stopInput.hook_event_name,
                            stop_hook_active:       stopInput.stop_hook_active,
                            last_assistant_message: stopInput.last_assistant_message?.slice(0, 100),
                            msg:                    'Agent session stopped normally',
                        });
                        onStop?.(stopInput);
                        return { 'continue': true };
                    },
                ],
            },
        ],
        StopFailure: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const failInput = input as StopFailureHookInput;
                        logger.error({
                            session_id:      failInput.session_id,
                            hook_event_name: failInput.hook_event_name,
                            error:           failInput.error,
                            error_details:   failInput.error_details,
                            msg:             'Agent session stopped with failure',
                        });
                        onStopFailure?.(failInput);
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
