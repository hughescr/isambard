/**
 * Quota threshold notes and the perch quota ceiling (docs/plans/session-peers-and-quota.md,
 * block 5).
 *
 * Block 4 already puts the subscription's utilization on every turn's time header, which is the
 * passive surface. This module is the active one, in the style of
 * {@link import('./health-notification').createHealthOutageCoalescer}: it watches the quota a
 * ledger carries and calls the shared notification bridge — ALWAYS `wake: false`, so a threshold
 * note accumulates into the transcript and is read on the next turn the session takes anyway,
 * and can never open a turn (and never spend quota) just to announce that quota is running out.
 *
 * Three facts govern the shape:
 *
 * 1. **Per window instance, not per reading.** Each window (`fiveHour`, `sevenDay`) is tracked by
 *    the `resetsAt` it reports; a FORWARD move of `resetsAt` IS the reset, and starts a fresh
 *    instance with fresh thresholds. A backward move is a stale ledger and is dropped whole (see
 *    {@link createQuotaNotes}'s `advance`). Per-model weekly windows are deliberately not tracked
 *    — neither session paces itself against those, and they would triple the notes for the same
 *    spend.
 * 2. **Peak, never the latest value.** Both roles' ledgers are folded in (one subscription each),
 *    and the same reading reaches them a turn apart, so a lower number arriving after a higher
 *    one is a stale ledger, not a drop. Thresholds and {@link QuotaNotes.isPaused} therefore read
 *    the instance's peak, and a reset is recognised ONLY from a changed `resetsAt` — never from a
 *    number going down. A source that reports no `resetsAt` at all consequently gets threshold
 *    notes (keyed `none`) but never a reset note.
 * 3. **Delivery-gated memory.** `notify()` returns `false` while the bridge has no open conductor
 *    (see `notification-bridge.ts`'s module doc), which is reachable at boot. A note is marked
 *    handled only once `notify()` reports it was actually taken, so an undelivered note is
 *    retried on the next reading instead of being lost for the life of the window — the same
 *    rule, and the same reasoning, as the health-outage coalescer's "already reported" memory.
 *
 * {@link QuotaNotes.isPaused} is the perch ceiling: true once the five-hour window's peak reaches
 * `perchPauseAtPercent`. The composition root ORs it with the daily cost ceiling's own
 * `isPaused()` into the single `isCostPaused` predicate `scheduler.ts` already consults and
 * presence already renders `⏸ perch` from, so no new plumbing reaches perch. Like
 * `cost-ceiling.ts`'s `ceilingUsd`, an omitted `perchPauseAtPercent` disables the ceiling
 * outright, and the pause self-clears when the window rolls over — no restart.
 *
 * @module agent/session/quota-notes
 */
import type { Ledger, QuotaWindow } from './ledger';
import type { NotifyFn } from './notification-bridge';

/** The spec's default thresholds: a note at 75% of a window, and another at 90%. */
export const DEFAULT_QUOTA_NOTIFY_PERCENTS: readonly number[] = [75, 90];

/** The unified windows this module tracks; see the module doc for why per-model windows are not. */
const TRACKED_WINDOWS = ['fiveHour', 'sevenDay'] as const;

/** One of {@link TRACKED_WINDOWS} — also the `window` segment of every dedupe key. */
type TrackedWindow = typeof TRACKED_WINDOWS[number];

/** How each window is named in a note's prose. */
const WINDOW_LABEL: Record<TrackedWindow, string> = { fiveHour: 'five-hour', sevenDay: 'weekly' };

/** Dependencies for {@link createQuotaNotes}. */
export interface CreateQuotaNotesParams {
    /** The shared notification bridge's `notify` — every note goes out `wake: false`. */
    notify:               NotifyFn
    /** Thresholds, in percent; defaults to {@link DEFAULT_QUOTA_NOTIFY_PERCENTS}. Given explicitly, it REPLACES the defaults. */
    notifyAtPercents?:    readonly number[]
    /** Five-hour utilization (percent) at which {@link QuotaNotes.isPaused} pauses perch; omitted disables the ceiling. */
    perchPauseAtPercent?: number
}

/** What {@link createQuotaNotes} returns. */
export interface QuotaNotes {
    /**
     * Folds one ledger's current quota in — subscribe it to every role's `LedgerStore`, exactly
     * like `cost-ceiling.ts`'s `record`. Cheap and idempotent: a reading that crosses nothing new
     * notifies nothing.
     */
    record:   (ledger: Pick<Ledger, 'quota'>) => void
    /** Whether the five-hour window has reached `perchPauseAtPercent`. Always false without one. */
    isPaused: () => boolean
}

/** One window instance's tracked state — see the module doc for why `peak` and not the latest value. */
interface WindowState {
    /** The `resetsAt` of the instance this state belongs to; `undefined` when the source reports none. */
    resetsAtMs?: number
    /** The highest utilization seen for this instance. */
    peak:        number
    /** Thresholds already notified (and delivered) for this instance. */
    notified:    Set<number>
    /** The ended instance's peak while its reset note is still waiting to be delivered; `undefined` once it has been (or was never owed). */
    resetNote?:  number
}

/** The `resetsAt` segment of a dedupe key: the instance's epoch ms, or `none` for a source that reports none. */
function resetsAtKey(resetsAtMs: number | undefined): string {
    return resetsAtMs === undefined ? 'none' : String(resetsAtMs);
}

/**
 * Builds the quota notes. See the module doc for the per-instance, peak-based and delivery-gated
 * semantics, and for the perch ceiling `isPaused` implements.
 * @param params See {@link CreateQuotaNotesParams}.
 * @returns A {@link QuotaNotes}.
 */
export function createQuotaNotes(params: CreateQuotaNotesParams): QuotaNotes {
    const { notify, notifyAtPercents = DEFAULT_QUOTA_NOTIFY_PERCENTS, perchPauseAtPercent } = params;
    // The threshold below which a rolled-over window was never worth announcing, so its reset is
    // not worth announcing either.
    const lowestPercent = Math.min(...notifyAtPercents);
    const states = new Map<TrackedWindow, WindowState>();

    /**
     * Folds one window's reading into its tracked state, opening a fresh instance when `resetsAt`
     * moves FORWARD. A reading whose `resetsAt` is older than the tracked instance's is a stale
     * ledger, not a rollover: `Ledger.quota` is sticky per role, so the quieter role keeps
     * re-delivering the ended window's numbers long after the other role has already seen the
     * reset. Such a reading is dropped whole — it neither raises the peak nor opens an instance —
     * which is the same "a lower number is staleness, not a drop" rule the module doc states,
     * applied across instances rather than within one.
     */
    function advance(name: TrackedWindow, window: QuotaWindow): WindowState {
        const resetsAtMs = window.resetsAt?.getTime();
        const previous = states.get(name);
        if(previous !== undefined) {
            // Checked BEFORE the same-instance test, so `<` is the only comparison that can hold
            // here: an equal `resetsAt` falls through and raises the peak, as it must.
            if(previous.resetsAtMs !== undefined && resetsAtMs !== undefined && resetsAtMs < previous.resetsAtMs) {
                return previous;
            }
            if(previous.resetsAtMs === resetsAtMs) {
                previous.peak = Math.max(previous.peak, window.utilization);
                return previous;
            }
        }
        const state: WindowState = {
            resetsAtMs,
            peak:      window.utilization,
            notified:  new Set(),
            // A rollover is only worth a note when the window that ended had actually reached the
            // lowest threshold Craig was told about; the very first reading of a process ends
            // nothing at all.
            resetNote: previous !== undefined && previous.peak >= lowestPercent ? previous.peak : undefined,
        };
        states.set(name, state);
        return state;
    }

    /** Emits the pending reset note, if any, clearing it only once the bridge takes it. */
    function noteReset(name: TrackedWindow, state: WindowState, at: Date): void {
        if(state.resetNote === undefined) {
            return;
        }
        const delivered = notify({
            source:    'quota',
            wake:      false,
            at,
            dedupeKey: `${name}:reset:${resetsAtKey(state.resetsAtMs)}`,
            text:      `Quota: the ${WINDOW_LABEL[name]} window has reset; it was at ${Math.round(state.resetNote)}%.`,
        });
        if(delivered) {
            state.resetNote = undefined;
        }
    }

    /**
     * Emits at most ONE threshold note per reading: the highest threshold newly crossed. Every
     * threshold that reading crossed is remembered together, so a window first seen at 92% says
     * "passed 90%" once rather than announcing 75% too, and never announces 75% afterwards.
     */
    function noteThresholds(name: TrackedWindow, state: WindowState, at: Date): void {
        const crossed = notifyAtPercents.filter(percent => state.peak >= percent && !state.notified.has(percent));
        if(crossed.length === 0) {
            return;
        }
        const highest = Math.max(...crossed);
        const delivered = notify({
            source:    'quota',
            wake:      false,
            at,
            dedupeKey: `${name}:${highest}:${resetsAtKey(state.resetsAtMs)}`,
            text:      `Quota: the ${WINDOW_LABEL[name]} window has passed ${highest}% (now ${Math.round(state.peak)}%) of the shared Claude subscription.`,
        });
        if(delivered) {
            for(const percent of crossed) {
                state.notified.add(percent);
            }
        }
    }

    return {
        record(ledger: Pick<Ledger, 'quota'>): void {
            const { quota } = ledger;
            if(quota === undefined) {
                return;
            }
            for(const name of TRACKED_WINDOWS) {
                const window = quota[name];
                if(window === undefined) {
                    continue;
                }
                const state = advance(name, window);
                noteReset(name, state, quota.at);
                noteThresholds(name, state, quota.at);
            }
        },

        isPaused(): boolean {
            const state = states.get('fiveHour');
            return perchPauseAtPercent !== undefined && state !== undefined && state.peak >= perchPauseAtPercent;
        },
    };
}
