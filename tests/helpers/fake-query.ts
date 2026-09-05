/**
 * A scriptable double of the long-lived session's {@link SessionQuery} port. The frames a
 * production `query()` would yield are pushed in by the test (`emit`/`end`/`fail`) and drained
 * out through the standard `for await` protocol; every control-plane call the session core makes
 * back onto the query (`interrupt`, `close`, `stopTask`, `streamInput`, `getContextUsage`) is
 * recorded for assertions. `FakeQuery` implements `SessionQuery` with no `as` casts — every
 * method below is a genuine implementation of the interface, not a stub coerced into shape.
 *
 * @module tests/helpers/fake-query
 */
import type { Options, SDKControlInterruptResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContextUsageSummary, SessionQuery, SessionQueryFn } from '@/agent/session/types';

type QueueItem
    = | { kind: 'frame', frame: SDKMessage }
      | { kind: 'end' }
      | { kind: 'error', error: unknown };

const DEFAULT_INTERRUPT_RESPONSE: SDKControlInterruptResponse = { still_queued: [], cancelled: [] };

/** In-memory double for the session core's narrowed view of the SDK's `Query`. */
export class FakeQuery implements SessionQuery {
    /** Every task id passed to {@link stopTask}, in call order. */
    readonly stopTaskCalls:    string[] = [];
    /** Every prompt iterable passed to {@link streamInput}, in call order. */
    readonly streamInputCalls: AsyncIterable<SDKUserMessage>[] = [];
    /** Every {@link SDKUserMessage} drained out of an iterable passed to {@link capturePrompt}. */
    readonly consumedPrompts:  SDKUserMessage[] = [];
    /** Number of times {@link interrupt} has been called. */
    interruptCalls = 0;
    /** Number of times {@link close} has been called. */
    closeCalls = 0;
    /** The exact `{ prompt, options }` object this instance's `queryFn` call was invoked with, so tests can assert identity (`toBe`) on either field. Set by {@link fakeQueryFn}. */
    receivedParams?:           { prompt: AsyncIterable<SDKUserMessage>, options: Options };

    /** Resolves once the prompt-capture loop started by {@link fakeQueryFn} has finished draining (or rejects if the prompt iterable throws). Exposed so tests can await/assert the capture directly instead of coupling to a fixed number of microtask ticks. */
    capturePromptDone: Promise<void> = Promise.resolve();

    private readonly buffer:           QueueItem[] = [];
    private readonly waitingResolvers: ((item: QueueItem) => void)[] = [];
    private pendingInterrupts:         { resolve: (response: SDKControlInterruptResponse) => void, reject: (error: unknown) => void }[] = [];
    private contextUsageScript:        ContextUsageSummary | Error = { percentage: 0, totalTokens: 0, maxTokens: 0 };

    /** Push a frame the fake query "yields" to whatever is iterating it. */
    emit(frame: SDKMessage): void {
        this.deliver({ kind: 'frame', frame });
    }

    /** End the iterator cleanly, as a real query does when the underlying process exits. */
    end(): void {
        this.deliver({ kind: 'end' });
    }

    /** Make the iterator throw `error` the next time it is pulled. */
    fail(error: unknown): void {
        this.deliver({ kind: 'error', error });
    }

    /** Script the value (or rejection) that {@link getContextUsage} resolves with from now on. */
    scriptContextUsage(value: ContextUsageSummary | Error): void {
        this.contextUsageScript = value;
    }

    /** Resolve every {@link interrupt} call still pending, in the order they were made. */
    resolveInterrupt(response: SDKControlInterruptResponse = DEFAULT_INTERRUPT_RESPONSE): void {
        const pending = this.pendingInterrupts;
        this.pendingInterrupts = [];
        for(const { resolve } of pending) {
            resolve(response);
        }
    }

    /** Reject every {@link interrupt} call still pending with `error`, in the order they were made. */
    rejectInterrupt(error: unknown): void {
        const pending = this.pendingInterrupts;
        this.pendingInterrupts = [];
        for(const { reject } of pending) {
            reject(error);
        }
    }

    interrupt = (): Promise<SDKControlInterruptResponse | undefined> => new Promise((resolve, reject) => {
        this.interruptCalls += 1;
        this.pendingInterrupts.push({ resolve, reject });
    });

    close = (): void => {
        this.closeCalls += 1;
    };

    stopTask = (taskId: string): Promise<void> => {
        this.stopTaskCalls.push(taskId);
        return Promise.resolve();
    };

    streamInput = (stream: AsyncIterable<SDKUserMessage>): Promise<void> => {
        this.streamInputCalls.push(stream);
        return Promise.resolve();
    };

    getContextUsage = (): Promise<ContextUsageSummary> => (this.contextUsageScript instanceof Error
        ? Promise.reject(this.contextUsageScript)
        : Promise.resolve(this.contextUsageScript));

    /** Drain `iterable` into {@link consumedPrompts}, one message at a time, until it ends. */
    async capturePrompt(iterable: AsyncIterable<SDKUserMessage>): Promise<void> {
        for await (const message of iterable) {
            this.consumedPrompts.push(message);
        }
    }

    async* [Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        for(;;) {
            // eslint-disable-next-line no-await-in-loop -- sequential by construction: each turn of this loop awaits exactly one pushed item before yielding it, mirroring how a real Query streams one frame at a time
            const item = await this.pull();
            if(item.kind === 'end') {
                return;
            }
            if(item.kind === 'error') {
                throw item.error;
            }
            yield item.frame;
        }
    }

    /**
     * Delivers `item` to the oldest still-pending {@link pull} (FIFO), or buffers it when nothing
     * is waiting. A queue (rather than a single slot) so a second concurrent consumer of the same
     * `FakeQuery` never silently strands an earlier one.
     */
    private deliver(item: QueueItem): void {
        const resolve = this.waitingResolvers.shift();
        if(resolve !== undefined) {
            resolve(item);
            return;
        }
        this.buffer.push(item);
    }

    private pull(): Promise<QueueItem> {
        const item = this.buffer.shift();
        if(item !== undefined) {
            return Promise.resolve(item);
        }
        return new Promise((resolve) => {
            this.waitingResolvers.push(resolve);
        });
    }
}

/** Build a {@link SessionQueryFn} double: every call constructs and records a fresh {@link FakeQuery}. */
export function fakeQueryFn(): { queryFn: SessionQueryFn, instances: FakeQuery[] } {
    const instances: FakeQuery[] = [];
    const queryFn: SessionQueryFn = (params) => {
        const instance = new FakeQuery();
        instance.receivedParams = params;
        instance.capturePromptDone = instance.capturePrompt(params.prompt);
        // A prompt iterable a test scripts to throw would otherwise reject with nobody awaiting
        // it, surfacing as a cross-test unhandled rejection; capturePromptDone above is the
        // awaitable/assertable surface, this just marks the original promise as handled.
        instance.capturePromptDone.catch(() => undefined);
        instances.push(instance);
        return instance;
    };
    return { queryFn, instances };
}
