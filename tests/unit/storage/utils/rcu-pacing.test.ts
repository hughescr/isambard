import { describe, expect, mock, test, jest, beforeEach, afterEach } from 'bun:test';
import {
    createRcuPacer, paceAfterRead, pacingDelayMs, recordRcuPage, requireConsumedReadUnits, waitForRcuPacer,
    sleepRespectingSignal
} from '@/storage/utils/rcu-pacing';

describe('requireConsumedReadUnits', () => {
    test('returns the reported units, zero included', () => {
        expect(requireConsumedReadUnits(2.5, 'BatchGetItem')).toBe(2.5);
        expect(requireConsumedReadUnits(0, 'BatchGetItem')).toBe(0);
    });

    test('fails closed, naming the request, when DynamoDB omitted ConsumedCapacity', () => {
        expect(() => requireConsumedReadUnits(undefined, 'GSI1 query for events')).toThrow(
            new Error('GSI1 query for events reported no ConsumedCapacity; refusing to continue without RCU pacing')
        );
    });
});

describe('pacingDelayMs', () => {
    test('owes consumed RCU / rate seconds, less the time already spent', () => {
        expect(pacingDelayMs({ consumedReadUnits: 4, rateLimitRcuPerSec: 2, startedAtMs: 1000, nowMs: 1500 })).toBe(1500);
        expect(pacingDelayMs({ consumedReadUnits: 1, rateLimitRcuPerSec: 4, startedAtMs: 0, nowMs: 0 })).toBe(250);
    });

    test('never goes negative when the request took longer than its budget', () => {
        expect(pacingDelayMs({ consumedReadUnits: 1, rateLimitRcuPerSec: 2, startedAtMs: 0, nowMs: 900 })).toBe(0);
    });
});

describe('paceAfterRead', () => {
    test('sleeps for exactly the owed delay', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        await paceAfterRead({ consumedReadUnits: 3, rateLimitRcuPerSec: 2, startedAtMs: 100, now: () => 600, sleep });
        expect(sleep.mock.calls).toEqual([[1000]]);
    });

    test('does not sleep at all when nothing is owed, including exactly zero', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        await paceAfterRead({ consumedReadUnits: 1, rateLimitRcuPerSec: 2, startedAtMs: 0, now: () => 500, sleep });
        await paceAfterRead({ consumedReadUnits: 0, rateLimitRcuPerSec: 2, startedAtMs: 0, now: () => 0, sleep });
        expect(sleep).not.toHaveBeenCalled();
    });

    test('waits for the sleep before resolving', async () => {
        const gate = Promise.withResolvers<undefined>();
        let resolved = false;
        const pending = paceAfterRead({ consumedReadUnits: 1, rateLimitRcuPerSec: 1, startedAtMs: 0, now: () => 0, sleep: async () => gate.promise })
            .then(() => {
                resolved = true;
                return undefined;
            });
        await Promise.resolve();
        expect(resolved).toBe(false);
        gate.resolve(undefined);
        await pending;
        expect(resolved).toBe(true);
    });
});

describe('createRcuPacer', () => {
    test('starts with no debt owed', () => {
        expect(createRcuPacer()).toEqual({ nextAllowedAtMs: 0 });
    });
});

describe('waitForRcuPacer', () => {
    test('sleeps for exactly the owed debt', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        await waitForRcuPacer({ nextAllowedAtMs: 1500 }, () => 1000, sleep);
        expect(sleep.mock.calls).toEqual([[500]]);
    });

    test('does not sleep when nothing is owed, including exactly zero debt', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        await waitForRcuPacer({ nextAllowedAtMs: 1000 }, () => 1000, sleep);
        await waitForRcuPacer({ nextAllowedAtMs: 500 }, () => 1000, sleep);
        expect(sleep).not.toHaveBeenCalled();
    });

    test('sleeps out a debt of exactly one millisecond', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        await waitForRcuPacer({ nextAllowedAtMs: 1001 }, () => 1000, sleep);
        expect(sleep.mock.calls).toEqual([[1]]);
    });

    test('waits for the sleep before resolving', async () => {
        const gate = Promise.withResolvers<undefined>();
        let resolved = false;
        const pending = waitForRcuPacer({ nextAllowedAtMs: 100 }, () => 0, async () => gate.promise)
            .then(() => {
                resolved = true;
                return undefined;
            });
        await Promise.resolve();
        expect(resolved).toBe(false);
        gate.resolve(undefined);
        await pending;
        expect(resolved).toBe(true);
    });
});

describe('recordRcuPage', () => {
    test('grows the pacer debt from now, by consumedReadUnits / rate seconds', () => {
        const pacer = createRcuPacer();
        const onMissing = mock(() => undefined);
        const paced = recordRcuPage(pacer, 4, 2, true, onMissing, () => 1000);
        expect(paced).toBe(true);
        expect(pacer.nextAllowedAtMs).toBe(3000); // 1000 + 4*1000/2
        expect(onMissing).not.toHaveBeenCalled();
    });

    test('grows the debt from the pacer\'s existing debt, not now, when debt is already owed', () => {
        const pacer = { nextAllowedAtMs: 5000 };
        recordRcuPage(pacer, 2, 2, false, () => undefined, () => 1000);
        expect(pacer.nextAllowedAtMs).toBe(6000); // max(1000, 5000) + 2*1000/2
    });

    test('tolerates a missing report when there is no further page to pace', () => {
        const pacer = createRcuPacer();
        const onMissing = mock(() => undefined);
        const paced = recordRcuPage(pacer, undefined, 2, false, onMissing, () => 1000);
        expect(paced).toBe(true);
        expect(pacer.nextAllowedAtMs).toBe(0); // untouched
        expect(onMissing).not.toHaveBeenCalled();
    });

    test('calls onMissing and returns false when a continuing page omits ConsumedCapacity', () => {
        const pacer = createRcuPacer();
        const onMissing = mock(() => undefined);
        const paced = recordRcuPage(pacer, undefined, 2, true, onMissing, () => 1000);
        expect(paced).toBe(false);
        expect(pacer.nextAllowedAtMs).toBe(0); // untouched
        expect(onMissing).toHaveBeenCalledTimes(1);
    });

    test('propagates a throw from onMissing instead of swallowing it', () => {
        const pacer = createRcuPacer();
        expect(() => recordRcuPage(pacer, undefined, 2, true, () => {
            throw new Error('boom');
        }, () => 1000)).toThrow(new Error('boom'));
    });

    test('defaults now to Date.now when omitted', () => {
        const pacer = createRcuPacer();
        const before = Date.now();
        recordRcuPage(pacer, 0, 1, false, () => undefined);
        expect(pacer.nextAllowedAtMs).toBeGreaterThanOrEqual(before);
    });
});

describe('sleepRespectingSignal', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('resolves after the full delay when no signal is given', async () => {
        let resolved = false;
        const pending = sleepRespectingSignal(1000).then(() => {
            resolved = true;
            return undefined;
        });
        jest.advanceTimersByTime(999);
        await Promise.resolve();
        expect(resolved).toBe(false);
        jest.advanceTimersByTime(1);
        await pending;
        expect(resolved).toBe(true);
    });

    test('resolves immediately without scheduling a timer when ms is zero or negative', async () => {
        await sleepRespectingSignal(0);
        await sleepRespectingSignal(-5);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('rejects with an AbortError DOMException immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(sleepRespectingSignal(1000, controller.signal)).rejects.toEqual(
            new DOMException('Aborted', 'AbortError')
        );
        expect(jest.getTimerCount()).toBe(0);
    });

    test('rejects with an AbortError DOMException when the signal aborts mid-wait, and clears its timer', async () => {
        const controller = new AbortController();
        const pending = sleepRespectingSignal(1000, controller.signal);
        jest.advanceTimersByTime(500);
        controller.abort();
        await expect(pending).rejects.toEqual(new DOMException('Aborted', 'AbortError'));
        expect(jest.getTimerCount()).toBe(0);
    });

    test('waits out a one-millisecond delay on a timer rather than resolving immediately', async () => {
        let resolved = false;
        const pending = sleepRespectingSignal(1).then(() => {
            resolved = true;
            return undefined;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(1);
        await pending;
        expect(resolved).toBe(true);
    });

    test('names the already-aborted rejection exactly: an "Aborted" AbortError', async () => {
        const controller = new AbortController();
        controller.abort();
        const error: unknown = await sleepRespectingSignal(1000, controller.signal).catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
        expect((error as DOMException).message).toBe('Aborted');
    });

    test('detaches its abort listener when the delay elapses', async () => {
        const addEventListener = mock((_type: string, _listener: () => void) => undefined);
        const removeEventListener = mock((_type: string, _listener: () => void) => undefined);
        const signal = { aborted: false, addEventListener, removeEventListener } as unknown as AbortSignal;

        const pending = sleepRespectingSignal(1000, signal);
        expect(addEventListener).toHaveBeenCalledTimes(1);
        const listener = addEventListener.mock.calls[0]?.[1];
        expect(addEventListener.mock.calls[0]?.[0]).toBe('abort');
        expect(removeEventListener).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1000);
        await pending;
        expect(removeEventListener.mock.calls).toEqual([['abort', listener]]);
    });

    test('detaches its abort listener and rejects with an exactly named AbortError when the signal fires mid-wait', async () => {
        const added: { type?: string, listener?: () => void } = {};
        const addEventListener = mock((type: string, listener: () => void) => {
            added.type = type;
            added.listener = listener;
        });
        const removeEventListener = mock((_type: string, _listener: () => void) => undefined);
        const signal = { aborted: false, addEventListener, removeEventListener } as unknown as AbortSignal;

        const pending = sleepRespectingSignal(1000, signal).catch((error_: unknown) => error_);
        expect(addEventListener).toHaveBeenCalledTimes(1);
        expect(added.type).toBe('abort');
        const { listener } = added;
        if(!listener) {
            throw new Error('sleepRespectingSignal registered no abort listener');
        }
        listener(); // what the signal would do on abort

        const error: unknown = await pending;
        expect(removeEventListener.mock.calls).toEqual([['abort', listener]]);
        expect(jest.getTimerCount()).toBe(0);
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
        expect((error as DOMException).message).toBe('Aborted');
    });

    test('resolves normally and does not react to a later abort once the delay has already elapsed', async () => {
        const controller = new AbortController();
        const pending = sleepRespectingSignal(1000, controller.signal);
        jest.advanceTimersByTime(1000);
        await expect(pending).resolves.toBeUndefined();
        expect(() => controller.abort()).not.toThrow(); // the resolved timeout already removed its listener
    });
});
