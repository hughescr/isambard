/**
 * Tests for presence-setup.ts (setupConductorPresence — the sole surviving setup function; the
 * legacy oneshot `setupPresence` bridge was retired in P14).
 *
 * Covers:
 * - getPreviousStatus forwarding: verifies the callback is passed to createIdleStatusGenerator
 *   so the anti-rut block in status-generator-idle.ts fires on the live path.
 * - createDynamicGenerator: the injectable per-ledger dynamic-status-generator factory (P14).
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach, jest } from 'bun:test';
import { ActivityType, type Client } from 'discord.js';
import * as frames from '../../../../helpers/sdk-frames';
import { createLedgerStore, type LedgerStore } from '@/agent/session/ledger';
import type { DiscordConfig } from '@/config';
import * as presenceModule from '@/integrations/discord/presence';
import type { PresenceManager, PresenceManagerDeps } from '@/integrations/discord/presence/manager';
import type { PresenceView } from '@/integrations/discord/presence/presence-view';
import type { IdleStatusGeneratorDeps } from '@/integrations/discord/presence/status-generator-idle';
import { IDLE_SETTLE_MS, setupConductorPresence } from '@/integrations/discord/setup/presence-setup';

/** Minimal presence config for tests — required fields only, all others use defaults */
const MINIMAL_PRESENCE_CONFIG: NonNullable<DiscordConfig['presence']> = {
    updateThrottleMs:      12_000,
    idleTimeoutMs:         60_000,
    idleRefreshIntervalMs: 300_000,
};

/** Minimal mock Client */
function makeMockClient(): Client {
    return {} as unknown as Client;
}

describe('setupConductorPresence', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    let mockPresenceManager: { start: ReturnType<typeof mock>, stop: ReturnType<typeof mock>, applyView: ReturnType<typeof mock> };
    let capturedPresenceManagerDeps: PresenceManagerDeps | undefined;
    let capturedIdleDeps: IdleStatusGeneratorDeps | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
        mockPresenceManager = {
            start:     mock(() => undefined),
            stop:      mock(() => undefined),
            applyView: mock(async (_view: PresenceView) => undefined),
        };
        capturedPresenceManagerDeps = undefined;
        capturedIdleDeps = undefined;

        spies.push(
            // @ts-expect-error — Mocking constructor
            spyOn(presenceModule, 'PresenceManager').mockImplementation((deps: PresenceManagerDeps): PresenceManager => {
                capturedPresenceManagerDeps = deps;
                return mockPresenceManager as unknown as PresenceManager;
            }),
            spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Active', type: ActivityType.Custom })),
                formatStatus: mock((s: string) => ({ name: s, type: ActivityType.Custom })),
            }),
            spyOn(presenceModule, 'createIdleStatusGenerator').mockImplementation((deps: IdleStatusGeneratorDeps) => {
                capturedIdleDeps = deps;
                return { generate: mock(async () => ({ name: 'Idle', type: ActivityType.Custom })) };
            })
        );
    });

    afterEach(() => {
        jest.useRealTimers();
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        mock.restore();
    });

    function makeConversationLedger(): LedgerStore {
        return createLedgerStore('conversation', { logger: { error: mock() } });
    }

    function throttleAlways() {
        return { shouldUpdate: mock(() => true), record: mock(() => undefined) };
    }

    test('forwards getPreviousStatus to createIdleStatusGenerator when provided', () => {
        const conversation = makeConversationLedger();
        const getPreviousStatus = mock((): string | undefined => 'previous status text');

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            getPreviousStatus,
        });

        expect(presenceModule.createIdleStatusGenerator).toHaveBeenCalled();
        expect(capturedIdleDeps?.getPreviousStatus).toBe(getPreviousStatus);
    });

    test('getPreviousStatus is undefined in createIdleStatusGenerator deps when not passed', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            // No getPreviousStatus
        });

        expect(capturedIdleDeps?.getPreviousStatus).toBeUndefined();
    });

    describe('createDynamicGenerator (P14: per-ledger instances)', () => {
        test('is called exactly once per ledger, with the identityContext, when two ledgers are supplied', () => {
            const conversation = makeConversationLedger();
            const perch = createLedgerStore('perch', { logger: { error: mock() } });
            const createDynamicGenerator = mock(() => ({
                generateSynopsis:        mock(async () => null),
                generateCatchUpSynopsis: mock(async () => null),
            }));

            setupConductorPresence({
                identityContext:  'Test identity',
                presenceConfig:   MINIMAL_PRESENCE_CONFIG,
                readyClient:      makeMockClient(),
                ledgers:          [conversation, perch],
                throttle:         throttleAlways(),
                getRecentContext: () => Promise.resolve(undefined),
                createDynamicGenerator,
            });

            expect(createDynamicGenerator).toHaveBeenCalledTimes(2);
            expect(createDynamicGenerator).toHaveBeenNthCalledWith(1, { identityContext: 'Test identity' });
            expect(createDynamicGenerator).toHaveBeenNthCalledWith(2, { identityContext: 'Test identity' });
        });

        test('is called exactly once when a single ledger is supplied', () => {
            const conversation = makeConversationLedger();
            const createDynamicGenerator = mock(() => ({
                generateSynopsis:        mock(async () => null),
                generateCatchUpSynopsis: mock(async () => null),
            }));

            setupConductorPresence({
                identityContext:  'Test identity',
                presenceConfig:   MINIMAL_PRESENCE_CONFIG,
                readyClient:      makeMockClient(),
                ledgers:          [conversation],
                throttle:         throttleAlways(),
                getRecentContext: () => Promise.resolve(undefined),
                createDynamicGenerator,
            });

            expect(createDynamicGenerator).toHaveBeenCalledTimes(1);
        });

        test('returns one generator instance per ledger, in ledger order', () => {
            const conversation = makeConversationLedger();
            const perch = createLedgerStore('perch', { logger: { error: mock() } });
            const conversationGenerator = { generateSynopsis: mock(async () => null), generateCatchUpSynopsis: mock(async () => null) };
            const perchGenerator = { generateSynopsis: mock(async () => null), generateCatchUpSynopsis: mock(async () => null) };
            const createDynamicGenerator = mock()
                .mockReturnValueOnce(conversationGenerator)
                .mockReturnValueOnce(perchGenerator);

            const result = setupConductorPresence({
                identityContext:  'Test identity',
                presenceConfig:   MINIMAL_PRESENCE_CONFIG,
                readyClient:      makeMockClient(),
                ledgers:          [conversation, perch],
                throttle:         throttleAlways(),
                getRecentContext: () => Promise.resolve(undefined),
                createDynamicGenerator,
            });

            expect(result.dynamicStatusGenerators).toEqual([conversationGenerator, perchGenerator]);
        });

        test('defaults to the real createDynamicStatusGenerator factory when omitted', () => {
            const conversation = makeConversationLedger();

            const result = setupConductorPresence({
                identityContext:  'Test identity',
                presenceConfig:   MINIMAL_PRESENCE_CONFIG,
                readyClient:      makeMockClient(),
                ledgers:          [conversation],
                throttle:         throttleAlways(),
                getRecentContext: () => Promise.resolve(undefined),
                // No createDynamicGenerator override
            });

            expect(result.dynamicStatusGenerators).toHaveLength(1);
            expect(typeof result.dynamicStatusGenerators[0]?.generateSynopsis).toBe('function');
        });
    });

    test('composes once synchronously at setup, applying an idle view before any ledger event', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase).toEqual({ type: 'idle', since: expect.any(Date) });
    });

    test('applies a new view when a subscribed ledger store changes', () => {
        const conversation = makeConversationLedger();
        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });
        mockPresenceManager.applyView.mockClear();

        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.live).toEqual(['conversation']);
    });

    test('an idle view always applies, bypassing the throttle', () => {
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };
        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
    });

    test('a non-idle view is blocked while the throttle window has not elapsed', () => {
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };
        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });
        mockPresenceManager.applyView.mockClear();

        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });

        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });

    test('isCostPaused omitted: composed prefix carries no pause marker (Q3 / B4)', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).not.toContain('⏸');
    });

    test('isCostPaused() true is composed into the prefix as the ⏸ perch marker (Q3 / B4)', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            isCostPaused:     () => true,
        });

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).toBe('💤 • ⏸ perch');
    });

    test('isCostPaused is re-read on every tick, not only at setup (Q3 / B4)', () => {
        const conversation = makeConversationLedger();
        let paused = false;

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            isCostPaused:     () => paused,
        });
        mockPresenceManager.applyView.mockClear();

        paused = true;
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).toContain('⏸ perch');
    });

    test('wires PresenceManager with a recomposeIdlePrefix that re-reads isCostPaused() at call time, not just at setup (Q3/B4 midnight-clear staleness)', () => {
        const conversation = makeConversationLedger();
        let paused = true;

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            isCostPaused:     () => paused,
        });

        expect(capturedPresenceManagerDeps?.recomposeIdlePrefix?.().prefix).toContain('⏸ perch');

        // The idle refresh loop calls this on its own periodic timer, independent of any ledger
        // event — a midnight clear (isCostPaused() flipping false with no ledger activity) must
        // be visible the very next time it is called.
        paused = false;
        expect(capturedPresenceManagerDeps?.recomposeIdlePrefix?.().prefix).not.toContain('⏸');
    });

    test('recomposeIdlePrefix with isCostPaused omitted carries no pause marker (Q3/B4)', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });

        expect(capturedPresenceManagerDeps?.recomposeIdlePrefix?.().prefix).not.toContain('⏸');
    });

    test('return shape carries only unsubscribeLedgers — no legacy bridge unsubscribe handles', () => {
        // The legacy `setupPresence` bridge (deleted in P14) returned
        // `unsubscribeModeTransition`/`unsubscribeActivityPhase`; `setupConductorPresence` never
        // did and still does not.
        const conversation = makeConversationLedger();

        const result = setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });

        expect(result).not.toHaveProperty('unsubscribeModeTransition');
        expect(result).not.toHaveProperty('unsubscribeActivityPhase');
        expect(typeof result.unsubscribeLedgers).toBe('function');
    });

    test('a synopsis that resolves for the same phase already shown without one is applied immediately, bypassing the throttle', () => {
        // Regression test for the P11 review finding: the ledger-sink stream handler kicks off an
        // async synopsis generation and, microseconds later, the base `sdk_frame` dispatch fires a
        // digest-less tick that would otherwise consume the whole 12s window before the synopsis
        // has a chance to resolve. `throttle.shouldUpdate()` is false throughout (simulating "the
        // window was already consumed by the placeholder apply") — the completion must still get
        // through, because it is a refinement of the phase already on screen, not a new event.
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });
        mockPresenceManager.applyView.mockClear();
        throttle.record.mockClear();

        // First frame: opens the turn into a digest-less 'responding' phase. Blocked by the
        // (always-false) throttle — matching production, where the placeholder already consumed it.
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(0) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();

        // The turn's own id is needed to target the phase_synopsis event at it.
        const turnId = conversation.get().turn?.id;
        expect(typeof turnId).toBe('string');

        // The synopsis resolves for that exact (still-open) phase — must be applied despite the
        // throttle never allowing an update.
        conversation.dispatch({
            type: 'phase_synopsis', turnId: turnId!, phaseType: 'responding', text: 'writing a reply', at: new Date(1),
        });

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase).toMatchObject({ type: 'responding', generatedStatus: 'writing a reply' });

        // The bypass still opens a fresh window: what it applied IS now what Discord shows, so
        // the very next ledger tick must not be entitled to re-send it (defect 3a — two
        // "Updated Discord presence" lines 1 ms apart in the 2026-09-08 production log).
        expect(throttle.record).toHaveBeenCalledTimes(1);

        // A later, DIFFERENT digest for the same phase also bypasses the throttle: digests are
        // already rate-limited at generation time (the stream handler only starts one when the
        // throttle window is open), and every one that resolves is the freshest description of
        // what Izzy is doing — holding it back for a window that a placeholder already spent is
        // exactly what left Discord stuck on "Thinking..." in the first conductor-mode soak.
        mockPresenceManager.applyView.mockClear();
        conversation.dispatch({
            type: 'phase_synopsis', turnId: turnId!, phaseType: 'responding', text: 'a later refinement', at: new Date(2),
        });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [refined] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(refined.phase).toMatchObject({ type: 'responding', generatedStatus: 'a later refinement' });

        // Re-dispatching the SAME digest text (the stream handler re-sends the pre-generated
        // thinking synopsis on every thinking transition) is not a change and stays throttled.
        mockPresenceManager.applyView.mockClear();
        conversation.dispatch({
            type: 'phase_synopsis', turnId: turnId!, phaseType: 'responding', text: 'a later refinement', at: new Date(3),
        });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });

    test('a real throttle recorded by the digest bypass suppresses the duplicate apply the next tick would otherwise make', () => {
        // Defect 3a end-to-end, against the REAL throttle rather than a stubbed one: before the
        // fix the bypass never recorded, so the ledger tick that followed it (the next sdk_frame,
        // carrying the very same digest) still satisfied planPresenceUpdate and re-applied
        // identical text — the pair of "Updated Discord presence" lines 1 ms apart in the log.
        const conversation = makeConversationLedger();
        let now = 0;
        const throttle = presenceModule.createPresenceThrottle(12_000, () => now);

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });

        // A turn opens well past the setup tick's own (idle) window, so its placeholder applies.
        now = 20_000;
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(now), channelId: 'chan-1' }, at: new Date(now),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(now) });
        const turnId = conversation.get().turn?.id;
        mockPresenceManager.applyView.mockClear();

        // The synopsis resolves a full window later: applied via the bypass.
        now = 33_000;
        conversation.dispatch({
            type: 'phase_synopsis', turnId: turnId!, phaseType: 'responding', text: 'writing a reply', at: new Date(now),
        });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);

        // 1 ms later the next frame of the same phase re-composes identical text. The window the
        // bypass just opened must hold it back.
        now = 33_001;
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(now) });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
    });

    test('a digest carried across a phase flip is not re-applied as "new" on the flip, but a fresher digest arriving after the flip is', () => {
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(0) });
        const turnId = conversation.get().turn?.id;
        conversation.dispatch({
            type: 'phase_synopsis', turnId: turnId!, phaseType: 'responding', text: 'writing a reply', at: new Date(1),
        });
        mockPresenceManager.applyView.mockClear();

        // Phase flips to using_tool; the ledger carries 'writing a reply' along. Same digest text,
        // new phase signature: an ordinary (throttled) event, not a digest arrival.
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_1'), at: new Date(2) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();

        // A fresher digest resolves for the new phase: applied immediately.
        conversation.dispatch({
            type: 'phase_synopsis', turnId: turnId!, phaseType: 'using_tool', text: 'running the tests', at: new Date(3),
        });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase).toMatchObject({ type: 'using_tool', generatedStatus: 'running the tests' });
    });

    test('a fresher digest that arrives on the SAME tick as a phase flip is an ordinary throttled event, not a bypass', () => {
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(0) });
        const turnId = conversation.get().turn?.id;
        conversation.dispatch({
            type: 'phase_synopsis', turnId: turnId!, phaseType: 'responding', text: 'writing a reply', at: new Date(1),
        });
        mockPresenceManager.applyView.mockClear();

        // New phase AND new digest in one event: the signature changed, so this is a new
        // presence-worthy event that the throttle is entitled to hold.
        conversation.dispatch({ type: 'phase_changed', phase: { type: 'thinking', startedAt: new Date(2), generatedStatus: 'now thinking' }, at: new Date(2) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });

    test('going idle is held for IDLE_SETTLE_MS: a turn opening inside the window cancels the idle apply entirely', () => {
        const conversation = makeConversationLedger();
        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });
        mockPresenceManager.applyView.mockClear();

        // The interrupted turn ends: the composed view is idle, but it must not be applied yet.
        conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(1) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();

        // The follow-up's turn opens well inside the window: the pending idle apply is dropped and
        // the active placeholder goes out as usual.
        jest.advanceTimersByTime(IDLE_SETTLE_MS / 2);
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-2', kind: 'discord', queuedAt: new Date(2), channelId: 'chan-1' }, at: new Date(2),
        });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase.type).not.toBe('idle');

        jest.advanceTimersByTime(IDLE_SETTLE_MS);
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
    });

    test('an idle view that persists past IDLE_SETTLE_MS is applied exactly once, and a second idle tick inside the window does not restart the clock', () => {
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };
        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });
        mockPresenceManager.applyView.mockClear();

        conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(1) });
        jest.advanceTimersByTime(IDLE_SETTLE_MS - 1);
        // Another idle-composed tick (a ledger event while idle) must not push the deadline out.
        conversation.dispatch({ type: 'tick', rssBytes: 1, at: new Date(2) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        // Idle bypasses the (always-closed) throttle, as before.
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase.type).toBe('idle');

        jest.advanceTimersByTime(IDLE_SETTLE_MS * 2);
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
    });

    test('unsubscribeLedgers cancels a pending idle apply', () => {
        const conversation = makeConversationLedger();
        const result = setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(1) });
        mockPresenceManager.applyView.mockClear();

        result.unsubscribeLedgers();
        jest.advanceTimersByTime(IDLE_SETTLE_MS * 2);

        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });

    test('unsubscribeLedgers stops mirroring from every ledger', () => {
        const conversation = makeConversationLedger();
        const { unsubscribeLedgers } = setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
        });
        mockPresenceManager.applyView.mockClear();
        unsubscribeLedgers();

        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });

        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });
});
