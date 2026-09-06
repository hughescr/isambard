/**
 * Ingress Gate
 *
 * Buffers live messages arriving during boot so the boot sequence (P10's `runBootSequence`) can
 * decide, once it knows which message ids it already replayed from Discord history, which
 * buffered messages still need to reach the coordinator — a message that arrives while
 * `loadUnread`/replay is running must be answered exactly once, not twice.
 *
 * Pure state machine, no Discord dependency: it only needs each message to expose an `id`.
 *
 * States: `buffering` -> `open` -> `stopped` (one-way; `open()` and `stop()` are both idempotent
 * no-ops once the gate has moved past the state they'd otherwise cause).
 *
 * @example
 * ```typescript
 * const gate = createIngressGate<Message>({ onDrain: (message) => dispatchToCoordinator(message) });
 *
 * // Live messages arriving during boot are buffered, not dispatched
 * gate.admit(message); // 'buffered'
 *
 * // Once boot's replay has run and we know which ids it already covered:
 * gate.open(new Set(replayedMessageIds)); // drains the buffer minus replayedMessageIds
 *
 * // From then on:
 * gate.admit(message); // 'pass' — caller dispatches it directly
 * ```
 */

/** Lifecycle state of an ingress gate. */
export type IngressGateState = 'buffering' | 'open' | 'stopped';

/** Result of admitting a message into the gate. */
export type IngressGateAdmitResult = 'buffered' | 'pass' | 'dropped';

/** Minimal shape a message must have to be gated: an id used for replay dedup. */
export interface IngressGateMessage {
    id: string
}

/** Options for creating an ingress gate. */
export interface CreateIngressGateOptions<T extends IngressGateMessage> {
    /**
     * Invoked once per buffered message that survives the replay-id dedup, in arrival order,
     * when `open()` transitions the gate out of `buffering`.
     */
    onDrain: (message: T) => void
}

/** An ingress gate instance. */
export interface IngressGate<T extends IngressGateMessage = IngressGateMessage> {
    /**
     * Admits a message, returning what the caller should do with it:
     * - `buffering` state: pushes the message and returns `'buffered'` (caller must not dispatch).
     * - `open` state: returns `'pass'` (caller dispatches the message itself).
     * - `stopped` state: returns `'dropped'` (caller must not dispatch — the message's lastSeen
     *   checkpoint already records it for a future replay).
     */
    admit(message: T): IngressGateAdmitResult
    /**
     * Transitions `buffering` -> `open` and calls `onDrain` for every buffered message whose id
     * is not in `replayedIds`, in arrival order, then clears the buffer. Idempotent: a call while
     * already `open` or `stopped` does nothing.
     */
    open(replayedIds: ReadonlySet<string>): void
    /**
     * Transitions to `stopped` from any state, discarding any buffered messages without draining
     * them. Idempotent.
     */
    stop(): void
    /** Current lifecycle state, for tests and logging. */
    state(): IngressGateState
}

/**
 * Creates a new ingress gate, starting in the `buffering` state.
 */
export function createIngressGate<T extends IngressGateMessage>(options: CreateIngressGateOptions<T>): IngressGate<T> {
    const { onDrain } = options;
    let state: IngressGateState = 'buffering';
    let buffer: T[] = [];

    return {
        admit(message: T): IngressGateAdmitResult {
            if(state === 'buffering') {
                buffer.push(message);
                return 'buffered';
            }

            if(state === 'open') {
                return 'pass';
            }

            return 'dropped';
        },

        open(replayedIds: ReadonlySet<string>): void {
            if(state !== 'buffering') {
                return;
            }

            state = 'open';
            const toDrain = buffer;
            buffer = [];

            for(const message of toDrain) {
                if(!replayedIds.has(message.id)) {
                    onDrain(message);
                }
            }
        },

        stop(): void {
            state = 'stopped';
            buffer = [];
        },

        state(): IngressGateState {
            return state;
        },
    };
}
