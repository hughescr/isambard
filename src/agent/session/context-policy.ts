/**
 * Context injection policy for the long-lived session core.
 *
 * Owns two independent, per-process gates that decide what re-seeds into an envelope's
 * context sections rather than being re-sent on every turn:
 *
 * - Per-user memory: {@link ContextPolicy.shouldInjectUserMemory} answers whether the
 *   `[About this user]` block should be rendered again for a given user, and
 *   {@link ContextPolicy.markInjected} records that it just was. A user's memory block is
 *   re-injected on first contact and again once `userMemoryWindowMs` has elapsed since the
 *   last injection.
 * - Events delta: {@link ContextPolicy.eventsDelta} returns the memory-preview-formatted
 *   events recorded since the last {@link ContextPolicy.markEventsSeen} call (or `[]` before
 *   the first mark). Deliberately does NOT construct or wrap `EventDeltaTracker`
 *   (event-delta-tracker.ts) — that class reads `Date.now()` directly and cannot be driven by
 *   an injected clock, which this policy needs for deterministic tests and for the
 *   compaction-time reset. `event-delta-tracker.ts` is untouched by this module.
 *
 * {@link ContextPolicy.resetAll} clears every user mark and the events mark; the compaction
 * sink (P9) calls it after a compaction completes so both gates re-arm as if this were a cold
 * start.
 *
 * @module agent/session/context-policy
 */
import { formatMemoryPreview, type ContextBuilder } from '../context-builder';

/** The subset of `ContextBuilder` this policy depends on. */
export type EventsDeltaSource = Pick<ContextBuilder, 'loadRecentEventsSince'>;

/** Inputs to {@link createContextPolicy}. */
export interface CreateContextPolicyParams {
    /** Millisecond clock, e.g. `() => clock.now()`. Plain function so this module stays independent of any particular Clock type. */
    now:                () => number
    /** How long a user's injected memory block stays "fresh" before it is re-injected. */
    userMemoryWindowMs: number
    contextBuilder:     EventsDeltaSource
    /** Max events fetched per `eventsDelta()` call. Defaults to 50. */
    eventLimit?:        number
}

/** Per-user memory gate plus self-owned events-delta tracking. */
export interface ContextPolicy {
    /** True when `userId`'s memory block has never been injected, or was injected `>= userMemoryWindowMs` ago. */
    shouldInjectUserMemory: (userId: string) => boolean
    /** Records that `userId`'s memory block was just injected, at the current clock time. */
    markInjected:           (userId: string) => void
    /** Clears every user's injection mark and the events mark, re-arming both gates. */
    resetAll:               () => void
    /** Memory-preview-formatted events recorded since the last `markEventsSeen()`; `[]` before the first mark. */
    eventsDelta:            () => Promise<string[]>
    /** Records the current clock time as the events high-water mark. */
    markEventsSeen:         () => void
}

/**
 * Creates a {@link ContextPolicy}.
 * @param params Clock, window and dependencies
 * @returns A fresh policy with no user marks and no events mark
 */
export function createContextPolicy(params: CreateContextPolicyParams): ContextPolicy {
    const { now, userMemoryWindowMs, contextBuilder, eventLimit = 50 } = params;

    const userMarks = new Map<string, number>();
    let lastEventsSeenMs: number | undefined;

    return {
        shouldInjectUserMemory(userId: string): boolean {
            const mark = userMarks.get(userId);
            return mark === undefined || now() - mark >= userMemoryWindowMs;
        },

        markInjected(userId: string): void {
            userMarks.set(userId, now());
        },

        resetAll(): void {
            userMarks.clear();
            lastEventsSeenMs = undefined;
        },

        async eventsDelta(): Promise<string[]> {
            if(lastEventsSeenMs === undefined) {
                return [];
            }

            const currentNow = now();
            const items = await contextBuilder.loadRecentEventsSince(currentNow - lastEventsSeenMs, eventLimit, new Date(currentNow));
            return items.map(item => formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, new Date(currentNow)));
        },

        markEventsSeen(): void {
            lastEventsSeenMs = now();
        },
    };
}
