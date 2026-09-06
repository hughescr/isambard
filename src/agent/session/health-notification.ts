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
import type { ServiceHealthChange, HealthChangeListener } from '@/services';

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
    /**
     * Cancels this coalescer's pending flush timer, if any, without flushing it — call once at
     * shutdown (alongside unsubscribing the listener this coalescer feeds) so a still-pending
     * batch's timer can never fire, and deliver into, a torn-down notification path, and never
     * keeps the process's event loop alive past shutdown. Any batch members still pending are
     * dropped without notifying; `stop()` does not otherwise disable the coalescer — a `report()`
     * afterward opens a fresh batch exactly as it would before `stop()` was ever called.
     */
    stop:   () => void
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
    //
    // Delivery-gated (review finding): a key is added here ONLY from `flush()`, and only once
    // `notify()` reports the batch actually reached (or had already reached) the conductor —
    // never eagerly from `report()`. `notify()` returns `false` while its conductor is
    // unattached or attached-but-not-yet-open (see notification-bridge.ts's module doc), which is
    // reachable at real composition-root boot: this coalescer is subscribed at the same
    // unconditional scope as the rest of createApp()'s health listeners, before bot.ts's
    // clientReady ever calls `conductor.open()`. Marking a key "reported" before delivery was
    // even attempted would permanently lose that outage notice for the rest of the epoch (epoch
    // does not advance on CONNECT_FAIL/RECOVERY_FAIL) the moment the very first flush landed
    // inside that boot window — silently, since `report()`/`flush()` never throw. Gating on
    // delivery instead means an outage whose first flush finds the conductor not yet open simply
    // is not remembered, so the next report() for that same key (a service's periodic reconnect
    // attempt failing again — see the flapping example above) opens a fresh batch and tries
    // again, until one flush finally lands after the conductor opens.
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
        const delivered = notify({
            source: 'health',
            wake:   true,
            dedupeKey,
            text:   `Service(s) offline: ${services.join(', ')}`,
        });
        // See the "already reported" memory's doc comment above: only remember these members'
        // keys once `notify()` confirms this batch was actually handed to the conductor.
        if(delivered) {
            for(const member of members) {
                rememberReported(`${member.service}:${member.epoch}`);
            }
        }
    }

    function report(change: ServiceHealthChange): void {
        const key = `${change.service}:${change.epoch}`;
        if(alreadyReported.has(key)) {
            return;
        }
        pending.set(key, { service: change.service, epoch: change.epoch });
        flushTimer ??= clock.setTimer(flush, windowMs);
    }

    function stop(): void {
        if(flushTimer !== undefined) {
            clock.clearTimer(flushTimer);
            flushTimer = undefined;
        }
    }

    return { report, stop };
}

/** Dependencies for {@link createHealthNotificationListener}. */
export interface CreateHealthNotificationListenerParams {
    /** The sole authority on which transitions are outage-worthy — typically {@link shouldNotifyHealthChange}, injected so this file asserts nothing about outage semantics itself. */
    shouldNotifyHealthChange: (change: ServiceHealthChange) => boolean
    /** Receives every qualifying change verbatim — typically a {@link HealthOutageCoalescer}. */
    coalescer:                Pick<HealthOutageCoalescer, 'report'>
    notify:                   NotifyFn
}

/**
 * Builds the `HealthChangeListener` to subscribe on `healthRegistry`: every `ServiceHealthChange`
 * that `shouldNotifyHealthChange` classifies as outage-worthy is handed verbatim to `coalescer`;
 * every other change (including a predicate-rejected transition into `'offline'`, e.g. a failed
 * first boot connect) is turned into an immediate accumulate notification. This function performs
 * no epoch arithmetic, no time window, and keeps no per-service memory of its own — that lives in
 * the coalescer.
 * @param params Listener dependencies
 * @returns A `HealthChangeListener` suitable for `healthRegistry.subscribe`
 */
export function createHealthNotificationListener(params: CreateHealthNotificationListenerParams): HealthChangeListener {
    const { shouldNotifyHealthChange: isOutageWorthy, coalescer, notify } = params;

    return function handleHealthChange(change: ServiceHealthChange): void {
        if(isOutageWorthy(change)) {
            coalescer.report(change);
            return;
        }
        // Intentional trade-off, not an oversight (review finding): this key carries no time
        // component, only (service, epoch, newState). Combined with the bridge's own
        // process-lifetime dedupe set, a service that keeps landing on the exact same
        // (previous, new) pair within one epoch — e.g. hourly degraded<->online churn while
        // `epoch` itself never advances, per the module doc — is announced at most once per
        // direction for the rest of that epoch, not re-announced on every recurrence. Left this
        // way deliberately: this file is required to carry no time window or per-service memory
        // of its own (see the module doc and Q6's acceptance criteria — that belongs solely to
        // the coalescer, and only for outage-worthy transitions). A coarser key (e.g.
        // time-bucketed) would need to live in the bridge's dedupe design instead, and is a
        // follow-on if flapping visibility turns out to matter in practice.
        notify({
            source:    'health',
            wake:      false,
            dedupeKey: `health:${change.service}:${change.epoch}:${change.newState}`,
            text:      `${change.service}: ${change.previousState} -> ${change.newState}`,
        });
    };
}
