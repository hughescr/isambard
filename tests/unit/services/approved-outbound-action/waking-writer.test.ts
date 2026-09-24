import { describe, test, expect, mock } from 'bun:test';
import type { ApprovedOutboundAction } from '@/services/approved-outbound-action/types';
import { createWakingActionWriter } from '@/services/approved-outbound-action/waking-writer';

const ACTION: ApprovedOutboundAction = {
    id:           'aaaaaaaa-1111-4222-8333-444444444444',
    state:        'approved',
    type:         'email_send',
    params:       { uid: 42 },
    approvalCard: { channelId: 'ch-1', messageId: 'msg-1' },
    createdAt:    '2026-09-24T12:00:00.000Z',
    updatedAt:    '2026-09-24T12:00:00.000Z',
};

describe('createWakingActionWriter', () => {
    test('wakes once after the underlying create resolves', async () => {
        const created = Promise.withResolvers<undefined>();
        const create = mock(() => created.promise);
        const wake = mock((): void => undefined);

        const pending = createWakingActionWriter({ create }, wake).create(ACTION);
        await Promise.resolve();
        expect(wake).not.toHaveBeenCalled();

        created.resolve(undefined);
        await pending;
        expect(wake).toHaveBeenCalledTimes(1);
    });

    test('propagates a create rejection without waking', async () => {
        const create = mock(async (): Promise<void> => {
            throw new Error('put failed');
        });
        const wake = mock((): void => undefined);

        await expect(createWakingActionWriter({ create }, wake).create(ACTION)).rejects.toThrow('put failed');
        expect(wake).not.toHaveBeenCalled();
    });

    test('passes the action through unchanged', async () => {
        const create = mock(async (_action: ApprovedOutboundAction): Promise<void> => undefined);

        await createWakingActionWriter({ create }, () => undefined).create(ACTION);

        expect(create.mock.calls).toEqual([[ACTION]]);
    });
});
