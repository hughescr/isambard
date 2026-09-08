/**
 * SessionStart boot-bundle hook: injects the async boot bundle (P6's
 * `createBootBundleBuilder`) as `additionalContext` for the sources where a session actually
 * needs re-seeding — `startup`, `resume`, and `compact` (working memory was just reset or is
 * fresh). `clear`/`fork` pass through untouched, and a builder rejection degrades to a bare
 * `{ continue: true }` with a warning rather than blocking the session from starting.
 *
 * An empty string from `build` (R1: an empty `resume` bundle — nothing happened while offline)
 * adds NO `additionalContext` at all, rather than injecting an empty string as context.
 *
 * @module agent/hooks/boot-bundle
 */
import type { HookCallbackMatcher, HookEvent, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';

/** SessionStart sources the boot bundle is built for. */
type BootBundleSource = 'startup' | 'resume' | 'compact';

const BOOT_BUNDLE_SOURCES: ReadonlySet<BootBundleSource> = new Set(['startup', 'resume', 'compact']);

/**
 * Creates the SessionStart hook matcher that injects a freshly-built boot bundle for
 * `startup`/`resume`/`compact`, and passes `clear`/`fork` through unchanged.
 * @param build Async boot-bundle builder, given the triggering source; its resolved string becomes `additionalContext`
 * @returns A partial hook map with only a `SessionStart` entry
 */
export function createBootBundleHooks(build: (source: BootBundleSource) => Promise<string>): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
        SessionStart: [
            {
                hooks: [
                    async (input) => {
                        const startInput = input as SessionStartHookInput;
                        const source = startInput.source;
                        if(!BOOT_BUNDLE_SOURCES.has(source as BootBundleSource)) {
                            return { 'continue': true };
                        }

                        try {
                            const additionalContext = await build(source as BootBundleSource);
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
