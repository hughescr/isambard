/**
 * Tests for {@link InputQueue}, the host-owned FIFO fed to the Agent SDK as the query's prompt
 * iterable. Generalised from the spike's Inbox (scripts/spike-long-lived-session.ts:231-264).
 */
import { describe, test, expect } from 'bun:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from '../../../../src/agent/session/input-queue';
import { InvariantViolationError } from '../../../../src/errors';

function userMessage(content: string, extra: Partial<SDKUserMessage> = {}): SDKUserMessage {
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...extra };
}

describe('InputQueue', () => {
    test('a message pushed before iteration starts is delivered immediately', async () => {
        const queue = new InputQueue();
        queue.push(userMessage('hello'));

        const iterator = queue[Symbol.asyncIterator]();
        const result = await iterator.next();

        expect(result.done).toBe(false);
        expect(result.value).toEqual(userMessage('hello'));
    });

    test('a push after the iterator has parked waiting resolves it', async () => {
        const queue = new InputQueue();
        const iterator = queue[Symbol.asyncIterator]();
        const pending = iterator.next();

        queue.push(userMessage('world'));

        const result = await pending;
        expect(result.done).toBe(false);
        expect(result.value).toEqual(userMessage('world'));
    });

    test('drains three pushed messages in FIFO order', async () => {
        const queue = new InputQueue();
        queue.push(userMessage('one'));
        // eslint-disable-next-line unicorn/prefer-single-call -- InputQueue.push takes exactly one message; this isn't Array#push, so there's no multi-arg call to consolidate into
        queue.push(userMessage('two'));
        // eslint-disable-next-line unicorn/prefer-single-call -- InputQueue.push takes exactly one message; this isn't Array#push, so there's no multi-arg call to consolidate into
        queue.push(userMessage('three'));

        const iterator = queue[Symbol.asyncIterator]();
        const first = await iterator.next();
        const second = await iterator.next();
        const third = await iterator.next();

        expect(first.value).toEqual(userMessage('one'));
        expect(second.value).toEqual(userMessage('two'));
        expect(third.value).toEqual(userMessage('three'));
    });

    test('close() ends iteration only after draining what was already queued', async () => {
        const queue = new InputQueue();
        queue.push(userMessage('last'));
        queue.close();

        const drained: SDKUserMessage[] = [];

        for await (const message of queue) {
            drained.push(message);
        }

        expect(drained).toEqual([userMessage('last')]);
    });

    test('close() wakes an iterator already parked waiting for the next message', async () => {
        const queue = new InputQueue();
        const iterator = queue[Symbol.asyncIterator]();
        const pending = iterator.next();

        queue.close();

        const result = await pending;
        expect(result.done).toBe(true);
    });

    test('close() with nothing queued ends iteration immediately', async () => {
        const queue = new InputQueue();
        queue.close();

        const iterator = queue[Symbol.asyncIterator]();
        const result = await iterator.next();

        expect(result.done).toBe(true);
    });

    test('push after close throws InvariantViolationError', () => {
        const queue = new InputQueue();
        queue.close();

        expect(() => {
            queue.push(userMessage('too late'));
        }).toThrow(InvariantViolationError);
    });

    test('size() reflects queued-but-undrained messages', async () => {
        const queue = new InputQueue();
        expect(queue.size()).toBe(0);

        queue.push(userMessage('a'));
        // eslint-disable-next-line unicorn/prefer-single-call -- InputQueue.push takes exactly one message; this isn't Array#push, so there's no multi-arg call to consolidate into
        queue.push(userMessage('b'));
        expect(queue.size()).toBe(2);

        const iterator = queue[Symbol.asyncIterator]();
        await iterator.next();
        expect(queue.size()).toBe(1);

        await iterator.next();
        expect(queue.size()).toBe(0);
    });

    test('a message carrying shouldQuery:false passes through untouched', async () => {
        const queue = new InputQueue();
        const message = userMessage('quiet', { shouldQuery: false });
        queue.push(message);

        const iterator = queue[Symbol.asyncIterator]();
        const result = await iterator.next();

        expect(result.value).toEqual(message);
        expect(result.value?.shouldQuery).toBe(false);
    });
});
