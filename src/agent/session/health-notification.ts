/**
 * Pure health-outage predicate and coalescer (Q5 / plan amendment B2's shared notify contract).
 *
 * {@link shouldNotifyHealthChange} is the sole authority on which {@link ServiceHealthChange}
 * transitions are outage-worthy — a deliberate "never silently fail to notify a boot-time
 * outage" choice: EVERY non-offline predecessor wakes on transition into `'offline'`, including
 * `'starting'` (a service that fails during its own startup connect, reachable via the
 * lifecycle machine's `starting` state `CONNECT_FAIL`/`CONNECTION_LOST` transitions). A
 * `'disabled' -> 'offline'` transition is structurally unreachable per
 * `src/services/lifecycle-orchestrator.ts` (`disabled` only transitions to `starting`) and is
 * not specifically asserted, but is also unaffected: the predicate only cares about the
 * (previous, new) pair, not which of the two is `'disabled'`.
 *
 * {@link createHealthOutageCoalescer} batches same-window offline transitions into ONE wake
 * notification naming every affected service. Per `src/services/lifecycle-orchestrator.ts`,
 * `epoch` increments only on `CONFIGURE`/`CONNECTION_LOST`, never on
 * `CONNECT_FAIL`/`RECOVERY_FAIL` — so a service that flaps
 * `online -> offline -> recovering -> offline` within one connection-loss episode keeps one
 * epoch throughout. The coalescer keys its own "already handled" memory on `${service}:${epoch}`
 * so that flap is intentionally coalesced/deduped to a single outage notice, not one per
 * transition, while a genuinely new epoch (a fresh `CONFIGURE`/`CONNECTION_LOST`) always starts
 * a new outage episode and notifies again.
 *
 * A batch is a fixed window from its first `report()`: the first report of a fresh batch starts
 * a `clock.setTimer(flush, windowMs)`; later reports arriving before that timer fires just join
 * the same batch (the timer is not rescheduled) — so the batch always flushes exactly `windowMs`
 * after its first member arrived, regardless of how many more join afterward.
 *
 * @module agent/session/health-notification
 */
import type { NotifyFn } from './notification-bridge';
import type { Clock, TimerHandle } from './types';
import type { ServiceHealthChange } from '@/services';

/** A low single-digit-seconds value: the outage-notification latency bound (batch window). */
export const DEFAULT_HEALTH_OUTAGE_WINDOW_MS = 5000;

/** Default capacity of the coalescer's bounded FIFO "already reported" memory — see {@link CreateHealthOutageCoalescerParams.alreadyReportedCapacity}. */
export const DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY = 200;

/**
 * The sole authority on which `ServiceHealthChange` transitions are outage-worthy: true for
 * EVERY transition into `'offline'` from any non-`'offline'` predecessor (including
 * `'starting'`), false otherwise.
 * @param change The health transition to classify
 * @returns Whether this transition should wake a notification (directly, or via the coalescer)
 */
export function shouldNotifyHealthChange(change: ServiceHealthChange): boolean {
    return change.newState === 'offline' && change.previousState !== 'offline';
}

/** Dependencies for {@link createHealthOutageCoalescer}. */
export interface CreateHealthOutageCoalescerParams {
    clock:                    Clock
    /** Batch window in ms; defaults to {@link DEFAULT_HEALTH_OUTAGE_WINDOW_MS}. */
    windowMs?:                number
    notify:                   NotifyFn
    /** Bounded FIFO capacity for the "already reported" memory; defaults to {@link DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY}. */
    alreadyReportedCapacity?: number
}

/** What {@link createHealthOutageCoalescer} returns. */
export interface HealthOutageCoalescer {
    /** Reports one outage-worthy {@link ServiceHealthChange} (see {@link shouldNotifyHealthChange}) into the coalescer's current batch. */
    report: (change: ServiceHealthChange) => void
}

/** One epoch-keyed member of the coalescer's currently-open batch. */
interface PendingMember {
    service: string
    epoch:   number
}

/**
 * Builds the health-outage coalescer. See the module doc for the batching and epoch-keyed
 * dedupe semantics.
 * @param params Coalescer dependencies
 * @returns A {@link HealthOutageCoalescer}
 */
export function createHealthOutageCoalescer(params: CreateHealthOutageCoalescerParams): HealthOutageCoalescer {
    const { clock, windowMs = DEFAULT_HEALTH_OUTAGE_WINDOW_MS, notify, alreadyReportedCapacity = DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY } = params;

    let pending = new Map<string, PendingMember>();
    let flushTimer: TimerHandle | undefined;
    // Bounded (not unbounded) memory of the most recent `${service}:${epoch}` keys already
    // reported, so a flap that recurs within the same epoch AFTER an earlier batch already
    // flushed is still suppressed — not just deduped within one still-open batch. A genuinely new
    // epoch (CONFIGURE/CONNECTION_LOST) is a different key and always notifies again. Bounded via
    // a FIFO (mirroring notification-bridge.ts's dedupe set) rather than an ever-growing Set,
    // since this process is designed to run for weeks.
    const alreadyReportedOrder: string[] = [];
    const alreadyReported = new Set<string>();

    /** Marks `key` as already reported and evicts the oldest entry once past `alreadyReportedCapacity`. */
    function rememberReported(key: string): void {
        alreadyReported.add(key);
        alreadyReportedOrder.push(key);
        if(alreadyReportedOrder.length > alreadyReportedCapacity) {
            // See notification-bridge.ts's `rememberKey` for the same pattern and rationale: the
            // length check above already guarantees a non-empty array, so `.shift()!` (rather
            // than an `if(oldest !== undefined)` check) avoids an unreachable undefined-check
            // branch that a ConditionalExpression mutant survives untested.
            alreadyReported.delete(alreadyReportedOrder.shift()!);
        }
    }

    function flush(): void {
        flushTimer = undefined;
        // `flush` is only ever scheduled from `report()`, which always does `pending.set(...)`
        // before arming the timer, and `pending` is emptied only here — so `members` is never
        // empty when this runs. No emptiness guard: it would be dead code (see Q5 review finding).
        const members = [...pending.values()];
        pending = new Map();
        const services = members.map(member => member.service);
        const dedupeKey = members.map(member => `${member.service}:${member.epoch}`).toSorted((a, b) => a.localeCompare(b)).join('+');
        notify({
            source: 'health',
            wake:   true,
            dedupeKey,
            text:   `Service(s) offline: ${services.join(', ')}`,
        });
    }

    function report(change: ServiceHealthChange): void {
        const key = `${change.service}:${change.epoch}`;
        if(alreadyReported.has(key)) {
            return;
        }
        rememberReported(key);
        pending.set(key, { service: change.service, epoch: change.epoch });
        flushTimer ??= clock.setTimer(flush, windowMs);
    }

    return { report };
}
