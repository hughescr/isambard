/**
 * Tests for the source-agnostic notification bridge (Q5 / plan amendments B1-B2).
 */
import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../../helpers/fake-clock';
import type { Conductor, ConductorLifecycle, ConductorStatus, Envelope, SubmitOptions, TurnResult } from '@/agent/session';
import {
    createNotificationBridge,
    DEFAULT_NOTIFICATION_DEDUPE_CAPACITY,
    type NotificationBridge,
    type NotifyParams
} from '@/agent/session/notification-bridge';

/** A minimal `ConductorStatus` with a chosen `lifecycle` — the only field `notify()` reads. */
function fakeStatus(lifecycle: ConductorLifecycle): ConductorStatus {
    return {
        role: 'conversation', sessionId: undefined, lifecycle, queueLength: 0, turn: null,
    };
}

/** A fake conductor exposing only the surface the bridge depends on. `lifecycle` defaults to `'open'`; pass another value to model one that cannot accept work. */
function createFakeConductor(lifecycle: ConductorLifecycle = 'open'): Pick<Conductor, 'submit' | 'appendWithoutTurn' | 'status'> & {
    submit:            Mock<(envelope: Envelope, options: SubmitOptions) => Promise<TurnResult>>
    appendWithoutTurn: Mock<(envelope: Envelope) => boolean>
    status:            Mock<() => ConductorStatus>
} {
    return {
        submit:            mock((_envelope: Envelope, _options: SubmitOptions) => Promise.resolve({} as TurnResult)),
        appendWithoutTurn: mock((_envelope: Envelope) => true),
        status:            mock(() => fakeStatus(lifecycle)),
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
    return { source: 'test-source', text: 'something happened', wake: false, key: 'key-1', ...overrides };
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

    test('wake:true submits via conductor.submit with priority "normal", never appendWithoutTurn', () => {
        bridge.notify(baseParams({ wake: true, key: 'wake-key' }));

        expect(conductor.submit).toHaveBeenCalledTimes(1);
        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        const [envelope, options] = conductor.submit.mock.calls[0];
        expect(options.priority).toBe('normal');
        expect(envelope.mode).toBe('query');
    });

    test('wake:true burns the dedupe key eagerly, before conductor.submit() has resolved', () => {
        let resolveSubmit!: (result: TurnResult) => void;
        conductor.submit.mockImplementationOnce(() => new Promise<TurnResult>((resolve) => {
            resolveSubmit = resolve;
        }));

        bridge.notify(baseParams({ wake: true, key: 'wake-dupe' }));
        // A second call with the same key, issued while the first submit() is still pending,
        // must already see the key as burned rather than submitting a second time.
        const second = bridge.notify(baseParams({ wake: true, key: 'wake-dupe' }));

        expect(second).toBe(true);
        expect(conductor.submit).toHaveBeenCalledTimes(1);

        resolveSubmit({
            status: 'failed', envelopeId: 'env-1', response: null, sessionId: 'sess-1', contextUsagePercent: 0, error: new Error('x'),
        });
    });

    test('wake:false appends via conductor.appendWithoutTurn, never submit', () => {
        bridge.notify(baseParams({ wake: false, key: 'accumulate-key' }));

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
        expect(conductor.submit).not.toHaveBeenCalled();
        const [envelope] = conductor.appendWithoutTurn.mock.calls[0];
        expect(envelope.mode).toBe('append');
    });

    test('an explicit `at` overrides the envelope timestamp instead of the call-time clock', () => {
        const explicitAt = new Date('2020-01-01T00:00:00.000Z');
        clock.advance(999_999); // clock.now() would produce a very different timestamp if used

        bridge.notify(baseParams({ key: 'at-key', at: explicitAt }));

        const [envelope] = conductor.appendWithoutTurn.mock.calls[0];
        expect(envelope.createdAt).toEqual(explicitAt);
    });

    test('omitting `at` falls back to `new Date(clock.now())` at call time', () => {
        clock.advance(12_345);

        bridge.notify(baseParams({ key: 'no-at-key' }));

        const [envelope] = conductor.appendWithoutTurn.mock.calls[0];
        expect(envelope.createdAt).toEqual(new Date(12_345));
    });

    test('timeHeader() is invoked fresh on every notify() call', () => {
        bridge.notify(baseParams({ key: 'key-a' }));
        clock.advance(1000);
        bridge.notify(baseParams({ key: 'key-b' }));

        expect(timeHeaderCalls).toHaveLength(2);
        expect(timeHeaderCalls[0]).not.toBe(timeHeaderCalls[1]);
        const [firstEnvelope] = conductor.appendWithoutTurn.mock.calls[0];
        const [secondEnvelope] = conductor.appendWithoutTurn.mock.calls[1];
        expect(firstEnvelope.text).not.toBe(secondEnvelope.text);
    });

    test('a repeated (source, key) suppresses the second notify(); a distinct key goes through', () => {
        bridge.notify(baseParams({ key: 'dupe' }));
        bridge.notify(baseParams({ key: 'dupe' }));
        bridge.notify(baseParams({ key: 'distinct' }));

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(2);
    });

    test('the same key under two different sources is not deduped: each source is its own namespace', () => {
        expect(bridge.notify(baseParams({ source: 'health', key: 'k1' }))).toBe(true);
        expect(bridge.notify(baseParams({ source: 'email', key: 'k1' }))).toBe(true);

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(2);
    });

    test('a source/key split that a colon join would collapse still counts as two distinct notifications', () => {
        bridge.notify(baseParams({ source: 'health:worker', key: 'k1' }));
        bridge.notify(baseParams({ source: 'health', key: 'worker:k1' }));

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(2);
    });

    test('the dedupe set evicts the oldest key once past dedupeCapacity', () => {
        const capacity = 3;
        const smallBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', dedupeCapacity: capacity, logger,
        });
        smallBridge.attachConductor(conductor);

        smallBridge.notify(baseParams({ key: 'k1' }));
        smallBridge.notify(baseParams({ key: 'k2' }));
        smallBridge.notify(baseParams({ key: 'k3' }));
        // at capacity: k1 still suppresses a resubmit
        smallBridge.notify(baseParams({ key: 'k1' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(3);

        // one more distinct key past capacity evicts k1 (the oldest)
        smallBridge.notify(baseParams({ key: 'k4' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(4);

        // k1 was evicted, so it now goes through again
        smallBridge.notify(baseParams({ key: 'k1' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(5);
    });

    test('dedupeCapacity zero retains no keys, so an accepted key is delivered again', () => {
        const zeroCapacityBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', dedupeCapacity: 0, logger,
        });
        zeroCapacityBridge.attachConductor(conductor);

        expect(zeroCapacityBridge.notify(baseParams({ key: 'repeat' }))).toBe(true);
        expect(zeroCapacityBridge.notify(baseParams({ key: 'repeat' }))).toBe(true);
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(2);
    });

    test('the default dedupe capacity constant is a positive number', () => {
        expect(DEFAULT_NOTIFICATION_DEDUPE_CAPACITY).toBeGreaterThan(0);
    });

    test('the default dedupe capacity retains exactly 200 keys, evicting the oldest only on the 201st distinct key', () => {
        // The 200 here is the default bridge's capacity written out as a literal on purpose: how
        // many keys the unwired default retains is behaviour, not an implementation detail, so a
        // change to that default must consciously update this test too.
        const defaultBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });
        defaultBridge.attachConductor(conductor);

        for(let i = 1; i <= 200; i++) {
            defaultBridge.notify(baseParams({ key: `key-${i}` }));
        }
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(200);

        // At exactly the capacity the oldest key is still retained, so a repeat is suppressed...
        defaultBridge.notify(baseParams({ key: 'key-1' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(200);

        // ...and it is the 201st distinct key that evicts it.
        defaultBridge.notify(baseParams({ key: 'key-201' }));
        defaultBridge.notify(baseParams({ key: 'key-1' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(202);
    });

    test('a synchronously-rejecting conductor.submit is caught and logged with the namespaced key, never thrown out of notify()', async () => {
        conductor.submit.mockImplementationOnce(() => Promise.reject(new Error('submit boom')));

        expect(() => {
            bridge.notify(baseParams({ wake: true, key: 'reject-key' }));
        }).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error), source: 'test-source', namespacedKey: '["test-source","reject-key"]' }),
            'Failed to submit wake notification'
        );
    });

    test('a wake:false notify the conductor could not accept returns false and does NOT burn the dedupe key', () => {
        conductor.appendWithoutTurn.mockImplementationOnce(() => false);

        expect(bridge.notify(baseParams({ wake: false, key: 'retry-key' }))).toBe(false);
        expect(logger.debug).toHaveBeenCalledWith(
            { source: 'test-source', namespacedKey: '["test-source","retry-key"]' },
            'Conductor did not accept an accumulate notification; leaving the dedupe key unburned for a retry'
        );

        // The same key retried later must actually be delivered: a burned key would drop this
        // notification permanently, since the source has already forgotten this occurrence.
        expect(bridge.notify(baseParams({ wake: false, key: 'retry-key' }))).toBe(true);
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(2);
    });

    test('a wake:false notify accepted into the conductor\'s reopen buffer returns true and burns the key once', () => {
        expect(bridge.notify(baseParams({ wake: false, key: 'buffered-key' }))).toBe(true);
        expect(bridge.notify(baseParams({ wake: false, key: 'buffered-key' }))).toBe(true);

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
    });

    test('a throwing conductor.appendWithoutTurn is caught and logged, never thrown out of notify(), and returns false without burning the dedupe key', () => {
        const appendError = new Error('append boom');
        conductor.appendWithoutTurn.mockImplementationOnce(() => {
            throw appendError;
        });

        let delivered: boolean | undefined;
        expect(() => {
            delivered = bridge.notify(baseParams({ wake: false, key: 'throw-key' }));
        }).not.toThrow();
        expect(delivered).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            { err: appendError, source: 'test-source', namespacedKey: '["test-source","throw-key"]' },
            'Failed to append accumulate notification'
        );

        // The dedupe key must not have been burned: a retry with the same key tries again.
        bridge.notify(baseParams({ wake: false, key: 'throw-key' }));
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(2);
    });

    test('notify() before attachConductor() logs at debug and drops, without calling submit/appendWithoutTurn, and returns false', () => {
        const freshBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });

        const delivered = freshBridge.notify(baseParams({ source: 'health', key: 'k1' }));

        expect(delivered).toBe(false);
        expect(conductor.submit).not.toHaveBeenCalled();
        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            { source: 'health', namespacedKey: '["health","k1"]' },
            'Notification bridge not attached to a conductor that can accept work; dropping notify'
        );
    });

    test('detach() reverts to the unattached no-op drop behaviour', () => {
        bridge.detach();

        const delivered = bridge.notify(baseParams({ key: 'after-detach' }));

        expect(delivered).toBe(false);
        expect(conductor.submit).not.toHaveBeenCalled();
        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalled();
    });

    test('an unattached notify() does not consume the dedupe budget: the same key delivers once attached', () => {
        const freshBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });

        freshBridge.notify(baseParams({ key: 'reused-key' }));
        freshBridge.attachConductor(conductor);
        freshBridge.notify(baseParams({ key: 'reused-key' }));

        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
    });

    test.each<ConductorLifecycle>(['new', 'opening', 'failed', 'closing', 'closed'])('a conductor whose lifecycle is %s cannot accept work: a wake notify returns false, submits nothing and is debug-logged', (lifecycle) => {
        const notReadyConductor = createFakeConductor(lifecycle);
        const freshBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });
        freshBridge.attachConductor(notReadyConductor);

        const delivered = freshBridge.notify(baseParams({ wake: true, key: 'not-ready-key' }));

        expect(delivered).toBe(false);
        expect(notReadyConductor.submit).not.toHaveBeenCalled();
        expect(notReadyConductor.appendWithoutTurn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            { source: 'test-source', namespacedKey: '["test-source","not-ready-key"]' },
            'Notification bridge not attached to a conductor that can accept work; dropping notify'
        );
    });

    test.each<ConductorLifecycle>(['new', 'opening', 'failed', 'closing', 'closed'])('a notify refused while the lifecycle is %s does not consume the dedupe budget: the same key delivers once the conductor is open', (lifecycle) => {
        const notReadyConductor = createFakeConductor(lifecycle);
        const freshBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });
        freshBridge.attachConductor(notReadyConductor);

        freshBridge.notify(baseParams({ key: 'reused-key-2' }));
        notReadyConductor.status.mockReturnValue(fakeStatus('open'));
        const delivered = freshBridge.notify(baseParams({ key: 'reused-key-2' }));

        expect(delivered).toBe(true);
        expect(notReadyConductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
    });

    test.each<ConductorLifecycle>(['open', 'reopening'])('a conductor whose lifecycle is %s accepts work: a wake notify submits and an accumulate notify appends', (lifecycle) => {
        const readyConductor = createFakeConductor(lifecycle);
        const freshBridge = createNotificationBridge({
            clock, timezone: 'America/Los_Angeles', timeHeader: () => 'H', logger,
        });
        freshBridge.attachConductor(readyConductor);

        expect(freshBridge.notify(baseParams({ wake: true, key: 'ready-wake' }))).toBe(true);
        expect(freshBridge.notify(baseParams({ wake: false, key: 'ready-accum' }))).toBe(true);

        expect(readyConductor.submit).toHaveBeenCalledTimes(1);
        expect(readyConductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
    });

    test('notify() returns true once the envelope is actually submitted (wake:true) or appended (wake:false)', () => {
        expect(bridge.notify(baseParams({ wake: true, key: 'ret-wake' }))).toBe(true);
        expect(bridge.notify(baseParams({ wake: false, key: 'ret-accum' }))).toBe(true);
    });

    test('notify() returns true for an already-delivered repeat, without re-delivering', () => {
        bridge.notify(baseParams({ key: 'ret-dupe' }));

        const delivered = bridge.notify(baseParams({ key: 'ret-dupe' }));

        expect(delivered).toBe(true);
        expect(conductor.appendWithoutTurn).toHaveBeenCalledTimes(1);
    });

    describe('attachReplyDelivery() (R2)', () => {
        const base = { envelopeId: 'env-1', sessionId: 'sess-1', contextUsagePercent: 0 };

        function completed(response: string): TurnResult {
            return { ...base, status: 'completed', response };
        }

        const notCompleted: [string, TurnResult][] = [
            ['failed', { ...base, status: 'failed', response: null, error: new Error('turn failed') }],
            ['interrupted', {
                ...base, status: 'interrupted', response: null, partialWork: {} as Extract<TurnResult, { status: 'interrupted' }>['partialWork'], cancellationSource: 'human_preempt',
            }],
            ['withdrawn', { ...base, status: 'withdrawn', response: null, cancellationSource: 'caller_signal' }],
        ];

        test('is called with the envelope and result once a wake submit() resolves with status completed', async () => {
            const delivery = mock((_envelope: Envelope, _result: TurnResult) => Promise.resolve());
            bridge.attachReplyDelivery(delivery);
            conductor.submit.mockImplementationOnce(() => Promise.resolve(completed('the reply')));

            bridge.notify(baseParams({ wake: true, key: 'reply-key' }));
            await Promise.resolve();
            await Promise.resolve();

            expect(delivery).toHaveBeenCalledTimes(1);
            const [, result] = delivery.mock.calls[0];
            expect(result.response).toBe('the reply');
        });

        test.each(notCompleted)('is not called when the wake submit() resolves with status %s', async (_status, result) => {
            const delivery = mock((_envelope: Envelope, _result: TurnResult) => Promise.resolve());
            bridge.attachReplyDelivery(delivery);
            conductor.submit.mockImplementationOnce(() => Promise.resolve(result));

            bridge.notify(baseParams({ wake: true, key: 'not-completed-key' }));
            await Promise.resolve();
            await Promise.resolve();

            expect(delivery).not.toHaveBeenCalled();
        });

        test('is never called for a wake:false notify() (the appendWithoutTurn path has no TurnResult to deliver)', () => {
            const delivery = mock((_envelope: Envelope, _result: TurnResult) => Promise.resolve());
            bridge.attachReplyDelivery(delivery);

            bridge.notify(baseParams({ wake: false, key: 'accumulate-key-2' }));

            expect(delivery).not.toHaveBeenCalled();
        });

        test('a rejecting delivery is caught and logged, and never affects notify()\'s own synchronous return', async () => {
            const delivery = mock((_envelope: Envelope, _result: TurnResult) => Promise.reject(new Error('delivery failed')));
            bridge.attachReplyDelivery(delivery);
            conductor.submit.mockImplementationOnce(() => Promise.resolve(completed('a reply')));

            const delivered = bridge.notify(baseParams({ wake: true, key: 'delivery-fails-key' }));
            expect(delivered).toBe(true);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.any(Error), source: 'test-source', namespacedKey: '["test-source","delivery-fails-key"]' }),
                'Failed to deliver a wake notification\'s reply'
            );
        });

        test('with no delivery attached, a resolved wake submit() with a real response does not throw', async () => {
            conductor.submit.mockImplementationOnce(() => Promise.resolve(completed('a reply')));

            expect(() => {
                bridge.notify(baseParams({ wake: true, key: 'no-delivery-key' }));
            }).not.toThrow();
            await Promise.resolve();
            await Promise.resolve();
        });
    });
});
