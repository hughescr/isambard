import { describe, test, expect, beforeEach, afterEach, mock, jest, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../../helpers/fake-clock';
import { createPerchDriver, type PerchDriverDeps } from '@/agent/perch/perch-driver';
import type { PerchConfig } from '@/agent/perch/types';
import type { Conductor, ConductorStatus, Envelope, SubmitOptions, TurnResult } from '@/agent/session';
import type { ActivityLogger } from '@/storage';

/** Flushes enough microtask ticks for a promise chain (e.g. an awaited contextBuilder call) to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

/** Minimal-but-complete TurnResult fixture; individual fields overridden per test. */
function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
    return {
        envelopeId:          'envelope-id',
        response:            'ok',
        wasInterrupted:      false,
        partialWork:         { thinking: '', text: '', pendingToolUse: null, sessionId: undefined },
        sessionId:           'session-id',
        isError:             false,
        contextUsagePercent: 0,
        ...overrides,
    };
}

interface FakeSubmission {
    envelope: Envelope
    options:  SubmitOptions
    resolve:  (result: TurnResult) => void
    /** Typed `Error` (not `unknown`) so `submit`'s wrapper below can call the native Promise
     * executor's `reject` with it directly without tripping `prefer-promise-reject-errors`. */
    reject:   (error: Error) => void
}

/** What {@link createFakeConductor}'s `status()` reports as the conductor's currently active turn. */
type FakeActiveTurn = NonNullable<ConductorStatus['turn']>;

/**
 * A fake conductor exposing only the surface `createPerchDriver` depends on
 * (`submit`/`interruptCurrent`/`status`). Every `submit()` call is captured (never auto-resolved)
 * so tests control exactly when a turn "finishes".
 *
 * `status()` mirrors the real conductor's own single-active-turn semantics closely enough for
 * these tests: by default, a `submit()` call becomes the "active" turn immediately UNLESS some
 * other turn is already active (mimicking `routeIncoming`'s enqueue-behind-a-running-turn
 * behaviour) — call `setActiveTurn` before `driver.runSlot(...)` to simulate an unrelated turn
 * (e.g. a live perch-channel Discord message) already running when the slot submission arrives,
 * so it merely queues instead of becoming active. A submission's own settle (`resolve`/`reject`)
 * clears `activeTurn` when it was the one holding it.
 */
function createFakeConductor(): Pick<Conductor, 'submit' | 'interruptCurrent' | 'status'> & {
    submissions:      FakeSubmission[]
    interruptCurrent: Mock<() => Promise<void>>
    status:           Mock<() => ConductorStatus>
    setActiveTurn:    (turn: FakeActiveTurn | null) => void
} {
    const submissions: FakeSubmission[] = [];
    let activeTurn: FakeActiveTurn | null = null;
    return {
        submissions,
        submit: mock((envelope: Envelope, options: SubmitOptions) => new Promise<TurnResult>((resolve, reject) => {
            activeTurn ??= { kind: envelope.kind, envelopeId: envelope.id, channelId: envelope.channelId };
            submissions.push({
                envelope,
                options,
                resolve: (result) => {
                    if(activeTurn?.envelopeId === envelope.id) {
                        activeTurn = null;
                    }
                    resolve(result);
                },
                reject: (error) => {
                    if(activeTurn?.envelopeId === envelope.id) {
                        activeTurn = null;
                    }
                    reject(error);
                },
            });
        })),
        interruptCurrent: mock(() => Promise.resolve()),
        status:           mock(() => ({
            role: 'perch', sessionId: undefined, opened: true, shuttingDown: false, queueLength: 0, turn: activeTurn,
        })),
        setActiveTurn(turn: FakeActiveTurn | null): void {
            activeTurn = turn;
        },
    };
}

function createMockLogger(): Logger {
    return {
        debug: mock(() => {}),
        info:  mock(() => {}),
        warn:  mock(() => {}),
        error: mock(() => {}),
    } as unknown as Logger;
}

function createMockActivityLogger(): ActivityLogger {
    return { log: mock(() => Promise.resolve()) };
}

// Distinct minute values so ArithmeticOperator mutants (endsAt +/- lead, +/- grace) cannot
// survive: wrapUpTimeoutMinutes (3) and interruptGraceMinutes (7) are both different from each
// other and from maxSessionMinutes (20).
const MAX_SESSION_MINUTES = 20;
const WRAP_UP_TIMEOUT_MINUTES = 3;
const INTERRUPT_GRACE_MINUTES = 7;
const MINUTE_MS = 60_000;

function makeConfig(overrides: Partial<PerchConfig> = {}): PerchConfig {
    return {
        enabled:               true,
        timezone:              'America/Los_Angeles',
        intervalMinutes:       60,
        jitterMinutes:         15,
        maxSessionMinutes:     MAX_SESSION_MINUTES,
        wrapUpTimeoutMinutes:  WRAP_UP_TIMEOUT_MINUTES,
        interruptGraceMinutes: INTERRUPT_GRACE_MINUTES,
        ...overrides,
    };
}

describe('createPerchDriver', () => {
    let clock: FakeClock;
    let conductor: ReturnType<typeof createFakeConductor>;
    let activityLogger: ActivityLogger;
    let logger: Logger;
    let getCurrentLocalHour: Mock<() => number>;
    let deps: PerchDriverDeps;

    beforeEach(() => {
        clock = new FakeClock(0);
        conductor = createFakeConductor();
        activityLogger = createMockActivityLogger();
        logger = createMockLogger();
        getCurrentLocalHour = mock(() => 14);
        deps = {
            conductor,
            clock,
            config: makeConfig(),
            getCurrentLocalHour,
            activityLogger,
            logger,
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('runSlot submits a perch envelope, returns "started", and logs perch-start', () => {
        const driver = createPerchDriver(deps);

        const outcome = driver.runSlot('afternoon');

        expect(outcome).toBe('started');
        expect(conductor.submit).toHaveBeenCalledTimes(1);
        const { envelope, options } = conductor.submissions[0];
        expect(envelope.kind).toBe('perch');
        expect(options.priority).toBe('other');
        expect(activityLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: 'perch-start' }));
    });

    test('renders the slot envelope\'s time header with formatTimeHeader and the perch timezone by default', () => {
        const driver = createPerchDriver(deps);

        driver.runSlot('afternoon');

        expect(conductor.submissions[0].envelope.text).toContain('## Current Time');
    });

    test('takes the slot envelope\'s time header from an injected provider, called with the perch timezone (session-peers block 4)', () => {
        const timeHeader = mock((_tz?: string) => 'AMBIENT-HEADER\n- Perch: idle');
        const driver = createPerchDriver({ ...deps, timeHeader });

        driver.runSlot('afternoon');

        expect(timeHeader).toHaveBeenCalledWith(makeConfig().timezone);
        expect(conductor.submissions[0].envelope.text).toContain('- Perch: idle');
    });

    test('submits the wrap-up envelope exactly at endsAt - wrapUpTimeoutMinutes while the slot turn is still running, at priority \'human\'', async () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        const wrapUpAt = (MAX_SESSION_MINUTES - WRAP_UP_TIMEOUT_MINUTES) * MINUTE_MS;

        clock.advance(wrapUpAt - 1);
        expect(conductor.submit).toHaveBeenCalledTimes(1);

        clock.advance(1);
        expect(conductor.submit).toHaveBeenCalledTimes(2);
        const { envelope: wrapUp, options: wrapUpOptions } = conductor.submissions[1];
        expect(wrapUp.kind).toBe('wrapup');
        expect(wrapUp.text).toContain(`ends in ${WRAP_UP_TIMEOUT_MINUTES} min`);
        // 'human' (not 'other'): the conductor's own priority queue puts a 'human'-priority item
        // ahead of any 'other'-priority one already queued — the only lever available (see the
        // module doc) to make the wrap-up the very next turn the conductor runs once the slot
        // turn ends, since nothing can inject it into the still-running slot turn itself.
        expect(wrapUpOptions.priority).toBe('human');
    });

    test('a wrap-up submission failure is logged but does not crash the driver', async () => {
        conductor.submit = mock((envelope, options) => {
            if(envelope.kind === 'wrapup') {
                return Promise.reject(new Error('conductor rejected the wrap-up envelope'));
            }
            return new Promise<TurnResult>((resolve, reject) => {
                conductor.submissions.push({ envelope, options, resolve, reject });
            });
        });
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        const wrapUpAt = (MAX_SESSION_MINUTES - WRAP_UP_TIMEOUT_MINUTES) * MINUTE_MS;
        clock.advance(wrapUpAt);
        await Promise.resolve();

        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to submit perch wrap-up envelope');
    });

    test('does not submit a wrap-up envelope when the slot turn already finished', async () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        conductor.submissions[0].resolve(makeTurnResult());
        await Promise.resolve();

        clock.runAll();
        expect(conductor.submit).toHaveBeenCalledTimes(1);
    });

    test('interrupts the running slot turn exactly at endsAt + interruptGraceMinutes', () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        const interruptAt = (MAX_SESSION_MINUTES + INTERRUPT_GRACE_MINUTES) * MINUTE_MS;

        clock.advance(interruptAt - 1);
        expect(conductor.interruptCurrent).not.toHaveBeenCalled();

        clock.advance(1);
        expect(conductor.interruptCurrent).toHaveBeenCalledTimes(1);
    });

    test('does not interrupt once the slot turn (tracked by its own submit) has already settled', async () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        conductor.submissions[0].resolve(makeTurnResult());
        await Promise.resolve();

        clock.runAll();
        expect(conductor.interruptCurrent).not.toHaveBeenCalled();
    });

    test('does not interrupt an unrelated turn still active when the slot envelope is merely queued behind it at grace time', () => {
        // Simulates the race the module doc describes: a perch-channel Discord turn was already
        // running when the hourly trigger fired, so the slot's own submit() call only enqueues
        // behind it (conductor.status().turn stays the foreign turn) — armInterruptTimer must
        // never interrupt THAT turn just because the driver's own `slotRunning` flag is true.
        conductor.setActiveTurn({ kind: 'discord', envelopeId: 'live-discord-1', channelId: 'chan-1' });
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        const interruptAt = (MAX_SESSION_MINUTES + INTERRUPT_GRACE_MINUTES) * MINUTE_MS;
        clock.advance(interruptAt);

        expect(conductor.interruptCurrent).not.toHaveBeenCalled();
    });

    test('interrupts the slot turn once it becomes the conductor\'s active turn, even though it started out queued behind another', () => {
        conductor.setActiveTurn({ kind: 'discord', envelopeId: 'live-discord-1', channelId: 'chan-1' });
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');
        const slotEnvelopeId = conductor.submissions[0].envelope.id;

        // The foreign turn finishes and the conductor promotes the slot's own queued envelope.
        conductor.setActiveTurn({ kind: 'perch', envelopeId: slotEnvelopeId });

        const interruptAt = (MAX_SESSION_MINUTES + INTERRUPT_GRACE_MINUTES) * MINUTE_MS;
        clock.advance(interruptAt);

        expect(conductor.interruptCurrent).toHaveBeenCalledTimes(1);
    });

    test('does not interrupt when the running turn at grace time is the wrap-up turn, not the slot turn', async () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        // Let the wrap-up fire, then finish the SLOT turn (not the wrap-up turn) before grace.
        const wrapUpAt = (MAX_SESSION_MINUTES - WRAP_UP_TIMEOUT_MINUTES) * MINUTE_MS;
        clock.advance(wrapUpAt);
        expect(conductor.submit).toHaveBeenCalledTimes(2);

        conductor.submissions[0].resolve(makeTurnResult());
        await Promise.resolve();

        const interruptAt = (MAX_SESSION_MINUTES + INTERRUPT_GRACE_MINUTES) * MINUTE_MS;
        clock.advance(interruptAt - wrapUpAt);
        expect(conductor.interruptCurrent).not.toHaveBeenCalled();
    });

    test('an overlapping trigger while a slot turn is running submits nothing and returns "deferred"', () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        const outcome = driver.runSlot('afternoon');

        expect(outcome).toBe('deferred');
        expect(conductor.submit).toHaveBeenCalledTimes(1);
    });

    test('repeated overlapping triggers submit zero wrap-ups and, once the slot ends, submit exactly one slot envelope for the current hour', async () => {
        getCurrentLocalHour.mockReturnValue(10); // mid-morning
        const driver = createPerchDriver(deps);
        driver.runSlot('mid-morning');

        // The 10:59 trigger:
        expect(driver.runSlot('mid-morning')).toBe('deferred');
        // The 11:00 trigger — hour has now rolled over, but the running slot's own envelope is unaffected:
        getCurrentLocalHour.mockReturnValue(11);
        expect(driver.runSlot('unscheduled')).toBe('deferred');

        expect(conductor.submit).toHaveBeenCalledTimes(1);

        conductor.submissions[0].resolve(makeTurnResult());
        await Promise.resolve();

        // Exactly one new submission, for the hour current at completion time (11 -> unscheduled),
        // and it is a slot envelope, never a wrap-up.
        expect(conductor.submit).toHaveBeenCalledTimes(2);
        expect(conductor.submissions[1].envelope.kind).toBe('perch');
        expect(conductor.submissions[1].envelope.text).toContain('Unscheduled');
        expect(conductor.submissions.every(s => s.envelope.kind === 'perch')).toBe(true);
    });

    test('perch-end is logged once the slot turn settles', async () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        conductor.submissions[0].resolve(makeTurnResult());
        await Promise.resolve();

        expect(activityLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: 'perch-end' }));
    });

    test('stop() clears timers and the pending flag: no wrap-up, no interrupt, and no auto-resumed slot', async () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');
        expect(driver.runSlot('afternoon')).toBe('deferred');

        driver.stop();

        clock.runAll();
        expect(conductor.submit).toHaveBeenCalledTimes(1);
        expect(conductor.interruptCurrent).not.toHaveBeenCalled();

        conductor.submissions[0].resolve(makeTurnResult());
        await Promise.resolve();

        expect(conductor.submit).toHaveBeenCalledTimes(1);
    });

    test('an interrupt failure is logged but does not crash the driver', async () => {
        conductor.interruptCurrent = mock(() => Promise.reject(new Error('SDK interrupt failed')));
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        const interruptAt = (MAX_SESSION_MINUTES + INTERRUPT_GRACE_MINUTES) * MINUTE_MS;
        clock.advance(interruptAt);
        await Promise.resolve();

        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to interrupt an overrunning perch slot turn');
    });

    test('a failed slot turn is logged and still runs perch-end / the pending resolution', async () => {
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        conductor.submissions[0].reject(new Error('SDK submit rejected'));
        await Promise.resolve();

        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), slot: 'afternoon' }), 'Perch slot turn failed');
        expect(activityLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: 'perch-end' }));
    });

    test('a perch-activity log failure is itself logged as a warning, not thrown', async () => {
        activityLogger = { log: mock(() => Promise.reject(new Error('activity log store unavailable'))) };
        deps = { ...deps, activityLogger };
        const driver = createPerchDriver(deps);

        driver.runSlot('afternoon');
        await Promise.resolve();

        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), type: 'perch-start' }), 'Failed to log perch activity');
    });

    test('when interruptGraceMinutes is omitted from config, the driver defaults to 2 minutes', () => {
        deps = { ...deps, config: makeConfig({ interruptGraceMinutes: undefined }) };
        const driver = createPerchDriver(deps);
        driver.runSlot('afternoon');

        const DEFAULT_GRACE_MINUTES = 2;
        const interruptAt = (MAX_SESSION_MINUTES + DEFAULT_GRACE_MINUTES) * MINUTE_MS;

        clock.advance(interruptAt - 1);
        expect(conductor.interruptCurrent).not.toHaveBeenCalled();

        clock.advance(1);
        expect(conductor.interruptCurrent).toHaveBeenCalledTimes(1);
    });

    describe('perch context (ContextBuilder)', () => {
        test('injects a successfully-built perch context into the slot envelope', () => {
            const buildPerchContext = mock(() => Promise.resolve('## Perch context\nQuiet night, nothing pending.'));
            deps = { ...deps, contextBuilder: { buildPerchContext } };
            const driver = createPerchDriver(deps);

            driver.runSlot('afternoon');

            expect(buildPerchContext).toHaveBeenCalledTimes(1);
        });

        test('a real (awaited) perch context still lands in the envelope text once the build resolves', async () => {
            const buildPerchContext = mock(() => Promise.resolve('## Perch context\nQuiet night, nothing pending.'));
            deps = { ...deps, contextBuilder: { buildPerchContext } };
            const driver = createPerchDriver(deps);

            driver.runSlot('afternoon');
            await flush();

            expect(conductor.submissions[0].envelope.text).toContain('Quiet night, nothing pending.');
        });

        test('a rejected perch context build degrades to an empty context block, logs a warning, and still submits the slot', async () => {
            const buildPerchContext = mock(() => Promise.reject(new Error('context store unavailable')));
            deps = { ...deps, contextBuilder: { buildPerchContext } };
            const driver = createPerchDriver(deps);

            driver.runSlot('afternoon');
            await flush();

            expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), slot: 'afternoon' }), 'Failed to build perch context; continuing without it');
            expect(conductor.submit).toHaveBeenCalledTimes(1);
            expect(conductor.submissions[0].envelope.kind).toBe('perch');
        });
    });
});
