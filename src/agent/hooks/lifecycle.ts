/**
 * Lifecycle Hooks
 *
 * Creates SDK hook callbacks for session lifecycle events:
 * - Stop: logs normal session stop
 * - StopFailure: logs session stop with error
 * - SessionStart: logs session start (source and model)
 * - SessionEnd: logs session end and calls cleanupSession for file cleanup,
 *   unless background tasks are still pending (cleanup deferred to collectBackgroundTasks)
 */
import type { HookCallbackMatcher, HookEvent, SessionEndHookInput, SessionStartHookInput, StopFailureHookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import { cleanupSession } from '../session-cleanup';

/** Callback invoked when the agent session stops normally (Stop hook). */
export type StopCallback = (input: StopHookInput) => void;

/** Callback invoked when the agent session stops with a failure (StopFailure hook). */
export type StopFailureCallback = (input: StopFailureHookInput) => void;

/**
 * Predicate consulted by the SessionEnd hook to decide whether cleanup should
 * be deferred. When true, background tasks are still outstanding and
 * collectBackgroundTasks() will perform the cleanup instead.
 */
export type ShouldDeferCleanup = () => boolean;

/**
 * Creates hook matchers for session lifecycle observability.
 *
 * - Stop: logs normal session completion, calls optional onStop callback
 * - StopFailure: logs session failure with error details, calls optional onStopFailure callback
 * - SessionStart: logs session start with source and model
 * - SessionEnd: logs session end and triggers session file cleanup, unless
 *   shouldDeferCleanup() returns true (cleanup deferred to collectBackgroundTasks)
 *
 * @param shouldDeferCleanup - Optional predicate; when true, SessionEnd skips cleanup
 * @param onStop - Optional callback invoked when the session stops normally
 * @param onStopFailure - Optional callback invoked when the session stops with failure
 * @returns A partial hook map for merging into query options
 */
export function createLifecycleHooks(
    shouldDeferCleanup?: ShouldDeferCleanup,
    onStop?: (input: StopHookInput) => void,
    onStopFailure?: (input: StopFailureHookInput) => void
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
        Stop: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const stopInput = input as StopHookInput;
                        // Stryker disable StringLiteral,ObjectLiteral,MethodExpression: Observability — logging only, no behavior change
                        logger.info({
                            session_id:             stopInput.session_id,
                            hook_event_name:        stopInput.hook_event_name,
                            stop_hook_active:       stopInput.stop_hook_active,
                            last_assistant_message: stopInput.last_assistant_message?.slice(0, 100),
                            msg:                    'Agent session stopped normally',
                        });
                        // Stryker restore StringLiteral,ObjectLiteral
                        // Stryker disable OptionalChaining: Callback invocation side effect
                        onStop?.(stopInput);
                        // Stryker restore OptionalChaining
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
                        // Stryker disable StringLiteral,ObjectLiteral: Observability — logging only, no behavior change
                        logger.error({
                            session_id:      failInput.session_id,
                            hook_event_name: failInput.hook_event_name,
                            error:           failInput.error,
                            error_details:   failInput.error_details,
                            msg:             'Agent session stopped with failure',
                        });
                        // Stryker restore StringLiteral,ObjectLiteral
                        // Stryker disable OptionalChaining: Callback invocation side effect
                        onStopFailure?.(failInput);
                        // Stryker restore OptionalChaining
                        return { 'continue': true };
                    },
                ],
            },
        ],
        SessionStart: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const startInput = input as SessionStartHookInput;
                        // Stryker disable StringLiteral,ObjectLiteral: Observability — logging only, no behavior change
                        logger.info({
                            session_id:      startInput.session_id,
                            hook_event_name: startInput.hook_event_name,
                            source:          startInput.source,
                            model:           startInput.model,
                            agent_type:      startInput.agent_type,
                            msg:             'Agent session started',
                        });
                        // Stryker restore StringLiteral,ObjectLiteral
                        return { 'continue': true };
                    },
                ],
            },
        ],
        SessionEnd: [
            {
                hooks: [
                    async (input): Promise<{ 'continue': boolean }> => {
                        const endInput = input as SessionEndHookInput;
                        // Stryker disable StringLiteral,ObjectLiteral: Observability — logging only, no behavior change
                        logger.info({
                            session_id:      endInput.session_id,
                            hook_event_name: endInput.hook_event_name,
                            reason:          endInput.reason,
                            msg:             'Agent session ended',
                        });
                        // Stryker restore StringLiteral,ObjectLiteral

                        // Clean up session files on end, unless background tasks are still pending.
                        // When pending, collectBackgroundTasks() will call cleanupSession() after
                        // the resume pass completes, ensuring cleanup happens exactly once per session.
                        // Stryker disable BlockStatement: I/O side effect — both branches are logging/cleanup only; return value unaffected
                        let shouldDefer = false;
                        try {
                            shouldDefer = shouldDeferCleanup?.() ?? false;
                        } catch (predicateError) {
                            // Stryker disable StringLiteral,ObjectLiteral: Observability — warning log for unexpected predicate error; fall through to cleanup
                            logger.warn({
                                session_id: endInput.session_id,
                                error:      predicateError,
                                msg:        'SessionEnd: shouldDeferCleanup predicate threw — falling through to cleanup',
                            });
                            // Stryker restore StringLiteral,ObjectLiteral
                        }
                        if(shouldDefer) {
                            // Stryker disable StringLiteral,ObjectLiteral: Observability — logging only, deferred cleanup path
                            logger.info({
                                session_id: endInput.session_id,
                                msg:        'SessionEnd: cleanup deferred — background tasks still pending',
                            });
                            // Stryker restore StringLiteral,ObjectLiteral
                        } else {
                            void cleanupSession(endInput.session_id);
                        }
                        // Stryker restore BlockStatement
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}
