/**
 * Behavioural tests for {@link setupPerchDriverAndScheduler} (P12): the conductor-mode branch of
 * perch setup — no `stateManager`/`PerchSessionRunner`, just a {@link createPerchDriver} wired to
 * a {@link createPerchScheduler} that triggers it unconditionally (no `isPerchTurnRunning` passed
 * through, per `scheduler.ts`'s own optional-`isPerchTurnRunning` contract), and a conductor
 * wrapped so a settled `perch`/`wrapup` turn's response is delivered to the well-known
 * `perch-time` channel.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import * as agentModule from '@/agent';
import { type SendOutcome, type PerchConfig, type TurnResult  } from '@/agent';
import { createChannelId } from '@/agent/types';
import { ResponseRouter } from '@/integrations/discord/channel-registry';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import { setupPerchDriverAndScheduler } from '@/integrations/discord/setup/perch-setup';

type SetupParams = Parameters<typeof setupPerchDriverAndScheduler>[0];

const PERCH_CONFIG: PerchConfig = {
    enabled:               true,
    timezone:              'America/Los_Angeles',
    intervalMinutes:       60,
    jitterMinutes:         15,
    slotWindowMinutes:     45,
    wrapUpLeadMinutes:     5,
    interruptGraceMinutes: 2,
};

/** Minimal-but-complete `TurnResult` fixture: `completed` when given a string `response`, else a reply-less `failed` turn. */
function makeTurnResult(overrides: { envelopeId?: string, response?: string } = {}): TurnResult {
    const base = { envelopeId: overrides.envelopeId ?? 'env-1', sessionId: 'session-id', contextUsagePercent: 0 };
    return overrides.response === undefined
        ? { ...base, status: 'failed', response: null, error: new Error('no reply') }
        : { ...base, status: 'completed', response: overrides.response };
}

/** A `TurnResult` for a turn the perch driver's own `interruptCurrent` cut short. */
function makeInterruptedTurnResult(envelopeId: string): TurnResult {
    return {
        envelopeId, sessionId: 'session-id', contextUsagePercent: 0, status: 'interrupted', response: null, partialWork: { thinking: '', text: '', pendingToolUse: null, sessionId: undefined }, cancellationSource: 'interrupt_current',
    };
}

function deliveryDeps(overrides: Record<string, unknown> = {}): Pick<SetupParams, 'responseRouter' | 'client' | 'rateLimiter'> {
    return {
        responseRouter: { resolveDeliveryTarget: ResponseRouter.prototype.resolveDeliveryTarget },
        client:         {},
        rateLimiter:    {},
        ...overrides,
    } as unknown as Pick<SetupParams, 'responseRouter' | 'client' | 'rateLimiter'>;
}

describe('setupPerchDriverAndScheduler', () => {
    // The shared `mockLogger` preload singleton can arrive carrying calls recorded by
    // whichever randomly-ordered file ran before this one; the `not.toHaveBeenCalled()`
    // assertions below must only see this test's own calls.
    beforeEach(() => {
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
    });

    it('creates a driver with no stateManager/runner dependency and a scheduler with no isPerchTurnRunning', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        const createPerchDriverSpy = jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        const createPerchSchedulerSpy = jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) };
        const clock = { now: () => 0, setTimer: mock(), clearTimer: mock() };

        const result = setupPerchDriverAndScheduler({
            conductor, perchConfig: PERCH_CONFIG, clock, ...deliveryDeps(),
        });

        expect(createPerchDriverSpy).toHaveBeenCalledTimes(1);
        const driverArgs = createPerchDriverSpy.mock.calls[0][0];
        expect(typeof driverArgs.conductor.submit).toBe('function');
        expect(driverArgs.clock).toBe(clock);
        expect(driverArgs.config).toBe(PERCH_CONFIG);

        expect(createPerchSchedulerSpy).toHaveBeenCalledTimes(1);
        const schedulerArgs = createPerchSchedulerSpy.mock.calls[0][0];
        expect(schedulerArgs.isPerchTurnRunning).toBeUndefined();
        expect(schedulerArgs).not.toHaveProperty('perchSessionRunner');
        expect(schedulerArgs.isPerchPaused).toBeUndefined();

        expect(result.driver).toBe(fakeDriver);
        expect(result.scheduler).toBe(fakeScheduler);
        expect(fakeScheduler.start).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Perch driver and scheduler initialized and started (conductor mode)' });
    });

    it('forwards the ambient time-header provider to the driver by identity (session-peers block 4)', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        const createPerchDriverSpy = jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) };
        const clock = { now: () => 0, setTimer: mock(), clearTimer: mock() };
        const timeHeader = (): string => 'AMBIENT-HEADER';

        setupPerchDriverAndScheduler({
            conductor, perchConfig: PERCH_CONFIG, clock, timeHeader, ...deliveryDeps(),
        });

        expect(createPerchDriverSpy.mock.calls[0][0].timeHeader).toBe(timeHeader);
    });

    it('forwards the perch slot hooks to the driver by identity, so the identity-driven reopen lands between slots', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        const createPerchDriverSpy = jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) };
        const clock = { now: () => 0, setTimer: mock(), clearTimer: mock() };
        const slotHooks = { onSlotStart: mock(), onSlotEnd: mock() };

        setupPerchDriverAndScheduler({
            conductor, perchConfig: PERCH_CONFIG, clock, slotHooks, ...deliveryDeps(),
        });

        expect(createPerchDriverSpy.mock.calls[0][0].slotHooks).toBe(slotHooks);
    });

    it('leaves the driver\'s slot hooks undefined when none are wired', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        const createPerchDriverSpy = jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) };
        const clock = { now: () => 0, setTimer: mock(), clearTimer: mock() };

        setupPerchDriverAndScheduler({
            conductor, perchConfig: PERCH_CONFIG, clock, ...deliveryDeps(),
        });

        expect(createPerchDriverSpy.mock.calls[0][0].slotHooks).toBeUndefined();
    });

    it('leaves the driver\'s time-header provider undefined when none is wired', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        const createPerchDriverSpy = jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) };
        const clock = { now: () => 0, setTimer: mock(), clearTimer: mock() };

        setupPerchDriverAndScheduler({
            conductor, perchConfig: PERCH_CONFIG, clock, ...deliveryDeps(),
        });

        expect(createPerchDriverSpy.mock.calls[0][0].timeHeader).toBeUndefined();
    });

    it('forwards isPerchPaused to the scheduler deps by identity (Q3 / B4)', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        const createPerchSchedulerSpy = jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) };
        const clock = { now: () => 0, setTimer: mock(), clearTimer: mock() };
        const isPerchPaused = (): boolean => true;

        setupPerchDriverAndScheduler({
            conductor, perchConfig: PERCH_CONFIG, clock, isPerchPaused, ...deliveryDeps(),
        });

        const schedulerArgs = createPerchSchedulerSpy.mock.calls[0][0];
        expect(schedulerArgs.isPerchPaused).toBe(isPerchPaused);
    });

    it('wires the scheduler\'s onPerchTrigger to call driver.runSlot', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        let capturedTrigger: ((slot: string) => void) | undefined;
        jest.spyOn(agentModule, 'createPerchScheduler').mockImplementation((deps) => {
            capturedTrigger = deps.onPerchTrigger as unknown as (slot: string) => void;
            return { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        });

        setupPerchDriverAndScheduler({
            conductor:   { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) },
            perchConfig: PERCH_CONFIG,
            clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
            ...deliveryDeps(),
        });

        expect(capturedTrigger).toBeDefined();
        capturedTrigger?.('mid-morning');
        expect(fakeDriver.runSlot).toHaveBeenCalledWith('mid-morning');
    });

    it('threads contextBuilder and activityLogger through to the driver when provided', () => {
        const createPerchDriverSpy = jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue({ runSlot: mock(), stop: mock() });
        jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue({ start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() });
        const contextBuilder = { buildPerchContext: mock(async () => '') };
        const activityLogger = { log: mock(async () => undefined) };

        setupPerchDriverAndScheduler({
            conductor:   { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })) },
            perchConfig: PERCH_CONFIG,
            clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
            contextBuilder,
            activityLogger,
            ...deliveryDeps(),
        });

        const driverArgs = createPerchDriverSpy.mock.calls[0][0];
        expect(driverArgs.contextBuilder).toBe(contextBuilder);
        expect(driverArgs.activityLogger).toBe(activityLogger);
    });

    describe('perch-turn result delivery (P12 folded gap)', () => {
        function captureDriverConductor(): { getConductor: () => { submit: (envelope: unknown, options: unknown) => Promise<TurnResult> } | undefined } {
            let captured: { submit: (envelope: unknown, options: unknown) => Promise<TurnResult> } | undefined;
            jest.spyOn(agentModule, 'createPerchDriver').mockImplementation((deps) => {
                captured = deps.conductor as unknown as { submit: (envelope: unknown, options: unknown) => Promise<TurnResult> };
                return { runSlot: mock(), stop: mock() };
            });
            jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue({ start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() });
            return { getConductor: () => captured };
        }

        it('delivers a settled \'perch\'-kind turn\'s response to the well-known perch-time channel via conductor.deliver', async () => {
            const { getConductor } = captureDriverConductor();
            const sendEnvelopeResponseSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });
            const innerSubmit = mock(async () => makeTurnResult({ envelopeId: 'env-perch-1', response: 'Perch summary text' }));
            let deliveredTarget: SendOutcome | undefined;
            const innerDeliver = mock(async (_id: string, send: () => Promise<SendOutcome>) => {
                deliveredTarget = await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            });
            setupPerchDriverAndScheduler({
                conductor:   { submit: innerSubmit, interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-perch-1', kind: 'perch' }, { priority: 'normal' });

            expect(innerDeliver).toHaveBeenCalledTimes(1);
            expect(deliveredTarget).toEqual({ kind: 'committed', disposition: 'sent', channelId: createChannelId('channel-1'), messageIds: [] });
            expect(sendEnvelopeResponseSpy).toHaveBeenCalledWith(expect.objectContaining({
                envelopeId: 'env-perch-1', kind: 'perch', text: 'Perch summary text',
            }));
        });

        it('forces a perch reply to perch-time even if its envelope carries an origin channel', async () => {
            const { getConductor } = captureDriverConductor();
            const sendEnvelopeResponseSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: createChannelId('perch-time'), messageIds: ['msg-1'] });
            let deliveredTarget: SendOutcome | undefined;
            const innerDeliver = mock(async (_id: string, send: () => Promise<SendOutcome>) => {
                deliveredTarget = await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            });
            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-perch-origin', response: 'Perch reply' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            await getConductor()?.submit({ id: 'env-perch-origin', kind: 'perch', channelId: createChannelId('launch-channel') }, { priority: 'normal' });

            expect(innerDeliver).toHaveBeenCalledTimes(1);
            expect(deliveredTarget).toEqual({ kind: 'committed', disposition: 'sent', channelId: createChannelId('perch-time'), messageIds: ['msg-1'] });
            expect(sendEnvelopeResponseSpy).toHaveBeenCalledTimes(1);
            expect(sendEnvelopeResponseSpy).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: 'env-perch-origin', kind: 'perch', channelId: undefined, text: 'Perch reply' }));
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('delivers a settled wrapup via the router mapping without overriding its channel', async () => {
            const { getConductor } = captureDriverConductor();
            const sendEnvelopeResponseSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });
            const innerSubmit = mock(async () => makeTurnResult({ envelopeId: 'env-wrapup-1', response: 'Wrapping up soon' }));
            let deliveredTarget: SendOutcome | undefined;
            const innerDeliver = mock(async (_id: string, send: () => Promise<SendOutcome>) => {
                deliveredTarget = await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            });
            setupPerchDriverAndScheduler({
                conductor:   { submit: innerSubmit, interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-wrapup-1', kind: 'wrapup' }, { priority: 'normal' });

            // `deliver` journals the target reported by the sender's tagged result.
            expect(deliveredTarget).toEqual({ kind: 'committed', disposition: 'sent', channelId: createChannelId('channel-1'), messageIds: [] });
            expect(sendEnvelopeResponseSpy).toHaveBeenCalledWith(expect.objectContaining({
                envelopeId: 'env-wrapup-1', kind: 'wrapup', channelId: undefined, text: 'Wrapping up soon',
            }));
        });

        it('never delivers a \'discord\'-kind turn (handlers.ts already delivers that one itself)', async () => {
            const { getConductor } = captureDriverConductor();
            const sendEnvelopeResponseSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });
            const innerDeliver = mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const }));

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-discord-1', response: 'hi' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-discord-1', kind: 'discord' }, { priority: 'normal' });

            expect(innerDeliver).not.toHaveBeenCalled();
            expect(sendEnvelopeResponseSpy).not.toHaveBeenCalled();
        });

        it('does not deliver when the turn produced no response (null)', async () => {
            const { getConductor } = captureDriverConductor();
            const innerDeliver = mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const }));

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeInterruptedTurnResult('env-perch-2')), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-perch-2', kind: 'perch' }, { priority: 'normal' });

            expect(innerDeliver).not.toHaveBeenCalled();
        });

        it('a delivery failure is logged but does not reject the wrapped submit() call', async () => {
            const { getConductor } = captureDriverConductor();
            const error = new Error('Discord API down');
            jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockRejectedValue(error);
            const innerDeliver = mock(async (_id: string, send: () => Promise<SendOutcome>) => {
                await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            });

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-perch-3', response: 'text' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await expect(wrapped?.submit({ id: 'env-perch-3', kind: 'perch' }, { priority: 'normal' })).resolves.toEqual(expect.objectContaining({ envelopeId: 'env-perch-3' }));
            expect(mockLogger.error).toHaveBeenCalledWith({
                err: error, envelopeId: 'env-perch-3', kind: 'perch', msg: 'Perch turn response delivery failed',
            });
        });

        it('the not-sent sentinel (sent:false, queued:false) is suppressed — no error log, no rejection of the wrapped submit() call', async () => {
            const { getConductor } = captureDriverConductor();
            jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'skipped', reason: 'no-response' });
            let sendCompleted = false;
            const innerDeliver = mock(async (_id: string, send: () => Promise<SendOutcome>) => {
                await send();
                sendCompleted = true;
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            });

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-perch-4', response: 'text' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await expect(wrapped?.submit({ id: 'env-perch-4', kind: 'perch' }, { priority: 'normal' })).resolves.toEqual(expect.objectContaining({ envelopeId: 'env-perch-4' }));
            expect(sendCompleted).toBe(true);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('a queued perch response completes delivery and returns the empty-channel receipt', async () => {
            const { getConductor } = captureDriverConductor();
            jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'queued', channelId: 'channel-1' as never, outboxIds: ['outbox-1'] });
            let deliveredTarget: SendOutcome | undefined;
            const innerDeliver = mock(async (_id: string, send: () => Promise<SendOutcome>) => {
                deliveredTarget = await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            });
            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ response: 'queued' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, lifecycle: 'open' as const, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            await getConductor()?.submit({ id: 'env-1', kind: 'perch' }, { priority: 'normal' });

            expect(deliveredTarget).toEqual({ kind: 'committed', disposition: 'queued', channelId: createChannelId('channel-1'), outboxIds: ['outbox-1'] });
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });
});
