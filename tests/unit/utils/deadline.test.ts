import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { clearDeadlineWhenBodySettles, createDeadline, deadlineFactory } from '@/utils/deadline';

describe('createDeadline', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('aborts its signal with a TimeoutError once the time is up, and not before', () => {
        const deadline = createDeadline(1000);

        jest.advanceTimersByTime(999);
        expect(deadline.signal.aborted).toBe(false);

        jest.advanceTimersByTime(1);
        expect(deadline.signal.aborted).toBe(true);
        const reason = deadline.signal.reason as DOMException;
        expect(reason).toBeInstanceOf(DOMException);
        expect(reason.name).toBe('TimeoutError');
        expect(reason.message).toBe('The operation timed out.');
    });

    it('holds exactly one timer while pending and none after clear()', () => {
        const deadline = createDeadline(1000);
        expect(jest.getTimerCount()).toBe(1);

        deadline.clear();

        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(5000);
        expect(deadline.signal.aborted).toBe(false);
    });

    it('may be cleared again after it fired', () => {
        const deadline = createDeadline(10);
        jest.advanceTimersByTime(10);

        deadline.clear();

        expect(deadline.signal.aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('deadlineFactory', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('builds real cancellable deadlines when nothing is injected', () => {
        const deadline = deadlineFactory(undefined)(500);
        expect(jest.getTimerCount()).toBe(1);

        deadline.clear();

        expect(jest.getTimerCount()).toBe(0);
    });

    it('wraps an injected signal source, passing the duration through, with a clear() that does nothing', () => {
        const seen: number[] = [];
        const controller = new AbortController();
        const deadline = deadlineFactory((ms) => {
            seen.push(ms);
            return controller.signal;
        })(250);

        deadline.clear();

        expect(seen).toEqual([250]);
        expect(deadline.signal).toBe(controller.signal);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('clearDeadlineWhenBodySettles', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('keeps the deadline armed while the body is unread, and clears it when the body ends', async () => {
        const deadline = createDeadline(1000);
        const wrapped = clearDeadlineWhenBodySettles(new Response('hello'), deadline);

        expect(jest.getTimerCount()).toBe(1);
        expect(await wrapped.text()).toBe('hello');

        expect(jest.getTimerCount()).toBe(0);
    });

    it('lets the deadline abort a body that stalls past it', async () => {
        const deadline = createDeadline(1000);
        const stalled = new ReadableStream<Uint8Array>({ pull: async () => Promise.withResolvers<void>().promise });
        const wrapped = clearDeadlineWhenBodySettles(new Response(stalled), deadline);
        const read = wrapped.text();
        read.catch(() => undefined);

        jest.advanceTimersByTime(1000);

        expect(deadline.signal.aborted).toBe(true);
    });

    it('clears the deadline when the body fails, and surfaces the failure', async () => {
        const deadline = createDeadline(1000);
        const failing = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(new Error('connection reset'));
            },
        });
        const wrapped = clearDeadlineWhenBodySettles(new Response(failing), deadline);

        await expect(wrapped.text()).rejects.toThrow('connection reset');

        expect(jest.getTimerCount()).toBe(0);
    });

    it('clears the deadline when the body is cancelled, and cancels the underlying body', async () => {
        const deadline = createDeadline(1000);
        const cancelled: unknown[] = [];
        const source = new ReadableStream<Uint8Array>({
            pull:   async () => Promise.withResolvers<void>().promise,
            cancel: (reason) => {
                cancelled.push(reason);
            },
        });
        const wrapped = clearDeadlineWhenBodySettles(new Response(source), deadline);

        await wrapped.body?.cancel('not needed');

        expect(jest.getTimerCount()).toBe(0);
        expect(cancelled).toEqual(['not needed']);
    });

    it('clears the deadline at once for a response without a body, returning that same response', () => {
        const deadline = createDeadline(1000);
        const bodiless = new Response(null, { status: 302, headers: { Location: 'https://x.test/' } });

        const result = clearDeadlineWhenBodySettles(bodiless, deadline);

        expect(result).toBe(bodiless);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('preserves status, status text and headers', () => {
        const deadline = createDeadline(1000);
        const original = new Response('x', { status: 418, statusText: 'Teapot', headers: { 'X-Test': 'yes' } });

        const wrapped = clearDeadlineWhenBodySettles(original, deadline);

        expect(wrapped.status).toBe(418);
        expect(wrapped.statusText).toBe('Teapot');
        expect(wrapped.headers.get('X-Test')).toBe('yes');
        deadline.clear();
    });
});
