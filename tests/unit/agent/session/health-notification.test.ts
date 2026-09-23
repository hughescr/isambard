/**
 * Tests for the pure health-outage predicate and coalescer (Q5 / plan amendment B2).
 */
import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import {
    shouldNotifyHealthChange,
    createHealthOutageCoalescer,
    createHealthNotificationListener,
    DEFAULT_HEALTH_OUTAGE_WINDOW_MS,
    DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY
} from '@/agent/session/health-notification';
import type { NotifyFn, NotifyParams } from '@/agent/session/notification-bridge';
import type { ServiceHealthChange } from '@/services';
import type { HealthState } from '@/services/types';

function change(overrides: Partial<ServiceHealthChange> = {}): ServiceHealthChange {
    return {
        service:       'discord',
        previousState: 'online',
        newState:      'offline',
        epoch:         0,
        timestamp:     new Date(0),
        ...overrides,
    };
}

describe('shouldNotifyHealthChange', () => {
    const truthTable: { previousState: HealthState, newState: HealthState, expected: boolean }[] = [
        { previousState: 'online', newState: 'offline', expected: true },
        { previousState: 'starting', newState: 'offline', expected: true },
        { previousState: 'recovering', newState: 'offline', expected: true },
        { previousState: 'offline', newState: 'online', expected: false },
        { previousState: 'offline', newState: 'recovering', expected: false },
        { previousState: 'offline', newState: 'offline', expected: false },
    ];

    test.each(truthTable)('$previousState -> $newState is $expected', ({ previousState, newState, expected }) => {
        expect(shouldNotifyHealthChange(change({ previousState, newState }))).toBe(expected);
    });

    test('a transition between two non-offline states is never outage-worthy', () => {
        expect(shouldNotifyHealthChange(change({ previousState: 'online', newState: 'recovering' }))).toBe(false);
        expect(shouldNotifyHealthChange(change({ previousState: 'starting', newState: 'online' }))).toBe(false);
    });
});

describe('createHealthOutageCoalescer', () => {
    let clock: FakeClock;
    let notify: Mock<NotifyFn>;

    beforeEach(() => {
        clock = new FakeClock(0);
        // Default: every flush is delivered — matches an already-open, attached conductor.
        // Individual tests override this (mockReturnValueOnce(false)) to model a flush that
        // finds the bridge not yet ready.
        notify = mock((_params: NotifyParams) => true);
    });

    test('two services going offline inside the window submit exactly one envelope naming both, with the exact source/text/key', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS - 1);
        coalescer.report(change({ service: 'email', epoch: 1 }));
        clock.advance(1);

        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.source).toBe('health');
        expect(params.wake).toBe(true);
        expect(params.text).toBe('Service(s) offline: discord, email');
        expect(params.key).toBe('discord:1+email:1');
    });

    test('the notify key is order-independent: reporting the same two services in the opposite order yields the identical sorted key', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        coalescer.report(change({ service: 'email', epoch: 1 }));
        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.source).toBe('health');
        expect(params.key).toBe('discord:1+email:1');
    });

    test('a transition at exactly windowMs is still coalesced; one tick past opens a second envelope', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        // Scheduled BEFORE coalescer.report(A) below opens its own flush timer, so this fires
        // first among two timers sharing the same fireAt (FakeClock's insertion-order tiebreak) —
        // landing report(B) in the same batch as report(A), at exactly windowMs.
        clock.setTimer(() => {
            coalescer.report(change({ service: 'email', epoch: 1 }));
        }, DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(1);
        const [firstBatch] = notify.mock.calls[0];
        expect(firstBatch.text).toContain('discord');
        expect(firstBatch.text).toContain('email');

        // A transition one tick past the already-fired window opens a fresh batch.
        coalescer.report(change({ service: 'caldav', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(2);
        const [secondBatch] = notify.mock.calls[1];
        expect(secondBatch.text).toContain('caldav');
        expect(secondBatch.text).not.toContain('discord');
    });

    test('one service flapping within a single connection-loss epoch produces exactly one notification', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        // online -> offline (epoch 1)
        coalescer.report(change({ service: 'bsky', previousState: 'online', newState: 'offline', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(1);

        // ... recovering -> offline again, same epoch (CONNECT_FAIL never increments epoch)
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS * 10);
        coalescer.report(change({ service: 'bsky', previousState: 'recovering', newState: 'offline', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(1);
    });

    test('a genuinely new epoch for the same service notifies again', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        coalescer.report(change({ service: 'bsky', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(1);

        // CONNECTION_LOST bumped the epoch: a genuinely new outage episode.
        coalescer.report(change({ service: 'bsky', epoch: 2 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(2);
    });

    test('documented default values hold the five-second batch latency bound and 200-key memory budget', () => {
        expect(DEFAULT_HEALTH_OUTAGE_WINDOW_MS).toBe(5000);
        expect(DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY).toBe(200);
    });

    test('the "already reported" memory is a bounded FIFO: once past capacity, the oldest key is evicted and can notify again', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify, alreadyReportedCapacity: 2 });

        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        coalescer.report(change({ service: 'email', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        // capacity is 2, and 'discord:1' + 'email:1' fill it; 'caldav:1' evicts the oldest ('discord:1')
        coalescer.report(change({ service: 'caldav', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(3);

        // 'discord:1' was evicted, so a repeat of the exact same (service, epoch) notifies again.
        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(4);
    });

    test('capacity zero retains no reported keys, so the same outage is delivered again', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify, alreadyReportedCapacity: 0 });

        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(2);
    });

    test('a key remains remembered when the FIFO is exactly at capacity', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify, alreadyReportedCapacity: 1 });

        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(1);
    });

    test('a batch that fails to deliver (notify() returns false — e.g. the conductor is not open yet) is NOT remembered: the next report for the same (service, epoch) retries rather than being silently dropped for the epoch (review finding)', () => {
        notify.mockReturnValueOnce(false);
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        coalescer.report(change({ service: 'bsky', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(1);

        // Still offline, same epoch (e.g. a subsequent reconnect attempt failing again): since
        // the first flush was never actually delivered, this reopens a batch and retries instead
        // of being suppressed by "already reported" memory that was never actually earned.
        coalescer.report(change({ service: 'bsky', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(2);

        // The second flush DID deliver (default mock), so a further same-epoch repeat is
        // suppressed as usual.
        coalescer.report(change({ service: 'bsky', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(2);
    });

    describe('stop()', () => {
        test('cancels a pending flush timer: notify is never called even long after the window elapses, and the clock has no timer left pending', () => {
            const coalescer = createHealthOutageCoalescer({ clock, notify });
            coalescer.report(change({ service: 'bsky', epoch: 1 }));
            expect(clock.pending()).toBe(1);

            coalescer.stop();
            clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS * 10);

            expect(notify).not.toHaveBeenCalled();
            expect(clock.pending()).toBe(0);
        });

        test('is a harmless no-op when there is no pending batch', () => {
            const coalescer = createHealthOutageCoalescer({ clock, notify });

            expect(() => {
                coalescer.stop();
            }).not.toThrow();
        });

        test('does not otherwise disable the coalescer: a report() after stop() opens a fresh batch as usual', () => {
            const coalescer = createHealthOutageCoalescer({ clock, notify });
            coalescer.report(change({ service: 'bsky', epoch: 1 }));
            coalescer.stop();

            coalescer.report(change({ service: 'bsky', epoch: 1 }));
            clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

            expect(notify).toHaveBeenCalledTimes(1);
        });
    });
});

describe('createHealthNotificationListener', () => {
    let predicate: Mock<(input: ServiceHealthChange) => boolean>;
    let coalescerReport: Mock<(input: ServiceHealthChange) => void>;
    let notify: Mock<NotifyFn>;

    beforeEach(() => {
        predicate = mock((_input: ServiceHealthChange) => false);
        coalescerReport = mock((_input: ServiceHealthChange) => {});
        notify = mock((_params: NotifyParams) => true);
    });

    function buildListener(): (input: ServiceHealthChange) => void {
        return createHealthNotificationListener({
            shouldNotifyHealthChange: predicate,
            coalescer:                { report: coalescerReport },
            notify,
        });
    }

    test('a qualifying change (predicate true) is handed verbatim to the coalescer; notify is not called', () => {
        predicate.mockReturnValue(true);
        const listener = buildListener();
        const input = change({ previousState: 'online', newState: 'offline' });

        listener(input);

        expect(coalescerReport).toHaveBeenCalledTimes(1);
        expect(notify).not.toHaveBeenCalled();
    });

    test('the object passed to coalescer.report is reference-equal to the input ServiceHealthChange', () => {
        predicate.mockReturnValue(true);
        const listener = buildListener();
        const input = change({ previousState: 'online', newState: 'offline' });

        listener(input);

        expect(coalescerReport.mock.calls[0]?.[0]).toBe(input);
    });

    test('an online <-> recovering flap with predicate false in both directions notifies once per transition (accumulate, wake:false); coalescer.report is never called', () => {
        predicate.mockReturnValue(false);
        const listener = buildListener();

        listener(change({ previousState: 'online', newState: 'recovering' }));
        listener(change({ previousState: 'recovering', newState: 'online' }));

        expect(coalescerReport).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(2);
        for(const [params] of notify.mock.calls) {
            expect(params.wake).toBe(false);
        }
    });

    test('a predicate-rejected starting -> offline transition (failed first boot connect) notifies accumulate and does NOT reach the coalescer', () => {
        predicate.mockReturnValue(false);
        const listener = buildListener();
        const input = change({ previousState: 'starting', newState: 'offline' });

        listener(input);

        expect(coalescerReport).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.wake).toBe(false);
    });

    test('a predicate-rejected offline -> online recovery notifies accumulate', () => {
        predicate.mockReturnValue(false);
        const listener = buildListener();
        const input = change({ previousState: 'offline', newState: 'online', service: 'bsky', epoch: 3 });

        listener(input);

        expect(coalescerReport).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.wake).toBe(false);
        expect(params.source).toBe('health');
        expect(params.key).toBe('bsky:3:online');
        // Review finding: pins the exact accumulate body so a StringLiteral mutant emptying it
        // (or an LLM mutant swapping previousState/newState) is caught here rather than surviving
        // unasserted.
        expect(params.text).toBe('bsky: offline -> online');
    });
});
