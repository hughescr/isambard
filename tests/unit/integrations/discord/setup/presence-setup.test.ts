/**
 * Tests for presence-setup.ts
 *
 * Covers:
 * - getPreviousStatus forwarding: verifies the callback is passed to createIdleStatusGenerator
 *   so the anti-rut block in status-generator-idle.ts fires on the live path.
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
import { IDLE_SETTLE_MS, setupConductorPresence, setupPresence } from '@/integrations/discord/setup/presence-setup';
import type { BotStateManager, StateChange } from '@/integrations/discord/state';

/** Minimal presence config for tests — required fields only, all others use defaults */
const MINIMAL_PRESENCE_CONFIG: NonNullable<DiscordConfig['presence']> = {
    updateThrottleMs:      12_000,
    idleTimeoutMs:         60_000,
    idleRefreshIntervalMs: 300_000,
};

/** Minimal mock BotStateManager */
function makeMockBotStateManager(): BotStateManager {
    return {
        subscribe:            mock((_listener: (change: StateChange) => void) => mock(() => undefined)),
        shouldUpdatePresence: mock(() => false),
        recordPresenceUpdate: mock(() => undefined),
        start:                mock(() => undefined),
        stop:                 mock(() => undefined),
    } as unknown as BotStateManager;
}

/** Minimal mock Client */
function makeMockClient(): Client {
    return {} as unknown as Client;
}

describe('setupPresence — getPreviousStatus forwarding', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    let capturedIdleDeps: IdleStatusGeneratorDeps | undefined;

    const mockPresenceManager = {
        start:                         mock(() => undefined),
        stop:                          mock(() => undefined),
        updatePhase:                   mock(async () => undefined),
        transitionPresenceDisplayMode: mock(() => undefined),
    };

    beforeEach(() => {
        capturedIdleDeps = undefined;

        spies.push(
            // @ts-expect-error — Mocking constructor
            spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
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
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        mock.restore();
    });

    test('should forward getPreviousStatus to createIdleStatusGenerator when provided', () => {
        const getPreviousStatus = mock((): string | undefined => 'previous status text');

        setupPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            botStateManager:        makeMockBotStateManager(),
            dynamicStatusGenerator: undefined,
            inboxManager:           undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            getPreviousStatus,
        });

        // Verify createIdleStatusGenerator was called with the deps
        expect(presenceModule.createIdleStatusGenerator).toHaveBeenCalled();
        expect(capturedIdleDeps?.getPreviousStatus).toBe(getPreviousStatus);
    });

    test('getPreviousStatus passed to setupPresence reaches createIdleStatusGenerator deps', () => {
        const getPreviousStatus = mock((): string | undefined => 'last idle text');

        setupPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            botStateManager:        makeMockBotStateManager(),
            dynamicStatusGenerator: undefined,
            inboxManager:           undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            getPreviousStatus,
        });

        // The captured deps must include the exact same getPreviousStatus function
        expect(capturedIdleDeps?.getPreviousStatus).toBe(getPreviousStatus);
    });

    test('getPreviousStatus is undefined in createIdleStatusGenerator deps when not passed to setupPresence', () => {
        setupPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            botStateManager:        makeMockBotStateManager(),
            dynamicStatusGenerator: undefined,
            inboxManager:           undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            // No getPreviousStatus
        });

        expect(capturedIdleDeps?.getPreviousStatus).toBeUndefined();
    });
});

describe('setupConductorPresence', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    let mockPresenceManager: { start: ReturnType<typeof mock>, stop: ReturnType<typeof mock>, applyView: ReturnType<typeof mock> };
    let capturedPresenceManagerDeps: PresenceManagerDeps | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
        mockPresenceManager = {
            start:     mock(() => undefined),
            stop:      mock(() => undefined),
            applyView: mock(async (_view: PresenceView) => undefined),
        };
        capturedPresenceManagerDeps = undefined;

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
            spyOn(presenceModule, 'createIdleStatusGenerator').mockImplementation(() => ({
                generate: mock(async () => ({ name: 'Idle', type: ActivityType.Custom })),
            }))
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

    test('composes once synchronously at setup, applying an idle view before any ledger event', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
        });

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.phase).toEqual({ type: 'idle', since: expect.any(Date) });
    });

    test('applies a new view when a subscribed ledger store changes', () => {
        const conversation = makeConversationLedger();
        setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle,
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
        });

        expect(mockPresenceManager.applyView).toHaveBeenCalledTimes(1);
    });

    test('a non-idle view is blocked while the throttle window has not elapsed', () => {
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };
        setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle,
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
        });

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).not.toContain('⏸');
    });

    test('isCostPaused() true is composed into the prefix as the ⏸ perch marker (Q3 / B4)', () => {
        const conversation = makeConversationLedger();

        setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            isCostPaused:           () => true,
        });

        const [view] = mockPresenceManager.applyView.mock.calls[0] as [PresenceView];
        expect(view.prefix).toBe('💤 • ⏸ perch');
    });

    test('isCostPaused is re-read on every tick, not only at setup (Q3 / B4)', () => {
        const conversation = makeConversationLedger();
        let paused = false;

        setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            isCostPaused:           () => paused,
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            isCostPaused:           () => paused,
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
        });

        expect(capturedPresenceManagerDeps?.recomposeIdlePrefix?.().prefix).not.toContain('⏸');
    });

    test('return shape carries no BotStateManager-bridge unsubscribe handles (setupConductorPresence takes no BotStateManager to subscribe to)', () => {
        // `setupConductorPresence`'s own parameter list has no `botStateManager`, so it cannot
        // call `.subscribe()` on one — there is no reference to spy on here. The behavioural
        // guarantee this test's old name claimed ("botStateManager.subscribe is never called in
        // the conductor branch") is verified where it is actually observable: bot.test.ts's "the
        // ring buffers themselves never subscribe to botStateManager in conductor mode". This test
        // only pins the return shape: no `unsubscribeModeTransition`/`unsubscribeActivityPhase`
        // (the oneshot bridge's handles), just `unsubscribeLedgers`.
        const conversation = makeConversationLedger();

        const result = setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle,
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
        });
        mockPresenceManager.applyView.mockClear();

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

    test('a digest carried across a phase flip is not re-applied as "new" on the flip, but a fresher digest arriving after the flip is', () => {
        const conversation = makeConversationLedger();
        const throttle = { shouldUpdate: mock(() => false), record: mock(() => undefined) };

        setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle,
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle,
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle,
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
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

    test('records every applied update on the legacy BotStateManager throttle, without ever subscribing to it', () => {
        // Regression test for the P11 review finding: `setupPresence`'s oneshot bridge (the only
        // caller of `botStateManager.recordPresenceUpdate()`) does not run in conductor mode, so
        // `shouldUpdatePresence()` — read by the still-legacy perch runner's own stream handler via
        // `createStreamEventHandler` — is permanently true unless something else keeps recording.
        const conversation = makeConversationLedger();
        const botStateManager = { recordPresenceUpdate: mock(() => undefined) };

        setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            botStateManager,
        });
        // The synchronous setup-time compose (idle) already recorded once.
        expect(botStateManager.recordPresenceUpdate).toHaveBeenCalledTimes(1);

        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });

        expect(botStateManager.recordPresenceUpdate).toHaveBeenCalledTimes(2);
    });

    test('never calls anything on botStateManager but recordPresenceUpdate (still no subscribe)', () => {
        const conversation = makeConversationLedger();
        const recordPresenceUpdate = mock(() => undefined);
        const botStateManager = new Proxy({ recordPresenceUpdate }, {
            get(target, prop: string) {
                if(prop === 'recordPresenceUpdate') {
                    return target.recordPresenceUpdate;
                }
                throw new Error(`Unexpected access to botStateManager.${prop} from setupConductorPresence`);
            },
        });

        expect(() => setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            botStateManager,
        })).not.toThrow();
    });

    test('unsubscribeLedgers stops mirroring from every ledger', () => {
        const conversation = makeConversationLedger();
        const { unsubscribeLedgers } = setupConductorPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            ledgers:                [conversation],
            throttle:               throttleAlways(),
            dynamicStatusGenerator: undefined,
            getRecentContext:       () => Promise.resolve(undefined),
        });
        mockPresenceManager.applyView.mockClear();
        unsubscribeLedgers();

        conversation.dispatch({
            type: 'turn_submitted', envelope: { id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1' }, at: new Date(0),
        });

        expect(mockPresenceManager.applyView).not.toHaveBeenCalled();
    });
});
