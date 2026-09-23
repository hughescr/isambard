/**
 * The session core's turn synopsis producer: the one attachment point that gives EVERY conductor
 * turn — human, notification, wake, peer, catch-up, perch, wrapup, resume — a Haiku synopsis on
 * `LedgerTurn.synopsis`, where Discord presence renders it and the other session's ambient line
 * reads it. This file imports nothing from Discord.
 *
 * Driven against a REAL `createLedgerStore` so the id proof is end-to-end: the regression test
 * for the dropped-synopsis bug asserts that a `turn_synopsis` dispatched by the handler this
 * module opened actually LANDS on `ledger.turn.synopsis`, which it only can when the handler's
 * `turnId` is the ledger's own turn id.
 */
import { afterEach, describe, expect, it, jest, mock } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeClock } from '../../../helpers/fake-clock';
import * as frames from '../../../helpers/sdk-frames';
import { createLedgerStore, type LedgerStore } from '@/agent/session/ledger';
import { sdkFrameToAgentStreamEvent } from '@/agent/session/session';
import type { SynopsisContext, SynopsisGenerator } from '@/agent/session/synopsis-generator';
import type { CreateSynopsisStreamHandlerDeps, SynopsisStreamHandler } from '@/agent/session/synopsis-stream-handler';
import { attachTurnSynopsis, createSynopsisBudget, SYNOPSIS_BUDGET_MS, type SynopsisBudget } from '@/agent/session/turn-synopsis';
import type { EnvelopeMeta } from '@/agent/session/types';

/** Drains the seed's `await`-chain: the IIFE, its `await thinkingSynopsis` continuation, and the dispatch. */
const flushPromises = async (): Promise<void> => {
    for(let i = 0; i < 6; i++) {
        // eslint-disable-next-line no-await-in-loop -- each turn must land one microtask tick later than the last (a chain, not a parallel batch)
        await Promise.resolve();
    }
};

const T1 = new Date('2026-09-09T12:00:00Z');
const T2 = new Date('2026-09-09T12:00:01Z');

afterEach(() => {
    jest.restoreAllMocks();
});

interface CapturedHandler {
    deps:          CreateSynopsisStreamHandlerDeps
    onStreamEvent: ReturnType<typeof mock>
    complete:      ReturnType<typeof mock>
}

function makeBudget(): SynopsisBudget {
    return { shouldGenerate: mock(() => true) };
}

function makeGenerator(result: string | null = 'Pondering'): SynopsisGenerator & { generateSynopsis: ReturnType<typeof mock> } {
    return { generateSynopsis: mock(async (_context: SynopsisContext): Promise<string | null> => result) };
}

function makeLedger(): LedgerStore {
    return createLedgerStore('conversation', { logger: { error: jest.fn() } });
}

type BuildSeed = NonNullable<Parameters<typeof attachTurnSynopsis>[0]['buildSeed']>;

function harness(overrides: { buildSeed?: BuildSeed, beforeAttach?: (store: LedgerStore) => void } = {}) {
    const ledgerStore = makeLedger();
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
    const createHandler = mock((deps: CreateSynopsisStreamHandlerDeps): SynopsisStreamHandler => {
        const captured: CapturedHandler = {
            deps,
            onStreamEvent: mock(() => undefined),
            complete:      mock(() => undefined),
        };
        handlers.push(captured);
        return { onStreamEvent: captured.onStreamEvent, complete: captured.complete };
    });
    const buildSeed = mock(overrides.buildSeed ?? (async (): Promise<string | undefined> => 'seeded synopsis'));
    const budget = makeBudget();
    const generator = makeGenerator();
    const clock = new FakeClock(T1.getTime());
    const onThinkingContentUpdate = mock((_content: string) => undefined);

    const detach = attachTurnSynopsis({
        conductor,
        ledgerStore,
        generator,
        budget,
        clock,
        onThinkingContentUpdate,
        createHandler,
        buildSeed,
    });

    return {
        ledgerStore, conductor, handlers, createHandler, buildSeed, budget, generator, clock, onThinkingContentUpdate, detach, unsubscribeFrames,
        emitFrame: (turnId: string, frame: SDKMessage): void => {
            frameHandler?.(turnId, frame);
        },
    };
}

/** A real ledger, the REAL handler and seed builder, a fake `subscribeTurn`, and a real budget over a FakeClock. */
function realHarness(generator: SynopsisGenerator, options: { beforeAttach?: (store: LedgerStore) => void } = {}) {
    const ledgerStore = makeLedger();
    options.beforeAttach?.(ledgerStore);
    const clock = new FakeClock(T1.getTime());
    let frameHandler: ((turnId: string, frame: SDKMessage) => void) | undefined;
    const detach = attachTurnSynopsis({
        conductor: {
            subscribeTurn: (handler: (turnId: string, frame: SDKMessage) => void) => {
                frameHandler = handler;
                return () => undefined;
            },
        },
        ledgerStore,
        generator,
        budget: createSynopsisBudget({ now: () => clock.now() }),
        clock,
    });
    return {
        ledgerStore, clock, detach,
        /** Mirrors the conductor: notify turn subscribers, THEN fold the frame into the ledger. */
        frame: (frame: SDKMessage): void => {
            frameHandler?.(ledgerStore.get().turn?.id ?? 'none', frame);
            ledgerStore.dispatch({ type: 'sdk_frame', frame, at: new Date(clock.now()) });
        },
    };
}

function envelope(overrides: Partial<EnvelopeMeta> = {}): EnvelopeMeta {
    return { id: 'env-1', kind: 'discord', queuedAt: T1, ...overrides };
}

/** A promise the test settles by hand, so generations can complete out of order. */
function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return { promise, resolve: (value: T) => settle(value) };
}

describe('attachTurnSynopsis', () => {
    it('opens a handler for a submitted turn, keyed on the ledger turn id and seeded from turn.seed, with this session\'s own generator, budget and clock', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ seed: 'fix the bug' }), at: T1 });

        expect(h.handlers).toHaveLength(1);
        const deps = h.handlers[0].deps;
        expect(deps.turnId).toBe(h.ledgerStore.get().turn!.id);
        expect(deps.userMessage).toBe('fix the bug');
        expect(deps.sink).toBe(h.ledgerStore);
        expect(deps.generator).toBe(h.generator);
        expect(deps.budget).toBe(h.budget);
        expect(deps.clock).toBe(h.clock);
        expect(deps.onThinkingContentUpdate).toBe(h.onThinkingContentUpdate);
        expect(h.buildSeed).toHaveBeenCalledWith(h.generator, h.budget, 'fix the bug');
        expect(deps.thinkingSynopsis).toBe(h.buildSeed.mock.results[0]?.value as Promise<string | undefined>);
    });

    it('a seedless turn gets an empty userMessage and no pre-generation at all', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope(), at: T1 });

        expect(h.handlers[0]?.deps.userMessage).toBe('');
        expect(h.handlers[0]?.deps.thinkingSynopsis).toBeUndefined();
        expect(h.buildSeed).not.toHaveBeenCalled();
    });

    it('routes every frame from subscribeTurn into the live handler', () => {
        const h = harness();
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope(), at: T1 });

        const frame = frames.assistantText('hi');
        h.emitFrame('env-1', frame);

        expect(h.handlers[0]?.onStreamEvent).toHaveBeenCalledWith(sdkFrameToAgentStreamEvent(frame));
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

        expect(h.handlers[0]?.onStreamEvent).toHaveBeenCalledWith(sdkFrameToAgentStreamEvent(frame));
    });

    it('a spontaneous notification turn gets a handler whose dispatched synopsis LANDS on the ledger', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'spontaneous_turn_opened', turnId: 'notification-1000', at: T1 });

        const handler = h.handlers[0];
        expect(handler.deps.turnId).toBe('notification-1000');
        // The regression test for the dropped-synopsis bug: dispatched with the handler's own
        // turnId, it must survive reduceTurnSynopsis's id guard.
        handler.deps.sink.dispatch({ type: 'turn_synopsis', turnId: handler.deps.turnId, text: 'catching up on mail', at: T2 });

        expect(h.ledgerStore.get().turn?.synopsis).toBe('catching up on mail');
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
        expect(h.buildSeed).not.toHaveBeenCalled();
    });

    it('a discord-kind turn does get one (the exclusion set is not blanket)', () => {
        const h = harness();

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ kind: 'discord' }), at: T1 });

        expect(h.handlers).toHaveLength(1);
    });

    it('adopts a turn that is ALREADY open when it attaches, rather than waiting for the next ledger event', () => {
        // `LedgerStore.subscribe` does not replay the current value, so without an explicit
        // `get()` at attach time a turn already open when the producer attaches gets no handler at
        // all — and if its next frame is the `result` that closes it, never will.
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

    it('attaching with no turn open creates no handler', () => {
        const h = harness();

        expect(h.handlers).toHaveLength(0);
        expect(h.buildSeed).not.toHaveBeenCalled();
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

describe('attachTurnSynopsis end to end (real ledger, real handler, real budget)', () => {
    it('a seeded turn gets its seed synopsis on the ledger as soon as the seed resolves, with no frames at all', async () => {
        const generator = makeGenerator('Pondering');
        const h = realHarness(generator);

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ seed: 'what should I cook' }), at: T1 });
        await flushPromises();

        expect(h.ledgerStore.get().turn?.synopsis).toBe('Pondering');
        expect(generator.generateSynopsis).toHaveBeenCalledTimes(1);
        expect(generator.generateSynopsis).toHaveBeenCalledWith({ phase: 'thinking', userMessage: 'what should I cook' });
        h.detach();
    });

    it('a tool-first turn publishes its seed: the seed spent the budget, so the tool frame starts no second generation', async () => {
        const generator = makeGenerator('Chasing the bug');
        const h = realHarness(generator);

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ seed: 'fix the bug' }), at: T1 });
        h.frame(frames.assistantToolUse('Bash', { command: 'ls' }, 'toolu_1'));
        await flushPromises();

        expect(generator.generateSynopsis).toHaveBeenCalledTimes(1);
        expect(h.ledgerStore.get().turn?.synopsis).toBe('Chasing the bug');
        expect(h.ledgerStore.get().turn?.phase).toMatchObject({ type: 'using_tool', toolName: 'Bash' });
        h.detach();
    });

    it('a text-first turn publishes its seed too, while it is still open', async () => {
        const generator = makeGenerator('Drafting a reply');
        const h = realHarness(generator);

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ seed: 'say hi' }), at: T1 });
        h.frame(frames.assistantText('Hello!'));
        await flushPromises();

        expect(generator.generateSynopsis).toHaveBeenCalledTimes(1);
        expect(h.ledgerStore.get().turn?.synopsis).toBe('Drafting a reply');
        expect(h.ledgerStore.get().turn?.phase).toMatchObject({ type: 'responding' });
        h.detach();
    });

    it('an adopted turn whose only remaining frame is `result` STILL lands its seed on the ledger before it closes', async () => {
        const generator = makeGenerator('adopted synopsis');
        const h = realHarness(generator, { beforeAttach: (store) => {
            store.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-inflight', seed: 'already running' }), at: T1 });
        } });
        await flushPromises();

        expect(h.ledgerStore.get().turn?.synopsis).toBe('adopted synopsis');
        h.detach();
    });

    it('a seed that resolves after its turn closed is never dispatched onto the next turn', async () => {
        const seed = deferred<string | null>();
        const generator: SynopsisGenerator = { generateSynopsis: mock(() => seed.promise) };
        const h = realHarness(generator);

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-a', seed: 'first' }), at: T1 });
        h.frame(frames.resultSuccess());
        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ id: 'env-b' }), at: T2 });
        seed.resolve('stale synopsis');
        await flushPromises();

        expect(h.ledgerStore.get().turn?.id).toBe('env-b');
        expect(h.ledgerStore.get().turn?.synopsis).toBeUndefined();
        h.detach();
    });

    it('generation STARTS are spaced by the budget, and arrivals follow their starts even when completions are deferred', async () => {
        // Challenge 2 of the #39 design review: the budget bounds starts, not arrivals. With the
        // generator's own cancel-and-replace (not modelled by this stub) a start also aborts the
        // call before it, so each start yields at most one arrival.
        const pending: ReturnType<typeof deferred<string | null>>[] = [];
        const generator: SynopsisGenerator = {
            generateSynopsis: mock(() => {
                const next = deferred<string | null>();
                pending.push(next);
                return next.promise;
            }),
        };
        const h = realHarness(generator);
        const turnAt = (ms: number): void => {
            h.clock.advance(ms);
        };

        h.ledgerStore.dispatch({ type: 'turn_submitted', envelope: envelope({ seed: 'long job' }), at: T1 });
        expect(pending).toHaveLength(1);

        turnAt(1000);
        h.frame(frames.assistantToolUse('Bash', {}, 'toolu_1'));
        turnAt(10_000);
        h.frame(frames.assistantToolUse('Read', {}, 'toolu_2'));
        expect(pending).toHaveLength(1);

        pending[0].resolve('first synopsis');
        await flushPromises();
        expect(h.ledgerStore.get().turn?.synopsis).toBe('first synopsis');

        turnAt(999);
        h.frame(frames.assistantToolUse('Grep', {}, 'toolu_3'));
        expect(pending).toHaveLength(1);

        turnAt(1);
        h.frame(frames.assistantToolUse('Glob', {}, 'toolu_4'));
        expect(pending).toHaveLength(2);

        pending[1].resolve('second synopsis');
        await flushPromises();
        expect(h.ledgerStore.get().turn?.synopsis).toBe('second synopsis');
        h.detach();
    });
});

describe('createSynopsisBudget', () => {
    it('the default window is SYNOPSIS_BUDGET_MS, 12 s', () => {
        expect(SYNOPSIS_BUDGET_MS).toBe(12_000);
    });

    it('answers true on the first ask, false 1 ms short of the window, and true exactly at it', () => {
        let now = 1000;
        const budget = createSynopsisBudget({ now: () => now });

        expect(budget.shouldGenerate()).toBe(true);
        now = 12_999;
        expect(budget.shouldGenerate()).toBe(false);
        now = 13_000;
        expect(budget.shouldGenerate()).toBe(true);
    });

    it('a false answer does not move the window: t=0 true, t=5s false, t=12s true', () => {
        let now = 0;
        const budget = createSynopsisBudget({ now: () => now });

        expect(budget.shouldGenerate()).toBe(true);
        now = 5000;
        expect(budget.shouldGenerate()).toBe(false);
        now = 12_000;
        expect(budget.shouldGenerate()).toBe(true);
    });

    it('a true answer spends the budget: asking again at the same instant is false', () => {
        const budget = createSynopsisBudget({ now: () => 50_000 });

        expect(budget.shouldGenerate()).toBe(true);
        expect(budget.shouldGenerate()).toBe(false);
    });

    it('honours an explicit intervalMs', () => {
        let now = 0;
        const budget = createSynopsisBudget({ now: () => now, intervalMs: 1000 });

        expect(budget.shouldGenerate()).toBe(true);
        now = 999;
        expect(budget.shouldGenerate()).toBe(false);
        now = 1000;
        expect(budget.shouldGenerate()).toBe(true);
    });
});
