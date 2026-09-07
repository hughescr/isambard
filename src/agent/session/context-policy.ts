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
 * - State top-set delta: {@link ContextPolicy.stateTopSetDelta} diffs the CURRENT state top set
 *   (`loadStateTopSet(now)` — the same top-8-full-plus-30-preview set `loadHotState` renders)
 *   against the set captured at the last {@link ContextPolicy.markStateTopSetSeen} call,
 *   reporting paths that newly entered the set (`added`), paths that fell out of it
 *   (`removed`), and paths present at both marks whose content fingerprint
 *   (`StateTopSetItem.contentFingerprint`, a hash of the item's content — deliberately NOT its
 *   `updatedAt`, which read-only access also bumps) differs (`changed`). Empty before the first
 *   mark, matching `eventsDelta`.
 *   {@link ContextPolicy.markStateTopSetSeen} is deliberately async and itself fetches the
 *   top set, unlike the synchronous `markEventsSeen()`: a timestamp is enough to drive
 *   `eventsDelta`'s time-windowed query, but a set-membership-plus-fingerprint diff has no
 *   "since" query equivalent — the mark must capture the actual baseline set to compare
 *   against next time. This is a deliberate asymmetry with `markEventsSeen`, not an oversight.
 *
 * {@link ContextPolicy.resetAll} clears every user mark, the events mark, and the state
 * top-set mark; the compaction sink (P9) calls it after a compaction completes so every gate
 * re-arms as if this were a cold start.
 *
 * @module agent/session/context-policy
 */
import { formatMemoryPreview, type ContextBuilder } from '../context-builder';

/** The subset of `ContextBuilder` this policy depends on for the events-delta gate. */
export type EventsDeltaSource = Pick<ContextBuilder, 'loadRecentEventsSince'>;

/** The subset of `ContextBuilder` this policy depends on for the state-top-set-delta gate. */
export type StateTopSetSource = Pick<ContextBuilder, 'loadStateTopSet'>;

/** Inputs to {@link createContextPolicy}. */
export interface CreateContextPolicyParams {
    /** Millisecond clock, e.g. `() => clock.now()`. Plain function so this module stays independent of any particular Clock type. */
    now:                () => number
    /** How long a user's injected memory block stays "fresh" before it is re-injected. */
    userMemoryWindowMs: number
    contextBuilder:     EventsDeltaSource & StateTopSetSource
    /** Max events fetched per `eventsDelta()` call. Defaults to 50. */
    eventLimit?:        number
}

/** The paths that changed between two state-top-set marks. */
export interface StateTopSetDelta {
    /** Paths present now that were absent from the last mark's set. */
    added:   string[]
    /** Paths present at the last mark's set that are absent now. */
    removed: string[]
    /** Paths present at both marks whose content fingerprint differs. */
    changed: string[]
}

/** Per-user memory gate plus self-owned events-delta and state-top-set-delta tracking. */
export interface ContextPolicy {
    /** True when `userId`'s memory block has never been injected, or was injected `>= userMemoryWindowMs` ago. */
    shouldInjectUserMemory: (userId: string) => boolean
    /** Records that `userId`'s memory block was just injected, at the current clock time. */
    markInjected:           (userId: string) => void
    /** Clears every user's injection mark, the events mark, and the state-top-set mark, re-arming every gate. */
    resetAll:               () => void
    /** Memory-preview-formatted events recorded since the last `markEventsSeen()`; `[]` before the first mark. */
    eventsDelta:            () => Promise<string[]>
    /** Records the current clock time as the events high-water mark. */
    markEventsSeen:         () => void
    /** Added/removed/changed paths in the state top set since the last `markStateTopSetSeen()`; all empty before the first mark. */
    stateTopSetDelta:       () => Promise<StateTopSetDelta>
    /** Fetches the current state top set and records it as the next comparison baseline. */
    markStateTopSetSeen:    () => Promise<void>
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
    let stateTopSetBaseline: Map<string, string> | undefined;

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
            stateTopSetBaseline = undefined;
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

        async stateTopSetDelta(): Promise<StateTopSetDelta> {
            if(stateTopSetBaseline === undefined) {
                return { added: [], removed: [], changed: [] };
            }

            const baseline = stateTopSetBaseline;
            const currentItems = await contextBuilder.loadStateTopSet(new Date(now()));
            const currentPaths = new Set<string>(currentItems.map(item => item.path));

            const added: string[] = [];
            const changed: string[] = [];
            for(const item of currentItems) {
                const baselineFingerprint = baseline.get(item.path);
                if(baselineFingerprint === undefined) {
                    added.push(item.path);
                } else if(baselineFingerprint !== item.contentFingerprint) {
                    changed.push(item.path);
                }
            }

            const removed: string[] = [];
            for(const path of baseline.keys()) {
                if(!currentPaths.has(path)) {
                    removed.push(path);
                }
            }

            return { added, removed, changed };
        },

        async markStateTopSetSeen(): Promise<void> {
            const items = await contextBuilder.loadStateTopSet(new Date(now()));
            stateTopSetBaseline = new Map<string, string>(items.map(item => [item.path, item.contentFingerprint]));
        },
    };
}
