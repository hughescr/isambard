/**
 * Tests for the pure health-outage predicate and coalescer (Q5 / plan amendment B2).
 */
import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import {
    shouldNotifyHealthChange,
    createHealthOutageCoalescer,
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
        { previousState: 'degraded', newState: 'offline', expected: true },
        { previousState: 'starting', newState: 'offline', expected: true },
        { previousState: 'recovering', newState: 'offline', expected: true },
        { previousState: 'online', newState: 'degraded', expected: false },
        { previousState: 'offline', newState: 'online', expected: false },
        { previousState: 'degraded', newState: 'online', expected: false },
        { previousState: 'offline', newState: 'recovering', expected: false },
        { previousState: 'offline', newState: 'offline', expected: false },
    ];

    test.each(truthTable)('$previousState -> $newState is $expected', ({ previousState, newState, expected }) => {
        expect(shouldNotifyHealthChange(change({ previousState, newState }))).toBe(expected);
    });
});

describe('createHealthOutageCoalescer', () => {
    let clock: FakeClock;
    let notify: Mock<NotifyFn>;

    beforeEach(() => {
        clock = new FakeClock(0);
        notify = mock((_params: NotifyParams) => {});
    });

    test('two services going offline inside the window submit exactly one envelope naming both, with the exact source/text/dedupeKey', () => {
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
        expect(params.dedupeKey).toBe('discord:1+email:1');
    });

    test('the dedupeKey is order-independent: reporting the same two services in the opposite order yields the identical sorted key', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        coalescer.report(change({ service: 'email', epoch: 1 }));
        coalescer.report(change({ service: 'discord', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.dedupeKey).toBe('discord:1+email:1');
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
        coalescer.report(change({ service: 'bluesky', previousState: 'online', newState: 'offline', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(1);

        // ... recovering -> offline again, same epoch (RECOVERY_FAIL never increments epoch)
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS * 10);
        coalescer.report(change({ service: 'bluesky', previousState: 'recovering', newState: 'offline', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);

        expect(notify).toHaveBeenCalledTimes(1);
    });

    test('a genuinely new epoch for the same service notifies again', () => {
        const coalescer = createHealthOutageCoalescer({ clock, notify });

        coalescer.report(change({ service: 'bluesky', epoch: 1 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(1);

        // CONNECTION_LOST bumped the epoch: a genuinely new outage episode.
        coalescer.report(change({ service: 'bluesky', epoch: 2 }));
        clock.advance(DEFAULT_HEALTH_OUTAGE_WINDOW_MS);
        expect(notify).toHaveBeenCalledTimes(2);
    });

    test('DEFAULT_HEALTH_OUTAGE_WINDOW_MS is a low single-digit-seconds value', () => {
        expect(DEFAULT_HEALTH_OUTAGE_WINDOW_MS).toBeGreaterThan(0);
        expect(DEFAULT_HEALTH_OUTAGE_WINDOW_MS).toBeLessThanOrEqual(9000);
    });

    test('DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY is a positive number', () => {
        expect(DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY).toBeGreaterThan(0);
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
});
