import type { BlueskyClient } from './client';
import { bskyDmParamsSchema, bskyReplyParamsSchema } from './outbound-approvals';
import type { DeliveryCheck, DeliveryCheckInput } from '@/services';

/**
 * How far clocks may disagree (5 minutes): ours, which stamps an action's delivery window and a
 * reply's `createdAt`, and Bluesky's, which stamps a DM's `sentAt` and a record key's time.
 * A scan reads back until it is this far before the window, and an identical message inside the
 * margin, just before the window, cannot be told apart from this action's own.
 */
export const DELIVERY_CHECK_CLOCK_MARGIN_MS = 5 * 60_000;

/** The most pages one check reads before giving up undecided. */
export const DELIVERY_CHECK_MAX_PAGES = 5;

/** Records or messages per page. */
export const DELIVERY_CHECK_PAGE_SIZE = 100;

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
const TID_PATTERN = /^[2-7a-j][2-7a-z]{12}$/;

/**
 * The creation time, in epoch milliseconds, that a TID record key encodes (its top 53 bits are
 * microseconds since the epoch, stamped by the PDS that created the record), or undefined when
 * `rkey` is not a TID.
 */
export function tidTimestampMs(rkey: string): number | undefined {
    if(!TID_PATTERN.test(rkey)) {
        return undefined;
    }
    let value = 0n;
    for(const char of rkey) {
        value = value * 32n + BigInt(TID_ALPHABET.indexOf(char));
    }
    // Drop the 10-bit clock id, then microseconds to milliseconds.
    return Number(value / 1024n / 1000n);
}

/**
 * How one scanned item bears on the check: an identical message inside the window (`match`), an
 * identical one that cannot be placed (`unclear`: just before the window, within the clock
 * margin, or deleted), anything else still inside the scan (`skip`), the first item older than
 * the scan needs (`older`, which ends it), or proof the listing is not newest first.
 */
type Inspection = 'match' | 'unclear' | 'skip' | 'older' | 'out-of-order';

interface Window {
    /** The delivery window start, in epoch milliseconds. */
    since: number
    /** How far back the scan reads: the window start less the clock margin. */
    floor: number
    /** The last instant a message can be this action's: the window end plus the clock margin. */
    end:   number
}

function windowFrom(since: Date, until: Date): Window {
    return { since: since.getTime(), floor: since.getTime() - DELIVERY_CHECK_CLOCK_MARGIN_MS, end: until.getTime() + DELIVERY_CHECK_CLOCK_MARGIN_MS };
}

/**
 * Place an identical message by its timestamp: inside the window (up to the clock margin past its
 * end, for a send that landed late or a clock that runs ahead), after it or well before it
 * (someone else's), or unplaceable.
 */
function placeIdentical(timestamp: string | undefined, window: Window): Inspection {
    const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
    if(at > window.end) {
        return 'skip';
    }
    if(at >= window.since) {
        return 'match';
    }
    if(at < window.floor) {
        return 'skip';
    }
    return 'unclear';
}

function undetermined(reason: string): DeliveryCheck {
    return { verdict: 'undetermined', reason };
}

/** What a scan reads, for its undetermined reasons. */
interface Noun {
    one:  string
    many: string
}

/** The identical messages a scan has seen so far. */
interface Tally {
    matches: number
    unclear: boolean
}

function verdictOf(tally: Tally, noun: Noun): DeliveryCheck {
    if(tally.unclear) {
        return undetermined(`an identical ${noun.one} could not be placed inside or outside the delivery window`);
    }
    if(tally.matches > 1) {
        return undetermined(`${tally.matches} identical ${noun.many} inside the delivery window`);
    }
    return tally.matches === 1 ? { verdict: 'delivered' } : { verdict: 'not-delivered' };
}

/** Inspect one page into `tally`: the check's result when the page ends the scan, else undefined. */
function scanPage<T>(items: T[], inspect: (item: T) => Inspection, tally: Tally, noun: Noun): DeliveryCheck | undefined {
    for(const item of items) {
        const seen = inspect(item);
        if(seen === 'out-of-order') {
            return undetermined(`the ${noun.many} were not listed newest first`);
        }
        if(seen === 'older') {
            return verdictOf(tally, noun);
        }
        tally.matches += seen === 'match' ? 1 : 0;
        tally.unclear ||= seen === 'unclear';
    }
    return undefined;
}

/**
 * Read newest-first pages until an item is older than the scan needs or the listing ends, and
 * decide from the identical messages seen: exactly one inside the window is delivered, none is
 * not delivered, and anything less clear-cut — several, one that cannot be placed, a listing out
 * of order, or more pages than {@link DELIVERY_CHECK_MAX_PAGES} — is undetermined.
 */
async function scanNewestFirst<T>(
    fetchPage: (cursor: string | undefined) => Promise<{ items: T[], cursor?: string }>,
    inspect: (item: T) => Inspection,
    noun: Noun
): Promise<DeliveryCheck> {
    const tally: Tally = { matches: 0, unclear: false };
    let cursor: string | undefined;
    for(let page = 0; page < DELIVERY_CHECK_MAX_PAGES; page++) {
        // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the one before.
        const listed = await fetchPage(cursor);
        const ended = scanPage(listed.items, inspect, tally, noun);
        if(ended !== undefined) {
            return ended;
        }
        if(listed.cursor === undefined) {
            return verdictOf(tally, noun);
        }
        cursor = listed.cursor;
    }
    return undetermined(`more than ${DELIVERY_CHECK_MAX_PAGES * DELIVERY_CHECK_PAGE_SIZE} ${noun.many} to search`);
}

/**
 * Whether a reply with exactly `text` under `parentUri` was posted by the account inside the
 * window from `since` to `until` (plus the clock margin past `until`), read from its own post
 * records (see {@link BlueskyClient.listOwnPostRecords}).
 *
 * The scan follows the repository's record-key order and ends at the first record whose TID key
 * was stamped more than the clock margin before the window — never at a record's own
 * `createdAt`, which a client may set to anything. Records without a TID key are skipped.
 * An identical reply counts as this action's when its `createdAt` (set by this process when it
 * sends) is inside the window; one stamped later is someone else's.
 */
export async function checkReplyDelivered(
    client: Pick<BlueskyClient, 'listOwnPostRecords'>,
    reply: { text: string, parentUri: string, since: Date, until: Date },
    signal: AbortSignal
): Promise<DeliveryCheck> {
    const window = windowFrom(reply.since, reply.until);
    // Above every record key, all of which are ASCII.
    let previousKey = '￿';
    return scanNewestFirst(
        async cursor => client.listOwnPostRecords({ limit: DELIVERY_CHECK_PAGE_SIZE, cursor, signal }).then(listed => ({ items: listed.records, cursor: listed.cursor })),
        (record) => {
            if(record.rkey >= previousKey) {
                return 'out-of-order';
            }
            previousKey = record.rkey;
            const created = tidTimestampMs(record.rkey);
            if(created === undefined) {
                return 'skip';
            }
            if(created < window.floor) {
                return 'older';
            }
            if(record.replyParentUri !== reply.parentUri || record.text !== reply.text) {
                return 'skip';
            }
            return placeIdentical(record.createdAt, window);
        },
        { one: 'reply', many: 'replies' }
    );
}

/**
 * Whether a DM with exactly `text` was sent by the account to `convoId` inside the window from
 * `since` to `until` (plus the clock margin past `until`), read from the conversation's message
 * log (see {@link BlueskyClient.getMessageLog}), whose `sentAt` Bluesky stamps. An identical DM
 * sent later is someone else's. A message of ours deleted before that — anywhere from the clock
 * margin before the window — cannot be compared, so it leaves the check undetermined.
 */
export async function checkDmDelivered(
    client: Pick<BlueskyClient, 'getMessageLog' | 'ownDid'>,
    dm: { text: string, convoId: string, since: Date, until: Date },
    signal: AbortSignal
): Promise<DeliveryCheck> {
    const window = windowFrom(dm.since, dm.until);
    const ownDid = client.ownDid;
    let previousSentAt = Number.POSITIVE_INFINITY;
    return scanNewestFirst(
        async cursor => client.getMessageLog(dm.convoId, { limit: DELIVERY_CHECK_PAGE_SIZE, cursor, signal }).then(listed => ({ items: listed.messages, cursor: listed.cursor })),
        (message) => {
            const sentAt = Date.parse(message.sentAt);
            if(sentAt > previousSentAt) {
                return 'out-of-order';
            }
            previousSentAt = sentAt;
            if(sentAt < window.floor) {
                return 'older';
            }
            if(message.senderDid !== ownDid) {
                return 'skip';
            }
            if(message.deleted) {
                return sentAt > window.end ? 'skip' : 'unclear';
            }
            return message.text === dm.text ? placeIdentical(message.sentAt, window) : 'skip';
        },
        { one: 'DM', many: 'DMs' }
    );
}

/** What makes two `bsky_reply` actions indistinguishable on Bluesky: parent and exact text. Undefined for unparseable params. */
export function bskyReplyContentKey(params: Record<string, unknown>): string | undefined {
    const parsed = bskyReplyParamsSchema.safeParse(params);
    return parsed.success ? JSON.stringify([parsed.data.parentUri, parsed.data.text]) : undefined;
}

/** What makes two `bsky_dm` actions indistinguishable on Bluesky: conversation and exact text. Undefined for unparseable params. */
export function bskyDmContentKey(params: Record<string, unknown>): string | undefined {
    const parsed = bskyDmParamsSchema.safeParse(params);
    return parsed.success ? JSON.stringify([parsed.data.convoId, parsed.data.text]) : undefined;
}

/** Check an approved `bsky_reply` action's destination (see {@link checkReplyDelivered}). Unparseable params throw. */
export async function checkBskyReplyDelivery(client: Pick<BlueskyClient, 'listOwnPostRecords'>, input: DeliveryCheckInput): Promise<DeliveryCheck> {
    const { text, parentUri } = bskyReplyParamsSchema.parse(input.params);
    return checkReplyDelivered(client, { text, parentUri, since: input.since, until: input.until }, input.signal);
}

/** Check an approved `bsky_dm` action's destination (see {@link checkDmDelivered}). Unparseable params throw. */
export async function checkBskyDmDelivery(client: Pick<BlueskyClient, 'getMessageLog' | 'ownDid'>, input: DeliveryCheckInput): Promise<DeliveryCheck> {
    const { text, convoId } = bskyDmParamsSchema.parse(input.params);
    return checkDmDelivered(client, { text, convoId, since: input.since, until: input.until }, input.signal);
}
