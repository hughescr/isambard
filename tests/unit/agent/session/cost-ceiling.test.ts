/**
 * Tests for the daily cost ceiling (Q3 / plan amendment B4): a day-bucketed spend accumulator,
 * independent of `ledger.cost.cumulativeUsd`'s `session_opened` reset, that pauses perch (never
 * Discord) once the day's total crosses a configured USD ceiling, self-clears at local midnight,
 * and survives a process restart via an injected persistence adapter.
 */
import { describe, test, expect, mock, jest, spyOn, afterEach } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import { createCostCeiling, type CostCeilingSnapshot } from '@/agent/session/cost-ceiling';
import { initialLedger, type Ledger, type LedgerEvent } from '@/agent/session/ledger';

/** A minimal ledger fixture carrying only the `cost.cumulativeUsd` field the ceiling reads. */
function ledgerWithCost(cumulativeUsd: number, role: Ledger['role'] = 'conversation'): Ledger {
    return { ...initialLedger(role), cost: { cumulativeUsd, lastTurnUsd: 0 } };
}

/** A harmless, cost-unrelated ledger event — the ceiling is deliberately event-type-agnostic. */
function tickEvent(at: Date): LedgerEvent {
    return { type: 'tick', rssBytes: 0, at };
}

/**
 * Baselines `store` at $0 cumulative spend, mirroring production: the ceiling subscribes to a
 * fresh `LedgerStore` (`cumulativeUsd` still 0) at construction, so a store's very first `record()`
 * call baselines to 0 and every later delta counts in full.
 */
function primeStore(ceiling: { record: (identity: unknown, ledger: Ledger, event: LedgerEvent) => void }, store: unknown, at: Date): void {
    ceiling.record(store, ledgerWithCost(0), tickEvent(at));
}

const T0 = Date.parse('2026-09-05T12:00:00.000Z');

// Real IANA DST transitions in America/New_York for 2026 (verified via Luxon):
// spring-forward 2026-03-08 is a 23-hour local day; fall-back 2026-11-01 is a 25-hour local day.
const SPRING_LOCAL_MIDNIGHT = Date.parse('2026-03-08T05:00:00.000Z');
const FALL_LOCAL_MIDNIGHT = Date.parse('2026-11-01T04:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

// tests/setup.ts's global Intl.DateTimeFormat mock gives every zone a single fixed offset (no
// DST — 'America/New_York' is always EST/-5), so it cannot exercise a real spring-forward/
// fall-back transition. Real, once-off transition instants for 2026 (verified via Luxon outside
// the mocked test environment): EDT (-4h) runs from 2026-03-08T07:00:00Z to 2026-11-01T06:00:00Z.
const NY_SPRING_TRANSITION_UTC = Date.parse('2026-03-08T07:00:00.000Z');
const NY_FALL_TRANSITION_UTC = Date.parse('2026-11-01T06:00:00.000Z');

/**
 * Overrides `Intl.DateTimeFormat.prototype.formatToParts` so that, for `America/New_York` in
 * Luxon's own default-branch shape (the request `IANAZone.js`'s `makeDTF` issues — no `weekday`,
 * no `timeZoneName`, not hour-only), the offset actually flips across the real 2026 DST
 * transition instants above instead of staying pinned at the setup mock's fixed -5h. Every other
 * zone/shape delegates to the original (setup-mocked) implementation unchanged.
 */
function mockRealNewYorkDst(): void {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function(this: Intl.DateTimeFormat, date?: Date | number) {
        const options = (this as unknown as { options: Intl.DateTimeFormatOptions }).options;
        const isLuxonOffsetQuery = options.timeZone === 'America/New_York' && !options.weekday && !options.timeZoneName && !(options.hour && !options.minute);
        if(!isLuxonOffsetQuery) {
            return original.call(this, date);
        }
        const ms = date instanceof Date ? date.getTime() : (date ?? Date.now());
        const isEdt = ms >= NY_SPRING_TRANSITION_UTC && ms < NY_FALL_TRANSITION_UTC;
        const offsetMs = (isEdt ? -4 : -5) * HOUR_MS;
        const d = new Date(ms + offsetMs);
        return [
            { type: 'year', value: String(d.getUTCFullYear()) },
            { type: 'month', value: String(d.getUTCMonth() + 1).padStart(2, '0') },
            { type: 'day', value: String(d.getUTCDate()).padStart(2, '0') },
            { type: 'hour', value: String(d.getUTCHours()).padStart(2, '0') },
            { type: 'minute', value: String(d.getUTCMinutes()).padStart(2, '0') },
            { type: 'second', value: String(d.getUTCSeconds()).padStart(2, '0') },
        ] satisfies Intl.DateTimeFormatPart[];
    });
}

function mockLogger(): { warn: ReturnType<typeof mock>, info: ReturnType<typeof mock> } {
    return { warn: mock(() => {}), info: mock(() => {}) };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('createCostCeiling — accumulation', () => {
    test('accumulates deltas from two distinct store identities into one shared day bucket', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 1 });
        const storeA = { name: 'conversation' };
        const storeB = { name: 'perch' };
        primeStore(ceiling, storeA, new Date(T0));
        primeStore(ceiling, storeB, new Date(T0));

        ceiling.record(storeA, ledgerWithCost(0.4), tickEvent(new Date(T0)));
        ceiling.record(storeB, ledgerWithCost(0.5), tickEvent(new Date(T0)));

        expect(ceiling.snapshot().totalUsd).toBeCloseTo(0.9);
        expect(ceiling.isPaused()).toBe(false);
    });

    test('pauses at >= ceiling, not only strictly >', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 0.9 });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(0.9), tickEvent(new Date(T0)));

        expect(ceiling.isPaused()).toBe(true);
    });

    test('a repeat record() with an unchanged cumulativeUsd adds nothing', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 10 });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(0.5), tickEvent(new Date(T0)));
        ceiling.record(store, ledgerWithCost(0.5), tickEvent(new Date(T0)));

        expect(ceiling.snapshot().totalUsd).toBeCloseTo(0.5);
    });

    test('the first record() for a store baselines rather than booking its whole prior spend', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 10 });
        const store = { name: 'conversation' };

        // A store that already had $3 of cumulative spend before the ceiling ever saw it (e.g. a
        // long-running store subscribed after boot) must not book that $3 as today's delta.
        ceiling.record(store, ledgerWithCost(3), tickEvent(new Date(T0)));

        expect(ceiling.snapshot().totalUsd).toBeCloseTo(0);
    });

    test('a session_opened-style reset does not book a negative delta or zero the bucket; the next delta is measured from the new baseline', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 10 });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(0.5), tickEvent(new Date(T0)));
        ceiling.record(store, ledgerWithCost(0), tickEvent(new Date(T0))); // reset: cumulativeUsd drops to 0
        ceiling.record(store, ledgerWithCost(0.2), tickEvent(new Date(T0)));

        expect(ceiling.snapshot().totalUsd).toBeCloseTo(0.7);
    });

    test('ceilingUsd undefined never pauses regardless of spend', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC' });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(1000), tickEvent(new Date(T0)));

        expect(ceiling.isPaused()).toBe(false);
    });
});

describe('createCostCeiling — local-midnight rollover', () => {
    test('advancing the clock past local midnight resets the bucket and clears isPaused()', () => {
        const clock = new FakeClock(T0); // 2026-09-05T12:00:00Z, UTC
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 0.1 });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(0.2), tickEvent(new Date(T0)));
        expect(ceiling.isPaused()).toBe(true);

        clock.advance(13 * HOUR_MS); // now 2026-09-06T01:00:00Z — past local midnight in UTC

        expect(ceiling.isPaused()).toBe(false);
        expect(ceiling.snapshot().totalUsd).toBe(0);
    });

    test('a DST 23-hour local day (America/New_York spring-forward) rolls over exactly once', () => {
        mockRealNewYorkDst();
        const clock = new FakeClock(SPRING_LOCAL_MIDNIGHT);
        const ceiling = createCostCeiling({ clock, timezone: 'America/New_York', ceilingUsd: 10 });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(SPRING_LOCAL_MIDNIGHT));

        ceiling.record(store, ledgerWithCost(1), tickEvent(new Date(SPRING_LOCAL_MIDNIGHT)));
        expect(ceiling.snapshot().dateKey).toBe('2026-03-08');

        clock.advance(23 * HOUR_MS - 1); // one ms before the next local midnight
        expect(ceiling.snapshot().dateKey).toBe('2026-03-08');
        expect(ceiling.snapshot().totalUsd).toBeCloseTo(1);

        clock.advance(1); // exactly the next local midnight
        expect(ceiling.snapshot().dateKey).toBe('2026-03-09');
        expect(ceiling.snapshot().totalUsd).toBe(0);
    });

    test('a DST 25-hour local day (America/New_York fall-back) rolls over exactly once', () => {
        mockRealNewYorkDst();
        const clock = new FakeClock(FALL_LOCAL_MIDNIGHT);
        const ceiling = createCostCeiling({ clock, timezone: 'America/New_York', ceilingUsd: 10 });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(FALL_LOCAL_MIDNIGHT));

        ceiling.record(store, ledgerWithCost(1), tickEvent(new Date(FALL_LOCAL_MIDNIGHT)));
        expect(ceiling.snapshot().dateKey).toBe('2026-11-01');

        clock.advance(25 * HOUR_MS - 1);
        expect(ceiling.snapshot().dateKey).toBe('2026-11-01');
        expect(ceiling.snapshot().totalUsd).toBeCloseTo(1);

        clock.advance(1);
        expect(ceiling.snapshot().dateKey).toBe('2026-11-02');
        expect(ceiling.snapshot().totalUsd).toBe(0);
    });
});

describe('createCostCeiling — logging visibility', () => {
    test('warns exactly once when the ceiling is first crossed, not on every subsequent record while still over', () => {
        const clock = new FakeClock(T0);
        const logger = mockLogger();
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 1, logger });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(1), tickEvent(new Date(T0)));
        ceiling.record(store, ledgerWithCost(1.5), tickEvent(new Date(T0)));
        ceiling.record(store, ledgerWithCost(2), tickEvent(new Date(T0)));

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    test('logs an info when a paused day clears at midnight', () => {
        const clock = new FakeClock(T0);
        const logger = mockLogger();
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 0.1, logger });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(0.2), tickEvent(new Date(T0)));
        expect(ceiling.isPaused()).toBe(true);

        clock.advance(13 * HOUR_MS);
        expect(ceiling.isPaused()).toBe(false);

        expect(logger.info).toHaveBeenCalledTimes(1);
    });

    test('does not log info on an uneventful midnight rollover that was never paused', () => {
        const clock = new FakeClock(T0);
        const logger = mockLogger();
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 10, logger });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(0.1), tickEvent(new Date(T0)));
        clock.advance(13 * HOUR_MS);
        ceiling.isPaused();

        expect(logger.info).not.toHaveBeenCalled();
    });
});

describe('createCostCeiling — snapshot/restore (B4)', () => {
    test('snapshot()/restore() round-trips the day bucket and paused flag across a process restart', () => {
        const clockBefore = new FakeClock(T0);
        const before = createCostCeiling({ clock: clockBefore, timezone: 'UTC', ceilingUsd: 1 });
        const store = { name: 'conversation' };
        primeStore(before, store, new Date(T0));

        before.record(store, ledgerWithCost(1.2), tickEvent(new Date(T0)));
        expect(before.isPaused()).toBe(true);
        const snap: CostCeilingSnapshot = before.snapshot();

        // Simulate a process restart: a fresh ceiling, same local day, hydrated from the snapshot.
        const clockAfter = new FakeClock(T0 + 5000);
        const after = createCostCeiling({ clock: clockAfter, timezone: 'UTC', ceilingUsd: 1 });
        after.restore(snap);

        expect(after.isPaused()).toBe(true);
        expect(after.snapshot().totalUsd).toBeCloseTo(1.2);

        // A store re-subscribing post-restart baselines against its now-current cumulative rather
        // than double-booking the pre-restart spend already folded into the restored bucket.
        after.record(store, ledgerWithCost(1.2), tickEvent(new Date(T0 + 5000)));
        expect(after.snapshot().totalUsd).toBeCloseTo(1.2);
    });

    test('restoring an already-stale (prior-day) snapshot rolls it over on the very next check and clears the pause — e.g. the process was down across a whole day', () => {
        const clock = new FakeClock(T0); // T0's local (UTC) day is 2026-09-05
        const logger = mockLogger();
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 1, logger });

        ceiling.restore({ dateKey: '2026-09-04', totalUsd: 5, paused: true });

        expect(ceiling.isPaused()).toBe(false);
        expect(ceiling.snapshot()).toEqual({ dateKey: '2026-09-05', totalUsd: 0, paused: false });
        expect(logger.info).toHaveBeenCalledTimes(1);

        // Stays cleared as the (now-current) day continues, rather than flapping back.
        clock.advance(HOUR_MS);
        expect(ceiling.isPaused()).toBe(false);
        expect(logger.info).toHaveBeenCalledTimes(1);
    });

    test('restoring a same-day paused snapshot keeps the pause until local midnight actually arrives', () => {
        const clock = new FakeClock(T0); // T0's local (UTC) day is 2026-09-05
        const logger = mockLogger();
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 1, logger });

        ceiling.restore({ dateKey: '2026-09-05', totalUsd: 5, paused: true });
        expect(ceiling.isPaused()).toBe(true);

        clock.advance(13 * HOUR_MS); // crosses into 2026-09-06 local (UTC) day

        expect(ceiling.isPaused()).toBe(false);
        expect(ceiling.snapshot().totalUsd).toBe(0);
        expect(logger.info).toHaveBeenCalledTimes(1);
    });
});

describe('createCostCeiling — persistence adapter wiring', () => {
    test('persists a snapshot through the injected persistence port when record() actually changes the bucket', () => {
        const clock = new FakeClock(T0);
        const save = mock(() => {});
        const ceiling = createCostCeiling({
            clock, timezone:    'UTC', ceilingUsd:  1,
            persistence: { load: mock(async () => undefined), save },
        });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(0.4), tickEvent(new Date(T0)));

        expect(save).toHaveBeenLastCalledWith({ dateKey: expect.any(String), totalUsd: 0.4, paused: false });
    });

    // Amplification finding: createLedgerStore notifies subscribers on every ledger-changing
    // event (each SDK frame, tick, envelope_queued, ...), not only when cumulativeUsd moves — a
    // repeat record() with an unchanged cumulativeUsd must not re-write an identical snapshot.
    test('does not persist again when a repeat record() leaves the snapshot unchanged (no ledger-notification write amplification)', () => {
        const clock = new FakeClock(T0);
        const save = mock(() => {});
        const ceiling = createCostCeiling({
            clock, timezone:    'UTC', ceilingUsd:  10,
            persistence: { load: mock(async () => undefined), save },
        });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));
        save.mockClear();

        ceiling.record(store, ledgerWithCost(0.4), tickEvent(new Date(T0)));
        expect(save).toHaveBeenCalledTimes(1);

        // Same cumulativeUsd again — e.g. a phase-transition or tick notification carrying no
        // new spend — must add nothing and must not write a byte-identical snapshot again.
        ceiling.record(store, ledgerWithCost(0.4), tickEvent(new Date(T0)));
        ceiling.record(store, ledgerWithCost(0.4), tickEvent(new Date(T0)));

        expect(save).toHaveBeenCalledTimes(1);
    });

    test('a midnight rollover persists the cleared snapshot even with no record() call in between (only isPaused()/snapshot() ticks it over)', () => {
        const clock = new FakeClock(T0);
        const save = mock(() => {});
        const ceiling = createCostCeiling({
            clock, timezone:    'UTC', ceilingUsd:  1,
            persistence: { load: mock(async () => undefined), save },
        });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));

        ceiling.record(store, ledgerWithCost(1.2), tickEvent(new Date(T0)));
        expect(ceiling.isPaused()).toBe(true);
        save.mockClear();

        clock.advance(13 * HOUR_MS); // past local midnight (UTC)
        expect(ceiling.isPaused()).toBe(false);

        expect(save).toHaveBeenLastCalledWith({ dateKey: expect.any(String), totalUsd: 0, paused: false });
    });
});

describe('createCostCeiling — record() rolls over its own bucket (not only isPaused()/snapshot())', () => {
    test('a record() called after local midnight rolls the bucket over first, so the new day\'s delta is not folded into (and then discarded with) yesterday\'s total', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 10 });
        const store = { name: 'conversation' };
        primeStore(ceiling, store, new Date(T0));
        const initialDateKey = ceiling.snapshot().dateKey;

        ceiling.record(store, ledgerWithCost(0.5), tickEvent(new Date(T0)));

        clock.advance(13 * HOUR_MS); // past local midnight (UTC) — no isPaused()/snapshot() call yet
        ceiling.record(store, ledgerWithCost(0.8), tickEvent(new Date(T0 + 13 * HOUR_MS))); // +0.3 delta

        const finalSnapshot = ceiling.snapshot();
        expect(finalSnapshot.dateKey).not.toBe(initialDateKey);
        expect(finalSnapshot.totalUsd).toBeCloseTo(0.3);
    });
});

describe('createCostCeiling — restore() re-evaluates the pause against the current ceiling (B4)', () => {
    test('a lowered ceiling re-arms the pause immediately on restore, even though the persisted flag says paused:false', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 5 });

        ceiling.restore({ dateKey: '2026-09-05', totalUsd: 12, paused: false });

        expect(ceiling.isPaused()).toBe(true);
    });

    test('an undefined ceilingUsd (operator kill switch) forces paused false on restore, even though the persisted flag says paused:true', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC' });

        ceiling.restore({ dateKey: '2026-09-05', totalUsd: 999, paused: true });

        expect(ceiling.isPaused()).toBe(false);
    });

    test('a raised ceiling clears an old pause on restore, even though the persisted flag says paused:true', () => {
        const clock = new FakeClock(T0);
        const ceiling = createCostCeiling({ clock, timezone: 'UTC', ceilingUsd: 100 });

        ceiling.restore({ dateKey: '2026-09-05', totalUsd: 12, paused: true });

        expect(ceiling.isPaused()).toBe(false);
    });
});
