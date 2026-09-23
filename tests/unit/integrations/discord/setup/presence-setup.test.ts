/**
 * Tests for presence-setup.ts (setupConductorPresence — the only presence setup function; it
 * drives the presence manager solely through applyView and recomposeIdlePrefix).
 *
 * Covers:
 * - getPreviousStatus forwarding: verifies the callback is passed to createIdleStatusGenerator
 *   so the anti-rut block in status-generator-idle.ts fires on the live path.
 * - The turn synopsis: rendered from `PresenceView.synopsis` (the synopsis-arrival throttle
 *   bypass, keyed on the winning (role, turnId)), never produced here (#39).
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach, jest } from 'bun:test';
import { ActivityType, type Client } from 'discord.js';
import * as frames from '../../../../helpers/sdk-frames';
import { createLedgerStore, type LedgerStore } from '@/agent/session/ledger';
import { createChannelId } from '@/agent/types';
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
                generate: mock(() => ({ name: 'Active', type: ActivityType.Custom })),
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

    describe('presence renders the turn synopsis but never produces it (#39)', () => {
        test('the presence barrel no longer exports the synopsis producer or its generator', () => {
            expect('attachTurnSynopsis' in presenceModule).toBe(false);
            expect('createDynamicStatusGenerator' in presenceModule).toBe(false);
        });

        test('the setup result is exactly the presence manager and the ledger unsubscribe', () => {
            const result = setupConductorPresence({
                identityContext:  'Test identity',
                presenceConfig:   MINIMAL_PRESENCE_CONFIG,
                readyClient:      makeMockClient(),
                ledgers:          [makeConversationLedger()],
                throttle:         throttleAlways(),
                getRecentContext: () => Promise.resolve(undefined),
            });

            expect(Object.keys(result).toSorted((a, b) => a.localeCompare(b))).toEqual(['presenceManager', 'unsubscribeLedgers']);
        });

        test('unsubscribeLedgers stops every ledger from reaching the presence manager', () => {
            const conversation = makeConversationLedger();
            const perch = createLedgerStore('perch', { logger: { error: mock() } });
            const { unsubscribeLedgers } = setupConductorPresence({
                identityContext:  'Test identity',
                presenceConfig:   MINIMAL_PRESENCE_CONFIG,
                readyClient:      makeMockClient(),
                ledgers:          [conversation, perch],
                throttle:         throttleAlways(),
                getRecentContext: () => Promise.resolve(undefined),
            });
            mockPresenceManager.applyView.mockClear();

            unsubscribeLedgers();
            conversation.dispatch({ type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(1) }, at: new Date(1) });
            perch.dispatch({ type: 'turn_submitted', envelope: { id: 'perch-1', kind: 'perch', queuedAt: new Date(1) }, at: new Date(1) });

            expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
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
        expect(mockPresenceManager.start).toHaveBeenCalledTimes(1);
        expect(throttle.shouldUpdate).not.toHaveBeenCalled();
        expect(throttle.record).toHaveBeenCalledTimes(1);
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });

        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });

    test('isPerchPaused omitted: composed prefix carries no pause marker (Q3 / B4)', () => {
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

    test('isPerchPaused() true is composed into the prefix as the ⏸ perch marker (Q3 / B4)', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            isPerchPaused:    () => true,
        });

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).toBe('💤 • ⏸ perch');
    });

    test('isPerchPaused is re-read on every tick, not only at setup (Q3 / B4)', () => {
        const conversation = makeConversationLedger();
        let paused = false;

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            isPerchPaused:    () => paused,
        });
        mockPresenceManager.applyView.mockClear();

        paused = true;
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).toContain('⏸ perch');
    });

    test('wires PresenceManager with a recomposeIdlePrefix that re-reads isPerchPaused() at call time, not just at setup (Q3/B4 midnight-clear staleness)', () => {
        const conversation = makeConversationLedger();
        let paused = true;

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle:         throttleAlways(),
            getRecentContext: () => Promise.resolve(undefined),
            isPerchPaused:    () => paused,
        });

        expect(capturedPresenceManagerDeps?.recomposeIdlePrefix?.().prefix).toContain('⏸ perch');

        // The idle refresh loop calls this on its own periodic timer, independent of any ledger
        // event — a midnight clear (isPerchPaused() flipping false with no ledger activity) must
        // be visible the very next time it is called.
        paused = false;
        expect(capturedPresenceManagerDeps?.recomposeIdlePrefix?.().prefix).not.toContain('⏸');
    });

    test('recomposeIdlePrefix with isPerchPaused omitted carries no pause marker (Q3/B4)', () => {
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
        // The retired P14 oneshot bridge returned `unsubscribeModeTransition` /
        // `unsubscribeActivityPhase` handles; `setupConductorPresence` never did and still does not.
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(0) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();

        // The turn's own id is needed to target the turn_synopsis event at it.
        const turnId = conversation.get().turn?.id;
        expect(typeof turnId).toBe('string');

        // The synopsis resolves for that exact (still-open) turn — must be applied despite the
        // throttle never allowing an update.
        conversation.dispatch({ type: 'turn_synopsis', turnId: turnId!, text: 'writing a reply', at: new Date(1) });

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.synopsis).toBe('writing a reply');

        // The bypass still opens a fresh window: what it applied IS now what Discord shows, so
        // the very next ledger tick must not be entitled to re-send it (defect 3a — two
        // "Updated Discord presence" lines 1 ms apart in the 2026-09-08 production log).
        expect(throttle.record).toHaveBeenCalledTimes(1);

        // A later, DIFFERENT synopsis for the same turn also bypasses the throttle: synopses are
        // already rate-limited at generation time (each session's SynopsisBudget), and every one
        // that resolves is the freshest description of what Izzy is doing — holding it back for a
        // window that a placeholder already spent is exactly what left Discord stuck on
        // "Thinking..." in the first conductor-mode soak.
        mockPresenceManager.applyView.mockClear();
        throttle.record.mockClear();
        conversation.dispatch({ type: 'turn_synopsis', turnId: turnId!, text: 'a later refinement', at: new Date(2) });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        expect(throttle.record).toHaveBeenCalledTimes(1);
        const [refined] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(refined.synopsis).toBe('a later refinement');

        // Re-dispatching the SAME synopsis text is a ledger no-op, so nothing is applied.
        mockPresenceManager.applyView.mockClear();
        conversation.dispatch({ type: 'turn_synopsis', turnId: turnId!, text: 'a later refinement', at: new Date(3) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });

    test('a real throttle recorded by the synopsis bypass suppresses the duplicate apply the next tick would otherwise make', () => {
        // Defect 3a end-to-end, against the REAL throttle rather than a stubbed one: before the
        // fix the bypass never recorded, so the ledger tick that followed it (the next sdk_frame,
        // carrying the very same synopsis) still satisfied planPresenceUpdate and re-applied
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(now), channelId: createChannelId('chan-1') }, at: new Date(now),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(now) });
        const turnId = conversation.get().turn?.id;
        mockPresenceManager.applyView.mockClear();

        // The synopsis resolves a full window later: applied via the bypass.
        now = 33_000;
        conversation.dispatch({ type: 'turn_synopsis', turnId: turnId!, text: 'writing a reply', at: new Date(now) });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);

        // 1 ms later the next frame of the same phase re-composes identical text. The window the
        // bypass just opened must hold it back.
        now = 33_001;
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(now) });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
    });

    test('a phase flip under an unchanged synopsis is an ordinary throttled event, and a fresher synopsis after the flip still bypasses', () => {
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: new Date(0) });
        conversation.dispatch({ type: 'turn_synopsis', turnId: 'env-1', text: 'writing a reply', at: new Date(1) });
        mockPresenceManager.applyView.mockClear();

        // Phase flips to using_tool; the synopsis lives on the turn and is unchanged, so this is
        // not a synopsis arrival.
        conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_1'), at: new Date(2) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();

        conversation.dispatch({ type: 'turn_synopsis', turnId: 'env-1', text: 'running the tests', at: new Date(3) });
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase).toMatchObject({ type: 'using_tool', toolName: 'Bash' });
        expect(view.synopsis).toBe('running the tests');
    });

    test('a new turn replacing the old one with no idle view in between is not mistaken for a synopsis arrival', () => {
        // Kills a role-only signature: the new turn has no synopsis, which differs from the old
        // turn's — but it is a different TURN, so its synopsis-less view is an ordinary event.
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        conversation.dispatch({ type: 'turn_synopsis', turnId: 'env-1', text: 'writing a reply', at: new Date(1) });
        mockPresenceManager.applyView.mockClear();

        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-2', kind: 'discord', queuedAt: new Date(2), channelId: createChannelId('chan-1') }, at: new Date(2),
        });

        expect(conversation.get().turn?.id).toBe('env-2');
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });

    test('a synopsis for the session that is NOT winning presence never bypasses the throttle', () => {
        const conversation = makeConversationLedger();
        const perch = createLedgerStore('perch', { logger: { error: mock() } });
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };

        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation, perch],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        perch.dispatch({ type: 'turn_submitted', envelope: { id: 'perch-1', kind: 'perch', queuedAt: new Date(0) }, at: new Date(0) });
        mockPresenceManager.applyView.mockClear();
        throttle.record.mockClear();

        perch.dispatch({ type: 'turn_synopsis', turnId: 'perch-1', text: 'tidying notes', at: new Date(1) });

        expect(perch.get().turn?.synopsis).toBe('tidying notes');
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
        expect(throttle.record).not.toHaveBeenCalled();
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        mockPresenceManager.applyView.mockClear();

        // The interrupted turn ends: the composed view is idle, but it must not be applied yet.
        conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(1) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(1);

        // The follow-up's turn opens well inside the window: the pending idle apply is dropped and
        // the active placeholder goes out as usual.
        jest.advanceTimersByTime(IDLE_SETTLE_MS / 2);
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-2', kind: 'discord', queuedAt: new Date(2), channelId: createChannelId('chan-1') }, at: new Date(2),
        });
        expect(jest.getTimerCount()).toBe(0);
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
            isPerchPaused:    () => true,
        });
        throttle.record.mockClear();
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        mockPresenceManager.applyView.mockClear();

        conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(1) });
        // Explicit boundary values, rather than IDLE_SETTLE_MS, make this test a change detector
        // for the production settling duration itself.
        jest.advanceTimersByTime(1499);
        // Another idle-composed tick (a ledger event while idle) must not push the deadline out.
        conversation.dispatch({ type: 'tick', rssBytes: 1, at: new Date(2) });
        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        // Idle bypasses the (always-closed) throttle, as before.
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase.type).toBe('idle');
        expect(view.prefix).toContain('⏸ perch');
        expect(throttle.record).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(IDLE_SETTLE_MS * 2);
        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
    });

    test('a delayed idle apply uses the unpaused default when isPerchPaused is omitted', () => {
        const conversation = makeConversationLedger();
        const throttle = throttleAlways();
        setupConductorPresence({
            identityContext:  'Test identity',
            presenceConfig:   MINIMAL_PRESENCE_CONFIG,
            readyClient:      makeMockClient(),
            ledgers:          [conversation],
            throttle,
            getRecentContext: () => Promise.resolve(undefined),
        });
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        mockPresenceManager.applyView.mockClear();
        conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(1) });

        jest.advanceTimersByTime(IDLE_SETTLE_MS);

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).toBe('💤');
    });

    test('a queued idle callback rechecks the current view after an active turn cancels its timer', () => {
        let queuedIdleCallback: (() => void) | undefined;
        const captureTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
            queuedIdleCallback = callback as () => void;
            return 99 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        spies.push(spyOn(globalThis, 'setTimeout').mockImplementation(captureTimeout));
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });
        conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(1) });
        expect(queuedIdleCallback).toBeDefined();
        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-2', kind: 'discord', queuedAt: new Date(2), channelId: createChannelId('chan-1') }, at: new Date(2),
        });
        const applyCount = mockPresenceManager.applyView.mock.calls.length;

        queuedIdleCallback?.();

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(applyCount);
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
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
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: createChannelId('chan-1') }, at: new Date(0),
        });

        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });
});
