/**
 * Tests for the quota threshold/reset note coalescer and the perch quota ceiling
 * (docs/plans/session-peers-and-quota.md, block 5).
 */
import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';
import type { Ledger, LedgerQuota, QuotaWindow } from '@/agent/session/ledger';
import type { NotifyFn, NotifyParams } from '@/agent/session/notification-bridge';
import { createQuotaNotes, DEFAULT_QUOTA_NOTIFY_PERCENTS } from '@/agent/session/quota-notes';

/** The `at` every reading below is stamped with — asserted verbatim on the notify params. */
const AT = new Date('2026-09-09T20:00:00Z');
/** The five-hour window instance a reading belongs to, and the one it rolls over into. */
const RESET_A = new Date('2026-09-09T22:30:00Z');
const RESET_B = new Date('2026-09-10T03:30:00Z');

/** One ledger-shaped reading: only `quota` is ever read by the notes. */
function reading(quota: Partial<LedgerQuota>): Pick<Ledger, 'quota'> {
    return { quota: { source: 'headers', at: AT, ...quota } };
}

/** A five-hour reading in window instance A unless another `resetsAt` is given; `null` reports none at all. */
function fiveHour(utilization: number, resetsAt: Date | null = RESET_A): Pick<Ledger, 'quota'> {
    const window: QuotaWindow = resetsAt === null ? { utilization } : { utilization, resetsAt };
    return reading({ fiveHour: window });
}

describe('DEFAULT_QUOTA_NOTIFY_PERCENTS', () => {
    test('is the spec\'s [75, 90]', () => {
        expect([...DEFAULT_QUOTA_NOTIFY_PERCENTS]).toEqual([75, 90]);
    });
});

describe('createQuotaNotes', () => {
    let notify: Mock<NotifyFn>;

    beforeEach(() => {
        // Default: every note is delivered — an attached, already-open conductor. Individual
        // tests override this (mockReturnValueOnce(false)) to model a note that finds the
        // notification bridge not yet ready.
        notify = mock((_params: NotifyParams) => true);
    });

    test('a five-hour window first seen above 75% appends exactly one accumulate-only note', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(80));

        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.source).toBe('quota');
        expect(params.wake).toBe(false);
        expect(params.at).toBe(AT);
        expect(params.dedupeKey).toBe(`fiveHour:75:${RESET_A.getTime()}`);
        expect(params.text).toBe('Quota: the five-hour window has passed 75% (now 80%) of the shared Claude subscription.');
    });

    test('a window first seen past both thresholds notes only the highest one, and says nothing more as it climbs', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(92));
        notes.record(fiveHour(95));

        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.dedupeKey).toBe(`fiveHour:90:${RESET_A.getTime()}`);
        expect(params.text).toBe('Quota: the five-hour window has passed 90% (now 92%) of the shared Claude subscription.');
    });

    test('crossing the thresholds one at a time notes each of them once', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(76));
        notes.record(fiveHour(91));

        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[0][0].dedupeKey).toBe(`fiveHour:75:${RESET_A.getTime()}`);
        expect(notify.mock.calls[1][0].dedupeKey).toBe(`fiveHour:90:${RESET_A.getTime()}`);
    });

    test('exactly 75% counts as crossed', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(75));

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0].text).toBe('Quota: the five-hour window has passed 75% (now 75%) of the shared Claude subscription.');
    });

    test('a repeated identical reading notes nothing further', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(80));
        notes.record(fiveHour(80));
        notes.record(fiveHour(80));

        expect(notify).toHaveBeenCalledTimes(1);
    });

    test('the weekly window is tracked independently, under its own key and label', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(reading({ sevenDay: { utilization: 76, resetsAt: RESET_B } }));

        expect(notify).toHaveBeenCalledTimes(1);
        const [params] = notify.mock.calls[0];
        expect(params.dedupeKey).toBe(`sevenDay:75:${RESET_B.getTime()}`);
        expect(params.text).toBe('Quota: the weekly window has passed 75% (now 76%) of the shared Claude subscription.');
    });

    test('a staler reading of the same window instance (the other role\'s ledger, one turn behind) neither re-notes nor reports a reset', () => {
        const notes = createQuotaNotes({ notify, perchPauseAtPercent: 90 });

        notes.record(fiveHour(92));
        notes.record(fiveHour(80));

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notes.isPaused()).toBe(true);
    });

    test('a reading from an ALREADY-ENDED window instance is ignored outright — the other role\'s ledger is sticky and re-delivers the old window long after the reset', () => {
        const notes = createQuotaNotes({ notify, perchPauseAtPercent: 90 });

        // Perch sees the rollover: instance A peaked at 92, instance B opens at 2.
        notes.record(fiveHour(92));
        notes.record(fiveHour(2, RESET_B));
        expect(notes.isPaused()).toBe(false);

        // The conversation ledger's own quota is still instance A's — an older `resetsAt` is a
        // stale reading, never a new instance, so it must not reinstate the ended peak.
        notes.record(fiveHour(92));

        expect(notes.isPaused()).toBe(false);
        // The reset note (once) and instance A's own 90% note (once) — nothing more.
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[1][0].dedupeKey).toBe(`fiveHour:reset:${RESET_B.getTime()}`);
    });

    test('a stale reading does not consume the new instance\'s thresholds: the next genuine reading still notes them under the new key', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(30));
        notes.record(fiveHour(2, RESET_B));
        notes.record(fiveHour(92));
        notes.record(fiveHour(80, RESET_B));

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0].dedupeKey).toBe(`fiveHour:75:${RESET_B.getTime()}`);
        expect(notify.mock.calls[0][0].text).toBe('Quota: the five-hour window has passed 75% (now 80%) of the shared Claude subscription.');
    });

    test('a new window instance after the peak passed a threshold notes the reset, and re-arms the thresholds under the new key', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(92));
        notes.record(fiveHour(3, RESET_B));
        notes.record(fiveHour(80, RESET_B));

        expect(notify).toHaveBeenCalledTimes(3);
        const [resetParams] = notify.mock.calls[1];
        expect(resetParams.source).toBe('quota');
        expect(resetParams.wake).toBe(false);
        expect(resetParams.dedupeKey).toBe(`fiveHour:reset:${RESET_B.getTime()}`);
        expect(resetParams.text).toBe('Quota: the five-hour window has reset; it was at 92%.');
        expect(notify.mock.calls[2][0].dedupeKey).toBe(`fiveHour:75:${RESET_B.getTime()}`);
    });

    test('a reset is reported from the lowest threshold up, not only from the highest', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(80));
        notes.record(fiveHour(2, RESET_B));

        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[1][0].text).toBe('Quota: the five-hour window has reset; it was at 80%.');
    });

    test('a window whose peak reached exactly the lowest threshold still reports its reset', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(75));
        notes.record(fiveHour(1, RESET_B));

        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[1][0].text).toBe('Quota: the five-hour window has reset; it was at 75%.');
    });

    test('a window that rolls over without ever reaching a threshold reports nothing at all', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(40));
        notes.record(fiveHour(3, RESET_B));

        expect(notify).not.toHaveBeenCalled();
    });

    test('a threshold note the bridge could not deliver is retried on the next reading, then settles', () => {
        notify.mockReturnValueOnce(false);
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(80));
        notes.record(fiveHour(80));
        notes.record(fiveHour(80));

        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[1][0].dedupeKey).toBe(`fiveHour:75:${RESET_A.getTime()}`);
    });

    test('a reset note the bridge could not deliver is retried on the next reading, then settles', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(92));
        notify.mockReturnValueOnce(false);
        notes.record(fiveHour(3, RESET_B));
        notes.record(fiveHour(3, RESET_B));
        notes.record(fiveHour(3, RESET_B));

        expect(notify).toHaveBeenCalledTimes(3);
        expect(notify.mock.calls[1][0].dedupeKey).toBe(`fiveHour:reset:${RESET_B.getTime()}`);
        expect(notify.mock.calls[2][0]).toMatchObject({ dedupeKey: `fiveHour:reset:${RESET_B.getTime()}`, text: 'Quota: the five-hour window has reset; it was at 92%.' });
    });

    test('a ledger with no quota at all reports nothing', () => {
        const notes = createQuotaNotes({ notify });

        notes.record({ quota: undefined });

        expect(notify).not.toHaveBeenCalled();
    });

    test('a quota carrying only per-model weekly windows reports nothing — neither session paces itself against those', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(reading({ perModel: { seven_day_opus: { utilization: 97, resetsAt: RESET_B } } }));

        expect(notify).not.toHaveBeenCalled();
    });

    test('notifyAtPercents replaces the defaults outright', () => {
        const notes = createQuotaNotes({ notify, notifyAtPercents: [50] });

        notes.record(fiveHour(60));

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0].dedupeKey).toBe(`fiveHour:50:${RESET_A.getTime()}`);
    });

    test('a source that reports no resetsAt still notes thresholds, under a `none` key, and never claims a reset', () => {
        const notes = createQuotaNotes({ notify });

        notes.record(fiveHour(80, null));
        notes.record(fiveHour(95, null));

        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[0][0].dedupeKey).toBe('fiveHour:75:none');
        expect(notify.mock.calls[1][0].dedupeKey).toBe('fiveHour:90:none');
    });

    describe('isPaused (the perch quota ceiling)', () => {
        test('is false before any reading', () => {
            expect(createQuotaNotes({ notify, perchPauseAtPercent: 90 }).isPaused()).toBe(false);
        });

        test('is false below the ceiling and true at exactly the ceiling', () => {
            const notes = createQuotaNotes({ notify, perchPauseAtPercent: 90 });

            notes.record(fiveHour(89));
            expect(notes.isPaused()).toBe(false);

            notes.record(fiveHour(90));
            expect(notes.isPaused()).toBe(true);
        });

        test('an omitted perchPauseAtPercent disables the ceiling entirely', () => {
            const notes = createQuotaNotes({ notify });

            notes.record(fiveHour(99));

            expect(notes.isPaused()).toBe(false);
        });

        test('only the five-hour window pauses perch — a nearly-full weekly window does not', () => {
            const notes = createQuotaNotes({ notify, perchPauseAtPercent: 90 });

            notes.record(reading({ sevenDay: { utilization: 99, resetsAt: RESET_B } }));

            expect(notes.isPaused()).toBe(false);
        });

        test('self-clears when the five-hour window rolls over, with no restart', () => {
            const notes = createQuotaNotes({ notify, perchPauseAtPercent: 90 });

            notes.record(fiveHour(93));
            expect(notes.isPaused()).toBe(true);

            notes.record(fiveHour(4, RESET_B));
            expect(notes.isPaused()).toBe(false);
        });
    });
});
