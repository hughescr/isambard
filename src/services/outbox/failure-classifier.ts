export interface OutboxFailure {
    message: string
    status?: number
    code?:   number
}

export type OutboxFailureDisposition = 'retry' | 'abandon';

export interface OutboxFailureClassification {
    disposition: OutboxFailureDisposition
    confidence:  number
}

/** Semantic classification is optional; this is the safe, deterministic policy. */
export const OUTBOX_FAILURE_FALLBACK: OutboxFailureClassification = { disposition: 'retry', confidence: 0 };

export interface OutboxFailureClassifier {
    classify(failure: OutboxFailure): Promise<OutboxFailureClassification>
}
