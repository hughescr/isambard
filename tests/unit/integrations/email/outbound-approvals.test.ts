import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { NotifyParams } from '@/agent';
import { EmailOutboundApprovals, FINGERPRINT_READ_TIMEOUT_MS, emailSendParamsSchema, type EmailOutboundApprovalsDeps } from '@/integrations/email/outbound-approvals';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import type { ApprovedOutboundAction } from '@/services';

const UID = 42;
const NOW = '2026-09-23T12:00:00.000Z';
const CARD = { channelId: 'admin-ch', messageId: 'card-msg' };

interface Harness {
    ops:            EmailOutboundApprovals
    create:         ReturnType<typeof mock<(action: ApprovedOutboundAction) => Promise<void>>>
    getMessage:     ReturnType<typeof mock<(folder: string, uid: number, signal?: AbortSignal) => Promise<unknown>>>
    updateMetadata: ReturnType<typeof mock<(folder: string, uid: number, metadata: Record<string, unknown>) => Promise<void>>>
    updateFlags:    ReturnType<typeof mock<(folder: string, uid: number, options: { addFlags?: string[] }) => Promise<void>>>
    activityLog:    ReturnType<typeof mock<(entry: { type: string, summary: string }) => Promise<void>>>
    notify:         ReturnType<typeof mock<(params: NotifyParams) => boolean>>
    events:         string[]
}

function makeHarness(overrides: Partial<EmailOutboundApprovalsDeps> = {}): Harness {
    const events: string[] = [];
    const create = mock(async (_action: ApprovedOutboundAction): Promise<void> => {
        events.push('create');
    });
    const getMessage = mock(async (_folder: string, _uid: number, _signal?: AbortSignal): Promise<unknown> => ({
        to: [{ address: 'a@example.com' }, { address: '' }],
        cc: [{ address: 'b@example.com' }, { address: 'a@example.com' }],
    }));
    const updateMetadata = mock(async (_folder: string, _uid: number, _metadata: Record<string, unknown>): Promise<void> => {
        events.push('metadata');
    });
    const updateFlags = mock(async (_folder: string, _uid: number, _options: { addFlags?: string[] }): Promise<void> => {
        events.push('flags');
    });
    const activityLog = mock(async (_entry: { type: string, summary: string }): Promise<void> => {
        events.push('activity');
    });
    const notify = mock((_params: NotifyParams): boolean => true);
    const wildDuckClient = {
        getMessage,
        updateMessageMetadata: updateMetadata,
        updateMessageFlags:    updateFlags,
    } as unknown as WildDuckClient;
    const ops = new EmailOutboundApprovals({
        wildDuckClient,
        actionWriter:   { create },
        activityLogger: { log: activityLog },
        notify,
        ...overrides,
    });
    return { ops, create, getMessage, updateMetadata, updateFlags, activityLog, notify, events };
}

describe('EmailOutboundApprovals', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('approveSend', () => {
        test('writes an approved email_send action for the uid with its approval card', async () => {
            const h = makeHarness();

            await h.ops.approveSend(UID, 'direct', CARD);

            expect(h.create).toHaveBeenCalledTimes(1);
            const action = h.create.mock.calls[0][0];
            expect(action).toEqual({
                id:           expect.any(String),
                state:        'approved',
                type:         'email_send',
                params:       { uid: UID },
                approvalCard: { channelId: 'admin-ch', messageId: 'card-msg' },
                createdAt:    NOW,
                updatedAt:    NOW,
            });
            expect(action.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
        });

        test('first reads the draft from Drafts, cancellably, and stores its Message-ID and Date as the send\'s fingerprint', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => ({ id: UID, messageId: '<draft@example.com>', date: '2026-09-23T11:59:00.000Z', draft: true }));

            await h.ops.approveSend(UID, 'direct', CARD);

            expect(h.getMessage).toHaveBeenCalledTimes(1);
            expect(h.getMessage.mock.calls[0]?.slice(0, 2)).toEqual(['Drafts', UID]);
            expect(h.getMessage.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
            expect(h.create.mock.calls[0]?.[0].params).toEqual({ uid: UID, messageId: '<draft@example.com>', draftDate: '2026-09-23T11:59:00.000Z' });
            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(h.getMessage.mock.invocationCallOrder[0]).toBeLessThan(h.create.mock.invocationCallOrder[0]);
        });

        test.each([
            ['the draft is not found', null],
            ['the draft has no Message-ID', { id: UID, date: '2026-09-23T11:59:00.000Z' }],
            ['the draft has no Date', { id: UID, messageId: '<draft@example.com>', date: null }],
        ])('records the uid alone, with a warning, when %s', async (_label, draft) => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => draft);

            await h.ops.approveSend(UID, 'direct', CARD);

            expect(h.create.mock.calls[0]?.[0].params).toEqual({ uid: UID });
            expect(mockLogger.warn).toHaveBeenCalledWith({
                uid:     UID,
                problem: 'the draft was not found, or has no Message-ID or Date',
                msg:     'Could not read the draft’s Message-ID and Date at approval; recording the send without them',
            });
        });

        test('records the uid alone, with the error, when the draft read fails', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => {
                throw new Error('WildDuck API error: 503');
            });

            await h.ops.approveSend(UID, 'direct', CARD);

            expect(h.create.mock.calls[0]?.[0].params).toEqual({ uid: UID });
            expect(mockLogger.warn).toHaveBeenCalledWith({
                uid:     UID,
                problem: 'WildDuck API error: 503',
                msg:     'Could not read the draft’s Message-ID and Date at approval; recording the send without them',
            });
        });

        test('records the uid alone when the draft read rejects with a non-Error', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => {
                throw 'offline';
            });

            await h.ops.approveSend(UID, 'direct', CARD);

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ problem: 'offline' }));
        });

        test('a draft read with no answer is cancelled after 10s and the action is still created', async () => {
            const h = makeHarness();
            let signal: AbortSignal | undefined;
            h.getMessage.mockImplementation(async (_folder: string, _uid: number, readSignal?: AbortSignal) => {
                signal = readSignal;
                return Promise.withResolvers<unknown>().promise;
            });

            const approving = h.ops.approveSend(UID, 'direct', CARD);
            await Promise.resolve();
            jest.advanceTimersByTime(FINGERPRINT_READ_TIMEOUT_MS - 1);
            await Promise.resolve();
            expect(h.create).not.toHaveBeenCalled();
            expect(signal?.aborted).toBe(false);

            jest.advanceTimersByTime(1);
            await approving;

            expect(signal?.aborted).toBe(true);
            expect(h.create.mock.calls[0]?.[0].params).toEqual({ uid: UID });
            expect(mockLogger.warn).toHaveBeenCalledWith({
                uid:     UID,
                problem: 'no answer within 10s',
                msg:     'Could not read the draft’s Message-ID and Date at approval; recording the send without them',
            });
            expect(FINGERPRINT_READ_TIMEOUT_MS).toBe(10_000);
        });

        test.each(['direct', 'allowlist'] as const)('logs one email-send-approved activity after the %s write and never email-sent', async (via) => {
            const h = makeHarness();

            await h.ops.approveSend(UID, via, CARD);

            expect(h.activityLog.mock.calls).toEqual([[{ type: 'email-send-approved', summary: 'Email approved for sending' }]]);
            expect(h.activityLog).not.toHaveBeenCalledWith({ type: 'email-sent', summary: expect.any(String) });
            expect(h.events).toEqual(['create', 'activity']);
        });

        test('a failed activity log on the direct route warns and never rejects', async () => {
            const h = makeHarness();
            const failure = new Error('activity down');
            h.activityLog.mockImplementation(async () => {
                throw failure;
            });

            await h.ops.approveSend(UID, 'direct', CARD);
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, msg: 'Activity log failed for email send (direct path)' });
        });

        test('a failed activity log on the allowlist route names the allowlist path', async () => {
            const h = makeHarness();
            const failure = new Error('activity down');
            h.activityLog.mockImplementation(async () => {
                throw failure;
            });

            await h.ops.approveSend(UID, 'allowlist', CARD);
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, msg: 'Activity log failed for email send (allowlist path)' });
        });

        test('works without an activity logger', async () => {
            const h = makeHarness({ activityLogger: undefined });

            await h.ops.approveSend(UID, 'direct', CARD);

            expect(h.create).toHaveBeenCalledTimes(1);
        });

        test('a failed write propagates and logs no activity', async () => {
            const h = makeHarness();
            h.create.mockImplementation(async () => {
                throw new Error('dynamo down');
            });

            await expect(h.ops.approveSend(UID, 'direct', CARD)).rejects.toThrow('dynamo down');
            expect(h.activityLog).not.toHaveBeenCalled();
        });
    });

    describe('rejectSend', () => {
        test('records the rejection metadata, then the draft review state, then the activity', async () => {
            const h = makeHarness();

            await h.ops.rejectSend(UID, 'Too blunt');

            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', UID, { rejectedAt: NOW, reason: 'Too blunt' }]]);
            expect(h.updateFlags.mock.calls).toEqual([['Drafts', UID, { addFlags: ['SendRejectedByAdmin'] }]]);
            expect(h.activityLog.mock.calls).toEqual([[{ type: 'email-rejected', summary: 'Email rejected' }]]);
            expect(h.events).toEqual(['metadata', 'flags', 'activity']);
        });

        test('a WildDuck failure propagates and logs no activity', async () => {
            const h = makeHarness();
            h.updateMetadata.mockImplementation(async () => {
                throw new Error('wildduck down');
            });

            await expect(h.ops.rejectSend(UID, 'nope')).rejects.toThrow('wildduck down');
            expect(h.updateFlags).not.toHaveBeenCalled();
            expect(h.activityLog).not.toHaveBeenCalled();
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

            await h.ops.rejectSend(UID, 'nope');

            expect(h.updateFlags).toHaveBeenCalledTimes(1);
        });
    });

    describe('draftRecipients', () => {
        test('returns the de-duplicated to + cc addresses, dropping empty ones', async () => {
            const h = makeHarness();

            expect(await h.ops.draftRecipients(UID)).toEqual(['a@example.com', 'b@example.com']);
            expect(h.getMessage.mock.calls).toEqual([['Drafts', UID]]);
        });

        test('returns an empty list when the draft has no recipients', async () => {
            const h = makeHarness();
            h.getMessage.mockImplementation(async () => null);

            expect(await h.ops.draftRecipients(UID)).toEqual([]);
        });

        test('returns undefined and warns when the draft cannot be fetched', async () => {
            const h = makeHarness();
            const failure = new Error('fetch failed');
            h.getMessage.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.ops.draftRecipients(UID)).toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: failure,
                uid: UID,
                msg: 'Failed to fetch draft message before allowlist select — falling back to simple approve',
            });
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
