/**
 * Orders the two writers of an approval card within this process. An approve click records the
 * approved action durably FIRST — so a crash can never leave a card whose controls are gone with
 * no row to execute or report — and only then edits the card to "sending…". Recording first
 * lets the executor send, and the outcome reporter write "Sent ✓", while that pending edit is
 * still in flight; the approve path therefore holds the card for the length of its record +
 * pending edit, and the outcome delivery waits for any hold before writing the outcome, so the
 * pending edit can never land after (and overwrite) the outcome.
 *
 * Holds live only in memory: after a restart there is no pending edit in flight, so there is
 * nothing to wait for.
 */
export class ApprovalCardEditGate {
    private readonly held = new Map<string, Set<Promise<void>>>();

    /** Hold the card with this message id; call the returned function exactly once to release it. */
    hold(messageId: string): () => void {
        let release!: () => void;
        const edit = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holds = this.held.get(messageId) ?? new Set<Promise<void>>();
        holds.add(edit);
        this.held.set(messageId, holds);
        return () => {
            release();
            holds.delete(edit);
            if(holds.size === 0) {
                this.held.delete(messageId);
            }
        };
    }

    /**
     * Hold the card exclusively: wait until nobody holds it, then hold it. Checking and holding
     * happen in one synchronous step, so of two callers woken by the same release only the first
     * holds and the other waits for it in turn. Used by the writers whose edit depends on a read
     * of the row (the outcome delivery's escalated card, and the admin's escalation buttons), so
     * neither paints over the other with a state it read before the other one wrote.
     */
    async acquire(messageId: string): Promise<() => void> {
        for(let pending = this.pendingEdit(messageId); pending !== undefined; pending = this.pendingEdit(messageId)) {
            // eslint-disable-next-line no-await-in-loop -- re-check after each release: another waiter may have taken the card first.
            await pending;
        }
        return this.hold(messageId);
    }

    /** Settles once every current hold on the card is released; undefined when the card is not held. */
    pendingEdit(messageId: string): Promise<unknown> | undefined {
        const holds = this.held.get(messageId);
        return holds === undefined ? undefined : Promise.all(holds);
    }
}

/** The process-wide gate shared by the approval adapters and the outcome delivery. */
export const approvalCardEditGate = new ApprovalCardEditGate();
