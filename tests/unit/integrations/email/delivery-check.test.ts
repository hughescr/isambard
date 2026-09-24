import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { ZodError } from 'zod';
import { checkEmailSendDelivery } from '@/integrations/email/delivery-check';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';

type Client = Pick<WildDuckClient, 'getMessage' | 'findMessageByMessageId'>;

const UID = 42;
const MESSAGE_ID = '<draft-42@example.com>';
const DRAFT_DATE = '2026-09-24T09:59:00.000Z';
const PARAMS = { uid: UID, messageId: MESSAGE_ID, draftDate: DRAFT_DATE };
const SINCE = new Date('2026-09-24T10:00:00.000Z');
const UNTIL = new Date('2026-09-24T10:02:00.000Z');

describe('checkEmailSendDelivery', () => {
    const signal = new AbortController().signal;
    let findMessageByMessageId: ReturnType<typeof mock<Client['findMessageByMessageId']>>;
    let getMessage: ReturnType<typeof mock<Client['getMessage']>>;

    async function check(params: Record<string, unknown> = PARAMS): Promise<unknown> {
        return checkEmailSendDelivery({ findMessageByMessageId, getMessage }, { params, since: SINCE, until: UNTIL, signal });
    }

    beforeEach(() => {
        findMessageByMessageId = mock(async () => false);
        getMessage = mock(async () => ({ id: UID, messageId: MESSAGE_ID, date: DRAFT_DATE, draft: true }));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('a row with no recorded Message-ID is undetermined, without any lookup', async () => {
        expect(await check({ uid: UID, draftDate: DRAFT_DATE })).toEqual({ verdict: 'undetermined', reason: 'no Message-ID and Date were recorded at approval to look for' });
        expect(findMessageByMessageId).not.toHaveBeenCalled();
        expect(getMessage).not.toHaveBeenCalled();
    });

    test('a row with no recorded Date is undetermined', async () => {
        expect(await check({ uid: UID, messageId: MESSAGE_ID })).toEqual({ verdict: 'undetermined', reason: 'no Message-ID and Date were recorded at approval to look for' });
    });

    test('a row approved before #108, with a uid alone, is undetermined', async () => {
        expect(await check({ uid: UID })).toEqual({ verdict: 'undetermined', reason: 'no Message-ID and Date were recorded at approval to look for' });
    });

    test('the Message-ID in Sent Mail is delivered, without reading the draft', async () => {
        findMessageByMessageId.mockImplementation(async () => true);

        expect(await check()).toEqual({ verdict: 'delivered' });
        expect(findMessageByMessageId.mock.calls).toEqual([['Sent Mail', MESSAGE_ID, signal]]);
        expect(getMessage).not.toHaveBeenCalled();
    });

    test('a draft gone from Drafts with no Sent copy is undetermined, never absent', async () => {
        getMessage.mockImplementation(async () => null);

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the draft is gone from Drafts and no copy was found in Sent Mail' });
        expect(getMessage.mock.calls).toEqual([['Drafts', UID, signal]]);
    });

    test('a different message at the draft\'s uid is undetermined', async () => {
        getMessage.mockImplementation(async () => ({ id: UID, messageId: '<other@example.com>', date: DRAFT_DATE, draft: true }));

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the message at the draft’s uid is no longer the approved draft' });
    });

    test.each([
        ['no longer a draft', false],
        ['not reported as a draft', undefined],
    ])('the approved message %s is undetermined', async (_label, draft) => {
        getMessage.mockImplementation(async () => ({ id: UID, messageId: MESSAGE_ID, date: DRAFT_DATE, draft }));

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the message at the draft’s uid is no longer the approved draft' });
    });

    test('a draft whose Date moved, even by a millisecond, is undetermined: a submit reached WildDuck', async () => {
        getMessage.mockImplementation(async () => ({ id: UID, messageId: MESSAGE_ID, date: '2026-09-24T09:59:00.001Z', draft: true }));

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the draft’s Date has changed since approval, so a submit reached WildDuck' });
    });

    test('the same untouched draft still waiting in Drafts is not delivered', async () => {
        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('a failed lookup propagates', async () => {
        findMessageByMessageId.mockImplementation(async () => {
            throw new Error('WildDuck API error: 503');
        });

        await expect(check()).rejects.toThrow('WildDuck API error: 503');
    });

    test('unreadable params throw', async () => {
        await expect(check({ uid: 'x' })).rejects.toBeInstanceOf(ZodError);
    });
});
