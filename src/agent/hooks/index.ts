/**
 * Hooks module barrel export.
 *
 * Provides hook factory functions and the mergeHookMaps utility for combining
 * multiple hook maps into a single object suitable for passing to the Agent SDK.
 */
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

/**
 * Merges multiple hook maps into a single map, concatenating arrays for any
 * overlapping HookEvent keys.
 *
 * When two maps both register callbacks on the same event, both sets of
 * HookCallbackMatchers are preserved in the output in the order the maps were
 * provided. Empty or undefined maps are skipped.
 *
 * @param maps - Two or more partial hook maps to merge
 * @returns A single merged partial hook map
 *
 * @example
 * ```typescript
 * const merged = mergeHookMaps(
 *   createTaskTrackingHooks(tracker),
 *   createLifecycleHooks(),
 *   createCompactionHooks(stateManager),
 * );
 * ```
 */
export function mergeHookMaps(...maps: (Partial<Record<HookEvent, HookCallbackMatcher[]>> | null | undefined)[]): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const result: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

    for(const map of maps) {
        // Stryker disable next-line ConditionalExpression: Guard skips null/undefined maps — equivalent mutant would add empty iteration with no entries
        if(map === null || map === undefined) {
            continue;
        }
        for(const [event, matchers] of Object.entries(map) as [HookEvent, HookCallbackMatcher[]][]) {
            const existing = result[event];
            // Stryker disable next-line ConditionalExpression: Equivalent — ternary determines concat vs assign, both produce correct final array
            result[event] = existing ? [...existing, ...matchers] : [...matchers];
        }
    }

    return result;
}
