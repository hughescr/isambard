import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { ZodError } from 'zod';
import type { BskyMessageLogEntry, BskyOwnPostRecord } from '@/integrations/bsky/client';
import {
    DELIVERY_CHECK_CLOCK_MARGIN_MS,
    DELIVERY_CHECK_MAX_PAGES,
    DELIVERY_CHECK_PAGE_SIZE,
    bskyDmContentKey,
    bskyReplyContentKey,
    checkBskyDmDelivery,
    checkBskyReplyDelivery,
    checkDmDelivered,
    checkReplyDelivered,
    tidTimestampMs
} from '@/integrations/bsky/delivery-check';

interface Page<T> {
    records?:  T[]
    messages?: T[]
    cursor?:   string
}
type ListRecords = (options?: { limit?: number, cursor?: string, signal?: AbortSignal }) => Promise<{ records: BskyOwnPostRecord[], cursor?: string }>;
type GetMessageLog = (convoId: string, options?: { limit?: number, cursor?: string, signal?: AbortSignal }) => Promise<{ messages: BskyMessageLogEntry[], cursor?: string }>;

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

/** Encode a TID record key for `ms` (and a clock id), as a PDS would. */
function tid(ms: number, clockId = 0): string {
    // Microseconds in the top 53 bits, the 10-bit clock id below them, base32-sortable.
    let value = (BigInt(ms) * 1000n * 1024n) + BigInt(clockId);
    let key = '';
    for(let index = 0; index < 13; index++) {
        key = TID_ALPHABET[Number(value % 32n)] + key;
        value /= 32n;
    }
    return key;
}

const SINCE = new Date('2026-09-24T10:00:00.000Z');
const SINCE_MS = SINCE.getTime();
const FLOOR_MS = SINCE_MS - DELIVERY_CHECK_CLOCK_MARGIN_MS;
/** When the action's outcome became unknown: the end of its delivery window. */
const UNTIL = new Date(SINCE_MS + 120_000);
/** The last instant an identical message still counts as this action's: the window end plus the clock margin. */
const END_MS = UNTIL.getTime() + DELIVERY_CHECK_CLOCK_MARGIN_MS;
const TWO_DAYS_MS = 2 * 24 * 60 * 60_000;
const PARENT = 'at://did:plc:friend/app.bsky.feed.post/3abc';
const OWN_DID = 'did:plc:izzy';
const CONVO = 'convo-1';

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

/** One of our own post records, keyed and stamped at `ms` unless overridden. */
function post(ms: number, overrides: Partial<BskyOwnPostRecord> = {}): BskyOwnPostRecord {
    const rkey = tid(ms);
    return { uri: `at://${OWN_DID}/app.bsky.feed.post/${rkey}`, rkey, text: 'Thanks!', createdAt: iso(ms), replyParentUri: PARENT, ...overrides };
}

function message(ms: number, overrides: Partial<BskyMessageLogEntry> = {}): BskyMessageLogEntry {
    return { id: `m${ms}`, senderDid: OWN_DID, sentAt: iso(ms), text: 'Thanks!', deleted: false, ...overrides };
}

describe('tidTimestampMs', () => {
    test('decodes the creation time of a TID record key', () => {
        expect(tidTimestampMs('3jzfcijpj2z2a')).toBe(1_688_137_381_887);
        expect(tidTimestampMs('2222222222222')).toBe(0);
    });

    test('round-trips a key stamped at a known instant, whatever its clock id', () => {
        expect(tidTimestampMs(tid(SINCE_MS))).toBe(SINCE_MS);
        expect(tidTimestampMs(tid(SINCE_MS, 1023))).toBe(SINCE_MS);
    });

    test.each([
        ['self'],
        ['3jzfcijpj2z2'],
        ['3jzfcijpj2z2aa'],
        ['kjzfcijpj2z2a'],
        ['3jzfcijpj2z1a'],
        ['3JZFCIJPJ2Z2A'],
        ['x3jzfcijpj2z2a'],
        ['3jzfcijpj2z2ax'],
    ])('is undefined for the non-TID key %s', (rkey) => {
        expect(tidTimestampMs(rkey)).toBeUndefined();
    });
});

describe('constants', () => {
    test('are exact', () => {
        expect(DELIVERY_CHECK_CLOCK_MARGIN_MS).toBe(300_000);
        expect(DELIVERY_CHECK_MAX_PAGES).toBe(5);
        expect(DELIVERY_CHECK_PAGE_SIZE).toBe(100);
    });
});

describe('checkReplyDelivered', () => {
    const signal = new AbortController().signal;
    let pages: Page<BskyOwnPostRecord>[];
    let listOwnPostRecords: ReturnType<typeof mock<ListRecords>>;

    async function check(): Promise<unknown> {
        return checkReplyDelivered({ listOwnPostRecords }, { text: 'Thanks!', parentUri: PARENT, since: SINCE, until: UNTIL }, signal);
    }

    beforeEach(() => {
        pages = [];
        listOwnPostRecords = mock(async () => {
            const page = pages.shift() ?? {};
            return { records: page.records ?? [], cursor: page.cursor };
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('an identical reply under the same parent inside the window is delivered', async () => {
        pages = [{ records: [post(SINCE_MS + 5000)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
        expect(listOwnPostRecords.mock.calls).toEqual([[{ limit: 100, cursor: undefined, signal }]]);
    });

    test('an identical reply stamped exactly at the window start is delivered', async () => {
        pages = [{ records: [post(SINCE_MS)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('an identical reply stamped exactly at the clock margin after the window end is delivered', async () => {
        pages = [{ records: [post(END_MS)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('an identical reply stamped a millisecond after the clock margin past the window end is someone else\'s, and is not this reply', async () => {
        pages = [{ records: [post(END_MS + 1)] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('an identical reply posted days after the window is not counted against this action\'s own reply inside it', async () => {
        pages = [{ records: [post(SINCE_MS + TWO_DAYS_MS), post(SINCE_MS + 1000)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('the same text under another parent is not this reply', async () => {
        pages = [{ records: [post(SINCE_MS + 5000, { replyParentUri: 'at://did:plc:friend/app.bsky.feed.post/3other' })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('other text under the same parent is not this reply', async () => {
        pages = [{ records: [post(SINCE_MS + 5000, { text: 'Thanks!!' })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('an identical reply stamped a millisecond before the window cannot be placed, so the check is undetermined', async () => {
        pages = [{ records: [post(SINCE_MS - 1)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'an identical reply could not be placed inside or outside the delivery window' });
    });

    test('an identical reply stamped exactly at the clock margin before the window cannot be placed', async () => {
        pages = [{ records: [post(SINCE_MS + 1000, { createdAt: iso(FLOOR_MS) })] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'an identical reply could not be placed inside or outside the delivery window' });
    });

    test('an identical reply with no createdAt cannot be placed', async () => {
        pages = [{ records: [post(SINCE_MS + 1000, { createdAt: undefined })] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'an identical reply could not be placed inside or outside the delivery window' });
    });

    test('an identical reply stamped before the clock margin is someone else\'s, and is not this reply', async () => {
        pages = [{ records: [post(SINCE_MS + 1000, { createdAt: iso(FLOOR_MS - 1) })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('a newer-keyed record with an old createdAt does not end the scan before an older-keyed matching reply', async () => {
        pages = [{ records: [
            post(SINCE_MS + 2000, { text: 'backdated', createdAt: '2020-01-01T00:00:00.000Z' }),
            post(SINCE_MS + 1000),
        ] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('the scan ends at the first record keyed before the clock margin, without reading the next page', async () => {
        pages = [
            { records: [post(SINCE_MS + 1000, { text: 'other' }), post(FLOOR_MS - 1), post(SINCE_MS - 10_000_000)], cursor: 'p2' },
            { records: [post(SINCE_MS - 20_000_000)] },
        ];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
        expect(listOwnPostRecords).toHaveBeenCalledTimes(1);
    });

    test('a record keyed exactly at the clock margin is still inside the scan', async () => {
        pages = [{ records: [post(FLOOR_MS, { createdAt: iso(SINCE_MS) })] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('records without a TID key are skipped, never matched or used to end the scan', async () => {
        pages = [{ records: [post(SINCE_MS + 2000, { rkey: 'zzzz-custom' }), post(SINCE_MS + 1000)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('an identical reply whose key is not a TID is not counted', async () => {
        pages = [{ records: [post(SINCE_MS + 1000, { rkey: 'self' })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('two identical replies inside the window cannot be attributed, so the check is undetermined', async () => {
        pages = [{ records: [post(SINCE_MS + 2000), post(SINCE_MS + 1000)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: '2 identical replies inside the delivery window' });
    });

    test('an empty listing is not delivered', async () => {
        expect(await check()).toEqual({ verdict: 'not-delivered' });
        expect(listOwnPostRecords).toHaveBeenCalledTimes(1);
    });

    test('follows the cursor to a match on a later page', async () => {
        pages = [
            { records: [post(SINCE_MS + 9000, { text: 'other' })], cursor: 'page-2' },
            { records: [post(SINCE_MS + 1000)] },
        ];

        expect(await check()).toEqual({ verdict: 'delivered' });
        expect(listOwnPostRecords.mock.calls[1]).toEqual([{ limit: 100, cursor: 'page-2', signal }]);
    });

    test('a listing out of key order is undetermined', async () => {
        pages = [{ records: [post(SINCE_MS + 1000, { text: 'other' }), post(SINCE_MS + 2000)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the replies were not listed newest first' });
    });

    test('a repeated key is out of order', async () => {
        pages = [{ records: [post(SINCE_MS + 1000, { text: 'other' }), post(SINCE_MS + 1000)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the replies were not listed newest first' });
    });

    test('the key order is checked across pages', async () => {
        pages = [
            { records: [post(SINCE_MS + 1000, { text: 'other' })], cursor: 'page-2' },
            { records: [post(SINCE_MS + 2000)] },
        ];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the replies were not listed newest first' });
    });

    test('a scan still inside the window after the page cap is undetermined', async () => {
        pages = Array.from({ length: DELIVERY_CHECK_MAX_PAGES + 1 }, (_, index) => ({ records: [post(SINCE_MS + 100_000 - index, { text: 'other' })], cursor: `page-${index + 2}` }));

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'more than 500 replies to search' });
        expect(listOwnPostRecords).toHaveBeenCalledTimes(5);
    });

    test('a scan that ends on the last allowed page decides', async () => {
        pages = Array.from({ length: DELIVERY_CHECK_MAX_PAGES - 1 }, (_, index) => ({ records: [post(SINCE_MS + 100_000 - index, { text: 'other' })], cursor: `page-${index + 2}` }));
        pages.push({ records: [post(FLOOR_MS - 1)], cursor: 'page-6' });

        expect(await check()).toEqual({ verdict: 'not-delivered' });
        expect(listOwnPostRecords).toHaveBeenCalledTimes(5);
    });

    test('a failed read propagates', async () => {
        listOwnPostRecords.mockImplementation(async () => {
            throw new Error('Failed to list own post records');
        });

        await expect(check()).rejects.toThrow('Failed to list own post records');
    });
});

describe('checkDmDelivered', () => {
    const signal = new AbortController().signal;
    let pages: Page<BskyMessageLogEntry>[];
    let getMessageLog: ReturnType<typeof mock<GetMessageLog>>;

    async function check(): Promise<unknown> {
        return checkDmDelivered({ getMessageLog, ownDid: OWN_DID }, { text: 'Thanks!', convoId: CONVO, since: SINCE, until: UNTIL }, signal);
    }

    beforeEach(() => {
        pages = [];
        getMessageLog = mock(async () => {
            const page = pages.shift() ?? {};
            return { messages: page.messages ?? [], cursor: page.cursor };
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('an identical DM from the account inside the window is delivered', async () => {
        pages = [{ messages: [message(SINCE_MS + 300)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
        expect(getMessageLog.mock.calls).toEqual([[CONVO, { limit: 100, cursor: undefined, signal }]]);
    });

    test('an identical DM sent exactly at the window start is delivered', async () => {
        pages = [{ messages: [message(SINCE_MS)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('an identical DM sent exactly at the clock margin after the window end is delivered', async () => {
        pages = [{ messages: [message(END_MS)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('an identical DM sent a millisecond after the clock margin past the window end is someone else\'s, and is not this DM', async () => {
        pages = [{ messages: [message(END_MS + 1)] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('an identical DM sent two days after the window, with none inside it, is not delivered', async () => {
        pages = [{ messages: [message(SINCE_MS + TWO_DAYS_MS)] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('the same text from the other member is not this DM', async () => {
        pages = [{ messages: [message(SINCE_MS + 300, { senderDid: 'did:plc:friend' })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('other text from the account is not this DM', async () => {
        pages = [{ messages: [message(SINCE_MS + 300, { text: 'Thanks!!' })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('an identical DM sent four minutes before the first claim cannot be told apart, so the check is undetermined, not delivered', async () => {
        pages = [{ messages: [message(SINCE_MS - 240_000)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'an identical DM could not be placed inside or outside the delivery window' });
    });

    test('an identical DM a millisecond before the window cannot be placed', async () => {
        pages = [{ messages: [message(SINCE_MS - 1)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'an identical DM could not be placed inside or outside the delivery window' });
    });

    test('an identical DM before the clock margin ends the scan and is not this DM', async () => {
        pages = [{ messages: [message(FLOOR_MS - 1)], cursor: 'older' }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
        expect(getMessageLog).toHaveBeenCalledTimes(1);
    });

    test('a DM sent exactly at the clock margin is still inside the scan', async () => {
        pages = [{ messages: [message(FLOOR_MS, { text: 'other' }), message(FLOOR_MS - 1)] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('a deleted DM of ours inside the scan cannot be compared, so the check is undetermined', async () => {
        pages = [{ messages: [message(SINCE_MS + 300, { deleted: true, text: undefined })] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'an identical DM could not be placed inside or outside the delivery window' });
    });

    test('a deleted DM of ours sent exactly at the clock margin past the window end cannot be compared', async () => {
        pages = [{ messages: [message(END_MS, { deleted: true, text: undefined })] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'an identical DM could not be placed inside or outside the delivery window' });
    });

    test('a deleted DM of ours sent a millisecond after the clock margin past the window end is ignored', async () => {
        pages = [{ messages: [message(END_MS + 1, { deleted: true, text: undefined })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('a deleted DM of ours before the clock margin is ignored', async () => {
        pages = [{ messages: [message(FLOOR_MS - 1, { deleted: true, text: undefined })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('a deleted DM from the other member is ignored', async () => {
        pages = [{ messages: [message(SINCE_MS + 300, { senderDid: 'did:plc:friend', deleted: true, text: undefined })] }];

        expect(await check()).toEqual({ verdict: 'not-delivered' });
    });

    test('two identical DMs inside the window cannot be attributed', async () => {
        pages = [{ messages: [message(SINCE_MS + 600), message(SINCE_MS + 300)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: '2 identical DMs inside the delivery window' });
    });

    test('messages sent at the same instant are in order', async () => {
        pages = [{ messages: [message(SINCE_MS + 300, { text: 'other' }), message(SINCE_MS + 300)] }];

        expect(await check()).toEqual({ verdict: 'delivered' });
    });

    test('a log out of time order is undetermined', async () => {
        pages = [{ messages: [message(SINCE_MS + 300, { text: 'other' }), message(SINCE_MS + 301)] }];

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'the DMs were not listed newest first' });
    });

    test('follows the cursor to a match on a later page', async () => {
        pages = [
            { messages: [message(SINCE_MS + 900, { text: 'other' })], cursor: 'older' },
            { messages: [message(SINCE_MS + 300)] },
        ];

        expect(await check()).toEqual({ verdict: 'delivered' });
        expect(getMessageLog.mock.calls[1]).toEqual([CONVO, { limit: 100, cursor: 'older', signal }]);
    });

    test('a scan still inside the window after the page cap is undetermined', async () => {
        pages = Array.from({ length: DELIVERY_CHECK_MAX_PAGES + 1 }, (_, index) => ({ messages: [message(SINCE_MS + 100_000 - index, { text: 'other' })], cursor: `page-${index + 2}` }));

        expect(await check()).toEqual({ verdict: 'undetermined', reason: 'more than 500 DMs to search' });
        expect(getMessageLog).toHaveBeenCalledTimes(5);
    });
});

describe('action params', () => {
    const signal = new AbortController().signal;
    const REPLY_PARAMS = { text: 'Thanks!', parentUri: PARENT, parentCid: 'bafyreiparent' };
    const DM_PARAMS = { text: 'Thanks!', convoId: CONVO };

    test('checkBskyReplyDelivery reads the reply\'s text and parent from its params', async () => {
        const listOwnPostRecords = mock<ListRecords>(async () => ({ records: [post(SINCE_MS + 1000)] }));

        expect(await checkBskyReplyDelivery({ listOwnPostRecords }, { params: REPLY_PARAMS, since: SINCE, until: UNTIL, signal })).toEqual({ verdict: 'delivered' });
        expect(listOwnPostRecords.mock.calls).toEqual([[{ limit: 100, cursor: undefined, signal }]]);
    });

    test('checkBskyReplyDelivery ends the window at the input\'s until', async () => {
        const listOwnPostRecords = mock<ListRecords>(async () => ({ records: [post(END_MS + 1)] }));

        expect(await checkBskyReplyDelivery({ listOwnPostRecords }, { params: REPLY_PARAMS, since: SINCE, until: UNTIL, signal })).toEqual({ verdict: 'not-delivered' });
    });

    test('checkBskyReplyDelivery throws on unreadable params', async () => {
        const listOwnPostRecords = mock<ListRecords>(async () => ({ records: [] }));

        await expect(checkBskyReplyDelivery({ listOwnPostRecords }, { params: { text: 'Thanks!', parentUri: 'not-a-uri', parentCid: 'c' }, since: SINCE, until: UNTIL, signal })).rejects.toBeInstanceOf(ZodError);
        expect(listOwnPostRecords).not.toHaveBeenCalled();
    });

    test('checkBskyDmDelivery reads the DM\'s text and conversation from its params', async () => {
        const getMessageLog = mock<GetMessageLog>(async () => ({ messages: [message(SINCE_MS + 300)] }));

        expect(await checkBskyDmDelivery({ getMessageLog, ownDid: OWN_DID }, { params: DM_PARAMS, since: SINCE, until: UNTIL, signal })).toEqual({ verdict: 'delivered' });
        expect(getMessageLog.mock.calls).toEqual([[CONVO, { limit: 100, cursor: undefined, signal }]]);
    });

    test('checkBskyDmDelivery ends the window at the input\'s until', async () => {
        const getMessageLog = mock<GetMessageLog>(async () => ({ messages: [message(END_MS + 1)] }));

        expect(await checkBskyDmDelivery({ getMessageLog, ownDid: OWN_DID }, { params: DM_PARAMS, since: SINCE, until: UNTIL, signal })).toEqual({ verdict: 'not-delivered' });
    });

    test('checkBskyDmDelivery throws on unreadable params', async () => {
        const getMessageLog = mock<GetMessageLog>(async () => ({ messages: [] }));

        await expect(checkBskyDmDelivery({ getMessageLog, ownDid: OWN_DID }, { params: { text: 'Thanks!' }, since: SINCE, until: UNTIL, signal })).rejects.toBeInstanceOf(ZodError);
    });

    test('a reply\'s content key is its parent and exact text', () => {
        expect(bskyReplyContentKey(REPLY_PARAMS)).toBe(JSON.stringify([PARENT, 'Thanks!']));
        expect(bskyReplyContentKey({ ...REPLY_PARAMS, rootUri: PARENT, rootCid: 'bafyreiroot' })).toBe(JSON.stringify([PARENT, 'Thanks!']));
    });

    test('a reply with unreadable params has no content key', () => {
        expect(bskyReplyContentKey({ text: 'Thanks!' })).toBeUndefined();
    });

    test('a DM\'s content key is its conversation and exact text', () => {
        expect(bskyDmContentKey(DM_PARAMS)).toBe(JSON.stringify([CONVO, 'Thanks!']));
    });

    test('a DM with unreadable params has no content key', () => {
        expect(bskyDmContentKey({ convoId: CONVO })).toBeUndefined();
    });
});
