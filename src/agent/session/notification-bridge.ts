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
 * once `createConversationConductor` resolves. `createConversationConductor` resolving is NOT
 * the same as the conductor being open: `bot.ts`'s `clientReady` calls `conductor.open()` later
 * still, after the Discord login round-trip, so there is a real window — after attach, before
 * open — during which a naive "attached, so deliver" `notify()` would burn a source's dedupe key
 * (and, for a coalesced source, its own "already reported" memory) on a delivery that never
 * happened, permanently losing it for as long as the underlying key stays the same (a health
 * outage's key is stable for the epoch's whole lifetime — see `health-notification.ts`'s module
 * doc). `notify()` therefore checks the conductor's `status().lifecycle` with
 * {@link lifecycleAcceptsWork} (not just whether a conductor is attached) and treats "attached
 * but cannot accept work" — not yet open, a failed open or reopen, or shutting down — exactly
 * like "not attached": a debug log, no dedupe/memory consumed, `notify()` returns `false` so the
 * caller knows to retry. Before attach — and after {@link NotificationBridge.detach} —
 * `notify()` is the same safe no-op: a debug log, nothing queued, never a throw.
 *
 * One notify contract (plan amendment B2): `notify({ source, text, wake, key, at? }): boolean`.
 * `key` is REQUIRED and unique only within its `source`: the bridge owns the namespace, deduping
 * every source (and Q5's own `createHealthOutageCoalescer`) on the `(source, key)` pair, so no
 * producer prefixes its keys with its own source tag. The boolean return is `true` once this
 * `(source, key)` has been (or was already) handed to the conductor, and `false` only when
 * delivery could not be attempted right now (see the readiness paragraph above) — a caller with
 * its own delivery memory reads this to decide whether THIS occurrence may be forgotten or must
 * be retried on the next one. `wake` selects the routing through the envelope contract it builds
 * (see `./envelope.ts`'s `buildNotificationEnvelope`): `true` submits a turn-opening envelope via
 * `conductor.submit(envelope, { priority: 'normal' })` — never `'urgent'`, so a notification can
 * never preempt a live Discord turn (`conductor.ts`'s human-only fast-path at
 * enqueue/routeIncoming); `false` appends via `conductor.appendWithoutTurn(envelope)`, the
 * accumulate-only seam — `conductor.submit()` unconditionally opens a turn, and the SDK
 * appends a `shouldQuery:false` message to the transcript without an
 * assistant turn, answering it only with a bare zero-turn `result` frame (which the conductor's
 * input queue claims by uuid), so routing an accumulate envelope through `submit()` would open a
 * turn that bare result settles with an empty reply. Both routes are
 * fire-and-forget from the caller's point of view once readiness is confirmed: `notify()` itself
 * never throws and never returns a rejected promise — a submit/append failure past that point
 * (rather than the conductor simply not being open yet) is logged via the injected `logger` and
 * still reports back `true`, since a genuine mid-flight failure is not the "not open yet, please
 * retry" case this return value exists for.
 *
 * `timeHeader` is `() => string` and is called fresh inside every `notify()` call — matching
 * every existing envelope call site (perch-driver.ts, discord/handlers.ts,
 * conductor-processor.ts, catchup-setup.ts), none of which precompute the header once.
 *
 * @module agent/session/notification-bridge
 */
import type { Logger } from '@hughescr/logger';
import { lifecycleAcceptsWork, type Conductor, type TurnResult } from './conductor';
import { buildNotificationEnvelope } from './envelope';
import type { Clock, Envelope } from './types';

/** Default capacity of the bounded FIFO dedupe set — see {@link CreateNotificationBridgeParams.dedupeCapacity}. */
export const DEFAULT_NOTIFICATION_DEDUPE_CAPACITY = 200;

/** One notification submission — the shared contract every notification source conforms to (plan amendment B2). */
export interface NotifyParams {
    /** Short source tag, e.g. `'health'`, `'email'`, `'bsky-dm'` — rendered into the envelope's `[NOTIFICATION · {source} · ...]` header, and the namespace {@link NotifyParams.key} is unique within. */
    source: string
    /** Human-readable notification body. */
    text:   string
    /** `true` opens a turn (`conductor.submit`, `priority:'normal'`); `false` appends without opening one (`conductor.appendWithoutTurn`). */
    wake:   boolean
    /**
     * REQUIRED. This notification's dedupe key, unique within {@link NotifyParams.source} — the
     * bridge namespaces it by `source` itself, so it carries no source prefix. A repeated
     * `(source, key)` pair (while still within {@link CreateNotificationBridgeParams.dedupeCapacity}
     * recent distinct pairs) is dropped silently.
     */
    key:    string
    /** Overrides the envelope's `now`/timestamp; defaults to `new Date(clock.now())` at call time. */
    at?:    Date
}

/**
 * A source-agnostic notification submission function — the single shared contract every
 * notification source imports (plan amendment B2). Returns `true` once this `(source, key)` has
 * been (or was already, via an earlier call) handed to the conductor, and `false` only when it
 * could not be attempted right now — no conductor attached, or one is attached whose lifecycle
 * cannot accept work (see `createNotificationBridge`'s module doc) — so a caller with its own
 * retry memory (e.g. {@link import('./health-notification').createHealthOutageCoalescer}) knows
 * to try again on the next occurrence instead of treating a dropped notification as delivered.
 */
export type NotifyFn = (params: NotifyParams) => boolean;

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

/**
 * The narrow slice of {@link Conductor} the bridge actually calls. `status` is read (not just
 * `submit`/`appendWithoutTurn`) so `notify()` can tell "attached to a conductor that cannot
 * accept work right now" apart from "actually ready to receive" — see `notify()`'s doc.
 */
export type NotificationConductor = Pick<Conductor, 'submit' | 'appendWithoutTurn' | 'status'>;

/** What {@link createNotificationBridge} returns. */
export interface NotificationBridge {
    notify:              NotifyFn
    /** Late-binds the real conductor once it exists (composition-root ordering, plan amendment B1). Subsequent `notify()` calls route through it. */
    attachConductor:     (conductor: NotificationConductor) => void
    /** Detaches the conductor: subsequent `notify()` calls revert to the unattached no-op (debug log, drop) until re-attached. */
    detach:              () => void
    /**
     * Attaches a reply-delivery callback (R2): once a `wake:true` `notify()`'s
     * `conductor.submit()` resolves with `status: 'completed'` (a genuine reply — never a
     * failed, interrupted or withdrawn turn, none of which carries one), `fn` is called with the
     * notification's own envelope and that `TurnResult`, so the composition root can deliver a
     * notification's reply the same way it delivers any other turn's. A rejection is caught and
     * logged; it never affects `notify()`'s own synchronous return. Never called for a
     * `wake:false` `notify()` (`appendWithoutTurn` produces no `TurnResult` to deliver).
     */
    attachReplyDelivery: (fn: (envelope: Envelope, result: TurnResult) => Promise<void>) => void
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
    let replyDelivery: ((envelope: Envelope, result: TurnResult) => Promise<void>) | undefined;
    const dedupeOrder: string[] = [];
    const dedupeSeen = new Set<string>();

    /** Marks `namespacedKey` as seen and evicts the oldest entry once the FIFO set exceeds `dedupeCapacity`. */
    function rememberKey(namespacedKey: string): void {
        dedupeSeen.add(namespacedKey);
        dedupeOrder.push(namespacedKey);
        if(dedupeOrder.length > dedupeCapacity) {
            // `dedupeOrder.length > dedupeCapacity` after the push above guarantees
            // `dedupeOrder.length >= 1` here, so `.shift()` always returns an element — the `!`
            // (rather than an `if(oldest !== undefined)` check) avoids an unreachable
            // undefined-check branch that a ConditionalExpression mutant survives untested.
            dedupeSeen.delete(dedupeOrder.shift()!);
        }
    }

    function notify(notifyParams: NotifyParams): boolean {
        const { source, text, wake, key, at } = notifyParams;
        // The dedupe identity (and the form every log line prints): a JSON tuple rather than a
        // `${source}:${key}` join, because both halves are open strings — a join would let
        // ('a:b', 'c') and ('a', 'b:c') collide and suppress each other.
        const namespacedKey = JSON.stringify([source, key]);

        // Not attached, or attached to a conductor that cannot accept work (not yet open, a
        // failed open or reopen, shutting down): treat exactly like the unattached case
        // (debug-log, drop, no dedupe burn) rather than attempting delivery —
        // conductor.submit() would only reject and conductor.appendWithoutTurn() would refuse,
        // and on the wake path the dedupe key below would already be burned by the time that
        // was discovered. Returning `false` here (see the module doc / review finding) lets a
        // caller with its own "already reported" memory — e.g. the health-outage coalescer —
        // hold off marking this occurrence handled, so the outage is retried on its next
        // occurrence instead of being silently and permanently dropped for the life of the
        // current epoch.
        if(conductor === undefined || !lifecycleAcceptsWork(conductor.status().lifecycle)) {
            logger.debug({ source, namespacedKey }, 'Notification bridge not attached to a conductor that can accept work; dropping notify');
            return false;
        }
        if(dedupeSeen.has(namespacedKey)) {
            return true;
        }

        const envelope = buildNotificationEnvelope({
            source, text, now: at ?? new Date(clock.now()), timezone, timeHeader: timeHeader(), wake,
        });

        // Narrowed on the envelope's own contract rather than on `wake`, which built it: the
        // compiler then holds each branch to the one conductor seam that contract belongs on.
        if(envelope.mode === 'query') {
            // Burned up front on this path: `submit()` opens a real turn and the conductor owns
            // the envelope from here, so a later failure is a failed turn, not a lost hand-off.
            rememberKey(namespacedKey);
            void (async (): Promise<void> => {
                let result: TurnResult;
                try {
                    result = await conductor.submit(envelope, { priority: 'normal' });
                } catch (err) {
                    logger.warn({ err, source, namespacedKey }, 'Failed to submit wake notification');
                    return;
                }
                if(result.status !== 'completed' || replyDelivery === undefined) {
                    return;
                }
                try {
                    await replyDelivery(envelope, result);
                } catch (err) {
                    logger.warn({ err, source, namespacedKey }, 'Failed to deliver a wake notification\'s reply');
                }
            })();
            return true;
        }

        // Accumulate-only: the key is burned ONLY once the conductor has actually taken the
        // envelope (queued on the live session, or held in its reopen buffer). Burning it on a
        // refusal would leave the source believing this occurrence was handled while nothing was
        // ever appended — and a source with its own stable key (a health outage's key is stable
        // for the whole epoch) would then never retry it.
        let accepted: boolean;
        try {
            accepted = conductor.appendWithoutTurn(envelope);
        } catch (err) {
            logger.warn({ err, source, namespacedKey }, 'Failed to append accumulate notification');
            return false;
        }
        if(!accepted) {
            logger.debug({ source, namespacedKey }, 'Conductor did not accept an accumulate notification; leaving the dedupe key unburned for a retry');
            return false;
        }
        rememberKey(namespacedKey);
        return true;
    }

    function attachConductor(newConductor: NotificationConductor): void {
        conductor = newConductor;
    }

    function detach(): void {
        conductor = undefined;
    }

    function attachReplyDelivery(fn: (envelope: Envelope, result: TurnResult) => Promise<void>): void {
        replyDelivery = fn;
    }

    return {
        notify, attachConductor, detach, attachReplyDelivery,
    };
}
