/**
 * Tests for {@link openSession}, the long-lived session handle. Uses P3's {@link FakeQuery}/
 * {@link fakeQueryFn} test doubles to drive the reader loop deterministically.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from '../../../../src/agent/session/input-queue';
import { createInterruptFlag } from '../../../../src/agent/session/interrupt-flag';
import { openSession, sdkFrameToAgentStreamEvent } from '../../../../src/agent/session/session';
import { fakeQueryFn } from '../../../helpers/fake-query';
import { mockLogger } from '../../../setup';

const OPTIONS = {} as Options;

function initFrame(sessionId: string): SDKMessage {
    return { type: 'system', subtype: 'init', session_id: sessionId } as unknown as Extract<SDKMessage, { type: 'system' }>;
}

function resultFrame(): SDKMessage {
    return { type: 'result', subtype: 'success' } as unknown as Extract<SDKMessage, { type: 'result' }>;
}

/** A minimal test-double InputQueue: nothing under test here actually drains it, and it never claims a result as an acknowledgement. */
function stubQueue(): InputQueue {
    return { close: () => undefined, claimAcknowledgement: () => false } as unknown as InputQueue;
}

/** A real queue holding one pushed `shouldQuery:false` message, and the bare result that acknowledges it. */
function queueWithPendingAck(): { queue: InputQueue, ack: SDKMessage } {
    const queue = new InputQueue();
    const uuid = queue.push({ type: 'user', message: { role: 'user', content: 'quiet' }, parent_tool_use_id: null, shouldQuery: false });
    const ack = { type: 'result', subtype: 'success', user_message_uuid: uuid, user_message_uuids: [uuid] } as unknown as Extract<SDKMessage, { type: 'result' }>;
    return { queue, ack };
}

/** Flushes enough microtask ticks for the reader loop's promise chain (pull -> yield -> for-await -> handleFrame) to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
});

afterEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
});

describe('openSession', () => {
    test('preserves non-init system frames for observability consumers', () => {
        const frame = {
            type:        'system',
            subtype:     'task_progress',
            task_id:     'task-abc',
            summary:     'Inspecting stream adapters',
            description: 'Fix system frames',
            usage:       { total_tokens: 42, tool_uses: 1, duration_ms: 7 },
        } as unknown as Extract<SDKMessage, { type: 'system' }>;

        expect(sdkFrameToAgentStreamEvent(frame)).toEqual(frame);

        const compactFrame = {
            type:             'system',
            subtype:          'compact_boundary',
            compact_metadata: { trigger: 'auto', pre_tokens: 42_000 },
        } as unknown as Extract<SDKMessage, { type: 'system' }>;

        expect(sdkFrameToAgentStreamEvent(compactFrame)).toEqual(compactFrame);
    });

    test('adapts mixed assistant content in SDK order without leaking SDK-only fields', () => {
        const frame = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'text', text: 'opening answer' },
                    { type: 'thinking', thinking: 'private reasoning', signature: 'signed-thinking' },
                    { type: 'tool_use', id: 'tool-123', name: 'Read', input: { path: '/tmp/example' } },
                    { type: 'text', text: 'visible answer', citations: [{ type: 'char_location', cited_text: 'answer' }] },
                ],
            },
        } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

        expect(sdkFrameToAgentStreamEvent(frame)).toEqual({
            type:    'assistant',
            message: {
                content: [
                    { type: 'text', text: 'opening answer' },
                    { type: 'thinking', thinking: 'private reasoning' },
                    { type: 'tool_use', id: 'tool-123', name: 'Read', input: { path: '/tmp/example' } },
                    { type: 'text', text: 'visible answer' },
                ],
            },
        });
    });

    test('adapts result observability fields without preserving unrelated SDK payload', () => {
        const frame = {
            type:              'result',
            subtype:           'success',
            duration_ms:       325,
            total_cost_usd:    0.0042,
            is_error:          false,
            usage:             { input_tokens: 15, output_tokens: 9 },
            queued_turn_count: 2,
            result:            'SDK-only final text',
        } as unknown as Extract<SDKMessage, { type: 'result' }>;

        expect(sdkFrameToAgentStreamEvent(frame)).toEqual({
            type:              'result',
            subtype:           'success',
            duration_ms:       325,
            total_cost_usd:    0.0042,
            is_error:          false,
            usage:             { input_tokens: 15, output_tokens: 9 },
            queued_turn_count: 2,
        });
    });
    test('adapts user and tool-progress observability fields', () => {
        const userFrame = {
            type:    'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'read result' }] },
        } as unknown as Extract<SDKMessage, { type: 'user' }>;
        expect(sdkFrameToAgentStreamEvent(userFrame)).toEqual({
            type:    'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'read result' }] },
        });

        const progressFrame = {
            type:                 'tool_progress',
            tool_use_id:          'tool-123',
            tool_name:            'Read',
            elapsed_time_seconds: 2.5,
        } as unknown as Extract<SDKMessage, { type: 'tool_progress' }>;
        expect(sdkFrameToAgentStreamEvent(progressFrame)).toEqual({
            type:                 'tool_progress',
            tool_use_id:          'tool-123',
            tool_name:            'Read',
            elapsed_time_seconds: 2.5,
        });
    });

    test('calls queryFn exactly once with prompt === the queue and options === the given options', () => {
        const { queryFn, instances } = fakeQueryFn();
        const queue = stubQueue();
        const onFrame = () => undefined;
        const onClosed = () => undefined;

        openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue, interrupting: createInterruptFlag(), onFrame, onClosed,
        });

        expect(instances).toHaveLength(1);
        expect(instances[0].receivedParams?.prompt).toBe(queue);
        expect(instances[0].receivedParams?.options).toBe(OPTIONS);
    });

    test('the init frame sets sessionId() and moves state to open', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });

        expect(session.state()).toBe('opening');
        expect(session.sessionId()).toBeUndefined();

        instances[0].emit(initFrame('sess-abc'));
        await flush();

        expect(session.sessionId()).toBe('sess-abc');
        expect(session.state()).toBe('open');
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Session opened', sessionId: 'sess-abc' }));
    });

    test('uses an injected logger when one is supplied', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const injectedLogger = { debug: mock(), info: mock(), warn: mock(), error: mock() };
        openSession({
            role:         'perch',
            queryFn,
            options:      OPTIONS,
            queue:        stubQueue(),
            interrupting: createInterruptFlag(),
            logger:       injectedLogger,
            onFrame:      () => undefined,
            onClosed:     () => undefined,
        });

        instances[0].emit(initFrame('injected-session'));
        await flush();

        expect(injectedLogger.info).toHaveBeenCalledWith(expect.objectContaining({ role: 'perch', sessionId: 'injected-session' }));
    });

    test('session id and open state survive a later non-init frame, and "Session opened" logs only once', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });

        instances[0].emit(initFrame('sess-abc'));
        await flush();
        mockLogger.info.mockClear();

        instances[0].emit(resultFrame());
        await flush();

        expect(session.sessionId()).toBe('sess-abc');
        expect(session.state()).toBe('open');
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    test('a second init-shaped frame after the session is already open does not re-log "Session opened"', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });

        instances[0].emit(initFrame('sess-first'));
        await flush();
        mockLogger.info.mockClear();

        instances[0].emit(initFrame('sess-second'));
        await flush();

        expect(session.sessionId()).toBe('sess-second');
        expect(session.state()).toBe('open');
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    test('every pushed frame reaches onFrame in order', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const received: SDKMessage[] = [];
        openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: frame => received.push(frame), onClosed: () => undefined,
        });

        const first = initFrame('sess-1');
        const second = resultFrame();
        instances[0].emit(first);
        instances[0].emit(second);
        await flush();

        expect(received).toEqual([first, second]);
    });

    test('interrupt() sets isInterrupting(), calls FakeQuery.interrupt once, and the flag clears on the first result frame observed after it resolves', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const interrupting = createInterruptFlag();
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting, onFrame: () => undefined, onClosed: () => undefined,
        });
        const fake = instances[0];

        const interruptPromise = session.interrupt();
        expect(session.isInterrupting()).toBe(true);
        expect(interrupting.value).toBe(true);
        expect(fake.interruptCalls).toBe(1);
        expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Session interrupt requested' }));

        // A result frame BEFORE interrupt() resolves must NOT clear the flag.
        fake.emit(resultFrame());
        await flush();
        expect(session.isInterrupting()).toBe(true);

        fake.resolveInterrupt();
        await interruptPromise;

        fake.emit(initFrame('still-open'));
        await flush();
        expect(session.isInterrupting()).toBe(true);

        // The first result frame AFTER interrupt() resolved clears it.
        fake.emit(resultFrame());
        await flush();
        expect(session.isInterrupting()).toBe(false);
        expect(interrupting.value).toBe(false);

        // Clearing also resets the private latch. A result that arrives while a second interrupt
        // is still awaiting acknowledgement must not be mistaken for that interrupt's result.
        const secondInterrupt = session.interrupt();
        fake.emit(resultFrame());
        await flush();
        expect(session.isInterrupting()).toBe(true);
        fake.resolveInterrupt();
        await secondInterrupt;
        fake.emit(resultFrame());
        await flush();
        expect(session.isInterrupting()).toBe(false);
    });

    test('generator throw sets state failed, calls onClosed(error), clears the interrupt flag, and queryFn was still only called once', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const interrupting = createInterruptFlag();
        interrupting.value = true;
        let closedWith: unknown = 'not-called';
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting, onFrame: () => undefined, onClosed: (error) => { closedWith = error; },
        });

        const boom = new Error('boom');
        instances[0].fail(boom);
        await flush();

        expect(session.state()).toBe('failed');
        expect(closedWith).toBe(boom);
        expect(instances).toHaveLength(1);
        expect(interrupting.value).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith({ role: 'conversation', msg: 'Session failed', error: boom });
    });

    test('generator end sets state closed, calls onClosed(undefined), and clears the interrupt flag', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const interrupting = createInterruptFlag();
        interrupting.value = true;
        let onClosedCalls = 0;
        let onClosedArg: unknown = 'not-called';
        const session = openSession({
            role:     'conversation',
            queryFn,
            options:  OPTIONS,
            queue:    stubQueue(),
            interrupting,
            onFrame:  () => undefined,
            onClosed: (error) => {
                onClosedCalls += 1;
                onClosedArg = error;
            },
        });

        instances[0].end();
        await flush();

        expect(session.state()).toBe('closed');
        expect(onClosedCalls).toBe(1);
        expect(onClosedArg).toBeUndefined();
        expect(interrupting.value).toBe(false);
        expect(mockLogger.info).toHaveBeenCalledWith({ role: 'conversation', msg: 'Session closed' });
    });

    test('interrupt() rejecting clears the interrupt flag and rethrows to the caller', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const interrupting = createInterruptFlag();
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting, onFrame: () => undefined, onClosed: () => undefined,
        });
        const fake = instances[0];

        const interruptPromise = session.interrupt();
        expect(interrupting.value).toBe(true);

        const boom = new Error('control channel down');
        fake.rejectInterrupt(boom);

        await expect(interruptPromise).rejects.toBe(boom);
        expect(session.isInterrupting()).toBe(false);
        expect(interrupting.value).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith({ role: 'conversation', error: boom, msg: 'Session interrupt failed' });

        // A later result frame must not try to clear an already-cleared flag incorrectly, and
        // isInterrupting() should stay false.
        fake.emit(resultFrame());
        await flush();
        expect(session.isInterrupting()).toBe(false);
    });

    test('a throwing onFrame observer is caught so it does not fail the session', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const boom = new Error('observer bug');
        let onClosedCalls = 0;
        const session = openSession({
            role:         'conversation',
            queryFn,
            options:      OPTIONS,
            queue:        stubQueue(),
            interrupting: createInterruptFlag(),
            onFrame:      () => { throw boom; },
            onClosed:     () => { onClosedCalls += 1; },
        });

        instances[0].emit(initFrame('sess-abc'));
        await flush();

        expect(session.state()).toBe('open');
        expect(onClosedCalls).toBe(0);
        expect(mockLogger.error).toHaveBeenCalledWith({ role: 'conversation', error: boom, msg: 'Frame observer threw' });

        // The reader loop must still be alive: a subsequent frame does not throw or fail the session.
        instances[0].emit(resultFrame());
        await flush();
        expect(session.state()).toBe('open');
    });

    test('close() closes the queue then calls query.close()', () => {
        const { queryFn, instances } = fakeQueryFn();
        const order: string[] = [];
        const queue = {
            close: () => {
                order.push('queue');
            },
        } as unknown as InputQueue;
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue, interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });

        instances[0].close = () => {
            order.push('query');
        };
        session.close();

        expect(order).toEqual(['queue', 'query']);
    });

    test('getContextUsage() proxies the underlying query', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const session = openSession({
            role: 'conversation', queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });

        instances[0].scriptContextUsage({ percentage: 55, totalTokens: 100, maxTokens: 200 });

        await expect(session.getContextUsage()).resolves.toEqual({ percentage: 55, totalTokens: 100, maxTokens: 200 });
    });

    test('two openSession instances keep independent pendingToolRequests, evidenced by independent tool_request/tool_response debug logs', async () => {
        const a = fakeQueryFn();
        const b = fakeQueryFn();

        openSession({
            role: 'conversation', queryFn: a.queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });
        openSession({
            role: 'perch', queryFn: b.queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });

        const assistantToolUse = {
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
        } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
        const userFrame = { type: 'user', message: { content: 'hi' } } as unknown as Extract<SDKMessage, { type: 'user' }>;

        a.instances[0].emit(assistantToolUse);
        await flush();
        mockLogger.debug.mockClear();

        // b never saw a tool request; its user frame must log a plain send, carrying role 'perch',
        // not a's pending tool response.
        b.instances[0].emit(userFrame);
        await flush();

        expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({ role: 'perch', eventType: 'user' }));
        expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'tool_response' }));
    });

    test('every log line session.ts emits itself carries the role field', async () => {
        const { queryFn, instances } = fakeQueryFn();
        openSession({
            role: 'perch', queryFn, options: OPTIONS, queue: stubQueue(), interrupting: createInterruptFlag(), onFrame: () => undefined, onClosed: () => undefined,
        });

        instances[0].emit(initFrame('sess-role'));
        await flush();

        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ role: 'perch' }));
    });

    describe('shouldQuery:false acknowledgements', () => {
        test('a result the queue claims as an acknowledgement goes to onAcknowledgement, never to onFrame; init and other results still reach onFrame', async () => {
            const { queryFn, instances } = fakeQueryFn({ drainPrompts: () => false });
            const { queue, ack } = queueWithPendingAck();
            const received: SDKMessage[] = [];
            const acknowledged: SDKMessage[] = [];
            openSession({
                role: 'perch', queryFn, options: OPTIONS, queue, interrupting: createInterruptFlag(), onFrame: frame => received.push(frame), onAcknowledgement: frame => acknowledged.push(frame), onClosed: () => undefined,
            });
            const init = initFrame('sess-ack');
            const other = resultFrame();

            instances[0].emit(init);
            instances[0].emit(ack);
            await flush();
            instances[0].emit(other);
            await flush();

            expect(received).toEqual([init, other]);
            expect(received[1]).toBe(other);
            expect(acknowledged).toEqual([ack]);
            expect(acknowledged[0]).toBe(ack);
            const [uuid] = (ack as { user_message_uuids: string[] }).user_message_uuids;
            expect(mockLogger.debug).toHaveBeenCalledWith({ role: 'perch', uuids: [uuid], msg: 'shouldQuery:false message acknowledged; not a turn result' });
        });

        test('an acknowledgement with no onAcknowledgement observer is dropped quietly', async () => {
            const { queryFn, instances } = fakeQueryFn({ drainPrompts: () => false });
            const { queue, ack } = queueWithPendingAck();
            const received: SDKMessage[] = [];
            const session = openSession({
                role: 'conversation', queryFn, options: OPTIONS, queue, interrupting: createInterruptFlag(), onFrame: frame => received.push(frame), onClosed: () => undefined,
            });

            instances[0].emit(initFrame('sess-ack'));
            instances[0].emit(ack);
            await flush();

            expect(received).toHaveLength(1);
            expect(session.state()).toBe('open');
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        test('a throwing onAcknowledgement observer is caught so it does not fail the session', async () => {
            const { queryFn, instances } = fakeQueryFn({ drainPrompts: () => false });
            const { queue, ack } = queueWithPendingAck();
            const boom = new Error('ack observer bug');
            const session = openSession({
                role: 'conversation', queryFn, options: OPTIONS, queue, interrupting: createInterruptFlag(), onFrame: () => undefined, onAcknowledgement: () => { throw boom; }, onClosed: () => undefined,
            });

            instances[0].emit(initFrame('sess-ack'));
            instances[0].emit(ack);
            await flush();

            expect(session.state()).toBe('open');
            expect(mockLogger.error).toHaveBeenCalledWith({ role: 'conversation', error: boom, msg: 'Frame observer threw' });
        });

        test('an acknowledgement arriving after interrupt() resolved does not clear the interrupt latch; the next real result does', async () => {
            const { queryFn, instances } = fakeQueryFn({ drainPrompts: () => false });
            const { queue, ack } = queueWithPendingAck();
            const interrupting = createInterruptFlag();
            const session = openSession({
                role: 'conversation', queryFn, options: OPTIONS, queue, interrupting, onFrame: () => undefined, onAcknowledgement: () => undefined, onClosed: () => undefined,
            });
            const fake = instances[0];

            const interruptPromise = session.interrupt();
            fake.resolveInterrupt();
            await interruptPromise;

            fake.emit(ack);
            await flush();
            expect(session.isInterrupting()).toBe(true);
            expect(interrupting.value).toBe(true);

            fake.emit(resultFrame());
            await flush();
            expect(session.isInterrupting()).toBe(false);
        });
    });
});
