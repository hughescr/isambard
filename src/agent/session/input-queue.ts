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
import type { SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { echoedUserMessageUuids } from './result-echo';
import { InvariantViolationError } from '@/errors';

/** A host-owned FIFO of {@link SDKUserMessage}, consumed by the Agent SDK as its prompt iterable. */
export class InputQueue {
    private readonly queue: SDKUserMessage[] = [];
    private waiters = new Set<() => void>();
    private closed = false;
    /** Wire uuids of the `shouldQuery:false` messages pushed here whose acknowledging result has not yet been claimed. */
    private readonly pendingAcks = new Set<string>();

    /**
     * Enqueues a copy of `message`, stamped with a fresh wire uuid, for delivery to whatever is
     * iterating this queue.
     *
     * The uuid is what lets a `result` frame be tied back to the message that caused it (see
     * `./result-echo.ts`). It is fresh on EVERY push, never the envelope id and never a uuid the
     * message already carries: the CLI silently drops a message whose uuid it has already seen —
     * no turn, no result — and the conductor pushes the same envelope again on a retry and after a
     * crash reopen, and re-pushes carried-over messages onto a replacement queue.
     *
     * A `shouldQuery:false` message's uuid is remembered so {@link claimAcknowledgement} can
     * recognise the bare result the SDK answers it with.
     *
     * @param message Message to enqueue; not mutated
     * @returns The wire uuid stamped on the enqueued copy
     * @throws {InvariantViolationError} If called after {@link close}
     */
    push(message: SDKUserMessage): string {
        if(this.closed) {
            throw new InvariantViolationError('InputQueue.push', 'push called after close()');
        }
        const uuid = crypto.randomUUID();
        if(message.shouldQuery === false) {
            this.pendingAcks.add(uuid);
        }
        this.queue.push({ ...message, uuid });
        this.wakeIterator();
        return uuid;
    }

    /**
     * Claims `frame` as the acknowledgement of `shouldQuery:false` messages pushed here, when it
     * is one: SDK 0.3.280 answers every such message with its own bare `result` frame (verified on
     * the real CLI, 2026-09-22), which can arrive AFTER the CLI has read the next, querying message
     * — so without this claim it would settle whichever turn is current with an empty response.
     *
     * A frame is claimed only when it echoes at least one uuid and every uuid it echoes is a
     * still-unclaimed `shouldQuery:false` push from this queue. A result that also names a
     * querying message is a real turn (a quiet message folded into it) and is never claimed; a
     * result that echoes nothing (a turn the CLI started itself) is never claimed. Each uuid is
     * claimed at most once.
     *
     * @param frame A `result` frame read from the session this queue feeds
     * @returns `true` when `frame` is an acknowledgement and has now been claimed
     */
    claimAcknowledgement(frame: SDKResultMessage): boolean {
        const echoed = echoedUserMessageUuids(frame);
        if(echoed.length === 0 || !echoed.every(uuid => this.pendingAcks.has(uuid))) {
            return false;
        }
        for(const uuid of echoed) {
            this.pendingAcks.delete(uuid);
        }
        return true;
    }

    /**
     * Marks the queue closed: no further {@link push} calls are permitted, and iteration ends
     * once every already-queued message has been drained.
     */
    close(): void {
        this.closed = true;
        this.wakeIterator();
    }

    /** Number of messages currently queued but not yet drained. */
    size(): number {
        return this.queue.length;
    }

    /**
     * Removes and returns every message queued here but not yet drained by the consumer.
     *
     * Used when a session's handle is being replaced (see `conductor.ts`'s reopen paths): a
     * message still sitting in this array was, by construction, never read by the SDK — the
     * async iterator only ever `shift()`s a message immediately before yielding it — so the
     * conductor can re-push these onto the replacement session's queue with no risk of double
     * delivery, and with no risk of silently losing an accumulate-only envelope that was queued
     * behind the boot handshake when the old handle died.
     *
     * Each returned message still carries the wire uuid this queue stamped on it; pushing it onto
     * another queue stamps a fresh one (see {@link push}).
     *
     * @returns The undrained messages, oldest first; `[]` when there are none.
     */
    takePending(): SDKUserMessage[] {
        return this.queue.splice(0);
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
                this.waiters.add(resolve);
            });
        }
    }

    private wakeIterator(): void {
        const waiters = this.waiters;
        this.waiters = new Set();
        for(const waiter of waiters) {
            waiter();
        }
    }
}
