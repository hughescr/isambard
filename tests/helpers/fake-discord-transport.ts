/**
 * In-memory double for the Discord delivery transport: records every delivery, dedupes repeats
 * of the same envelope (a real delivery is idempotent per envelopeId), and can script one
 * rejection at a time.
 *
 * @module tests/helpers/fake-discord-transport
 */

/** One outbound delivery: which envelope, to which channel/user, with what text. */
export interface DiscordDelivery {
    envelopeId: string
    target:     string
    text:       string
}

/** Scriptable double of the transport used to deliver a session's responses to Discord. */
export class FakeDiscordTransport {
    /** Every delivery that actually went out, in call order, with duplicates excluded. */
    readonly sent: DiscordDelivery[] = [];
    /** Count of `deliver()` calls that were no-ops because their envelopeId was already sent. */
    duplicates = 0;

    private readonly deliveredEnvelopeIds = new Set<string>();
    private scriptedFailure: Error | undefined;

    /** Script the very next `deliver()` call to reject with `error` instead of delivering. */
    failNext(error: Error): void {
        this.scriptedFailure = error;
    }

    deliver(delivery: DiscordDelivery): Promise<void> {
        if(this.scriptedFailure !== undefined) {
            const error = this.scriptedFailure;
            this.scriptedFailure = undefined;
            return Promise.reject(error);
        }

        if(this.deliveredEnvelopeIds.has(delivery.envelopeId)) {
            this.duplicates += 1;
            return Promise.resolve();
        }

        this.deliveredEnvelopeIds.add(delivery.envelopeId);
        this.sent.push(delivery);
        return Promise.resolve();
    }
}
