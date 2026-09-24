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

    test('falls back deterministically for missing keys, low confidence, malformed responses and HTTP failures', async () => {
        const noKey = createJevOutboxFailureClassifier({});
        expect(await noKey.classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });

        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: { disposition: { choice: 'retry', confidence: 0.9 } } })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
        globalThis.fetch = mock(async (): Promise<Response> => Response.json({ answers: {} })) as unknown as typeof fetch;
        expect(await createJevOutboxFailureClassifier({ apiKey: 'test-key' }).classify({ message: 'x' })).toEqual({ disposition: 'retry', confidence: 0 });
        globalThis.fetch = mock(async (): Promise<Response> => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
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
