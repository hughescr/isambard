/**
 * Host-owned input queue fed to the Agent SDK as the `query()` prompt iterable. Generalised
 * from the spike's `Inbox` (scripts/spike-long-lived-session.ts:231-264): a plain FIFO of
 * {@link SDKUserMessage}, parking on a waiter when empty and draining what was queued before
 * ending once closed.
 *
 * The element type is the plain SDK `SDKUserMessage` — there is no `peekKinds()` here.
 * Envelope-kind peeking arrives once P6 defines the envelope type; the conductor wraps or
 * counts kinds on its own side.
 *
 * @module agent/session/input-queue
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { InvariantViolationError } from '@/errors';

/** A host-owned FIFO of {@link SDKUserMessage}, consumed by the Agent SDK as its prompt iterable. */
export class InputQueue {
    private readonly queue:   SDKUserMessage[] = [];
    private readonly waiters: (() => void)[] = [];
    private closed = false;

    /**
     * Enqueues `message` for delivery to whatever is iterating this queue.
     * @param message Message to enqueue
     * @throws {InvariantViolationError} If called after {@link close}
     */
    push(message: SDKUserMessage): void {
        if(this.closed) {
            throw new InvariantViolationError('InputQueue.push', 'push called after close()');
        }
        this.queue.push(message);
        for(const waiter of this.waiters.splice(0)) {
            waiter();
        }
    }

    /**
     * Marks the queue closed: no further {@link push} calls are permitted, and iteration ends
     * once every already-queued message has been drained.
     */
    close(): void {
        this.closed = true;
        for(const waiter of this.waiters.splice(0)) {
            waiter();
        }
    }

    /** Number of messages currently queued but not yet drained. */
    size(): number {
        return this.queue.length;
    }

    async* [Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
        for(;;) {
            const next = this.queue.shift();
            if(next !== undefined) {
                yield next;
                continue;
            }
            if(this.closed) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop -- this loop IS the host's wait-for-next-input mechanism; there's nothing to parallelize
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
    }
}
