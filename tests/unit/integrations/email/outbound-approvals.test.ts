import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { NotifyParams } from '@/agent';
import { ErrorCode } from '@/errors/codes';
import { EmailProcessingError } from '@/errors/email';
import { ApprovalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import { CARD_LINK_LOCK_WAIT_MS, EmailOutboundApprovals, FINGERPRINT_READ_TIMEOUT_MS, emailSendParamsSchema, type EmailOutboundApprovalsDeps } from '@/integrations/email/outbound-approvals';
import type { WildDuckClient, WildDuckMessage } from '@/integrations/email/wildduck-client';
import type { ApprovedOutboundAction } from '@/services';

const UID = 42;
const NOW = '2026-09-23T12:00:00.000Z';
const CARD = { channelId: 'admin-ch', messageId: 'card-msg' };
const OTHER_CARD = { channelId: 'admin-ch', messageId: 'other-card-msg' };
const LINK = { channelId: 'admin-ch', messageId: 'card-msg', edits: 0 };
const DRAFT_DATE = '2026-09-23T11:59:00.000Z';
const MESSAGE_ID = '<draft@example.com>';
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** The `err` field of the first logged object in a logger mock's calls. */
function loggedErr(calls: unknown[][]): unknown {
    return (calls[0][0] as { err: unknown }).err;
}

/** The in-lock read that gets no answer within the timeout must fail as a typed EmailProcessingError. */
function expectNoAnswerError(err: unknown): void {
    expect(err).toBeInstanceOf(EmailProcessingError);
    expect(err).toMatchObject({ code: ErrorCode.EMAIL_PROCESSING_ERROR, message: 'no answer within 10s' });
}

function draftWith(metaData?: Record<string, unknown>, extra: Partial<WildDuckMessage> = {}): WildDuckMessage {
    return {
        id:        UID,
        draft:     true,
        messageId: MESSAGE_ID,
        date:      DRAFT_DATE,
        to:        [{ address: 'a@example.com' }, { address: '' }],
        cc:        [{ address: 'b@example.com' }, { address: 'a@example.com' }],
        metaData:  metaData ?? { approvalCard: LINK, keep: 'me' },
        ...extra,
    };
}

function makeDeferred(): { promise: Promise<void>, resolve: () => void } {
    const { promise, resolve } = Promise.withResolvers<void>();
    return { promise, resolve: () => resolve() };
}

async function drainMicrotasks(ticks = 20): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

interface Harness {
    ops:            EmailOutboundApprovals
    /** The draft WildDuck currently stores (null once deleted); getMessage returns a copy, metaData writes replace its metaData. */
    store:          { draft: WildDuckMessage | null }
    /** Rows the writer created, by id; the reader reads these. */
    rows:           Map<string, ApprovedOutboundAction>
    create:         ReturnType<typeof mock<(action: ApprovedOutboundAction) => Promise<void>>>
    get:            ReturnType<typeof mock<(id: string) => Promise<ApprovedOutboundAction | undefined>>>
    getMessage:     ReturnType<typeof mock<(folder: string, uid: number, signal?: AbortSignal) => Promise<WildDuckMessage | null>>>
    updateMetadata: ReturnType<typeof mock<(folder: string, uid: number, metadata: Record<string, unknown>) => Promise<void>>>
    updateFlags:    ReturnType<typeof mock<(folder: string, uid: number, options: { addFlags?: string[] }) => Promise<void>>>
    activityLog:    ReturnType<typeof mock<(entry: { type: string, summary: string }) => Promise<void>>>
    notify:         ReturnType<typeof mock<(params: NotifyParams) => boolean>>
    acquire:        ReturnType<typeof mock<(key: string) => Promise<() => void>>>
    gate:           ApprovalCardEditGate
    events:         string[]
}

function makeHarness(overrides: Partial<EmailOutboundApprovalsDeps> = {}, draft: WildDuckMessage | null = draftWith()): Harness {
    const events: string[] = [];
    const store = { draft };
    const rows = new Map<string, ApprovedOutboundAction>();
    const gate = new ApprovalCardEditGate();
    const create = mock(async (action: ApprovedOutboundAction): Promise<void> => {
        events.push('create');
        rows.set(action.id, action);
    });
    const get = mock(async (id: string): Promise<ApprovedOutboundAction | undefined> => {
        events.push('get');
        return rows.get(id);
    });
    const getMessage = mock(async (_folder: string, _uid: number, _signal?: AbortSignal): Promise<WildDuckMessage | null> => {
        events.push('getMessage');
        return store.draft === null ? null : { ...store.draft };
    });
    const updateMetadata = mock(async (_folder: string, _uid: number, metadata: Record<string, unknown>): Promise<void> => {
        events.push('metadata');
        if(store.draft !== null) {
            store.draft = { ...store.draft, metaData: metadata };
        }
    });
    const updateFlags = mock(async (_folder: string, _uid: number, _options: { addFlags?: string[] }): Promise<void> => {
        events.push('flags');
    });
    const activityLog = mock(async (_entry: { type: string, summary: string }): Promise<void> => {
        events.push('activity');
    });
    const notify = mock((_params: NotifyParams): boolean => true);
    const acquire = mock(async (key: string): Promise<() => void> => {
        events.push(`acquire:${key}`);
        const release = await gate.acquire(key);
        events.push(`acquired:${key}`);
        return () => {
            events.push(`release:${key}`);
            release();
        };
    });
    const wildDuckClient = {
        getMessage,
        updateMessageMetadata: updateMetadata,
        updateMessageFlags:    updateFlags,
    } as unknown as WildDuckClient;
    const ops = new EmailOutboundApprovals({
        wildDuckClient,
        actionWriter:   { create },
        actionReader:   { get },
        draftLocks:     { acquire },
        activityLogger: { log: activityLog },
        notify,
        ...overrides,
    });
    return { ops, store, rows, create, get, getMessage, updateMetadata, updateFlags, activityLog, notify, acquire, gate, events };
}

/** A harness whose draft already carries an approval marker, optionally with its row. */
function approvedHarness(withRow: boolean): Harness {
    const h = makeHarness({}, draftWith({ approvalCard: LINK, approval: { actionId: 'act-1', at: 'earlier' } }));
    if(withRow) {
        h.rows.set('act-1', { id: 'act-1' } as ApprovedOutboundAction);
    }
    return h;
}

describe('EmailOutboundApprovals', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('approveSend', () => {
        test('under the draft key, marks the draft approved (merged into the in-lock read) and then records the row carrying the fingerprint', async () => {
            const h = makeHarness();

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'recorded' });

            expect(h.events).toEqual(['acquire:email-draft:42', 'acquired:email-draft:42', 'getMessage', 'metadata', 'create', 'activity', 'release:email-draft:42']);
            const action = h.create.mock.calls[0][0];
            expect(action).toEqual({
                id:           expect.any(String),
                state:        'approved',
                type:         'email_send',
                params:       { uid: UID, messageId: MESSAGE_ID, draftDate: DRAFT_DATE },
                approvalCard: { channelId: 'admin-ch', messageId: 'card-msg' },
                createdAt:    NOW,
                updatedAt:    NOW,
            });
            expect(action.id).toMatch(UUID_PATTERN);
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { approvalCard: LINK, keep: 'me', approval: { actionId: action.id, at: NOW } }]]);
            expect(h.getMessage.mock.calls[0]?.slice(0, 2)).toEqual(['Drafts', UID]);
            expect(h.getMessage.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
            expect(h.get).not.toHaveBeenCalled();
        });

        test('a failed marker write refuses as unreadable and never records a row', async () => {
            const h = makeHarness();
            const failure = new Error('wildduck down');
            h.updateMetadata.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({
                status: 'refused',
                reason: 'unreadable',
                detail: 'Couldn\'t mark the draft approved (wildduck down)',
            });
            expect(h.create).not.toHaveBeenCalled();
            expect(h.activityLog).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: 'Could not mark the draft approved — nothing was approved' });
            expect(h.events.at(-1)).toBe('release:email-draft:42');
        });

        test('a failed row write refuses as unrecorded and keeps the marker', async () => {
            const h = makeHarness();
            const failure = new Error('dynamo down');
            h.create.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({
                status: 'refused',
                reason: 'unrecorded',
                detail: 'Couldn\'t record the approval (dynamo down) — nothing will be sent until it is; try again.',
            });
            const actionId = h.create.mock.calls[0][0].id;
            expect(h.store.draft?.metaData).toEqual({ approvalCard: LINK, keep: 'me', approval: { actionId, at: NOW } });
            expect(h.activityLog).not.toHaveBeenCalled();
            expect(mockLogger.error).toHaveBeenCalledWith({ err: failure, uid: UID, actionId, msg: 'Could not record the approved send — the draft keeps its approval marker for a retry' });
            expect(h.events.at(-1)).toBe('release:email-draft:42');
        });

        test('resumes an approval whose row is missing with the same actionId, writing no new marker', async () => {
            const h = approvedHarness(false);

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'recorded' });

            expect(h.get.mock.calls).toEqual([['act-1']]);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.create.mock.calls[0][0].id).toBe('act-1');
            expect(h.events).toEqual(['acquire:email-draft:42', 'acquired:email-draft:42', 'getMessage', 'get', 'create', 'activity', 'release:email-draft:42']);
        });

        test('a retry after a failed row write records the row once, under the marker\'s id', async () => {
            const h = makeHarness();
            h.create.mockImplementationOnce(async () => {
                throw new Error('dynamo down');
            });

            await h.ops.approveSend(UID, 'direct', CARD);
            const firstId = h.create.mock.calls[0][0].id;
            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'recorded' });

            expect(h.create.mock.calls[1][0].id).toBe(firstId);
            expect(h.updateMetadata).toHaveBeenCalledTimes(1);
            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(h.create).toHaveBeenCalledTimes(2);
        });

        test('refuses as decided when the approval\'s row exists', async () => {
            const h = approvedHarness(true);

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(h.create).not.toHaveBeenCalled();
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('refuses as decided when the draft was rejected, without reading any row', async () => {
            const h = makeHarness({}, draftWith({ rejectedAt: 'earlier', reason: 'no', approval: { actionId: 'act-1', at: 'x' } }));

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(h.get).not.toHaveBeenCalled();
            expect(h.create).not.toHaveBeenCalled();
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('refuses as unreadable when the row read throws', async () => {
            const h = approvedHarness(false);
            const failure = new Error('dynamo read down');
            h.get.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'unreadable', detail: 'Couldn\'t check the approval record (dynamo read down)' });
            expect(h.create).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, actionId: 'act-1', msg: 'Could not read the approved action for an admin decision' });
        });

        test.each([
            ['no Message-ID', { messageId: undefined }],
            ['a null Date', { date: null }],
            ['no Date', { date: undefined }],
        ])('refuses as unreadable when the draft has %s', async (_label, extra) => {
            const h = makeHarness({}, draftWith(undefined, extra));

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'unreadable', detail: 'The draft has no Message-ID or Date' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.create).not.toHaveBeenCalled();
        });

        test.each([
            ['missing', null],
            ['not a draft', draftWith(undefined, { draft: false })],
            ['with no draft flag', draftWith(undefined, { draft: undefined })],
        ])('refuses as gone when the draft is %s', async (_label, draft) => {
            const h = makeHarness({}, draft);

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'gone', detail: 'The draft is no longer in Drafts' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.create).not.toHaveBeenCalled();
        });

        test('refuses as gone when the draft was superseded', async () => {
            const h = makeHarness({}, draftWith({ supersededBy: 55 }));

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'gone', detail: 'The draft was replaced by Drafts:55' });
            expect(h.create).not.toHaveBeenCalled();
        });

        test('refuses as unreadable, with the error, when the draft read throws', async () => {
            const h = makeHarness();
            const failure = new Error('WildDuck API error: 503');
            h.getMessage.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'unreadable', detail: 'Couldn\'t read the draft from WildDuck (WildDuck API error: 503)' });
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: 'Could not read the draft for an admin decision' });
            expect(h.events.at(-1)).toBe('release:email-draft:42');
        });

        test('refuses as unreadable when the draft read rejects with a non-Error', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => {
                throw 'offline';
            });

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'refused', reason: 'unreadable', detail: 'Couldn\'t read the draft from WildDuck (offline)' });
        });

        test('a draft read with no answer is cancelled after 10s and refused as unreadable, recording nothing', async () => {
            const h = makeHarness();
            let signal: AbortSignal | undefined;
            h.getMessage.mockImplementation(async (_folder: string, _uid: number, readSignal?: AbortSignal) => {
                signal = readSignal;
                return Promise.withResolvers<WildDuckMessage | null>().promise;
            });

            const approving = h.ops.approveSend(UID, 'direct', CARD);
            await drainMicrotasks();
            jest.advanceTimersByTime(FINGERPRINT_READ_TIMEOUT_MS - 1);
            await drainMicrotasks();
            expect(Bun.peek.status(approving)).toBe('pending');
            expect(signal?.aborted).toBe(false);

            jest.advanceTimersByTime(1);

            expect(await approving).toEqual({ status: 'refused', reason: 'unreadable', detail: 'Couldn\'t read the draft from WildDuck (no answer within 10s)' });
            expect(signal?.aborted).toBe(true);
            expect(h.create).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: UID, msg: 'Could not read the draft for an admin decision: no answer within 10s' });
            expect(FINGERPRINT_READ_TIMEOUT_MS).toBe(10_000);
        });

        test.each(['direct', 'allowlist'] as const)('logs one email-send-approved activity after the %s write and never email-sent', async (via) => {
            const h = makeHarness();

            await h.ops.approveSend(UID, via, CARD);

            expect(h.activityLog.mock.calls).toEqual([[{ type: 'email-send-approved', summary: 'Email approved for sending' }]]);
        });

        test.each(['direct', 'allowlist'] as const)('a failed activity log on the %s route warns naming the route and never rejects', async (via) => {
            const h = makeHarness();
            const failure = new Error('activity down');
            h.activityLog.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.approveSend(UID, via, CARD)).toEqual({ status: 'recorded' });
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, msg: `Activity log failed for email send (${via} path)` });
        });

        test('works without an activity logger', async () => {
            const h = makeHarness({ activityLogger: undefined });

            expect(await h.ops.approveSend(UID, 'direct', CARD)).toEqual({ status: 'recorded' });
        });
    });

    describe('rejectSend', () => {
        test('under the draft key, merges the rejection into the in-lock read, then flags the draft, then logs the activity', async () => {
            const h = makeHarness();

            expect(await h.ops.rejectSend(UID, 'Too blunt')).toEqual({ status: 'rejected' });

            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { approvalCard: LINK, keep: 'me', rejectedAt: NOW, reason: 'Too blunt' }]]);
            expect(h.updateFlags.mock.calls).toEqual([['Drafts', UID, { addFlags: ['SendRejectedByAdmin'] }]]);
            expect(h.activityLog.mock.calls).toEqual([[{ type: 'email-rejected', summary: 'Email rejected' }]]);
            expect(h.events).toEqual(['acquire:email-draft:42', 'acquired:email-draft:42', 'getMessage', 'metadata', 'flags', 'activity', 'release:email-draft:42']);
        });

        test('clears an approval marker whose row was never written', async () => {
            const h = approvedHarness(false);

            expect(await h.ops.rejectSend(UID, 'changed my mind')).toEqual({ status: 'rejected' });

            const written = h.updateMetadata.mock.calls[0][2];
            expect(written).toEqual({ approvalCard: LINK, rejectedAt: NOW, reason: 'changed my mind' });
            expect(Object.hasOwn(written, 'approval')).toBe(false);
        });

        test('refuses as decided when the approval\'s row exists, writing nothing', async () => {
            const h = approvedHarness(true);

            expect(await h.ops.rejectSend(UID, 'nope')).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.updateFlags).not.toHaveBeenCalled();
            expect(h.activityLog).not.toHaveBeenCalled();
        });

        test('refuses as unreadable when the row read throws', async () => {
            const h = approvedHarness(false);
            h.get.mockImplementation(async () => {
                throw new Error('dynamo read down');
            });

            expect(await h.ops.rejectSend(UID, 'nope')).toEqual({ status: 'refused', reason: 'unreadable', detail: 'Couldn\'t check the approval record (dynamo read down)' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('refuses as gone when the draft is missing, writing nothing', async () => {
            const h = makeHarness({}, null);

            expect(await h.ops.rejectSend(UID, 'nope')).toEqual({ status: 'refused', reason: 'gone', detail: 'The draft is no longer in Drafts' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('refuses as unreadable when the read times out after 10s', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => Promise.withResolvers<WildDuckMessage | null>().promise);

            const rejecting = h.ops.rejectSend(UID, 'nope');
            await drainMicrotasks();
            jest.advanceTimersByTime(FINGERPRINT_READ_TIMEOUT_MS);

            expect(await rejecting).toEqual({ status: 'refused', reason: 'unreadable', detail: 'Couldn\'t read the draft from WildDuck (no answer within 10s)' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('a retry after the flag write failed completes it and keeps the first rejectedAt', async () => {
            const h = makeHarness();
            h.updateFlags.mockImplementationOnce(async () => {
                throw new Error('flags down');
            });

            await expect(h.ops.rejectSend(UID, 'first')).rejects.toThrow('flags down');
            expect(h.events.at(-1)).toBe('release:email-draft:42');
            jest.setSystemTime(new Date('2026-09-23T12:05:00.000Z'));

            expect(await h.ops.rejectSend(UID, 'second')).toEqual({ status: 'rejected' });

            expect(h.store.draft?.metaData).toEqual({ approvalCard: LINK, keep: 'me', rejectedAt: NOW, reason: 'second' });
            expect(h.updateFlags).toHaveBeenCalledTimes(2);
            expect(h.activityLog).toHaveBeenCalledTimes(1);
        });

        test('a metadata write failure propagates, flags nothing, logs no activity and releases the key', async () => {
            const h = makeHarness();
            h.updateMetadata.mockImplementation(async () => {
                throw new Error('wildduck down');
            });

            await expect(h.ops.rejectSend(UID, 'nope')).rejects.toThrow('wildduck down');
            expect(h.updateFlags).not.toHaveBeenCalled();
            expect(h.activityLog).not.toHaveBeenCalled();
            expect(h.events.at(-1)).toBe('release:email-draft:42');
            expect(h.gate.pendingEdit('email-draft:42')).toBeUndefined();
        });

        test('a failed activity log warns and never rejects', async () => {
            const h = makeHarness();
            const failure = new Error('activity down');
            h.activityLog.mockImplementation(async () => {
                throw failure;
            });

            await h.ops.rejectSend(UID, 'nope');
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, msg: 'Activity log failed for email rejection' });
        });

        test('works without an activity logger', async () => {
            const h = makeHarness({ activityLogger: undefined });

            expect(await h.ops.rejectSend(UID, 'nope')).toEqual({ status: 'rejected' });
            expect(h.updateFlags).toHaveBeenCalledTimes(1);
        });
    });

    describe('interleavings on one draft key', () => {
        test('a card link waiting behind an approval keeps the approval marker', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me' }));
            const rowWrite = makeDeferred();
            h.create.mockImplementation(async (action: ApprovedOutboundAction) => {
                h.events.push('create');
                await rowWrite.promise;
                h.rows.set(action.id, action);
            });

            const approving = h.ops.approveSend(UID, 'direct', CARD);
            await drainMicrotasks();
            const linking = h.ops.linkCard(UID, LINK);
            await drainMicrotasks();
            expect(h.getMessage).toHaveBeenCalledTimes(1);

            rowWrite.resolve();
            expect(await approving).toEqual({ status: 'recorded' });
            expect(await linking).toBe(true);

            const actionId = h.create.mock.calls[0][0].id;
            expect(h.store.draft?.metaData).toEqual({ keep: 'me', approval: { actionId, at: NOW }, approvalCard: LINK });
        });

        test('a card link waiting behind a rejection keeps rejectedAt and the reason', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me' }));
            const flagWrite = makeDeferred();
            h.updateFlags.mockImplementation(async () => {
                await flagWrite.promise;
            });

            const rejecting = h.ops.rejectSend(UID, 'nope');
            await drainMicrotasks();
            const linking = h.ops.linkCard(UID, LINK);
            await drainMicrotasks();
            expect(h.getMessage).toHaveBeenCalledTimes(1);

            flagWrite.resolve();
            await rejecting;
            expect(await linking).toBe(true);

            expect(h.store.draft?.metaData).toEqual({ keep: 'me', rejectedAt: NOW, reason: 'nope', approvalCard: LINK });
        });

        test('an approval and a rejection from two cards for one uid: the first wins and the second is refused as decided', async () => {
            const h = makeHarness();

            const approving = h.ops.approveSend(UID, 'direct', CARD);
            const rejecting = h.ops.rejectSend(UID, 'nope');

            expect(await approving).toEqual({ status: 'recorded' });
            expect(await rejecting).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(h.updateFlags).not.toHaveBeenCalled();
            expect(h.create).toHaveBeenCalledTimes(1);
        });

        test('a rejection before an approval from another card leaves no row', async () => {
            const h = makeHarness();

            const rejecting = h.ops.rejectSend(UID, 'nope');
            const approving = h.ops.approveSend(UID, 'direct', OTHER_CARD);

            expect(await rejecting).toEqual({ status: 'rejected' });
            expect(await approving).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(h.create).not.toHaveBeenCalled();
        });

        test('two approvals from two cards for one uid create one row', async () => {
            const h = makeHarness();

            const first = h.ops.approveSend(UID, 'direct', CARD);
            const second = h.ops.approveSend(UID, 'allowlist', OTHER_CARD);

            expect(await first).toEqual({ status: 'recorded' });
            expect(await second).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(h.create).toHaveBeenCalledTimes(1);
            expect(h.create.mock.calls[0][0].approvalCard).toEqual(CARD);
        });
    });

    describe('linkCard', () => {
        test('reads the draft only after taking its key, merges the link into that read, and reports true', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me', approvalCard: { channelId: 'old', messageId: 'old', edits: 3 } }));

            expect(await h.ops.linkCard(UID, LINK)).toBe(true);

            expect(h.events).toEqual(['acquire:email-draft:42', 'acquired:email-draft:42', 'getMessage', 'metadata', 'release:email-draft:42']);
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { keep: 'me', approvalCard: LINK }]]);
            expect(h.getMessage.mock.calls[0]?.slice(0, 2)).toEqual(['Drafts', UID]);
            expect(h.getMessage.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
        });

        test.each([
            ['missing', null],
            ['not a draft', draftWith(undefined, { draft: false })],
        ])('writes nothing and reports false when the draft is %s', async (_label, draft) => {
            const h = makeHarness({}, draft);

            expect(await h.ops.linkCard(UID, LINK)).toBe(false);
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('a failed write is logged and reported as false', async () => {
            const h = makeHarness();
            const failure = new Error('wildduck down');
            h.updateMetadata.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.linkCard(UID, LINK)).toBe(false);
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: 'Could not link the draft to its approval card' });
            expect(h.events.at(-1)).toBe('release:email-draft:42');
        });

        test('a read with no answer in 10s is logged and reported as false', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => Promise.withResolvers<WildDuckMessage | null>().promise);

            const linking = h.ops.linkCard(UID, LINK);
            await drainMicrotasks();
            jest.advanceTimersByTime(FINGERPRINT_READ_TIMEOUT_MS);

            expect(await linking).toBe(false);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: expect.any(EmailProcessingError), uid: UID, msg: 'Could not link the draft to its approval card' });
            expectNoAnswerError(loggedErr(mockLogger.warn.mock.calls));
        });
    });

    describe('reconcileCardLink', () => {
        const NEW_LINK = { channelId: 'admin-ch', messageId: 'new-card', edits: 0 };
        const OLD_LINK = { channelId: 'admin-ch', messageId: 'old-card', edits: 2 };
        const NO_ANSWER_MSG = 'Could not read the draft to reconcile its approval card link';

        test('links a draft with no card under its key from a fresh read, keeping unrelated metadata and decision markers', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me', approval: { actionId: 'act-1', at: 'x' } }));

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK)).toEqual({ status: 'linked' });

            expect(h.events).toEqual(['acquire:email-draft:42', 'acquired:email-draft:42', 'getMessage', 'metadata', 'release:email-draft:42']);
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { keep: 'me', approval: { actionId: 'act-1', at: 'x' }, approvalCard: NEW_LINK }]]);
            expect(h.getMessage.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
        });

        test('treats a malformed stored card as no card', async () => {
            const h = makeHarness({}, draftWith({ approvalCard: { channelId: 'admin-ch' } }));

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK)).toEqual({ status: 'linked' });
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { approvalCard: NEW_LINK }]]);
        });

        test.each([
            ['the same edits', LINK],
            ['a different edit count', { ...LINK, edits: 5 }],
        ])('is idempotent without writing when the stored card is the same message and channel (%s)', async (_label, stored) => {
            const h = makeHarness({}, draftWith({ approvalCard: stored }));

            expect(await h.ops.reconcileCardLink(UID, LINK)).toEqual({ status: 'linked' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test.each([
            ['another message', { channelId: 'admin-ch', messageId: 'other' }],
            ['another channel', { channelId: 'other-ch', messageId: 'card-msg' }],
        ])('reports a conflict carrying the stored link, writing nothing, when it is %s and no replacement is named', async (_label, ids) => {
            const stored = { ...ids, edits: 4 };
            const h = makeHarness({}, draftWith({ approvalCard: stored }));

            expect(await h.ops.reconcileCardLink(UID, LINK)).toEqual({ status: 'conflict', existing: stored });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('replaces the stored card when it is the one named by `replace`, ignoring its edit count', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me', approvalCard: OLD_LINK }));

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK, { ...OLD_LINK, edits: 0 })).toEqual({ status: 'linked' });
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { keep: 'me', approvalCard: NEW_LINK }]]);
        });

        test('does not replace a stored card other than the one named, and reports it as the conflict', async () => {
            const stored = { channelId: 'admin-ch', messageId: 'third-card', edits: 1 };
            const h = makeHarness({}, draftWith({ approvalCard: stored }));

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK, OLD_LINK)).toEqual({ status: 'conflict', existing: stored });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('a replacement already in place is idempotent even when `replace` names another card', async () => {
            const h = makeHarness({}, draftWith({ approvalCard: { ...NEW_LINK, edits: 3 } }));

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK, OLD_LINK)).toEqual({ status: 'linked' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('links a draft with no stored card even when a replacement is named', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me' }));

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK, OLD_LINK)).toEqual({ status: 'linked' });
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { keep: 'me', approvalCard: NEW_LINK }]]);
        });

        test.each([
            ['missing', null],
            ['not a draft', draftWith(undefined, { draft: false })],
            ['superseded', draftWith({ approvalCard: LINK, supersededBy: 55 })],
        ])('is obsolete and writes nothing when the draft is %s', async (_label, draft) => {
            const h = makeHarness({}, draft);

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK)).toEqual({ status: 'obsolete' });
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.events.at(-1)).toBe('release:email-draft:42');
        });

        test('a read error is logged and reported unreadable', async () => {
            const h = makeHarness();
            const failure = new Error('wildduck down');
            h.getMessage.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK)).toEqual({ status: 'unreadable' });
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: NO_ANSWER_MSG });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('a read with no answer in 10s is logged and reported unreadable', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => Promise.withResolvers<WildDuckMessage | null>().promise);

            const reconciling = h.ops.reconcileCardLink(UID, NEW_LINK);
            await drainMicrotasks();
            jest.advanceTimersByTime(FINGERPRINT_READ_TIMEOUT_MS);

            expect(await reconciling).toEqual({ status: 'unreadable' });
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: UID, msg: `${NO_ANSWER_MSG}: no answer within 10s` });
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('a failed write is logged and reported unreadable, releasing the key', async () => {
            const h = makeHarness({}, draftWith({}));
            const failure = new Error('wildduck down');
            h.updateMetadata.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.reconcileCardLink(UID, NEW_LINK)).toEqual({ status: 'unreadable' });
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: 'Could not reconcile the draft\'s approval card link' });
            expect(h.events.at(-1)).toBe('release:email-draft:42');
        });

        test('waits for a decision holding the draft key, then merges into the read taken after it', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me' }));
            const release = await h.gate.acquire('email-draft:42');

            const reconciling = h.ops.reconcileCardLink(UID, NEW_LINK);
            await drainMicrotasks();
            expect(h.getMessage).not.toHaveBeenCalled();
            h.store.draft = draftWith({ keep: 'me', rejectedAt: 'later' });
            release();

            expect(await reconciling).toEqual({ status: 'linked' });
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { keep: 'me', rejectedAt: 'later', approvalCard: NEW_LINK }]]);
        });

        test('waits at most 30s for the draft key', () => {
            expect(CARD_LINK_LOCK_WAIT_MS).toBe(30_000);
        });

        test.each([
            ['no replacement', undefined],
            ['a named replacement', OLD_LINK],
        ])('gives up on a draft key held for 30s with %s: logged with the uid, unreadable, nothing read', async (_label, replace) => {
            const h = makeHarness();
            const holder = await h.gate.acquire('email-draft:42');

            const reconciling = h.ops.reconcileCardLink(UID, NEW_LINK, replace);
            await drainMicrotasks();
            jest.advanceTimersByTime(29_999);
            await drainMicrotasks();
            expect(Bun.peek.status(reconciling)).toBe('pending');
            jest.advanceTimersByTime(1);

            expect(await reconciling).toEqual({ status: 'unreadable' });
            expect(mockLogger.warn.mock.calls).toEqual([[{ uid: UID, msg: 'Could not reconcile the draft\'s approval card link: its key stayed held for 30s' }]]);
            expect(h.getMessage).not.toHaveBeenCalled();
            expect(h.updateMetadata).not.toHaveBeenCalled();
            holder();
        });

        test('an abandoned wait releases the draft key as soon as it is granted, so the key is never leaked', async () => {
            const h = makeHarness();
            const holder = await h.gate.acquire('email-draft:42');
            const reconciling = h.ops.reconcileCardLink(UID, NEW_LINK);
            await drainMicrotasks();
            jest.advanceTimersByTime(30_000);
            expect(await reconciling).toEqual({ status: 'unreadable' });

            holder();
            await drainMicrotasks();
            expect(h.events).toEqual(['acquire:email-draft:42', 'acquired:email-draft:42', 'release:email-draft:42']);
            const third = h.gate.acquire('email-draft:42');
            await drainMicrotasks();
            expect(Bun.peek.status(third)).toBe('fulfilled');
            expect(h.getMessage).not.toHaveBeenCalled();
        });

        test('links normally when the draft key is released just inside 30s', async () => {
            const h = makeHarness({}, draftWith({ keep: 'me' }));
            const holder = await h.gate.acquire('email-draft:42');
            const reconciling = h.ops.reconcileCardLink(UID, NEW_LINK);
            await drainMicrotasks();
            jest.advanceTimersByTime(29_999);
            holder();

            expect(await reconciling).toEqual({ status: 'linked' });
            jest.advanceTimersByTime(1);
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { keep: 'me', approvalCard: NEW_LINK }]]);
            expect(h.events.at(-1)).toBe('release:email-draft:42');
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    describe('readCardTarget', () => {
        test('reports an active draft with its stored card, reading without taking the draft key', async () => {
            const h = makeHarness({}, draftWith({ approvalCard: { ...LINK, edits: 3 } }));

            expect(await h.ops.readCardTarget(UID)).toEqual({ status: 'active', card: { ...LINK, edits: 3 } });
            expect(h.events).toEqual(['getMessage']);
            expect(h.acquire).not.toHaveBeenCalled();
            expect(h.getMessage.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('reads while another holder has the draft key', async () => {
            const h = makeHarness();
            const release = await h.gate.acquire('email-draft:42');
            try {
                expect(await h.ops.readCardTarget(UID)).toEqual({ status: 'active', card: LINK });
            } finally {
                release();
            }
        });

        test.each([
            ['no card', draftWith({ keep: 'me' })],
            ['a malformed card', draftWith({ approvalCard: { channelId: 'x' } })],
        ])('reports an active draft with no card key for %s', async (_label, draft) => {
            const h = makeHarness({}, draft);

            expect(await h.ops.readCardTarget(UID)).toStrictEqual({ status: 'active' });
        });

        test.each([
            ['an approval marker', { approvalCard: LINK, approval: { actionId: 'act-1', at: 'x' } }],
            ['a rejection', { approvalCard: LINK, rejectedAt: 'x', reason: 'no' }],
        ])('a decision marker alone keeps the draft active (%s)', async (_label, metaData) => {
            const h = makeHarness({}, draftWith(metaData));

            expect(await h.ops.readCardTarget(UID)).toEqual({ status: 'active', card: LINK });
        });

        test.each([
            ['missing', null, { status: 'obsolete' }],
            ['not a draft', draftWith(undefined, { draft: false }), { status: 'obsolete', card: LINK }],
            ['superseded', draftWith({ approvalCard: LINK, supersededBy: 55 }), { status: 'obsolete', card: LINK }],
        ] as const)('reports obsolete when the draft is %s, keeping any stored link as delivery evidence', async (_label, draft, expected) => {
            const h = makeHarness({}, draft);

            expect(await h.ops.readCardTarget(UID)).toEqual(expected);
        });

        test('a read error is logged and reported unreadable', async () => {
            const h = makeHarness();
            const failure = new Error('wildduck down');
            h.getMessage.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.readCardTarget(UID)).toEqual({ status: 'unreadable' });
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: 'Could not read the draft to find its approval card' });
        });

        test('a read with no answer in 10s is logged and reported unreadable', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => Promise.withResolvers<WildDuckMessage | null>().promise);

            const reading = h.ops.readCardTarget(UID);
            await drainMicrotasks();
            jest.advanceTimersByTime(FINGERPRINT_READ_TIMEOUT_MS);

            expect(await reading).toEqual({ status: 'unreadable' });
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: UID, msg: 'Could not read the draft to find its approval card: no answer within 10s' });
        });
    });

    describe('markSupersededLocked', () => {
        test('merges supersededBy into a fresh read of the old uid, keeping a decision marker, without taking its key', async () => {
            const h = makeHarness({}, draftWith({ approval: { actionId: 'act-1', at: 'x' } }));

            expect(await h.ops.markSupersededLocked(UID, 55)).toBe(true);

            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { approval: { actionId: 'act-1', at: 'x' }, supersededBy: 55 }]]);
            expect(h.events).toEqual(['getMessage', 'metadata']);
            expect(h.acquire).not.toHaveBeenCalled();
        });

        test('completes while the caller holds the old uid\'s key on the gate, which is not re-entrant', async () => {
            const h = makeHarness();
            const release = await h.gate.acquire('email-draft:42');
            try {
                expect(await h.ops.markSupersededLocked(UID, 55)).toBe(true);
                expect(h.store.draft?.metaData).toEqual({ approvalCard: LINK, keep: 'me', supersededBy: 55 });
            } finally {
                release();
            }
        });

        test('reports true without writing when the old uid is already gone', async () => {
            const h = makeHarness({}, null);

            expect(await h.ops.markSupersededLocked(UID, 55)).toBe(true);
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('a failed write is logged at error and reported as false', async () => {
            const h = makeHarness();
            const failure = new Error('wildduck down');
            h.updateMetadata.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.markSupersededLocked(UID, 55)).toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith({ err: failure, oldUid: UID, newUid: 55, msg: 'Could not mark the replaced draft as superseded' });
        });

        test('a read with no answer in 10s is reported as false', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => Promise.withResolvers<WildDuckMessage | null>().promise);

            const marking = h.ops.markSupersededLocked(UID, 55);
            await drainMicrotasks();
            jest.advanceTimersByTime(FINGERPRINT_READ_TIMEOUT_MS);

            expect(await marking).toBe(false);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(mockLogger.error).toHaveBeenCalledWith({ err: expect.any(EmailProcessingError), oldUid: UID, newUid: 55, msg: 'Could not mark the replaced draft as superseded' });
            expectNoAnswerError(loggedErr(mockLogger.error.mock.calls));
        });
    });

    describe('allowlistCandidates', () => {
        test('returns the de-duplicated to + cc addresses, dropping empty ones, read under the draft key', async () => {
            const h = makeHarness();

            expect(await h.ops.allowlistCandidates(UID)).toEqual({ status: 'ok', recipients: ['a@example.com', 'b@example.com'] });
            expect(h.events).toEqual(['acquire:email-draft:42', 'acquired:email-draft:42', 'getMessage', 'release:email-draft:42']);
            expect(h.updateMetadata).not.toHaveBeenCalled();
        });

        test('returns an empty list when the draft has no recipients', async () => {
            const h = makeHarness({}, draftWith(undefined, { to: undefined, cc: undefined }));

            expect(await h.ops.allowlistCandidates(UID)).toEqual({ status: 'ok', recipients: [] });
        });

        test('offers the recipients of an approval whose row is missing, so it can be resumed', async () => {
            const h = approvedHarness(false);

            expect(await h.ops.allowlistCandidates(UID)).toEqual({ status: 'ok', recipients: ['a@example.com', 'b@example.com'] });
        });

        test('refuses as decided when the draft is approved or rejected', async () => {
            expect(await approvedHarness(true).ops.allowlistCandidates(UID)).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
            expect(await makeHarness({}, draftWith({ rejectedAt: 'x' })).ops.allowlistCandidates(UID)).toEqual({ status: 'refused', reason: 'decided', detail: 'The draft was already approved or rejected' });
        });

        test('refuses as gone or unreadable as a decision read does', async () => {
            expect(await makeHarness({}, null).ops.allowlistCandidates(UID)).toEqual({ status: 'refused', reason: 'gone', detail: 'The draft is no longer in Drafts' });
            const h = approvedHarness(false);
            h.get.mockImplementation(async () => {
                throw new Error('dynamo read down');
            });
            expect(await h.ops.allowlistCandidates(UID)).toEqual({ status: 'refused', reason: 'unreadable', detail: 'Couldn\'t check the approval record (dynamo read down)' });
        });
    });

    describe('announceApproved', () => {
        test('notes the approval for Izzy without waking, promising the real outcome later', () => {
            const h = makeHarness();

            h.ops.announceApproved(UID);

            expect(h.notify.mock.calls).toEqual([[{
                source: 'email-approval',
                wake:   false,
                key:    '42:approved',
                text:   'Outbound email (uid 42) approved by admin; sending now. You will be notified when it has been sent or has failed.',
            }]]);
        });

        test('a throwing notify warns and never throws', () => {
            const h = makeHarness();
            const failure = new Error('bridge down');
            h.notify.mockImplementation(() => {
                throw failure;
            });

            expect(() => h.ops.announceApproved(UID)).not.toThrow();
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: 'Notify failed for email approval' });
        });
    });

    describe('announceRejected', () => {
        test('wakes the conductor with the rejection key, text and reason', () => {
            const h = makeHarness();

            h.ops.announceRejected(UID, 'Too blunt');

            expect(h.notify.mock.calls).toEqual([[{
                source: 'email-approval',
                wake:   true,
                key:    '42:rejected',
                text:   'Outbound email (uid 42) rejected by admin. Reason: Too blunt',
            }]]);
        });

        test('a throwing notify warns and never throws', () => {
            const h = makeHarness();
            const failure = new Error('bridge down');
            h.notify.mockImplementation(() => {
                throw failure;
            });

            expect(() => h.ops.announceRejected(UID, 'nope')).not.toThrow();
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: UID, msg: 'Notify failed for email rejection' });
        });
    });

    describe('the HTML part marker', () => {
        const MARKED = { approvalCard: LINK, previewToken: 'tok', htmlSha256: 'a'.repeat(64) };

        test.each([
            ['linking the card', async (h: Harness) => h.ops.linkCard(UID, { ...LINK, edits: 2 })],
            ['approving', async (h: Harness) => h.ops.approveSend(UID, 'direct', CARD)],
            ['rejecting', async (h: Harness) => h.ops.rejectSend(UID, 'nope')],
        ])('survives %s, so the draft keeps its HTML part', async (_label, write) => {
            const h = makeHarness({}, draftWith(MARKED));
            await write(h);

            expect(h.updateMetadata.mock.calls[0]?.[2]).toMatchObject({ previewToken: 'tok', htmlSha256: 'a'.repeat(64) });
        });
    });
});

describe('emailSendParamsSchema', () => {
    test('parses a uid alone (rows approved before #108) and a uid with its fingerprint', () => {
        expect(emailSendParamsSchema.parse({ uid: 7 })).toEqual({ uid: 7 });
        const withFingerprint = { uid: 7, messageId: '<a@b>', draftDate: '2026-09-23T11:59:00.000Z' };
        expect(emailSendParamsSchema.parse(withFingerprint)).toEqual(withFingerprint);
    });

    test('rejects a missing or fractional uid', () => {
        expect(emailSendParamsSchema.safeParse({ messageId: '<a@b>' }).success).toBe(false);
        expect(emailSendParamsSchema.safeParse({ uid: 7.5 }).success).toBe(false);
    });

    test('rejects a non-string fingerprint field', () => {
        expect(emailSendParamsSchema.safeParse({ uid: 7, messageId: 1 }).success).toBe(false);
        expect(emailSendParamsSchema.safeParse({ uid: 7, draftDate: 1 }).success).toBe(false);
    });
});
