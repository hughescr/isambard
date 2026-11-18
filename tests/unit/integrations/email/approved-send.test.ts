import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { ZodError } from 'zod';
import { mockLogger } from '../../../setup';
import { ApprovedDraftChangedError, EmailProcessingError, ErrorCode, WildDuckAuthError, WildDuckError } from '@/errors';
import { APPROVED_SEND_CHECK_TIMEOUT_MS, submitApprovedDraft } from '@/integrations/email/approved-send';
import type { WildDuckMessage } from '@/integrations/email/wildduck-client';
import { classifyFailure } from '@/services/approved-outbound-action/executor';

const ACTION_ID = 'eeeeeeee-1111-4222-8333-444444444444';
const MESSAGE_ID = '<draft-42@example.com>';
const DRAFT_DATE = '2026-11-17T10:00:00.000Z';
const PARAMS = { uid: 42, messageId: MESSAGE_ID, draftDate: DRAFT_DATE };
const DRAFT: WildDuckMessage = { id: 42, draft: true, messageId: MESSAGE_ID, date: DRAFT_DATE, metaData: { approval: { actionId: ACTION_ID, at: DRAFT_DATE } } };
const FIRST = { actionId: ACTION_ID, firstSend: true };
const RESEND = { actionId: ACTION_ID, firstSend: false };
const MARKER_MISMATCH = 'its approval marker is missing or names another approval';

/** Drafts whose own metaData contradicts or garbles the approval: refused on a first send and a resend alike. */
const CONTRADICTED: [string, WildDuckMessage, string][] = [
    ['has a marker for another approval', { ...DRAFT, metaData: { approval: { actionId: 'ffffffff-1111-4222-8333-444444444444', at: DRAFT_DATE } } }, MARKER_MISMATCH],
    ['has a marker with no timestamp', { ...DRAFT, metaData: { approval: { actionId: ACTION_ID } } }, MARKER_MISMATCH],
    ['has a marker that is not an object', { ...DRAFT, metaData: { approval: ACTION_ID } }, MARKER_MISMATCH],
    ['was rejected as well as approved', { ...DRAFT, metaData: { ...DRAFT.metaData, rejectedAt: DRAFT_DATE } }, 'it was rejected'],
    ['has a null rejectedAt', { ...DRAFT, metaData: { ...DRAFT.metaData, rejectedAt: null } }, 'it was rejected'],
    ['has an empty rejectedAt', { ...DRAFT, metaData: { ...DRAFT.metaData, rejectedAt: '' } }, 'it was rejected'],
    ['has an undefined rejectedAt', { ...DRAFT, metaData: { ...DRAFT.metaData, rejectedAt: undefined } }, 'it was rejected'],
    ['was replaced by an amend', { ...DRAFT, metaData: { ...DRAFT.metaData, supersededBy: 55 } }, 'an amend replaced it'],
    ['has a malformed supersededBy', { ...DRAFT, metaData: { ...DRAFT.metaData, supersededBy: 'Drafts:55' } }, 'an amend replaced it'],
    ['has a null supersededBy', { ...DRAFT, metaData: { ...DRAFT.metaData, supersededBy: null } }, 'an amend replaced it'],
    ['has an undefined supersededBy', { ...DRAFT, metaData: { ...DRAFT.metaData, supersededBy: undefined } }, 'an amend replaced it'],
];

async function drainMicrotasks(ticks = 10): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

describe('submitApprovedDraft', () => {
    let draft: WildDuckMessage | null;
    let events: string[];
    let client: {
        getMessage:    ReturnType<typeof mock<(folder: string, uid: number, signal?: AbortSignal) => Promise<WildDuckMessage | null>>>
        submitMessage: ReturnType<typeof mock<(folder: string, uid: number, signal?: AbortSignal) => Promise<void>>>
    };

    beforeEach(() => {
        mockLogger.warn.mockClear();
        draft = DRAFT;
        events = [];
        client = {
            getMessage: mock(async (folder: string, uid: number) => {
                events.push(`read ${folder}:${uid}`);
                return draft;
            }),
            submitMessage: mock(async (folder: string, uid: number) => {
                events.push(`submit ${folder}:${uid}`);
            }),
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        mockLogger.warn.mockClear();
    });

    const send = async (params: Record<string, unknown> = PARAMS, attempt = FIRST, signal = new AbortController().signal): Promise<void> => submitApprovedDraft(client, params, attempt, signal);

    /** What `send` rejects with, for a send that must fail. */
    const failure = async (attempt = FIRST, params: Record<string, unknown> = PARAMS): Promise<unknown> => {
        try {
            await send(params, attempt);
        } catch (error) {
            return error;
        }
        throw new Error('expected the send to be refused');
    };

    describe('a draft that still matches its approval', () => {
        test('reads the draft, then submits it exactly once under the executor\'s signal', async () => {
            const controller = new AbortController();

            await send(PARAMS, FIRST, controller.signal);

            expect(events).toEqual(['read Drafts:42', 'submit Drafts:42']);
            expect(client.submitMessage.mock.calls).toEqual([['Drafts', 42, controller.signal]]);
        });

        test('fails with the submit\'s own failure, and settles only once the submit has', async () => {
            const refused = new Error('submit refused');
            client.submitMessage.mockImplementation(async () => {
                await Promise.resolve();
                events.push('submit settled');
                throw refused;
            });

            expect(await failure()).toBe(refused);
            expect(events).toEqual(['read Drafts:42', 'submit settled']);
        });

        test('sends a resend (a row claimed before) exactly once', async () => {
            await send(PARAMS, RESEND);

            expect(events).toEqual(['read Drafts:42', 'submit Drafts:42']);
        });

        test('sends a resend whose Date an earlier, refused submit rewrote, exactly once: a partial submit is not a mismatch', async () => {
            draft = { ...DRAFT, date: '2026-11-17T11:00:00.000Z' };

            await send(PARAMS, RESEND);

            expect(client.submitMessage).toHaveBeenCalledTimes(1);
        });

        test('sends a draft whose metaData carries more than its approval', async () => {
            draft = { ...DRAFT, metaData: { ...DRAFT.metaData, approvalCard: { channelId: '1', messageId: '2', edits: 1 }, previewToken: 'x' } };

            await send();

            expect(client.submitMessage).toHaveBeenCalledTimes(1);
        });
    });

    describe('a draft that no longer matches its approval', () => {
        test.each([
            ['is gone from Drafts', null, 'it is no longer in Drafts'],
            ['is no longer a draft', { ...DRAFT, draft: false }, 'it is no longer a draft'],
            ['has no draft flag', { ...DRAFT, draft: undefined }, 'it is no longer a draft'],
            ['has another Message-ID', { ...DRAFT, messageId: '<other@example.com>' }, 'its Message-ID differs'],
            ['has no Message-ID', { ...DRAFT, messageId: undefined }, 'its Message-ID differs'],
            ['has another Date', { ...DRAFT, date: '2026-11-17T10:00:01.000Z' }, 'its Date differs'],
            ['has no Date', { ...DRAFT, date: null }, 'its Date differs'],
            ['has no approval marker', { ...DRAFT, metaData: {} }, MARKER_MISMATCH],
            ['has no metaData at all', { ...DRAFT, metaData: undefined }, MARKER_MISMATCH],
            ...CONTRADICTED,
        ])('refuses a first send of a draft that %s, for good and without submitting', async (_label, current, detail) => {
            draft = current;

            const error = await failure();

            expect(error).toBeInstanceOf(ApprovedDraftChangedError);
            expect((error as Error).message).toBe(`the draft no longer matches what was approved (${detail}), so it was not sent`);
            expect(classifyFailure(error)).toBe('permanent');
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test.each([
            ['no Message-ID', { uid: 42, draftDate: DRAFT_DATE }],
            ['no Date', { uid: 42, messageId: MESSAGE_ID }],
            ['neither', { uid: 42 }],
        ])('refuses, for good and before any read, a row with %s recorded at approval', async (_label, params) => {
            for(const attempt of [FIRST, RESEND]) {
                // eslint-disable-next-line no-await-in-loop -- each attempt is checked on its own
                const error = await failure(attempt, params);
                expect(error).toBeInstanceOf(ApprovedDraftChangedError);
                expect((error as Error).message).toBe('the draft no longer matches what was approved (no Message-ID and Date were recorded when it was approved), so it was not sent');
            }
            expect(client.getMessage).not.toHaveBeenCalled();
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test.each([
            ['is gone from Drafts (an earlier submit may have moved it to Sent Mail)', null, 'it is no longer in Drafts'],
            ['is no longer a draft', { ...DRAFT, draft: false }, 'it is no longer a draft'],
            ['has another Message-ID', { ...DRAFT, messageId: '<other@example.com>' }, 'its Message-ID differs'],
        ])('leaves a resend of a draft that %s to the destination check, without submitting', async (_label, current, detail) => {
            draft = current;

            const error = await failure(RESEND);

            expect(error).toBeInstanceOf(EmailProcessingError);
            expect((error as Error).message).toBe(`the approved draft is no longer in Drafts as approved (${detail}), so an earlier send may have gone out`);
            expect(classifyFailure(error)).toBe('ambiguous');
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test.each(CONTRADICTED)('refuses a resend of a draft that %s for good: no submit changes metaData', async (_label, current, detail) => {
            draft = current;

            const error = await failure(RESEND);

            expect(error).toBeInstanceOf(ApprovedDraftChangedError);
            expect((error as Error).message).toBe(`the draft no longer matches what was approved (${detail}), so it was not sent`);
            expect(classifyFailure(error)).toBe('permanent');
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test('names the marker mismatch first when a rejection and an amend also contradict it', async () => {
            draft = { ...DRAFT, metaData: { rejectedAt: DRAFT_DATE, supersededBy: 55 } };

            expect(((await failure()) as Error).message).toBe(`the draft no longer matches what was approved (${MARKER_MISMATCH}), so it was not sent`);
        });

        test('names the rejection before an amend', async () => {
            draft = { ...DRAFT, metaData: { ...DRAFT.metaData, rejectedAt: DRAFT_DATE, supersededBy: 55 } };

            expect(((await failure()) as Error).message).toBe('the draft no longer matches what was approved (it was rejected), so it was not sent');
        });
    });

    describe('a draft that cannot be read', () => {
        const failRead = (thrown: unknown): void => {
            client.getMessage.mockImplementation(async () => {
                throw thrown;
            });
        };

        test.each([
            ['a 502 carrying a gateway page', new WildDuckError(`WildDuck API error: 502 Bad Gateway: ${'<html>'.repeat(5000)}`, undefined, { status: 502, kind: 'http', body: 'x' }), 'HTTP 502', { status: 502, kind: 'http' }, 'ambiguous'],
            ['a 404', new WildDuckError('WildDuck API error: 404 Not Found: gone', undefined, { status: 404, kind: 'http' }), 'HTTP 404', { status: 404, kind: 'http' }, 'ambiguous'],
            ['a 400', new WildDuckError('WildDuck API error: 400 Bad Request: no', undefined, { status: 400, kind: 'http' }), 'HTTP 400', { status: 400, kind: 'http' }, 'transient'],
            ['an http failure with no status', new WildDuckError('WildDuck API error', undefined, { kind: 'http' }), 'HTTP error', { kind: 'http' }, 'transient'],
            ['an invalid request', new WildDuckError('WildDuck: unknown mailbox path: Drafts', undefined, { kind: 'invalid_request' }), 'request refused before it was sent', { kind: 'invalid_request' }, 'transient'],
            ['an unusable response', new WildDuckError('WildDuck: odd answer', undefined, { kind: 'bad_response' }), 'unusable response', { kind: 'bad_response' }, 'transient'],
            ['a WildDuck timeout', new WildDuckError('WildDuck request timed out', undefined, { kind: 'timeout' }), 'timed out', { kind: 'timeout' }, 'transient'],
            ['a WildDuck error of no known kind', new WildDuckError('WildDuck: something'), 'WildDuck error', {}, 'transient'],
        ] as const)('turns %s into a short WildDuckError of the same class, status and kind, never submitting', async (_label, thrown, detail, context, failureClass) => {
            failRead(thrown);

            const error = await failure();

            expect(error).toBeInstanceOf(WildDuckError);
            expect(error).not.toBeInstanceOf(WildDuckAuthError);
            expect((error as WildDuckError).message).toBe(`could not read the draft before sending (${detail})`);
            expect((error as WildDuckError).code).toBe(ErrorCode.WILDDUCK_ERROR);
            expect((error as WildDuckError).context).toEqual(context);
            expect(classifyFailure(error)).toBe(failureClass);
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test('turns a refused login into a short WildDuckAuthError, still transient', async () => {
            failRead(new WildDuckAuthError('WildDuck authentication failed (401)', { kind: 'auth' }));

            const error = await failure();

            expect(error).toBeInstanceOf(WildDuckAuthError);
            expect((error as WildDuckAuthError).message).toBe('could not read the draft before sending (authentication failed)');
            expect((error as WildDuckAuthError).code).toBe(ErrorCode.WILDDUCK_AUTH_ERROR);
            expect((error as WildDuckAuthError).context).toEqual({ kind: 'auth' });
            expect(classifyFailure(error)).toBe('transient');
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test.each([
            ['TimeoutError', 'timed out'],
            ['AbortError', 'cancelled'],
        ])('turns a %s into a short DOMException of the same name, still ambiguous', async (name, detail) => {
            failRead(new DOMException('The operation timed out.', name));

            const error = await failure();

            expect(error).toBeInstanceOf(DOMException);
            expect((error as DOMException).name).toBe(name);
            expect((error as DOMException).message).toBe(`could not read the draft before sending (${detail})`);
            expect(classifyFailure(error)).toBe('ambiguous');
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test.each([
            ['a fetch TypeError', new TypeError('fetch failed: ECONNRESET')],
            ['a thrown string', 'socket hang up'],
        ])('turns %s into a short EmailProcessingError, still ambiguous', async (_label, thrown) => {
            failRead(thrown);

            const error = await failure();

            expect(error).toBeInstanceOf(EmailProcessingError);
            expect((error as Error).message).toBe('could not read the draft before sending (network error)');
            expect(classifyFailure(error)).toBe('ambiguous');
            expect(client.submitMessage).not.toHaveBeenCalled();
        });

        test.each([
            ['an error\'s message', new WildDuckError('WildDuck API error: 503 Service Unavailable', undefined, { status: 503, kind: 'http' }), 'WildDuck API error: 503 Service Unavailable'],
            ['a thrown string', 'socket hang up', 'socket hang up'],
            ['a 500-character message whole', new WildDuckError('x'.repeat(500)), 'x'.repeat(500)],
            ['a 501-character message cut to 500', new WildDuckError('x'.repeat(501)), `${'x'.repeat(499)}…`],
        ])('logs %s at warn', async (_label, thrown, logged) => {
            failRead(thrown);

            await failure();

            expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, actionId: ACTION_ID, error: logged, msg: 'Could not read the approved draft before sending it' }]]);
        });

        test('gives up on a read still unanswered after exactly 10 s, not a millisecond earlier, never submitting', async () => {
            jest.useFakeTimers();
            client.getMessage.mockImplementation(async (_folder: string, _uid: number, signal?: AbortSignal) => new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    reject(signal.reason as Error);
                });
            }));
            let settled = false;
            const sending = send().finally(() => {
                settled = true;
            });
            const outcome = sending.catch((error: unknown) => error);

            await drainMicrotasks();
            jest.advanceTimersByTime(APPROVED_SEND_CHECK_TIMEOUT_MS - 1);
            await drainMicrotasks();
            expect(settled).toBe(false);
            jest.advanceTimersByTime(1);
            const error = await outcome;

            expect(APPROVED_SEND_CHECK_TIMEOUT_MS).toBe(10_000);
            expect((error as Error).name).toBe('TimeoutError');
            expect(classifyFailure(error)).toBe('ambiguous');
            expect(client.submitMessage).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0);
        });

        test('stands its read deadline down once the read answers', async () => {
            jest.useFakeTimers();

            await send();

            expect(jest.getTimerCount()).toBe(0);
        });

        test('aborts the read when the executor\'s send timeout aborts', async () => {
            const controller = new AbortController();
            const reads: AbortSignal[] = [];
            client.getMessage.mockImplementation(async (_folder: string, _uid: number, signal?: AbortSignal) => {
                reads.push(signal!);
                return draft;
            });

            await send(PARAMS, FIRST, controller.signal);

            expect(reads[0]?.aborted).toBe(false);
            controller.abort();
            expect(reads[0]?.aborted).toBe(true);
        });

        test('refuses unparseable params before reading anything', async () => {
            const error = await failure(FIRST, { uid: 'x' });

            expect(error).toBeInstanceOf(ZodError);
            expect(client.getMessage).not.toHaveBeenCalled();
        });
    });
});
