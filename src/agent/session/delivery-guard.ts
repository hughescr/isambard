/**
 * Guards Discord delivery by envelope id (P8) so a crash-and-restart replay of an undelivered
 * envelope (see ./recovery.ts) is deduplicated within a process, and across most restarts: the
 * conductor checks {@link DeliveryGuard.alreadyDelivered} before sending and calls
 * {@link DeliveryGuard.markDelivered} only after the `response_delivered` journal entry has been
 * appended AND the journal flushed (see ./conductor.ts's `deliver` helper). This is not an
 * exactly-once guarantee: a crash in the narrow window between the send and that flush leaves no
 * `response_delivered` row for recovery to find, so the next boot's guard is seeded without it
 * and legitimately redelivers — the in-memory guard only prevents a second send within the same
 * process once a delivery is journaled, not a resend after a crash that beat the flush.
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
