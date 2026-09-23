/**
 * Tests for {@link InputQueue}, the host-owned FIFO fed to the Agent SDK as the query's prompt
 * iterable. Generalised from the spike's Inbox (scripts/spike-long-lived-session.ts:231-264).
 */
import { describe, test, expect } from 'bun:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from '../../../../src/agent/session/input-queue';
import { InvariantViolationError } from '../../../../src/errors';
import * as frames from '../../../helpers/sdk-frames';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

function userMessage(content: string, extra: Partial<SDKUserMessage> = {}): SDKUserMessage {
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...extra };
}

/** `userMessage(content, extra)` as the queue delivers it: stamped with the wire uuid `push` returned. */
function stamped(uuid: string, content: string, extra: Partial<SDKUserMessage> = {}): SDKUserMessage {
    return { ...userMessage(content, extra), uuid: uuid as SDKUserMessage['uuid'] };
}

/** A `result` frame echoing `uuids` the way SDK 0.3.280 does. */
function echoing(...uuids: string[]): ReturnType<typeof frames.bareResult> {
    return frames.bareResult({ user_message_uuid: uuids.at(-1), user_message_uuids: uuids });
}

describe('InputQueue', () => {
    test('a message pushed before iteration starts is delivered immediately', async () => {
        const queue = new InputQueue();
        const uuid = queue.push(userMessage('hello'));

        const iterator = queue[Symbol.asyncIterator]();
        const result = await iterator.next();

        expect(result.done).toBe(false);
        expect(result.value).toEqual(stamped(uuid, 'hello'));
    });

    test('a push after the iterator has parked waiting resolves it', async () => {
        const queue = new InputQueue();
        const iterator = queue[Symbol.asyncIterator]();
        const pending = iterator.next();

        const uuid = queue.push(userMessage('world'));

        const result = await pending;
        expect(result.done).toBe(false);
        expect(result.value).toEqual(stamped(uuid, 'world'));
    });

    test('two independently parked iterators both complete when one message arrives and the queue closes', async () => {
        const queue = new InputQueue();
        const firstPending = queue[Symbol.asyncIterator]().next();
        const secondPending = queue[Symbol.asyncIterator]().next();

        const uuid = queue.push(userMessage('one'));
        queue.close();

        const results = await Promise.all([firstPending, secondPending]);
        expect(results.map(result => result.value)).toEqual(expect.arrayContaining([
            stamped(uuid, 'one'),
            undefined,
        ]));
        expect(results.map(result => result.done)).toEqual(expect.arrayContaining([false, true]));
    });

    test('drains three pushed messages in FIFO order', async () => {
        const queue = new InputQueue();
        const one = queue.push(userMessage('one'));
        const two = queue.push(userMessage('two'));
        const three = queue.push(userMessage('three'));

        const iterator = queue[Symbol.asyncIterator]();
        const first = await iterator.next();
        const second = await iterator.next();
        const third = await iterator.next();

        expect(first.value).toEqual(stamped(one, 'one'));
        expect(second.value).toEqual(stamped(two, 'two'));
        expect(third.value).toEqual(stamped(three, 'three'));
    });

    test('close() ends iteration only after draining what was already queued', async () => {
        const queue = new InputQueue();
        const uuid = queue.push(userMessage('last'));
        queue.close();

        const drained: SDKUserMessage[] = [];

        for await (const message of queue) {
            drained.push(message);
        }

        expect(drained).toEqual([stamped(uuid, 'last')]);
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

        const pushAfterClose = (): void => {
            queue.push(userMessage('too late'));
        };
        expect(pushAfterClose).toThrow(InvariantViolationError);
        expect(pushAfterClose).toThrow('Invariant violated in InputQueue.push: push called after close()');
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

    test('a message carrying shouldQuery:false passes through, stamped and otherwise untouched', async () => {
        const queue = new InputQueue();
        const message = userMessage('quiet', { shouldQuery: false });
        const uuid = queue.push(message);

        const iterator = queue[Symbol.asyncIterator]();
        const result = await iterator.next();

        expect(result.value).toEqual(stamped(uuid, 'quiet', { shouldQuery: false }));
        expect(result.value?.shouldQuery).toBe(false);
    });

    test('takePending() returns the queued-but-undrained messages, in order, and empties the queue', () => {
        const queue = new InputQueue();
        const a = queue.push(userMessage('a'));
        const b = queue.push(userMessage('b'));

        const taken = queue.takePending();

        expect(taken).toEqual([stamped(a, 'a'), stamped(b, 'b')]);
        expect(queue.size()).toBe(0);
        expect(queue.takePending()).toEqual([]);
    });

    test('takePending() on a queue nothing was ever pushed to returns an empty array', () => {
        expect(new InputQueue().takePending()).toEqual([]);
    });

    test('a message the consumer already drained is never returned by takePending()', async () => {
        const queue = new InputQueue();
        queue.push(userMessage('drained'));
        const stillQueued = queue.push(userMessage('still queued'));

        const iterator = queue[Symbol.asyncIterator]();
        await iterator.next();

        expect(queue.takePending()).toEqual([stamped(stillQueued, 'still queued')]);
    });

    describe('wire uuids', () => {
        test('push stamps a fresh v4 uuid on a copy and returns it, leaving the caller\'s message untouched', async () => {
            const queue = new InputQueue();
            const message = userMessage('hello');

            const uuid = queue.push(message);
            const delivered = await queue[Symbol.asyncIterator]().next();

            expect(uuid).toMatch(UUID_PATTERN);
            expect(delivered.value?.uuid).toBe(uuid);
            expect(delivered.value).not.toBe(message);
            expect(message.uuid).toBeUndefined();
        });

        test('pushing the same message twice stamps two different uuids — the CLI silently drops a uuid it has already seen', () => {
            const queue = new InputQueue();
            const message = userMessage('retry me');

            const first = queue.push(message);
            const second = queue.push(message);

            expect(second).not.toBe(first);
            expect(queue.takePending().map(pending => String(pending.uuid))).toEqual([first, second]);
        });

        test('a message that already carries a uuid (a carried-over message being re-pushed) is re-stamped', () => {
            const queue = new InputQueue();
            const carried = userMessage('carried', { uuid: '00000000-0000-4000-8000-000000000000' });

            const uuid = queue.push(carried);

            expect(uuid).not.toBe('00000000-0000-4000-8000-000000000000');
            expect(queue.takePending()).toEqual([stamped(uuid, 'carried')]);
        });
    });

    describe('claimAcknowledgement', () => {
        test('claims a result echoing only a pending shouldQuery:false message (user_message_uuids)', () => {
            const queue = new InputQueue();
            const ack = queue.push(userMessage('quiet', { shouldQuery: false }));

            expect(queue.claimAcknowledgement(echoing(ack))).toBe(true);
        });

        test('claims via the singular user_message_uuid when the list is absent', () => {
            const queue = new InputQueue();
            const ack = queue.push(userMessage('quiet', { shouldQuery: false }));

            expect(queue.claimAcknowledgement(frames.bareResult({ user_message_uuid: ack, user_message_uuids: undefined }))).toBe(true);
        });

        test('claims a result echoing two pending acknowledgements at once', () => {
            const queue = new InputQueue();
            const first = queue.push(userMessage('one', { shouldQuery: false }));
            const second = queue.push(userMessage('two', { shouldQuery: false }));

            expect(queue.claimAcknowledgement(echoing(first, second))).toBe(true);
        });

        test('never claims a result with no echo (a CLI-started turn, or an older producer)', () => {
            const queue = new InputQueue();
            queue.push(userMessage('quiet', { shouldQuery: false }));

            expect(queue.claimAcknowledgement(frames.bareResult({ user_message_uuid: undefined, user_message_uuids: undefined }))).toBe(false);
        });

        test('never claims the result of a querying message', () => {
            const queue = new InputQueue();
            const turn = queue.push(userMessage('ask', { shouldQuery: true }));
            const unmarked = queue.push(userMessage('also ask'));

            expect(queue.claimAcknowledgement(echoing(turn))).toBe(false);
            expect(queue.claimAcknowledgement(echoing(unmarked))).toBe(false);
        });

        test('never claims a result that also answers a querying message — that is a real turn the quiet message was folded into', () => {
            const queue = new InputQueue();
            const ack = queue.push(userMessage('quiet', { shouldQuery: false }));
            const turn = queue.push(userMessage('ask', { shouldQuery: true }));

            expect(queue.claimAcknowledgement(echoing(ack, turn))).toBe(false);
            expect(queue.claimAcknowledgement(echoing(turn, ack))).toBe(false);
        });

        test('never claims a uuid this queue did not stamp', () => {
            const queue = new InputQueue();
            queue.push(userMessage('quiet', { shouldQuery: false }));

            expect(queue.claimAcknowledgement(echoing('someone-else'))).toBe(false);
        });

        test('claims each acknowledgement once: a second result echoing the same uuid is not an acknowledgement', () => {
            const queue = new InputQueue();
            const ack = queue.push(userMessage('quiet', { shouldQuery: false }));

            expect(queue.claimAcknowledgement(echoing(ack))).toBe(true);
            expect(queue.claimAcknowledgement(echoing(ack))).toBe(false);
        });

        test('claiming a pair releases both uuids', () => {
            const queue = new InputQueue();
            const first = queue.push(userMessage('one', { shouldQuery: false }));
            const second = queue.push(userMessage('two', { shouldQuery: false }));

            expect(queue.claimAcknowledgement(echoing(first, second))).toBe(true);
            expect(queue.claimAcknowledgement(echoing(first))).toBe(false);
            expect(queue.claimAcknowledgement(echoing(second))).toBe(false);
        });
    });
});
