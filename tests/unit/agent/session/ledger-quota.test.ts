/**
 * Quota folding in the pure ledger reducer (docs/plans/session-peers-and-quota.md block 3).
 * Fake timers pin `Date.now()` to SENTINEL, far from every event's explicit `at`, so any output
 * Date that happens to equal SENTINEL proves the reducer read the clock instead of the event.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import {
    type Ledger,
    type QuotaWindows,
    initialLedger,
    reduceLedger,
    toQuotaWindow
} from '@/agent/session/ledger';

const SENTINEL = new Date('2099-01-01T00:00:00Z');
const T1 = new Date('2026-09-04T12:00:00Z');
const T2 = new Date('2026-09-04T12:00:01Z');

/** Probe P4's verbatim five-hour reset (unix seconds) and its Date equivalent. */
const FIVE_HOUR_RESET_SECONDS = 1_788_993_000;
const FIVE_HOUR_RESET = new Date(FIVE_HOUR_RESET_SECONDS * 1000);
const SEVEN_DAY_RESET_SECONDS = 1_789_466_400;
const SEVEN_DAY_RESET = new Date(SEVEN_DAY_RESET_SECONDS * 1000);

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(SENTINEL);
});

afterEach(() => {
    jest.useRealTimers();
});

/**
 * The `rate_limit_event` frame exactly as probe P4 recorded it: `unifiedWindows` is emitted on
 * every frame but is undeclared in `sdk.d.ts`, so it is widened to `unknown` here rather than
 * pretending the SDK types it.
 */
type RateLimitInfoWithWindows = SDKRateLimitInfo & { unifiedWindows?: unknown };

function rateLimitEvent(info: Partial<RateLimitInfoWithWindows>): SDKMessage {
    return {
        type:            'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', ...info },
        uuid:            '222a99c1-0000-4000-8000-000000000000',
        session_id:      '9301c9ba-0000-4000-8000-000000000000',
    };
}

function fold(ledger: Ledger, frame: SDKMessage, at = T1): Ledger {
    return reduceLedger(ledger, { type: 'sdk_frame', frame, at });
}

function polled(ledger: Ledger, quota: QuotaWindows, at = T1): Ledger {
    return reduceLedger(ledger, { type: 'quota_polled', quota, at });
}

describe('toQuotaWindow', () => {
    it('scales the SDK 0-1 utilization fraction to 0-100 percent and reads resetsAt as unix seconds', () => {
        expect(toQuotaWindow(0.53, SEVEN_DAY_RESET_SECONDS)).toEqual({ utilization: 53, resetsAt: SEVEN_DAY_RESET });
    });

    it('omits resetsAt when it is missing or not a finite number', () => {
        expect(toQuotaWindow(0.02, undefined)).toEqual({ utilization: 2 });
        expect(toQuotaWindow(0.02, 'soon')).toEqual({ utilization: 2 });
        expect(toQuotaWindow(0.02, Number.NaN)).toEqual({ utilization: 2 });
        expect(toQuotaWindow(0.02, Number.POSITIVE_INFINITY)).toEqual({ utilization: 2 });
        expect(toQuotaWindow(0.02, true)).toEqual({ utilization: 2 });
    });

    it('reads an ISO-8601 resetsAt string, so a poll window still carries its rollover boundary', () => {
        expect(toQuotaWindow(0.42, SEVEN_DAY_RESET.toISOString())).toEqual({ utilization: 42, resetsAt: SEVEN_DAY_RESET });
    });

    it('accepts both ends of the 0-1 fraction', () => {
        expect(toQuotaWindow(0, undefined)).toEqual({ utilization: 0 });
        expect(toQuotaWindow(1, undefined)).toEqual({ utilization: 100 });
    });

    it('REJECTS a utilization outside 0-1 rather than clamping it — a percent-shaped 87 from the unverified usage endpoint must not be filed as a real 87%, still less as a 100% that pauses perch', () => {
        expect(toQuotaWindow(87, undefined)).toBeUndefined();
        expect(toQuotaWindow(1.5, undefined)).toBeUndefined();
        expect(toQuotaWindow(-0.25, undefined)).toBeUndefined();
        expect(toQuotaWindow(Number.POSITIVE_INFINITY, undefined)).toBeUndefined();
        expect(toQuotaWindow(Number.NEGATIVE_INFINITY, undefined)).toBeUndefined();
    });

    it('returns undefined when utilization is absent, non-numeric or non-finite', () => {
        expect(toQuotaWindow(undefined, SEVEN_DAY_RESET_SECONDS)).toBeUndefined();
        expect(toQuotaWindow('0.53', SEVEN_DAY_RESET_SECONDS)).toBeUndefined();
        expect(toQuotaWindow(Number.NaN, SEVEN_DAY_RESET_SECONDS)).toBeUndefined();
    });
});

describe('reduceLedger sdk_frame rate_limit_event', () => {
    it('folds both unifiedWindows into quota with source headers and the event stamp', () => {
        const frame = rateLimitEvent({
            rateLimitType:  'seven_day',
            utilization:    0.53,
            resetsAt:       SEVEN_DAY_RESET_SECONDS,
            unifiedWindows: {
                five_hour: { utilization: 0.02, resetsAt: FIVE_HOUR_RESET_SECONDS },
                seven_day: { utilization: 0.53, resetsAt: SEVEN_DAY_RESET_SECONDS },
            },
        });

        expect(fold(initialLedger('conversation'), frame).quota).toEqual({
            fiveHour: { utilization: 2, resetsAt: FIVE_HOUR_RESET },
            sevenDay: { utilization: 53, resetsAt: SEVEN_DAY_RESET },
            source:   'headers',
            at:       T1,
        });
    });

    it('lets the top-level rateLimitType window win over the same window in unifiedWindows', () => {
        const frame = rateLimitEvent({
            rateLimitType:  'five_hour',
            utilization:    0.9,
            resetsAt:       FIVE_HOUR_RESET_SECONDS,
            unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: FIVE_HOUR_RESET_SECONDS } },
        });

        expect(fold(initialLedger('conversation'), frame).quota?.fiveHour).toEqual({ utilization: 90, resetsAt: FIVE_HOUR_RESET });
    });

    it('files every seven_day_* variant under perModel, keyed by its raw rate-limit type', () => {
        const frame = rateLimitEvent({
            unifiedWindows: {
                seven_day_opus:   { utilization: 0.4, resetsAt: SEVEN_DAY_RESET_SECONDS },
                seven_day_sonnet: { utilization: 0.1 },
            },
        });

        expect(fold(initialLedger('conversation'), frame).quota?.perModel).toEqual({
            seven_day_opus:   { utilization: 40, resetsAt: SEVEN_DAY_RESET },
            seven_day_sonnet: { utilization: 10 },
        });
    });

    it('folds the top-level window alone when the frame carries no unifiedWindows', () => {
        const frame = rateLimitEvent({ rateLimitType: 'seven_day', utilization: 0.53, resetsAt: SEVEN_DAY_RESET_SECONDS });

        expect(fold(initialLedger('conversation'), frame).quota).toEqual({
            sevenDay: { utilization: 53, resetsAt: SEVEN_DAY_RESET },
            source:   'headers',
            at:       T1,
        });
    });

    it('returns the ledger by reference when the frame names no window this ledger tracks', () => {
        const before = initialLedger('conversation');
        const frame = rateLimitEvent({ rateLimitType: 'overage', utilization: 0.3, unifiedWindows: { overage: { utilization: 0.3 } } });

        expect(fold(before, frame)).toBe(before);
    });

    it('returns the ledger by reference when unifiedWindows is not an object and no top-level type is named', () => {
        const before = initialLedger('conversation');

        expect(fold(before, rateLimitEvent({ unifiedWindows: 'nope' }))).toBe(before);
        expect(fold(before, rateLimitEvent({ unifiedWindows: null }))).toBe(before);
        expect(fold(before, rateLimitEvent({ utilization: 0.5 }))).toBe(before);
    });

    it('skips a unifiedWindows entry whose utilization is unusable', () => {
        const before = initialLedger('conversation');
        const frame = rateLimitEvent({ unifiedWindows: { five_hour: { resetsAt: FIVE_HOUR_RESET_SECONDS }, seven_day: { utilization: 0.53 } } });
        const after = fold(before, frame);

        expect(after.quota?.fiveHour).toBeUndefined();
        expect(after.quota?.sevenDay).toEqual({ utilization: 53 });
    });

    it('skips the top-level window when its rateLimitType is named but its utilization is unusable', () => {
        const before = initialLedger('conversation');
        const frame = rateLimitEvent({ rateLimitType: 'five_hour', unifiedWindows: { seven_day: { utilization: 0.53 } } });
        const after = fold(before, frame);

        expect(after.quota?.fiveHour).toBeUndefined();
        expect(after.quota?.sevenDay).toEqual({ utilization: 53 });
    });

    it('keeps a window an earlier event set when a later event does not carry it', () => {
        const first = fold(initialLedger('conversation'), rateLimitEvent({ unifiedWindows: { five_hour: { utilization: 0.02 } } }));
        const second = fold(first, rateLimitEvent({ unifiedWindows: { seven_day: { utilization: 0.53 } } }), T2);

        expect(second.quota).toEqual({
            fiveHour: { utilization: 2 },
            sevenDay: { utilization: 53 },
            source:   'headers',
            at:       T2,
        });
    });

    it('merges perModel across events rather than replacing the map', () => {
        const first = fold(initialLedger('conversation'), rateLimitEvent({ unifiedWindows: { seven_day_opus: { utilization: 0.4 } } }));
        const second = fold(first, rateLimitEvent({ unifiedWindows: { seven_day_sonnet: { utilization: 0.1 } } }), T2);

        expect(second.quota?.perModel).toEqual({ seven_day_opus: { utilization: 40 }, seven_day_sonnet: { utilization: 10 } });
    });

    it('shares every untouched sub-object with the previous ledger', () => {
        const before = initialLedger('conversation');
        const after = fold(before, rateLimitEvent({ unifiedWindows: { five_hour: { utilization: 0.02 } } }));

        expect(after).not.toBe(before);
        expect(after.tasks).toBe(before.tasks);
        expect(after.context).toBe(before.context);
        expect(after.cost).toBe(before.cost);
    });
});

describe('reduceLedger quota_polled', () => {
    it('records polled windows with source poll and the event stamp', () => {
        const after = polled(initialLedger('perch'), { fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET } });

        expect(after.quota).toEqual({ fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET }, source: 'poll', at: T1 });
    });

    it('merges over a headers-sourced quota, keeping windows the poll did not carry', () => {
        const seeded = fold(initialLedger('perch'), rateLimitEvent({ unifiedWindows: { five_hour: { utilization: 0.02 }, seven_day: { utilization: 0.53 } } }));
        const after = polled(seeded, { sevenDay: { utilization: 61 } }, T2);

        expect(after.quota).toEqual({
            fiveHour: { utilization: 2 },
            sevenDay: { utilization: 61 },
            source:   'poll',
            at:       T2,
        });
    });

    it('returns the ledger by reference when the poll carries no window at all', () => {
        const before = initialLedger('perch');

        expect(polled(before, {})).toBe(before);
    });
});

/**
 * A quota reading that moved nothing must not allocate a new ledger: every subscriber
 * (`quota-notes`, the presence renderer, the ambient-line providers) is woken by a changed
 * reference, and the poller repeats the same numbers every five minutes.
 */
describe('reduceLedger quota dedupe', () => {
    const READING: QuotaWindows = {
        fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET },
        sevenDay: { utilization: 61 },
        perModel: { seven_day_opus: { utilization: 40, resetsAt: SEVEN_DAY_RESET } },
    };

    /** A structurally-equal but distinct copy, so a passing test cannot be an identity comparison. */
    function copyOfReading(): QuotaWindows {
        return {
            fiveHour: { utilization: 42, resetsAt: new Date(FIVE_HOUR_RESET) },
            sevenDay: { utilization: 61 },
            perModel: { seven_day_opus: { utilization: 40, resetsAt: new Date(SEVEN_DAY_RESET) } },
        };
    }

    it('returns the ledger by reference — and leaves `at` where it was — when a poll repeats the current reading exactly', () => {
        const first = polled(initialLedger('perch'), READING, T1);

        const second = polled(first, copyOfReading(), T2);

        expect(second).toBe(first);
        expect(second.quota?.at).toBe(T1);
    });

    it('refreshes when a window utilization moves', () => {
        const first = polled(initialLedger('perch'), READING, T1);

        const second = polled(first, { ...copyOfReading(), sevenDay: { utilization: 62 } }, T2);

        expect(second).not.toBe(first);
        expect(second.quota).toMatchObject({ sevenDay: { utilization: 62 }, at: T2 });
    });

    it('refreshes when only resetsAt moves — the window rolled over at the same utilization', () => {
        const first = polled(initialLedger('perch'), READING, T1);

        const second = polled(first, { ...copyOfReading(), fiveHour: { utilization: 42, resetsAt: SEVEN_DAY_RESET } }, T2);

        expect(second).not.toBe(first);
        expect(second.quota?.fiveHour).toEqual({ utilization: 42, resetsAt: SEVEN_DAY_RESET });
    });

    it('refreshes when a window loses its resetsAt while the utilization stands', () => {
        const first = polled(initialLedger('perch'), { fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET } }, T1);

        const second = polled(first, { fiveHour: { utilization: 42 } }, T2);

        expect(second).not.toBe(first);
        expect(second.quota?.fiveHour).toEqual({ utilization: 42 });
    });

    it('refreshes when the same numbers arrive from the other source', () => {
        const first = polled(initialLedger('perch'), { fiveHour: { utilization: 2 } }, T1);

        const second = fold(first, rateLimitEvent({ unifiedWindows: { five_hour: { utilization: 0.02 } } }), T2);

        expect(second).not.toBe(first);
        expect(second.quota).toEqual({ fiveHour: { utilization: 2 }, source: 'headers', at: T2 });
    });

    it('returns the ledger by reference for an identical reading that carries no perModel at all', () => {
        const first = polled(initialLedger('perch'), { fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET } }, T1);

        const second = polled(first, { fiveHour: { utilization: 42, resetsAt: new Date(FIVE_HOUR_RESET) } }, T2);

        expect(second).toBe(first);
    });

    it('refreshes when ONE of several perModel windows moves and the others stand', () => {
        const twoModels: QuotaWindows = {
            perModel: { seven_day_opus: { utilization: 40 }, seven_day_sonnet: { utilization: 10 } },
        };
        const first = polled(initialLedger('perch'), twoModels, T1);

        const second = polled(first, { perModel: { seven_day_opus: { utilization: 40 }, seven_day_sonnet: { utilization: 11 } } }, T2);

        expect(second).not.toBe(first);
        expect(second.quota?.perModel).toEqual({ seven_day_opus: { utilization: 40 }, seven_day_sonnet: { utilization: 11 } });
    });

    it('refreshes when a perModel window moves', () => {
        const first = polled(initialLedger('perch'), READING, T1);

        const second = polled(first, { ...copyOfReading(), perModel: { seven_day_opus: { utilization: 41, resetsAt: SEVEN_DAY_RESET } } }, T2);

        expect(second).not.toBe(first);
        expect(second.quota?.perModel).toEqual({ seven_day_opus: { utilization: 41, resetsAt: SEVEN_DAY_RESET } });
    });

    it('refreshes when a reading brings the first perModel window this ledger has ever seen', () => {
        const first = polled(initialLedger('perch'), { fiveHour: { utilization: 42 } }, T1);

        const second = polled(first, { fiveHour: { utilization: 42 }, perModel: { seven_day_opus: { utilization: 40 } } }, T2);

        expect(second).not.toBe(first);
        expect(second.quota?.perModel).toEqual({ seven_day_opus: { utilization: 40 } });
    });

    it('refreshes when a poll adds a perModel window the ledger did not know', () => {
        const first = polled(initialLedger('perch'), READING, T1);

        const second = polled(first, { ...copyOfReading(), perModel: { seven_day_sonnet: { utilization: 10 } } }, T2);

        expect(second).not.toBe(first);
        expect(second.quota?.perModel).toEqual({
            seven_day_opus:   { utilization: 40, resetsAt: SEVEN_DAY_RESET },
            seven_day_sonnet: { utilization: 10 },
        });
    });

    it('still refreshes the FIRST reading a ledger ever sees', () => {
        const before = initialLedger('perch');

        const after = polled(before, READING, T1);

        expect(after).not.toBe(before);
        expect(after.quota?.at).toBe(T1);
    });
});
