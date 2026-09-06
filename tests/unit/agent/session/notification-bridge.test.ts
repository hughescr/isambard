/**
 * Tests for the source-agnostic notification bridge (Q5 / plan amendments B1-B2).
 */
import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../../helpers/fake-clock';
import type { Conductor, Envelope, SubmitOptions, TurnResult } from '@/agent/session';
import {
    createNotificationBridge,
    DEFAULT_NOTIFICATION_DEDUPE_CAPACITY,
    type NotificationBridge,
    type NotifyParams
} from '@/agent/session/notification-bridge';

/** A fake conductor exposing only the surface the bridge depends on. */
function createFakeConductor(): Pick<Conductor, 'submit' | 'appendWithoutTurn'> & {
    submit:            Mock<(envelope: Envelope, options: SubmitOptions) => Promise<TurnResult>>
    appendWithoutTurn: Mock<(envelope: Envelope) => void>
} {
    return {
        submit:            mock((_envelope: Envelope, _options: SubmitOptions) => Promise.resolve({} as TurnResult)),
        appendWithoutTurn: mock((_envelope: Envelope) => {}),
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

function baseParams(overrides: Partial<NotifyParams> = {}): NotifyParams {
    return { source: 'test-source', text: 'something happened', wake: false, dedupeKey: 'key-1', ...overrides };
}

describe('createNotificationBridge', () => {
    let clock: FakeClock;
    let conductor: ReturnType<typeof createFakeConductor>;
    let logger: Logger;
    let timeHeaderCalls: string[];
    let bridge: NotificationBridge;

    beforeEach(() => {
        clock = new FakeClock(0);
        conductor = createFakeConductor();
        logger = createMockLogger();
        timeHeaderCalls = [];
        bridge = createNotificationBridge({
            clock,
            timezone:   'America/Los_Angeles',
            timeHeader: () => {
                const header = `HEADER@${clock.now()}`;
                timeHeaderCalls.push(header);
                return header;
            },
            logger,
        });
        bridge.attachConductor(conductor);
    });

    test('wake:true submits via conductor.submit with priority "other", never appendWithoutTurn', () => {
        bridge.notify(baseParams({ wake: true, dedupeKey: 'wake-key' }));

        expect(conductor.submit).toHaveBeenCalledTimes(1);
        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        const [envelope, options] = conductor.submit.mock.calls[0];
        expect(options.priority).toBe('other');
        expect(envelope.hostPriority).toBe('wake');
        expect(envelope.shouldQuery).toBe(true);
    });

    test('wake:false appends via conductor.appendWithoutTurn, never submit', () => {
        bridge.notify(baseParams({ wake: false, dedupeKey: 'accumulate-key' }));

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
        expect(conductor.submit).not.toHaveBeenCalled();
        const [envelope] = conductor.appendWithoutTurn.mock.calls[0];
        expect(envelope.hostPriority).toBe('accumulate');
        expect(envelope.shouldQuery).toBe(false);
    });

    test('an explicit `at` overrides the envelope timestamp instead of the call-time clock', () => {
        const explicitAt = new Date('2020-01-01T00:00:00.000Z');
        clock.advance(999_999); // clock.now() would produce a very different timestamp if used

        bridge.notify(baseParams({ dedupeKey: 'at-key', at: explicitAt }));

        const [envelope] = conductor.appendWithoutTurn.mock.calls[0];
        expect(envelope.createdAt).toEqual(explicitAt);
    });

    test('omitting `at` falls back to `new Date(clock.now())` at call time', () => {
        clock.advance(12_345);

        bridge.notify(baseParams({ dedupeKey: 'no-at-key' }));

        const [envelope] = conductor.appendWithoutTurn.mock.calls[0];
        expect(envelope.createdAt).toEqual(new Date(12_345));
    });

    test('timeHeader() is invoked fresh on every notify() call', () => {
        bridge.notify(baseParams({ dedupeKey: 'key-a' }));
        clock.advance(1000);
        bridge.notify(baseParams({ dedupeKey: 'key-b' }));

        expect(timeHeaderCalls).toHaveLength(2);
        expect(timeHeaderCalls[0]).not.toBe(timeHeaderCalls[1]);
        const [firstEnvelope] = conductor.appendWithoutTurn.mock.calls[0];
        const [secondEnvelope] = conductor.appendWithoutTurn.mock.calls[1];
        expect(firstEnvelope.text).not.toBe(secondEnvelope.text);
    });

    test('a repeated dedupeKey suppresses the second notify(); a distinct key goes through', () => {
        bridge.notify(baseParams({ dedupeKey: 'dupe' }));
        bridge.notify(baseParams({ dedupeKey: 'dupe' }));
        bridge.notify(baseParams({ dedupeKey: 'distinct' }));

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(2);
    });

    test('the dedupe set evicts the oldest key once past dedupeCapacity', () => {
        const capacity = 3;
        const smallBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', dedupeCapacity: capacity, logger,
        });
        smallBridge.attachConductor(conductor);

        smallBridge.notify(baseParams({ dedupeKey: 'k1' }));
        smallBridge.notify(baseParams({ dedupeKey: 'k2' }));
        smallBridge.notify(baseParams({ dedupeKey: 'k3' }));
        // at capacity: k1 still suppresses a resubmit
        smallBridge.notify(baseParams({ dedupeKey: 'k1' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(3);

        // one more distinct key past capacity evicts k1 (the oldest)
        smallBridge.notify(baseParams({ dedupeKey: 'k4' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(4);

        // k1 was evicted, so it now goes through again
        smallBridge.notify(baseParams({ dedupeKey: 'k1' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(5);
    });

    test('the default dedupe capacity constant is a positive number', () => {
        expect(DEFAULT_NOTIFICATION_DEDUPE_CAPACITY).toBeGreaterThan(0);
    });

    test('a synchronously-rejecting conductor.submit is caught and logged, never thrown out of notify()', async () => {
        conductor.submit.mockImplementationOnce(() => Promise.reject(new Error('submit boom')));

        expect(() => {
            bridge.notify(baseParams({ wake: true, dedupeKey: 'reject-key' }));
        }).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        expect(logger.warn).toHaveBeenCalled();
    });

    test('a throwing conductor.appendWithoutTurn is caught and logged, never thrown out of notify()', () => {
        conductor.appendWithoutTurn.mockImplementationOnce(() => {
            throw new Error('append boom');
        });

        expect(() => {
            bridge.notify(baseParams({ wake: false, dedupeKey: 'throw-key' }));
        }).not.toThrow();
        expect(logger.warn).toHaveBeenCalled();
    });

    test('notify() before attachConductor() logs at debug and drops, without calling submit/appendWithoutTurn', () => {
        const freshBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });

        freshBridge.notify(baseParams({ dedupeKey: 'unattached-key' }));

        expect(conductor.submit).not.toHaveBeenCalled();
        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalled();
    });

    test('detach() reverts to the unattached no-op drop behaviour', () => {
        bridge.detach();

        bridge.notify(baseParams({ dedupeKey: 'after-detach' }));

        expect(conductor.submit).not.toHaveBeenCalled();
        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalled();
    });

    test('an unattached notify() does not consume the dedupe budget: the same key delivers once attached', () => {
        const freshBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });

        freshBridge.notify(baseParams({ dedupeKey: 'reused-key' }));
        freshBridge.attachConductor(conductor);
        freshBridge.notify(baseParams({ dedupeKey: 'reused-key' }));

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
    });
});
