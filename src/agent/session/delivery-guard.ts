/**
 * Guards Discord delivery by envelope id (P8) so a crash-and-restart replay of an undelivered
 * envelope (see ./recovery.ts) can never double-send: the conductor checks
 * {@link DeliveryGuard.alreadyDelivered} before sending and calls
 * {@link DeliveryGuard.markDelivered} only after the `response_delivered` journal entry has been
 * appended AND the journal flushed (see ./conductor.ts's `deliver` helper), so a crash between
 * send and mark is a narrow window bounded by the flush, not by the send-vs-mark gap alone — and
 * even a re-send inside that window still lands correctly, because the journal (not this
 * in-memory guard) is what recovery reseeds on the next boot.
 *
 * @module agent/session/delivery-guard
 */

/** In-memory set of envelope ids already delivered this process. */
export interface DeliveryGuard {
    /** True when `envelopeId` has already been delivered (seeded at boot, or marked this process). */
    alreadyDelivered: (envelopeId: string) => boolean
    /** Records `envelopeId` as delivered. Idempotent — marking an already-delivered id is a no-op. */
    markDelivered:    (envelopeId: string) => void
}

/**
 * Creates a {@link DeliveryGuard} pre-seeded with `seed` — typically
 * {@link import('./recovery').RecoveryResult.deliveredEnvelopeIds} computed at boot from the
 * journal, so envelopes a prior process already delivered stay refused across a restart.
 */
export function createDeliveryGuard(seed: Iterable<string>): DeliveryGuard {
    const delivered = new Set(seed);

    return {
        alreadyDelivered(envelopeId: string): boolean {
            return delivered.has(envelopeId);
        },
        markDelivered(envelopeId: string): void {
            delivered.add(envelopeId);
        },
    };
}
