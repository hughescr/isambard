import { OUTBOX_FAILURE_FALLBACK, type OutboxFailureClassifier, type OutboxFailure, type OutboxFailureClassification } from '@/services/outbox/failure-classifier';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const CONFIDENCE_THRESHOLD = 0.9;

export interface JevOutboxFailureClassifierDeps {
    /** Optional so an absent secret leaves delivery on the deterministic retry policy. */
    apiKey?: string
}

interface JevResponse {
    answers: { disposition: { choice: OutboxFailureClassification['disposition'], confidence: number } }
}

/** A null payload throws on `.answers`; the caller's catch turns that into the fallback. */
function isClassification(value: unknown): value is JevResponse {
    const answer = value as { answers?: { disposition?: { choice?: unknown, confidence?: unknown } } };
    const disposition = answer.answers?.disposition?.choice;
    const confidence = answer.answers?.disposition?.confidence;
    return (disposition === 'retry' || disposition === 'abandon') && typeof confidence === 'number' && Number.isFinite(confidence) && confidence > CONFIDENCE_THRESHOLD && confidence <= 1;
}

export function createJevOutboxFailureClassifier(deps: JevOutboxFailureClassifierDeps): OutboxFailureClassifier {
    return {
        async classify(failure: OutboxFailure): Promise<OutboxFailureClassification> {
            if(deps.apiKey === undefined || deps.apiKey.length === 0) {
                return OUTBOX_FAILURE_FALLBACK;
            }
            try {
                const response = await fetch(ENDPOINT, {
                    method:  'POST',
                    headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                        model:     'jev-latest',
                        state:     failure,
                        questions: {
                            disposition: {
                                type:         'choice',
                                instructions: 'Classify this known Discord send rejection. Choose abandon only when retrying will not succeed without changing the message or destination.',
                                criteria:     {
                                    retry:   'The rejection may succeed later without changing the message or destination.',
                                    abandon: 'The rejection is a permanent message or destination error; discard the outbox item.',
                                },
                            },
                        },
                    }),
                });
                if(!response.ok) {
                    return OUTBOX_FAILURE_FALLBACK;
                }
                const payload: unknown = await response.json();
                if(!isClassification(payload)) {
                    return OUTBOX_FAILURE_FALLBACK;
                }
                return {
                    disposition: payload.answers.disposition.choice,
                    confidence:  payload.answers.disposition.confidence,
                };
            } catch{
                return OUTBOX_FAILURE_FALLBACK;
            }
        },
    };
}
