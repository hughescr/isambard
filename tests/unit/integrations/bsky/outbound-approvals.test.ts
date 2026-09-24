import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { NotifyParams } from '@/agent';
import { BskyOutboundApprovals, type BskyOutboundApprovalsDeps } from '@/integrations/bsky/outbound-approvals';
import type { BskyRejectionItem } from '@/integrations/bsky/rejection-backend';
import { createAtUri, createCid } from '@/integrations/bsky/types';
import type { ApprovedOutboundAction } from '@/services';

const NOW  = '2026-09-23T12:00:00.000Z';
const CARD = { channelId: 'admin-ch', messageId: 'card-msg' };
const UUID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';

const REPLY_REJECTION: BskyRejectionItem = {
    type:         'reply',
    uuid:         UUID,
    text:         'Hello!',
    targetHandle: 'someone.bsky.social',
    reply:        { parent: { uri: createAtUri('at://did:plc:x/app.bsky.feed.post/p'), cid: createCid('bafyp') }, root: undefined },
    reason:       'Off topic',
    rejectedAt:   NOW,
};

const DM_REJECTION: BskyRejectionItem = {
    type:             'dm',
    uuid:             UUID,
    text:             'Hey',
    recipientHandles: ['alice.bsky.social'],
    convoId:          'convo-1',
    reason:           'Too pushy',
    rejectedAt:       NOW,
};

interface Harness {
    ops:             BskyOutboundApprovals
    create:          ReturnType<typeof mock<(action: ApprovedOutboundAction) => Promise<void>>>
    recordRejection: ReturnType<typeof mock<(item: BskyRejectionItem) => Promise<void>>>
    activityLog:     ReturnType<typeof mock<(entry: { type: string, summary: string }) => Promise<void>>>
    notify:          ReturnType<typeof mock<(params: NotifyParams) => boolean>>
    events:          string[]
}

function makeHarness(overrides: Partial<BskyOutboundApprovalsDeps> = {}): Harness {
    const events: string[] = [];
    const create = mock(async (_action: ApprovedOutboundAction): Promise<void> => {
        events.push('create');
    });
    const recordRejection = mock(async (_item: BskyRejectionItem): Promise<void> => {
        events.push('record');
    });
    const activityLog = mock(async (_entry: { type: string, summary: string }): Promise<void> => {
        events.push('activity');
    });
    const notify = mock((_params: NotifyParams): boolean => {
        events.push('notify');
        return true;
    });
    const ops = new BskyOutboundApprovals({
        rejectionBackend: { recordRejection },
        actionWriter:     { create },
        activityLogger:   { log: activityLog },
        notify,
        ...overrides,
    });
    return { ops, create, recordRejection, activityLog, notify, events };
}

describe('BskyOutboundApprovals', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('approveReply', () => {
        test('writes an approved bsky_reply action with the flat reply params', async () => {
            const h = makeHarness();

            await h.ops.approveReply({ text: 'Hi', parentUri: 'at://p', parentCid: 'bafyp', rootUri: 'at://r', rootCid: 'bafyr' }, CARD);

            const action = h.create.mock.calls[0][0];
            expect(action).toEqual({
                id:           expect.any(String),
                state:        'approved',
                type:         'bsky_reply',
                params:       { text: 'Hi', parentUri: 'at://p', parentCid: 'bafyp', rootUri: 'at://r', rootCid: 'bafyr' },
                approvalCard: { channelId: 'admin-ch', messageId: 'card-msg' },
                createdAt:    NOW,
                updatedAt:    NOW,
            });
            expect(action.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
            expect(h.activityLog.mock.calls).toEqual([[{ type: 'bsky-post-sent', summary: 'Bluesky reply approved for posting' }]]);
            expect(h.events).toEqual(['create', 'activity']);
        });

        test('keeps absent root fields as undefined keys in the params', async () => {
            const h = makeHarness();

            await h.ops.approveReply({ text: 'Hi', parentUri: 'at://p', parentCid: 'bafyp' }, CARD);

            const params = h.create.mock.calls[0][0].params;
            expect(Object.keys(params)).toEqual(['text', 'parentUri', 'parentCid', 'rootUri', 'rootCid']);
            expect(params.rootUri).toBeUndefined();
        });

        test('a failed activity log warns and never rejects', async () => {
            const h = makeHarness();
            const failure = new Error('activity down');
            h.activityLog.mockImplementation(async () => {
                throw failure;
            });

            await h.ops.approveReply({ text: 'Hi', parentUri: 'at://p', parentCid: 'bafyp' }, CARD);
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, msg: 'Activity log failed for Bluesky post approval' });
        });

        test('a failed write propagates and logs no activity', async () => {
            const h = makeHarness();
            h.create.mockImplementation(async () => {
                throw new Error('dynamo down');
            });

            await expect(h.ops.approveReply({ text: 'Hi', parentUri: 'at://p', parentCid: 'bafyp' }, CARD)).rejects.toThrow('dynamo down');
            expect(h.activityLog).not.toHaveBeenCalled();
        });
    });

    describe('approveDm', () => {
        test('writes an approved bsky_dm action with text and convoId', async () => {
            const h = makeHarness();

            await h.ops.approveDm({ text: 'Hey', convoId: 'convo-1' }, CARD);

            expect(h.create.mock.calls[0][0]).toEqual({
                id:           expect.any(String),
                state:        'approved',
                type:         'bsky_dm',
                params:       { text: 'Hey', convoId: 'convo-1' },
                approvalCard: { channelId: 'admin-ch', messageId: 'card-msg' },
                createdAt:    NOW,
                updatedAt:    NOW,
            });
            expect(h.activityLog.mock.calls).toEqual([[{ type: 'bsky-dm-sent', summary: 'Bluesky DM approved for sending' }]]);
        });

        test('a failed activity log warns and never rejects', async () => {
            const h = makeHarness();
            const failure = new Error('activity down');
            h.activityLog.mockImplementation(async () => {
                throw failure;
            });

            await h.ops.approveDm({ text: 'Hey', convoId: 'convo-1' }, CARD);
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, msg: 'Activity log failed for Bluesky DM approval' });
        });

        test('works without an activity logger', async () => {
            const h = makeHarness({ activityLogger: undefined });

            await h.ops.approveDm({ text: 'Hey', convoId: 'convo-1' }, CARD);

            expect(h.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('reject', () => {
        test('records a reply rejection, then notifies keyed on its uuid, then logs the activity', async () => {
            const h = makeHarness();

            await h.ops.reject(REPLY_REJECTION);

            expect(h.recordRejection.mock.calls).toEqual([[REPLY_REJECTION]]);
            expect(h.notify.mock.calls).toEqual([[{
                source: 'bsky-approval',
                text:   'Bluesky reply rejected: Off topic',
                wake:   true,
                key:    `${UUID}:rejected`,
            }]]);
            expect(h.activityLog.mock.calls).toEqual([[{ type: 'bsky-post-rejected', summary: 'Bluesky post/DM rejected' }]]);
            expect(h.events).toEqual(['record', 'notify', 'activity']);
        });

        test('a DM rejection notifies and logs the DM activity type', async () => {
            const h = makeHarness();

            await h.ops.reject(DM_REJECTION);

            expect(h.notify.mock.calls[0][0].text).toBe('Bluesky dm rejected: Too pushy');
            expect(h.activityLog.mock.calls).toEqual([[{ type: 'bsky-dm-rejected', summary: 'Bluesky post/DM rejected' }]]);
        });

        test('a failed recordRejection propagates with no notify and no activity', async () => {
            const h = makeHarness();
            h.recordRejection.mockImplementation(async () => {
                throw new Error('dynamo down');
            });

            await expect(h.ops.reject(REPLY_REJECTION)).rejects.toThrow('dynamo down');
            expect(h.notify).not.toHaveBeenCalled();
            expect(h.activityLog).not.toHaveBeenCalled();
        });

        test('works without notify', async () => {
            const h = makeHarness({ notify: undefined });

            await h.ops.reject(REPLY_REJECTION);

            expect(h.events).toEqual(['record', 'activity']);
        });

        test('a failed activity log warns with the rejection type and never rejects', async () => {
            const h = makeHarness();
            const failure = new Error('activity down');
            h.activityLog.mockImplementation(async () => {
                throw failure;
            });

            await h.ops.reject(DM_REJECTION);
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, type: 'dm', msg: 'Activity log failed for Bluesky rejection' });
        });
    });
});
