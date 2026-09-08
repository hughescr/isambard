/**
 * Behavioural tests for {@link setupPerchDriverAndScheduler} (P12): the conductor-mode branch of
 * perch setup — no `stateManager`/`PerchSessionRunner`, just a {@link createPerchDriver} wired to
 * a {@link createPerchScheduler} that triggers it unconditionally (no `isPerchTurnRunning` passed
 * through, per `scheduler.ts`'s own optional-`isPerchTurnRunning` contract), and a conductor
 * wrapped so a settled `perch`/`wrapup` turn's response is delivered to the well-known
 * `perch-time` channel.
 */
import { afterEach, describe, expect, it, jest, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import * as agentModule from '@/agent';
import type { PerchConfig, TurnResult } from '@/agent';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import { setupPerchDriverAndScheduler } from '@/integrations/discord/setup/perch-setup';

type SetupParams = Parameters<typeof setupPerchDriverAndScheduler>[0];

const PERCH_CONFIG: PerchConfig = {
    enabled:               true,
    timezone:              'America/Los_Angeles',
    intervalMinutes:       60,
    jitterMinutes:         15,
    maxSessionMinutes:     45,
    wrapUpTimeoutMinutes:  5,
    interruptGraceMinutes: 2,
};

/** Minimal-but-complete `TurnResult` fixture. */
function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
    return {
        envelopeId:          'env-1',
        response:            null,
        wasInterrupted:      false,
        partialWork:         { thinking: '', text: '', pendingToolUse: null, sessionId: undefined },
        sessionId:           'session-id',
        isError:             false,
        contextUsagePercent: 0,
        ...overrides,
    };
}

function fakeChannelRegistry(perchTimeChannelId: string | null = 'perch-time-channel-id') {
    return {
        getWellKnownChannel: mock(async () => (perchTimeChannelId === null
            ? null
            : {
                channelId: perchTimeChannelId, channelName: 'perch-time', guildId: 'guild-1', isMuted: false, isWellKnown: 'perch-time' as const, discoveredAt: '2025-01-01T00:00:00.000Z', lastSeenAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
            })),
    };
}

function deliveryDeps(overrides: Record<string, unknown> = {}): Pick<SetupParams, 'channelRegistry' | 'responseRouter' | 'client' | 'rateLimiter'> {
    return {
        channelRegistry: fakeChannelRegistry(),
        responseRouter:  {},
        client:          {},
        rateLimiter:     {},
        ...overrides,
    } as unknown as Pick<SetupParams, 'channelRegistry' | 'responseRouter' | 'client' | 'rateLimiter'>;
}

describe('setupPerchDriverAndScheduler', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        mockLogger.error.mockClear();
    });

    it('creates a driver with no stateManager/runner dependency and a scheduler with no isPerchTurnRunning', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        const createPerchDriverSpy = jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        const createPerchSchedulerSpy = jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ delivered: true })) };
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
        expect(schedulerArgs.isCostPaused).toBeUndefined();

        expect(result.driver).toBe(fakeDriver);
        expect(result.scheduler).toBe(fakeScheduler);
        expect(fakeScheduler.start).toHaveBeenCalledTimes(1);
    });

    it('forwards isCostPaused to the scheduler deps by identity (Q3 / B4)', () => {
        const fakeDriver = { runSlot: mock(), stop: mock() };
        const fakeScheduler = { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
        jest.spyOn(agentModule, 'createPerchDriver').mockReturnValue(fakeDriver);
        const createPerchSchedulerSpy = jest.spyOn(agentModule, 'createPerchScheduler').mockReturnValue(fakeScheduler);
        const conductor = { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ delivered: true })) };
        const clock = { now: () => 0, setTimer: mock(), clearTimer: mock() };
        const isCostPaused = (): boolean => true;

        setupPerchDriverAndScheduler({
            conductor, perchConfig: PERCH_CONFIG, clock, isCostPaused, ...deliveryDeps(),
        });

        const schedulerArgs = createPerchSchedulerSpy.mock.calls[0][0];
        expect(schedulerArgs.isCostPaused).toBe(isCostPaused);
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
            conductor:   { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ delivered: true })) },
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
            conductor:   { submit: mock(async () => makeTurnResult()), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: mock(async () => ({ delivered: true })) },
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
            const sendEnvelopeResponseSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });
            const innerSubmit = mock(async () => makeTurnResult({ envelopeId: 'env-perch-1', response: 'Perch summary text' }));
            const innerDeliver = mock(async (_id: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                await send();
                return { delivered: true };
            });

            setupPerchDriverAndScheduler({
                conductor:   { submit: innerSubmit, interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-perch-1', kind: 'perch' }, { priority: 'other' });

            expect(innerDeliver).toHaveBeenCalledTimes(1);
            expect(sendEnvelopeResponseSpy).toHaveBeenCalledWith(expect.objectContaining({
                envelopeId: 'env-perch-1', kind: 'perch', text: 'Perch summary text',
            }));
        });

        it('delivers a settled \'wrapup\'-kind turn\'s response, resolving the perch-time channel id explicitly', async () => {
            const { getConductor } = captureDriverConductor();
            const sendEnvelopeResponseSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });
            const innerSubmit = mock(async () => makeTurnResult({ envelopeId: 'env-wrapup-1', response: 'Wrapping up soon' }));
            const innerDeliver = mock(async (_id: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                await send();
                return { delivered: true };
            });
            const channelRegistry = fakeChannelRegistry('perch-time-channel-id');

            setupPerchDriverAndScheduler({
                conductor:   { submit: innerSubmit, interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps({ channelRegistry }),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-wrapup-1', kind: 'wrapup' }, { priority: 'other' });

            expect(channelRegistry.getWellKnownChannel).toHaveBeenCalledWith('perch-time');
            expect(sendEnvelopeResponseSpy).toHaveBeenCalledWith(expect.objectContaining({
                envelopeId: 'env-wrapup-1', kind: 'wrapup', channelId: 'perch-time-channel-id', text: 'Wrapping up soon',
            }));
        });

        it('never delivers a \'discord\'-kind turn (handlers.ts already delivers that one itself)', async () => {
            const { getConductor } = captureDriverConductor();
            const sendEnvelopeResponseSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });
            const innerDeliver = mock(async () => ({ delivered: true }));

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-discord-1', response: 'hi' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-discord-1', kind: 'discord' }, { priority: 'other' });

            expect(innerDeliver).not.toHaveBeenCalled();
            expect(sendEnvelopeResponseSpy).not.toHaveBeenCalled();
        });

        it('does not deliver when the turn produced no response (null)', async () => {
            const { getConductor } = captureDriverConductor();
            const innerDeliver = mock(async () => ({ delivered: true }));

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-perch-2', response: null, wasInterrupted: true })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await wrapped?.submit({ id: 'env-perch-2', kind: 'perch' }, { priority: 'other' });

            expect(innerDeliver).not.toHaveBeenCalled();
        });

        it('a delivery failure is logged but does not reject the wrapped submit() call', async () => {
            const { getConductor } = captureDriverConductor();
            jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockRejectedValue(new Error('Discord API down'));
            const innerDeliver = mock(async (_id: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                await send();
                return { delivered: true };
            });

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-perch-3', response: 'text' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await expect(wrapped?.submit({ id: 'env-perch-3', kind: 'perch' }, { priority: 'other' })).resolves.toEqual(expect.objectContaining({ envelopeId: 'env-perch-3' }));
        });

        it('the not-sent sentinel (sent:false, queued:false) is suppressed — no error log, no rejection of the wrapped submit() call', async () => {
            const { getConductor } = captureDriverConductor();
            jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, queued: false });
            const innerDeliver = mock(async (_id: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                await send();
                return { delivered: true };
            });

            setupPerchDriverAndScheduler({
                conductor:   { submit: mock(async () => makeTurnResult({ envelopeId: 'env-perch-4', response: 'text' })), interruptCurrent: mock(), status: mock(() => ({ role: 'perch' as const, sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: null })), deliver: innerDeliver },
                perchConfig: PERCH_CONFIG,
                clock:       { now: () => 0, setTimer: mock(), clearTimer: mock() },
                ...deliveryDeps(),
            });

            const wrapped = getConductor();
            await expect(wrapped?.submit({ id: 'env-perch-4', kind: 'perch' }, { priority: 'other' })).resolves.toEqual(expect.objectContaining({ envelopeId: 'env-perch-4' }));
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });
});
