import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { NotifyParams } from '@/agent';
import { EmailOutboundApprovals, type EmailOutboundApprovalsDeps } from '@/integrations/email/outbound-approvals';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import type { ApprovedOutboundAction } from '@/services';

const UID = 42;
const NOW = '2026-09-23T12:00:00.000Z';
const CARD = { channelId: 'admin-ch', messageId: 'card-msg' };

interface Harness {
    ops:            EmailOutboundApprovals
    create:         ReturnType<typeof mock<(action: ApprovedOutboundAction) => Promise<void>>>
    getMessage:     ReturnType<typeof mock<(folder: string, uid: number) => Promise<unknown>>>
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
    const getMessage = mock(async (_folder: string, _uid: number): Promise<unknown> => ({
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

        test('logs the email-sent activity after the write', async () => {
            const h = makeHarness();

            await h.ops.approveSend(UID, 'direct', CARD);

            expect(h.activityLog.mock.calls).toEqual([[{ type: 'email-sent', summary: 'Email approved for sending' }]]);
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
