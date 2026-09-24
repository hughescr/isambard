import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { raceDeadline, raceSendTimeout } from '@/services/approved-outbound-action/send-timeout';

describe('raceDeadline', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('resolves the work\'s value, wrapped, when it settles before the deadline, and clears its timer', async () => {
        const onTimeout = mock((): void => undefined);

        expect(await raceDeadline(Promise.resolve(42), 1000, onTimeout)).toEqual({ value: 42 });

        expect(onTimeout).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('wraps an undefined value, so it is told apart from the deadline', async () => {
        expect(await raceDeadline(Promise.resolve(undefined), 1000)).toEqual({ value: undefined });
    });

    test('resolves undefined and cancels exactly at the deadline while the work is still pending', async () => {
        const work = Promise.withResolvers<number>();
        const onTimeout = mock((): void => undefined);
        const outcome = raceDeadline(work.promise, 1000, onTimeout);

        jest.advanceTimersByTime(999);
        expect(onTimeout).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);

        expect(await outcome).toBeUndefined();
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    test('rejects with the work\'s own error when it rejects first', async () => {
        await expect(raceDeadline(Promise.reject(new Error('lookup failed')), 1000)).rejects.toThrow('lookup failed');
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('raceSendTimeout', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('resolves sent without cancelling when the send resolves before the deadline, and clears its timer', async () => {
        const onTimeout = mock((): void => undefined);

        expect(await raceSendTimeout(Promise.resolve(), 1000, onTimeout)).toBe('sent');

        expect(onTimeout).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('calls the timeout callback exactly at the deadline after the timeout outcome wins the race', async () => {
        const send = Promise.withResolvers<void>();
        const onTimeout = mock(() => send.reject(new Error('request aborted')));
        const outcome = raceSendTimeout(send.promise, 1000, onTimeout);

        jest.advanceTimersByTime(1000);

        expect(await outcome).toBe('timed-out');
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    test('rejects with the send error without cancelling when the send rejects before the deadline, and clears its timer', async () => {
        const onTimeout = mock((): void => undefined);

        await expect(raceSendTimeout(Promise.reject(new Error('network failure')), 1000, onTimeout)).rejects.toThrow('network failure');

        expect(onTimeout).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('is still pending one millisecond before the deadline', async () => {
        const send = Promise.withResolvers<undefined>();
        const outcome = raceSendTimeout(send.promise, 1000);

        jest.advanceTimersByTime(999);

        expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('pending');
        send.resolve(undefined);
        expect(await outcome).toBe('sent');
    });

    test('resolves timed-out exactly at the deadline while the send is still pending', async () => {
        const send = Promise.withResolvers<undefined>();
        const outcome = raceSendTimeout(send.promise, 1000);

        jest.advanceTimersByTime(1000);

        expect(await outcome).toBe('timed-out');
    });

    test('a send that rejects after the timeout causes no unhandled rejection', async () => {
        const send = Promise.withResolvers<undefined>();
        const outcome = raceSendTimeout(send.promise, 1000);
        jest.advanceTimersByTime(1000);
        expect(await outcome).toBe('timed-out');

        send.reject(new Error('late failure'));
        await Promise.resolve();
        await Promise.resolve();

        expect(jest.getTimerCount()).toBe(0);
    });
});
