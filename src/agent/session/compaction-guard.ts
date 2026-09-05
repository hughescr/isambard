/**
 * Host-driven compaction guard (design doc section 6). Watches context-usage percentage after
 * every turn and, once it crosses `thresholdPercent` with an empty queue and no compaction
 * already in flight, submits a `/compact` turn and holds until the compaction is observably
 * over — a `compact_boundary` frame, a PostCompact report, the `/compact` turn's own result with
 * no boundary seen (the CLI's "not enough messages to compact" path), the CLI's
 * `error-compacting-conversation` notification, or a clock ceiling. A failed attempt backs off:
 * the guard skips a doubling number of turn ends (capped at 8) before trying again, reset by the
 * next success.
 *
 * This module never reads the SDK stream itself — the conductor (P7's other half) is the one
 * reader loop, and calls {@link CompactionGuard.onFrame} for every raw frame it observes and
 * {@link CompactionGuard.onCompactionFinished} from its PostCompact hook handler (which is not
 * itself a stream frame). `ledgerStore` is used write-only, purely so `context_usage_polled`,
 * `compaction_started` and `compaction_failed` are visible on the ledger the same way every other
 * conductor-observed fact is; the guard keeps its own in-flight/backoff state privately.
 *
 * @module agent/session/compaction-guard
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';
import type { LedgerStore } from './ledger';
import type { Clock, ContextUsageSummary, SessionQuery, TimerHandle } from './types';

const MAX_BACKOFF_SKIPS = 8;

/** A reason a compaction attempt ended without completing, carried on the `compaction_failed` ledger event. */
export type CompactionFailureReason = 'no-boundary' | 'notification' | 'timeout' | 'submit-rejected';

/** Dependencies {@link createCompactionGuard} needs. */
export interface CreateCompactionGuardParams {
    getContextUsage:  SessionQuery['getContextUsage']
    submitCompact:    () => Promise<void>
    ledgerStore:      Pick<LedgerStore, 'dispatch'>
    clock:            Clock
    thresholdPercent: number
    /** How long to hold before giving up on an observable release and failing with `'timeout'`. Default 300000 (5 minutes). */
    ceilingMs?:       number
    logger:           Pick<Logger, 'info' | 'warn' | 'error'>
}

/** Host-driven compaction guard returned by {@link createCompactionGuard}. */
export interface CompactionGuard {
    /**
     * Call after every turn ends (a `result` frame processed), with whether the input queue is
     * now empty. Always polls and logs context usage; may submit a `/compact` turn.
     */
    onTurnEnd:            (args: { queueEmpty: boolean }) => Promise<void>
    /**
     * Call for every raw SDK frame observed, in order. Only has an effect while a compaction is
     * in flight: releases on `compact_boundary` (success), on the `error-compacting-conversation`
     * notification (failure), and on any `result` frame — the `/compact` turn's own answer, when
     * nothing else already released the hold (failure, `'no-boundary'`).
     */
    onFrame:              (frame: SDKMessage) => void
    /** Call when the PostCompact hook reports a finished compaction (not itself a stream frame). Releases as success. */
    onCompactionFinished: () => void
}

/**
 * @param params See {@link CreateCompactionGuardParams}.
 */
export function createCompactionGuard(params: CreateCompactionGuardParams): CompactionGuard {
    const { getContextUsage, submitCompact, ledgerStore, clock, thresholdPercent, ceilingMs = 300_000, logger } = params;

    let inFlight = false;
    let ceilingTimer: TimerHandle | undefined;
    let nextBackoffSkips = 1;
    let skipRemaining = 0;

    function release(reason: 'success' | CompactionFailureReason): void {
        if(!inFlight) {
            return;
        }
        inFlight = false;
        if(ceilingTimer !== undefined) {
            clock.clearTimer(ceilingTimer);
            ceilingTimer = undefined;
        }
        if(reason === 'success') {
            nextBackoffSkips = 1;
            skipRemaining = 0;
            return;
        }
        logger.error({ reason }, 'Compaction guard: compaction failed');
        ledgerStore.dispatch({ type: 'compaction_failed', reason, at: new Date(clock.now()) });
        skipRemaining = nextBackoffSkips;
        nextBackoffSkips = Math.min(MAX_BACKOFF_SKIPS, nextBackoffSkips * 2);
    }

    async function submit(): Promise<void> {
        inFlight = true;
        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(clock.now()) });
        ceilingTimer = clock.setTimer(() => {
            release('timeout');
        }, ceilingMs);
        try {
            await submitCompact();
        } catch (error) {
            logger.warn({ error }, 'Compaction guard: submitCompact rejected');
            release('submit-rejected');
        }
    }

    return {
        async onTurnEnd({ queueEmpty }: { queueEmpty: boolean }): Promise<void> {
            let usage: ContextUsageSummary;
            try {
                usage = await getContextUsage({ detail: 'summary' });
            } catch (error) {
                logger.warn({ error }, 'Compaction guard: getContextUsage rejected');
                return;
            }
            logger.info({ percentage: usage.percentage }, 'Compaction guard: context usage polled');
            ledgerStore.dispatch({ type: 'context_usage_polled', usage, at: new Date(clock.now()) });

            if(inFlight) {
                return;
            }
            if(skipRemaining > 0) {
                skipRemaining -= 1;
                return;
            }
            if(usage.percentage < thresholdPercent || !queueEmpty) {
                return;
            }
            await submit();
        },

        onFrame(frame: SDKMessage): void {
            if(!inFlight) {
                return;
            }
            if(frame.type === 'system' && frame.subtype === 'compact_boundary') {
                release('success');
                return;
            }
            if(frame.type === 'system' && frame.subtype === 'notification' && frame.key === 'error-compacting-conversation') {
                release('notification');
                return;
            }
            if(frame.type === 'result') {
                release('no-boundary');
            }
        },

        onCompactionFinished(): void {
            release('success');
        },
    };
}
