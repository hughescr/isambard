/**
 * SessionStart boot-bundle hook: injects the compaction boot bundle (P6's
 * `createBootBundleBuilder`, `compact` kind) as `additionalContext` once a compaction has reset
 * working memory. A builder rejection degrades to a bare `{ continue: true }` with a warning
 * rather than blocking the session, and an empty string adds NO `additionalContext` at all.
 *
 * Compact only (#98). The real Claude Agent SDK never invokes an SDK-callback SessionStart hook
 * for `startup` or `resume` in a streaming-input `query()` session
 * (anthropics/claude-agent-sdk-typescript#465; probed on SDK 0.3.258, 0.3.273 and 0.3.280), so
 * the fresh and restart-resume bundles travel in the conductor's opening `[BOOT]` handshake
 * instead (`buildBootBundle` in `../session/conductor.ts`). A `startup`/`resume` call reaching
 * this hook is therefore a tripwire: it logs a warning and adds nothing, so an upstream fix can
 * never deliver the bundle twice, and the log line says when to re-evaluate. `clear`/`fork` pass
 * through untouched.
 *
 * @module agent/hooks/boot-bundle
 */
import type { HookCallbackMatcher, HookEvent, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/**
 * Creates the SessionStart hook matcher that injects a freshly built compaction bundle for
 * `compact`, warns (and adds nothing) for `startup`/`resume`, and passes `clear`/`fork` through.
 * @param buildCompact Async compaction-bundle builder; its resolved string becomes `additionalContext`
 * @returns A partial hook map with only a `SessionStart` entry
 */
export function createBootBundleHooks(buildCompact: () => Promise<string>): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
        SessionStart: [
            {
                hooks: [
                    async (input) => {
                        const { source } = input as SessionStartHookInput;
                        if(source === 'startup' || source === 'resume') {
                            logger.warn({
                                source,
                                msg: `SessionStart ${source} callback fired: upstream claude-agent-sdk-typescript#465 appears fixed. The boot bundle already went in the [BOOT] handshake, so this hook adds nothing; re-evaluate delivering it here (#98).`,
                            });
                            return { 'continue': true };
                        }
                        if(source !== 'compact') {
                            return { 'continue': true };
                        }

                        try {
                            const additionalContext = await buildCompact();
                            if(additionalContext === '') {
                                return { 'continue': true };
                            }
                            return {
                                'continue':         true,
                                hookSpecificOutput: {
                                    hookEventName: 'SessionStart' as const,
                                    additionalContext,
                                },
                            };
                        } catch (error) {
                            logger.warn({ error, source, msg: 'Boot bundle builder rejected; starting session without it' });
                            return { 'continue': true };
                        }
                    },
                ],
            },
        ],
    };
}
