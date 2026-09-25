import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createJevOutboxFailureClassifier } from '@/integrations/typesafe/jev-outbox-failure-classifier';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('createJevOutboxFailureClassifier', () => {
    test('posts one Choice question and accepts a high-confidence abandon decision', async () => {
        const fetchMock = mock(async (): Promise<Response> => Response.json({
            answers: { disposition: { type: 'choice', choice: 'abandon', confidence: 0.91 } },
        }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        const classifier = createJevOutboxFailureClassifier({ apiKey: 'test-key' });

        expect(await classifier.classify({ message: 'Invalid form body', status: 400, code: 50_035 })).toEqual({ disposition: 'abandon', confidence: 0.91 });
        expect(fetchMock).toHaveBeenCalledWith('https://api.typesafe.ai/v1/systemone', expect.objectContaining({
            method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        }));
        const request = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]?.[1];
        const body = request.body as string;
        expect(JSON.parse(body)).toEqual(expect.objectContaining({
            model:     'jev-latest',
            state:     { message: 'Invalid form body', status: 400, code: 50_035 },
            questions: { disposition: expect.objectContaining({ type: 'choice', criteria: expect.objectContaining({ retry: expect.any(String), abandon: expect.any(String) }) }) },
        }));
    });

    test('falls back deterministically for low confidence, malformed responses and HTTP failures', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'retry', confidence: 0.9 } } })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: {} })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
        globalThis.fetch = mock(async (): Promise<Response> => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
    });

    test('sends the exact Jev request body with instructions and criteria text', async () => {
        const fetchMock = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'retry', confidence: 0.95 } } }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'm', status: 403 });
        const body = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]?.[1].body as string;
        expect(JSON.parse(body)).toEqual({
            model:     'jev-latest',
            state:     { message: 'm', status: 403 },
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
        });
    });

    test('does not call Jev when the api key is undefined', async () => {
        const fetchMock = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'abandon', confidence: 0.95 } } }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({}).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('does not call Jev when the api key is empty', async () => {
        const fetchMock = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'abandon', confidence: 0.95 } } }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: '' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('calls Jev with a one-character api key', async () => {
        const fetchMock = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'abandon', confidence: 0.95 } } }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'k' }).classify({ message: 'x' })).toEqual({ disposition: 'abandon', confidence: 0.95 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('accepts a high-confidence retry decision', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'retry', confidence: 0.95 } } })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0.95 });
    });

    test('falls back for an unknown choice even at high confidence', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'maybe', confidence: 0.95 } } })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
    });

    test('accepts a confidence of exactly one', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'abandon', confidence: 1 } } })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'abandon', confidence: 1 });
    });

    test('falls back for a confidence above one', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'abandon', confidence: 1.5 } } })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
    });

    test('falls back for a non-ok response even when its body is a valid decision', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'abandon', confidence: 0.95 } } }, { status: 500 })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
    });

    test('falls back for a null JSON payload', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => Response.json(null)) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
    });

    test('falls back when fetch rejects without leaking the failure', async () => {
        globalThis.fetch = mock(async (): Promise<Response> => {
            throw new Error('network');
        }) as unknown as typeof fetch;
        const classifier = createJevOutboxFailureClassifier({ apiKey: 'test-key' });
        expect(await classifier.classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
    });
});
