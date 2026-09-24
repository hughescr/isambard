import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { raceSendTimeout } from '@/services/approved-outbound-action/send-timeout';

describe('raceSendTimeout', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('resolves sent when the send resolves before the deadline, and clears its timer', async () => {
        expect(await raceSendTimeout(Promise.resolve(), 1000)).toBe('sent');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('rejects with the send error when the send rejects before the deadline, and clears its timer', async () => {
        await expect(raceSendTimeout(Promise.reject(new Error('network failure')), 1000)).rejects.toThrow('network failure');
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
