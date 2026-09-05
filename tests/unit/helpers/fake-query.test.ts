import { afterEach, describe, expect, it, jest } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SDKAuthStatusMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeQuery, fakeQueryFn } from '../../helpers/fake-query';

function authStatusFrame(output: string[]): SDKAuthStatusMessage {
    return { type: 'auth_status', isAuthenticating: false, output, uuid: randomUUID(), session_id: 'sess-1' };
}

function userMessage(text: string): SDKUserMessage {
    return {
        type:               'user',
        message:            { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id:         'sess-1',
        uuid:               randomUUID(),
    };
}

async function* iterableOf<T>(items: T[]): AsyncGenerator<T> {
    for(const item of items) {
        yield item;
    }
}

describe('FakeQuery', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('yields emitted frames in order to a for-await consumer', async () => {
        const query = new FakeQuery();
        query.emit(authStatusFrame(['a']));
        query.emit(authStatusFrame(['b']));
        query.end();

        const seen: string[][] = [];
        for await (const frame of query) {
            expect(frame.type).toBe('auth_status');
            seen.push((frame as SDKAuthStatusMessage).output);
        }

        expect(seen).toEqual([['a'], ['b']]);
    });

    it('yields frames pushed after iteration has already started', async () => {
        const query = new FakeQuery();
        const seen: string[][] = [];

        const consume = (async () => {
            for await (const frame of query) {
                seen.push((frame as SDKAuthStatusMessage).output);
            }
        })();

        query.emit(authStatusFrame(['late']));
        query.end();
        await consume;

        expect(seen).toEqual([['late']]);
    });

    it('end() terminates the iterator with no further frames', async () => {
        const query = new FakeQuery();
        query.end();

        const seen: unknown[] = [];
        for await (const frame of query) {
            seen.push(frame);
        }

        expect(seen).toEqual([]);
    });

    it('fail() throws the given error from the iterator', async () => {
        const query = new FakeQuery();
        const boom = new Error('boom');
        query.emit(authStatusFrame(['ok']));
        query.fail(boom);

        const drain = async () => {
            const seen: unknown[] = [];
            for await (const frame of query) {
                seen.push(frame);
            }
            return seen;
        };

        await expect(drain()).rejects.toThrow('boom');
    });

    it('interrupt() is recorded and its promise settles only after resolveInterrupt()', async () => {
        const query = new FakeQuery();
        let settled = false;
        const pending = query.interrupt().then((response) => {
            settled = true;
            return response;
        });

        expect(query.interruptCalls).toBe(1);
        await Promise.resolve();
        expect(settled).toBe(false);

        query.resolveInterrupt();
        const response = await pending;

        expect(settled).toBe(true);
        expect(response).toEqual({ still_queued: [], cancelled: [] });
    });

    it('interrupt() can be scripted with a custom response', async () => {
        const query = new FakeQuery();
        const pending = query.interrupt();

        query.resolveInterrupt({ still_queued: ['u1'], cancelled: ['u2'] });

        await expect(pending).resolves.toEqual({ still_queued: ['u1'], cancelled: ['u2'] });
    });

    it('capturePrompt drains a pushed prompt iterable into consumedPrompts', async () => {
        const query = new FakeQuery();
        const messages = [userMessage('one'), userMessage('two')];

        await query.capturePrompt(iterableOf(messages));

        expect(query.consumedPrompts).toEqual(messages);
    });

    it('getContextUsage returns the scripted summary', async () => {
        const query = new FakeQuery();
        query.scriptContextUsage({ percentage: 42, totalTokens: 1000, maxTokens: 2000 });

        await expect(query.getContextUsage()).resolves.toEqual({ percentage: 42, totalTokens: 1000, maxTokens: 2000 });
    });

    it('getContextUsage rejects when scripted with an Error', async () => {
        const query = new FakeQuery();
        const failure = new Error('context usage unavailable');
        query.scriptContextUsage(failure);

        await expect(query.getContextUsage()).rejects.toThrow('context usage unavailable');
    });

    it('deferContextUsage() holds getContextUsage() pending until its resolve is called', async () => {
        const query = new FakeQuery();
        const { resolve } = query.deferContextUsage();
        let settled = false;

        const pending = query.getContextUsage().then((value) => {
            settled = true;
            return value;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        resolve({ percentage: 77, totalTokens: 500, maxTokens: 1000 });

        await expect(pending).resolves.toEqual({ percentage: 77, totalTokens: 500, maxTokens: 1000 });
        expect(settled).toBe(true);
    });

    it('queues a second concurrent pull instead of stranding the first', async () => {
        const query = new FakeQuery();
        const iterA = query[Symbol.asyncIterator]();
        const iterB = query[Symbol.asyncIterator]();

        const pendingA = iterA.next();
        const pendingB = iterB.next();

        query.emit(authStatusFrame(['a']));
        query.emit(authStatusFrame(['b']));

        const resultA = await pendingA;
        const resultB = await pendingB;

        expect((resultA.value as SDKAuthStatusMessage).output).toEqual(['a']);
        expect((resultB.value as SDKAuthStatusMessage).output).toEqual(['b']);
    });

    it('records close/stopTask/streamInput calls', async () => {
        const query = new FakeQuery();
        const promptIterable = iterableOf<SDKUserMessage>([]);

        query.close();
        await query.stopTask('task-1');
        await query.streamInput(promptIterable);

        expect(query.closeCalls).toBe(1);
        expect(query.stopTaskCalls).toEqual(['task-1']);
        expect(query.streamInputCalls).toEqual([promptIterable]);
    });
});

describe('fakeQueryFn', () => {
    it('returns a SessionQueryFn that constructs a new FakeQuery per call, tracked in instances', () => {
        const { queryFn, instances } = fakeQueryFn();
        const prompt = iterableOf<SDKUserMessage>([]);

        const queryA = queryFn({ prompt, options: {} });
        const queryB = queryFn({ prompt, options: {} });

        expect(instances).toHaveLength(2);
        expect(queryA).toBe(instances[0]);
        expect(queryB).toBe(instances[1]);
        expect(queryA).not.toBe(queryB);
    });

    it('drains the given prompt into the created FakeQuery.consumedPrompts', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const message = userMessage('hello');

        queryFn({ prompt: iterableOf([message]), options: {} });
        await instances[0]?.capturePromptDone;

        expect(instances[0]?.consumedPrompts).toEqual([message]);
    });

    it('exposes a rejecting capturePromptDone instead of an unhandled rejection when the prompt iterable throws', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const boom = new Error('prompt iterable exploded');
        async function* throwingPrompt(): AsyncGenerator<SDKUserMessage> {
            throw boom;
        }

        queryFn({ prompt: throwingPrompt(), options: {} });

        await expect(instances[0]?.capturePromptDone).rejects.toThrow('prompt iterable exploded');
    });
});
