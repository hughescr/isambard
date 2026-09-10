/**
 * The one attachment point that gives EVERY conductor turn — human, notification, wake, peer,
 * catch-up, perch, wrapup, resume — a Haiku synopsis overlaid on Discord presence.
 *
 * Driven against a REAL `createLedgerStore` so the id proof is end-to-end: the regression test
 * for the dropped-synopsis bug asserts that a `phase_synopsis` dispatched by the handler this
 * module opened actually LANDS on `ledger.turn.phase.generatedStatus`, which it only can when
 * the handler's `turnId` is the ledger's own turn id.
 */
import { afterEach, describe, expect, it, jest, mock } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PresenceThrottle } from '../../../../../src/integrations/discord/presence/presence-view.js';
import type { CreateLedgerStreamEventHandlerDeps, LedgerStreamEventHandler } from '../../../../../src/integrations/discord/presence/stream-event-handler.js';
import { attachTurnSynopsis } from '../../../../../src/integrations/discord/presence/turn-synopsis.js';
import * as frames from '../../../../helpers/sdk-frames';
import { createLedgerStore, type EnvelopeMeta, type LedgerStore } from '@/agent';

/** Drains the seed's `await`-chain: the priming IIFE, its `await thinkingSynopsis` continuation, and the dispatch. */
const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

const T1 = new Date('2026-09-09T12:00:00Z');
const T2 = new Date('2026-09-09T12:00:01Z');

afterEach(() => {
    jest.restoreAllMocks();
});

interface CapturedHandler {
    deps:          CreateLedgerStreamEventHandlerDeps
    onStreamEvent: ReturnType<typeof mock>
    complete:      ReturnType<typeof mock>
}

function makeThrottle(): PresenceThrottle {
    return { shouldUpdate: mock(() => true), record: mock(() => undefined) };
}

function harness(overrides: { buildThinkingSynopsis?: (...args: never[]) => Promise<string | undefined>, beforeAttach?: (store: LedgerStore) => void } = {}) {
    const ledgerStore: LedgerStore = createLedgerStore('conversation', { logger: { error: jest.fn() } });
    overrides.beforeAttach?.(ledgerStore);
    let frameHandler: ((turnId: string, frame: SDKMessage) => void) | undefined;
    const unsubscribeFrames = mock(() => undefined);
    const conductor = {
        subscribeTurn: mock((handler: (turnId: string, frame: SDKMessage) => void) => {
            frameHandler = handler;
            return unsubscribeFrames;
        }),
    };
    const handlers: CapturedHandler[] = [];
    const createHandler = mock((deps: CreateLedgerStreamEventHandlerDeps): LedgerStreamEventHandler => {
        const captured: CapturedHandler = {
            deps,
            onStreamEvent: mock(() => undefined),
            complete:      mock(() => undefined),
        };
        handlers.push(captured);
        return { onStreamEvent: captured.onStreamEvent, complete: captured.complete };
    });
    const buildThinkingSynopsis = mock(overrides.buildThinkingSynopsis ?? (async (): Promise<string | undefined> => 'seeded digest'));
    const throttle = makeThrottle();

    const detach = attachTurnSynopsis({
        conductor,
        ledgerStore,
        throttle,
        logger:                { error: mock(() => undefined) },
        createHandler,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injected test double for the real buildLedgerThinkingSynopsis signature
        buildThinkingSynopsis: buildThinkingSynopsis as any,
    });

    return {
        ledgerStore, conductor, handlers, createHandler, buildThinkingSynopsis, throttle, detach, unsubscribeFrames,
        emitFrame: (turnId: string, frame: SDKMessage): void => {
            frameHandler?.(turnId, frame);
        },
    };
}

function envelope(overrides: Partial<EnvelopeMeta> = {}): EnvelopeMeta {
    return { id: 'env-1', kind: 'discord', queuedAt: T1, ...overrides };
}

describe('attachTurnSynopsis', () => {
    it('opens a handler for a submitted turn, keyed on the ledger turn id and seeded from turn.seed', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ seed: 'fix the bug' }), at: T1 });

        expect(h.handlers).toHaveLength(1);
        expect(h.handlers[0]?.deps.turnId).toBe(h.ledgerStore.get().turn!.id);
        expect(h.handlers[0]?.deps.userMessage).toBe('fix the bug');
        expect(h.buildThinkingSynopsis).toHaveBeenCalledWith(undefined, h.throttle, 'fix the bug');
    });

    it('a seedless turn gets an empty userMessage and no pre-generation at all', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope(), at: T1 });

        expect(h.handlers[0]?.deps.userMessage).toBe('');
        expect(h.handlers[0]?.deps.thinkingSynopsis).toBeUndefined();
        expect(h.buildThinkingSynopsis).not.toHaveBeenCalled();
    });

    it('routes every frame from subscribeTurn into the live handler', () => {
        const h = harness();
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope(), at: T1 });

        const frame = frames.assistantText('hi');
        h.emitFrame('env-1', frame);

        expect(h.handlers[0]?.onStreamEvent).toHaveBeenCalledWith(frame);
    });

    it('routes a frame whose callback turnId does NOT match the ledger turn (the awaitingTurnEnd sentinel)', () => {
        // conductor.ts's `awaitingTurnEnd` branch opens a LEDGER turn (`notification-<ms>`)
        // without claiming `currentTurn`, so `turnIdFor` reports the `'none'` sentinel for that
        // turn's frames. Routing deliberately does no id comparison: adding one here would
        // discard the only assistant frame of exactly the turn shape this module exists to
        // rescue, and no other test in this file would notice (every other one happens to emit a
        // matching id).
        const h = harness();
        h.ledgerStore.dispatch({ type: 'spontaneous_turn_opened', turnId: 'notification-1000', at: T1 });

        const frame = frames.assistantText('unbidden');
        h.emitFrame('none', frame);

        expect(h.handlers[0]?.onStreamEvent).toHaveBeenCalledWith(frame);
    });

    it('a spontaneous notification turn gets a handler whose dispatched synopsis LANDS on the ledger', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'spontaneous_turn_opened', turnId: 'notification-1000', at: T1 });

        const handler = h.handlers[0];
        expect(handler.deps.turnId).toBe('notification-1000');
        // The regression test for the dropped-synopsis bug: dispatched with the handler's own
        // turnId, it must survive reducePhaseSynopsis's id guard.
        handler.deps.sink.dispatch({
            type: 'phase_synopsis', turnId: handler.deps.turnId, phaseType: 'thinking', text: 'catching up on mail', at: T2,
        });

        expect(h.ledgerStore.get().turn?.phase).toEqual({ type: 'thinking', startedAt: T2, generatedStatus: 'catching up on mail' });
    });

    it('completes the handler exactly once when the turn closes, and stops routing frames', () => {
        const h = harness();
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope(), at: T1 });

        h.ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: T2 });

        expect(h.ledgerStore.get().turn).toBeNull();
        expect(h.handlers[0]?.complete).toHaveBeenCalledTimes(1);

        h.emitFrame('env-1', frames.assistantText('after the turn'));
        expect(h.handlers[0]?.onStreamEvent).not.toHaveBeenCalled();
    });

    it('completes the previous handler BEFORE creating the next turn\'s', () => {
        const h = harness();
        const order: string[] = [];
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-a' }), at: T1 });
        h.handlers[0]?.complete.mockImplementation(() => {
            order.push('complete-first');
        });
        h.createHandler.mockImplementation(() => {
            order.push('create-second');
            return { onStreamEvent: mock(() => undefined), complete: mock(() => undefined) };
        });

        h.ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: T2 });
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-b' }), at: T2 });

        expect(order).toEqual(['complete-first', 'create-second']);
    });

    it('creates no second handler for a ledger event that leaves turn.id unchanged', () => {
        const h = harness();
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope(), at: T1 });

        h.ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.assistantText('thinking'), at: T2 });
        h.ledgerStore.dispatch({ type: 'interrupt_requested', at: T2 });

        expect(h.handlers).toHaveLength(1);
    });

    it('a compact-kind turn gets no handler and no pre-generation', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ kind: 'compact', seed: 'never' }), at: T1 });

        expect(h.handlers).toHaveLength(0);
        expect(h.buildThinkingSynopsis).not.toHaveBeenCalled();
    });

    it('a discord-kind turn does get one (the exclusion set is not blanket)', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ kind: 'discord' }), at: T1 });

        expect(h.handlers).toHaveLength(1);
    });

    it('adopts a turn that is ALREADY open when it attaches, rather than waiting for the next ledger event', () => {
        // `LedgerStore.subscribe` does not replay the current value, so without an explicit
        // `get()` at attach time a turn opened before setup runs (a resumed session emitting an
        // autonomous notification while the perch conductor open is still awaited) gets no
        // handler at all — and if its next frame is the `result` that closes it, never will.
        const h = harness({ beforeAttach: (store) => {
            store.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-inflight', seed: 'already running' }), at: T1 });
        } });

        expect(h.handlers).toHaveLength(1);
        expect(h.handlers[0]?.deps.turnId).toBe(h.ledgerStore.get().turn!.id);
        expect(h.handlers[0]?.deps.userMessage).toBe('already running');

        // The adopted turn is tracked, so its own later ledger events do not open a second one.
        h.ledgerStore.dispatch({ type: 'tick', rssBytes: 1, at: T2 });
        expect(h.handlers).toHaveLength(1);

        // And frames still route to it.
        h.emitFrame('env-inflight', frames.assistantText('mid-turn'));
        expect(h.handlers[0]?.onStreamEvent).toHaveBeenCalledTimes(1);
    });

    it('primes the adopted turn\'s seed, so it dispatches without waiting for a thinking transition', () => {
        const h = harness({ beforeAttach: (store) => {
            store.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-inflight', seed: 'already running' }), at: T1 });
        } });

        expect(h.handlers[0]?.deps.primeThinkingSynopsis).toBe(true);
    });

    it('does NOT prime a turn that opens while attached — its seed waits for the first thinking transition', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ seed: 'fix the bug' }), at: T1 });

        expect(h.handlers[0]?.deps.primeThinkingSynopsis).toBe(false);
    });

    it('an adopted turn whose only remaining frame is `result` STILL lands its digest on the ledger', async () => {
        // End-to-end against the REAL stream handler: adoption that merely constructs a handler
        // spends the Haiku call and shows nothing, because `createLedgerStreamEventHandler` only
        // consumes the seed from a `thinking` transition it may never see again.
        const ledgerStore: LedgerStore = createLedgerStore('conversation', { logger: { error: jest.fn() } });
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-inflight', seed: 'already running' }), at: T1 });

        const detach = attachTurnSynopsis({
            conductor:             { subscribeTurn: mock(() => mock(() => undefined)) },
            ledgerStore,
            throttle:              makeThrottle(),
            logger:                { error: mock(() => undefined) },
            buildThinkingSynopsis: async (): Promise<string | undefined> => 'adopted digest',
        });
        await flushPromises();

        expect(ledgerStore.get().turn?.phase).toEqual({ type: 'thinking', startedAt: expect.any(Date), generatedStatus: 'adopted digest' });
        detach();
    });

    it('attaching with no turn open creates no handler', () => {
        const h = harness();

        expect(h.handlers).toHaveLength(0);
        expect(h.buildThinkingSynopsis).not.toHaveBeenCalled();
    });

    it('detach() completes the live handler, unsubscribes both sources, and goes inert', () => {
        const h = harness();
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope(), at: T1 });

        h.detach();

        expect(h.handlers[0]?.complete).toHaveBeenCalledTimes(1);
        expect(h.unsubscribeFrames).toHaveBeenCalledTimes(1);

        h.emitFrame('env-1', frames.assistantText('later'));
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-later' }), at: T2 });

        expect(h.handlers[0]?.onStreamEvent).not.toHaveBeenCalled();
        expect(h.handlers).toHaveLength(1);
    });

    it('an is_error retry of the same envelope id gets a FRESH handler', () => {
        const h = harness();
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-retry' }), at: T1 });

        h.ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess({ is_error: true }), at: T2 });
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-retry' }), at: T2 });

        expect(h.handlers).toHaveLength(2);
        expect(h.handlers[0]?.complete).toHaveBeenCalledTimes(1);
        expect(h.handlers[1]?.deps.turnId).toBe('env-retry');
    });
});
