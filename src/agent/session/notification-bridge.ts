/**
 * Source-agnostic notification submission seam (Q5 / plan amendments B1-B2): every notification
 * source (health outages — {@link import('./health-notification').createHealthOutageCoalescer} —
 * email, Bluesky, ...) calls one shared `notify()` rather than hand-rolling its own conductor
 * plumbing, so one dedupe set and one routing decision govern every source.
 *
 * Composition-root ordering (plan amendment B1): `src/index.ts` constructs this bridge BEFORE
 * `setupEmail`/the conductor-mode block (the real conductor does not exist yet at that point —
 * `createConversationConductor` itself consumes email's MCP server instance, so the dependency
 * runs the other way), and attaches the real conductor via {@link NotificationBridge.attachConductor}
 * once `createConversationConductor` resolves. Before that call — and after {@link
 * NotificationBridge.detach} — `notify()` is a safe no-op: a debug log, nothing queued, never a
 * throw.
 *
 * One notify contract (plan amendment B2): `notify({ source, text, wake, dedupeKey, at? })`.
 * `dedupeKey` is REQUIRED — it is the sole dedupe key every source (and Q5's own
 * `createHealthOutageCoalescer`) keys on. `wake` selects the routing, mirroring `Envelope`'s
 * `hostPriority`/`shouldQuery` split (see `./envelope.ts`'s `buildNotificationEnvelope`):
 * `true` submits a turn-opening envelope via `conductor.submit(envelope, { priority: 'other' })`
 * — never `'human'`, so a notification can never preempt a live Discord turn (`conductor.ts`'s
 * human-only fast-path at enqueue/routeIncoming); `false` appends via
 * `conductor.appendWithoutTurn(envelope)`, the accumulate-only seam — `conductor.submit()`
 * unconditionally opens a turn regardless of `shouldQuery`, and the SDK contract for
 * `shouldQuery:false` is "appended to the transcript without triggering an assistant turn" (no
 * result frame), so routing an accumulate envelope through `submit()` would permanently wedge
 * the one-turn-in-flight invariant. Both routes are fire-and-forget from the caller's point of
 * view: `notify()` itself never throws and never returns a rejected promise — failures are
 * logged via the injected `logger`.
 *
 * `timeHeader` is `() => string` and is called fresh inside every `notify()` call — matching
 * every existing envelope call site (perch-driver.ts, discord/handlers.ts,
 * conductor-processor.ts, catchup-setup.ts), none of which precompute the header once.
 *
 * @module agent/session/notification-bridge
 */
import type { Logger } from '@hughescr/logger';
import type { Conductor } from './conductor';
import { buildNotificationEnvelope } from './envelope';
import type { Clock } from './types';

/** Default capacity of the bounded FIFO dedupe set — see {@link CreateNotificationBridgeParams.dedupeCapacity}. */
export const DEFAULT_NOTIFICATION_DEDUPE_CAPACITY = 200;

/** One notification submission — the shared contract every notification source conforms to (plan amendment B2). */
export interface NotifyParams {
    /** Short source tag, e.g. `'health'`, `'email'`, `'bluesky-dm'` — rendered into the envelope's `[NOTIFICATION · {source} · ...]` header. */
    source:    string
    /** Human-readable notification body. */
    text:      string
    /** `true` opens a turn (`conductor.submit`, `priority:'other'`); `false` appends without opening one (`conductor.appendWithoutTurn`). */
    wake:      boolean
    /** REQUIRED. The bridge's sole dedupe key — a repeated key (while still within {@link CreateNotificationBridgeParams.dedupeCapacity} recent distinct keys) is dropped silently. */
    dedupeKey: string
    /** Overrides the envelope's `now`/timestamp; defaults to `new Date(clock.now())` at call time. */
    at?:       Date
}

/** A source-agnostic notification submission function — the single shared contract every notification source imports (plan amendment B2). */
export type NotifyFn = (params: NotifyParams) => void;

/** Dependencies for {@link createNotificationBridge}. */
export interface CreateNotificationBridgeParams {
    clock:           Clock
    /** IANA timezone the envelope's stamp is rendered in (e.g. `config.session.timezone`). */
    timezone:        string
    /** `() => string`, called fresh per `notify()` call — e.g. `() => formatTimeHeader(timezone)`. */
    timeHeader:      () => string
    /** Bounded FIFO dedupe-set capacity; defaults to {@link DEFAULT_NOTIFICATION_DEDUPE_CAPACITY}. */
    dedupeCapacity?: number
    logger:          Pick<Logger, 'debug' | 'warn'>
}

/** The narrow slice of {@link Conductor} the bridge actually calls. */
export type NotificationConductor = Pick<Conductor, 'submit' | 'appendWithoutTurn'>;

/** What {@link createNotificationBridge} returns. */
export interface NotificationBridge {
    notify:          NotifyFn
    /** Late-binds the real conductor once it exists (composition-root ordering, plan amendment B1). Subsequent `notify()` calls route through it. */
    attachConductor: (conductor: NotificationConductor) => void
    /** Detaches the conductor: subsequent `notify()` calls revert to the unattached no-op (debug log, drop) until re-attached. */
    detach:          () => void
}

/**
 * Builds the source-agnostic notification bridge. See the module doc for the composition-root
 * ordering and the one-notify-contract this implements.
 * @param params Bridge dependencies
 * @returns A {@link NotificationBridge}
 */
export function createNotificationBridge(params: CreateNotificationBridgeParams): NotificationBridge {
    const { clock, timezone, timeHeader, dedupeCapacity = DEFAULT_NOTIFICATION_DEDUPE_CAPACITY, logger } = params;

    let conductor: NotificationConductor | undefined;
    const dedupeOrder: string[] = [];
    const dedupeSeen = new Set<string>();

    /** Marks `key` as seen and evicts the oldest entry once the FIFO set exceeds `dedupeCapacity`. */
    function rememberKey(key: string): void {
        dedupeSeen.add(key);
        dedupeOrder.push(key);
        if(dedupeOrder.length > dedupeCapacity) {
            // `dedupeOrder.length > dedupeCapacity` after the push above guarantees
            // `dedupeOrder.length >= 1` here, so `.shift()` always returns an element — the `!`
            // (rather than an `if(oldest !== undefined)` check) avoids an unreachable
            // undefined-check branch that a ConditionalExpression mutant survives untested.
            dedupeSeen.delete(dedupeOrder.shift()!);
        }
    }

    function notify(notifyParams: NotifyParams): void {
        const { source, text, wake, dedupeKey, at } = notifyParams;

        if(conductor === undefined) {
            logger.debug({ source, dedupeKey }, 'Notification bridge not attached to a conductor; dropping notify');
            return;
        }
        if(dedupeSeen.has(dedupeKey)) {
            return;
        }
        rememberKey(dedupeKey);

        const envelope = buildNotificationEnvelope({
            source, text, now: at ?? new Date(clock.now()), timezone, timeHeader: timeHeader(), wake,
        });

        if(wake) {
            conductor.submit(envelope, { priority: 'other' }).catch((err: unknown) => {
                logger.warn({ err, source, dedupeKey }, 'Failed to submit wake notification');
            });
        } else {
            try {
                conductor.appendWithoutTurn(envelope);
            } catch (err) {
                logger.warn({ err, source, dedupeKey }, 'Failed to append accumulate notification');
            }
        }
    }

    function attachConductor(newConductor: NotificationConductor): void {
        conductor = newConductor;
    }

    function detach(): void {
        conductor = undefined;
    }

    return { notify, attachConductor, detach };
}
