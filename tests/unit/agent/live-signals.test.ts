/**
 * Tests for LiveSignals aggregator.
 *
 * All tests inject a frozen Luxon DateTime clock so they are timezone-aware
 * and deterministic.  No real timers are used.
 */

import { describe, test, expect, afterEach, spyOn, jest } from 'bun:test';
import * as loggerModule from '@hughescr/logger';
import { DateTime } from 'luxon';
import { LiveSignals, type LiveSignalsDeps, type RecentTool, type RecentChannel } from '@/agent/live-signals';
import { createChannelId } from '@/agent/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMEZONE = 'America/Los_Angeles';

/** Build a frozen clock that returns the given hour in the test timezone. */
function makeClock(hour: number, weekday = 1 /* Monday */): () => DateTime {
    // Luxon DateTime.fromObject with zone; set weekday-compatible date
    // Weekday: 1=Monday … 7=Sunday. Use a known Monday (2026-01-05).
    const baseDate = { year: 2026, month: 1, day: 5 }; // Monday
    // Advance day to match requested weekday
    const dt = DateTime
        .fromObject({ ...baseDate, hour, minute: 0, second: 0, millisecond: 0 }, { zone: TIMEZONE })
        .plus({ days: weekday - 1 });
    return () => dt;
}

function makeDefaultDeps(overrides: Partial<LiveSignalsDeps> = {}): LiveSignalsDeps {
    return {
        timezone:           TIMEZONE,
        now:                makeClock(10),
        getRecentTools:     () => [],
        getRecentChannels:  () => [],
        resolveChannelName: () => undefined,
        getPreviousStatus:  () => undefined,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.concurrent('LiveSignals.snapshot()', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // already restored
            }
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    // -------------------------------------------------------------------------
    // perch signal
    // -------------------------------------------------------------------------
    describe.concurrent('perch signal', () => {
        test('returns the current slot hint when in a named slot', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(10) })).snapshot();
            const perch = signals.find(s => s.kind === 'perch');
            expect(perch).toBeDefined();
            expect(perch!.label).toBe('perch');
            expect(perch!.content).toContain('Morning work hours');
        });

        test('returns "between scheduled slots" when unscheduled (hour 8)', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(8) })).snapshot();
            const perch = signals.find(s => s.kind === 'perch');
            expect(perch).toBeDefined();
            expect(perch!.content).toBe('between scheduled slots');
        });

        test('returns pre-dawn hint for hour 5', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(5) })).snapshot();
            const perch = signals.find(s => s.kind === 'perch');
            expect(perch!.content).toContain('Craig wakes around 7am');
        });

        test('returns late-night hint for hour 23', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(23) })).snapshot();
            const perch = signals.find(s => s.kind === 'perch');
            expect(perch!.content).toContain('Late night');
        });
    });

    // -------------------------------------------------------------------------
    // perch-next signal
    // -------------------------------------------------------------------------
    describe.concurrent('perch-next signal', () => {
        test('shows next slot with hours-until prefix (from mid-morning → wikipedia in ~2h)', async () => {
            // mid-morning (9-11), hour 9 → next is wikipedia (starts 12), 3h away
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(9) })).snapshot();
            const next = signals.find(s => s.kind === 'perch-next');
            expect(next).toBeDefined();
            expect(next!.label).toBe('perch-next');
            expect(next!.content).toMatch(/^next slot in 3h:/);
            expect(next!.content).toContain('Lunchtime breadth exploration');
        });

        test('uses singular "1h" when exactly 1 hour away', async () => {
            // evening is 18-20, hour 17 is unscheduled → next is evening at 18, 1h away
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(17) })).snapshot();
            const next = signals.find(s => s.kind === 'perch-next');
            expect(next).toBeDefined();
            expect(next!.content).toMatch(/^next slot in 1h:/);
        });

        test('wraps around from late-night to pre-dawn', async () => {
            // hour 23 is late-night → next is pre-dawn (startHour 5), 6h away
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(23) })).snapshot();
            const next = signals.find(s => s.kind === 'perch-next');
            expect(next).toBeDefined();
            expect(next!.content).toMatch(/^next slot in 6h:/);
            expect(next!.content).toContain('Craig wakes around 7am');
        });

        test('wraps around from late-night hour 0 to pre-dawn', async () => {
            // hour 0 is late-night → next is pre-dawn at 5, 5h away
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(0) })).snapshot();
            const next = signals.find(s => s.kind === 'perch-next');
            expect(next).toBeDefined();
            expect(next!.content).toMatch(/^next slot in 5h:/);
        });
    });

    // -------------------------------------------------------------------------
    // time signal
    // -------------------------------------------------------------------------
    describe.concurrent('time signal', () => {
        test.each<[number, string]>([
            [0, 'deep night'],
            [3, 'deep night'],
            [4, 'deep night'],
            [5, 'pre-dawn'],
            [6, 'pre-dawn'],
            [7, 'early morning'],
            [8, 'early morning'],
            [9, 'late morning'],
            [11, 'late morning'],
            [12, 'midday'],
            [13, 'midday'],
            [14, 'early afternoon'],
            [15, 'early afternoon'],
            [16, 'late afternoon'],
            [17, 'late afternoon'],
            [18, 'evening'],
            [20, 'evening'],
            [21, 'late evening'],
            [22, 'late evening'],
            [23, 'late night'],
        ])('hour %d → %s', async (hour, expected) => {
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(hour) })).snapshot();
            const time = signals.find(s => s.kind === 'time');
            expect(time).toBeDefined();
            expect(time!.content).toBe(expected);
            expect(time!.label).toBe('time');
        });
    });

    // -------------------------------------------------------------------------
    // day signal
    // -------------------------------------------------------------------------
    describe.concurrent('day signal', () => {
        test.each<[number, string]>([
            [1, 'Monday'],
            [2, 'Tuesday'],
            [3, 'Wednesday'],
            [4, 'Thursday'],
            [5, 'Friday'],
            [6, 'Saturday'],
            [7, 'Sunday'],
        ])('weekday %d → day name contains %s', async (weekday, dayName) => {
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(10, weekday) })).snapshot();
            const day = signals.find(s => s.kind === 'day');
            expect(day).toBeDefined();
            expect(day!.label).toBe('day');
            expect(day!.content).toContain(dayName);
        });

        test('content includes time-of-day bucket', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ now: makeClock(14, 3) })).snapshot();
            const day = signals.find(s => s.kind === 'day');
            expect(day!.content).toContain('early afternoon');
            expect(day!.content).toContain('Wednesday');
        });
    });

    // -------------------------------------------------------------------------
    // tool signal
    // -------------------------------------------------------------------------
    describe.concurrent('tool signal', () => {
        test('returns undefined (signal omitted) when ring buffer is empty', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ getRecentTools: () => [] })).snapshot();
            expect(signals.find(s => s.kind === 'tool')).toBeUndefined();
        });

        test('returns the most recent tool with relative time', async () => {
            const now = Date.now();
            const tools: RecentTool[] = [
                { toolName: 'memory.recall',  timestamp: now - 22 * 60 * 1000 },
                { toolName: 'bsky.getFeed',   timestamp: now - 11 * 60 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({ getRecentTools: () => tools })).snapshot();
            const tool = signals.find(s => s.kind === 'tool');
            expect(tool).toBeDefined();
            expect(tool!.label).toBe('tool');
            expect(tool!.content).toBe('11m ago: bsky.getFeed');
        });

        test('shows "just now" when timestamp is very recent (< 60s)', async () => {
            const tools: RecentTool[] = [
                { toolName: 'wikipedia.get', timestamp: Date.now() - 30 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({ getRecentTools: () => tools })).snapshot();
            const tool = signals.find(s => s.kind === 'tool');
            expect(tool!.content).toBe('just now: wikipedia.get');
        });

        test('shows "1m ago" when timestamp is exactly 60 seconds ago (boundary)', async () => {
            const tools: RecentTool[] = [
                { toolName: 'search.query', timestamp: Date.now() - 60 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({ getRecentTools: () => tools })).snapshot();
            const tool = signals.find(s => s.kind === 'tool');
            expect(tool!.content).toBe('1m ago: search.query');
        });

        test('shows "1h ago" when timestamp is exactly 60 minutes ago (boundary)', async () => {
            const tools: RecentTool[] = [
                { toolName: 'memory.store', timestamp: Date.now() - 60 * 60 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({ getRecentTools: () => tools })).snapshot();
            const tool = signals.find(s => s.kind === 'tool');
            expect(tool!.content).toBe('1h ago: memory.store');
        });

        test('shows hours for old entries', async () => {
            const tools: RecentTool[] = [
                { toolName: 'calendar.list', timestamp: Date.now() - 2 * 60 * 60 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({ getRecentTools: () => tools })).snapshot();
            const tool = signals.find(s => s.kind === 'tool');
            expect(tool!.content).toBe('2h ago: calendar.list');
        });
    });

    // -------------------------------------------------------------------------
    // channel signal
    // -------------------------------------------------------------------------
    describe.concurrent('channel signal', () => {
        const chanId = createChannelId('123456789');

        test('returns undefined when ring buffer is empty', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ getRecentChannels: () => [] })).snapshot();
            expect(signals.find(s => s.kind === 'channel')).toBeUndefined();
        });

        test('resolves channel name from callback', async () => {
            const now = Date.now();
            const channels: RecentChannel[] = [
                { channelId: chanId, timestamp: now - 5 * 60 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({
                getRecentChannels:  () => channels,
                resolveChannelName: () => 'general',
            })).snapshot();
            const channel = signals.find(s => s.kind === 'channel');
            expect(channel).toBeDefined();
            expect(channel!.label).toBe('channel');
            expect(channel!.content).toBe('5m ago: #general');
        });

        test('falls back to raw ID with #? prefix when resolver returns undefined', async () => {
            const now = Date.now();
            const channels: RecentChannel[] = [
                { channelId: chanId, timestamp: now - 3 * 60 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({
                getRecentChannels:  () => channels,
                resolveChannelName: () => undefined,
            })).snapshot();
            const channel = signals.find(s => s.kind === 'channel');
            expect(channel!.content).toBe(`3m ago: #?${chanId}`);
        });

        test('uses most-recent entry when multiple channels in buffer', async () => {
            const now = Date.now();
            const chanId2 = createChannelId('999888777');
            const channels: RecentChannel[] = [
                { channelId: chanId,  timestamp: now - 10 * 60 * 1000 },
                { channelId: chanId2, timestamp: now - 2 * 60 * 1000 },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({
                getRecentChannels:  () => channels,
                resolveChannelName: id => (id === chanId2 ? 'private' : undefined),
            })).snapshot();
            const channel = signals.find(s => s.kind === 'channel');
            expect(channel!.content).toBe('2m ago: #private');
        });
    });

    // -------------------------------------------------------------------------
    // previous signal
    // -------------------------------------------------------------------------
    describe.concurrent('previous signal', () => {
        test('is omitted when getPreviousStatus returns undefined', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({ getPreviousStatus: () => undefined })).snapshot();
            expect(signals.find(s => s.kind === 'previous')).toBeUndefined();
        });

        test('is included with previous status text', async () => {
            const signals = await new LiveSignals(makeDefaultDeps({
                getPreviousStatus: () => 'Mind tangled in diaspora threads',
            })).snapshot();
            const prev = signals.find(s => s.kind === 'previous');
            expect(prev).toBeDefined();
            expect(prev!.label).toBe('previous');
            expect(prev!.content).toBe('Mind tangled in diaspora threads');
        });
    });

    // -------------------------------------------------------------------------
    // fail-soft behaviour
    // -------------------------------------------------------------------------
    describe.concurrent('fail-soft when a signal source throws', () => {
        test('omits throwing signal but returns all others', async () => {
            const debugSpy = spyOn(loggerModule.logger, 'debug');
            spies.push(debugSpy);

            const deps = makeDefaultDeps({
                // perch-next would call getNextSlot which can throw for bad hour,
                // but getSlotConfig can also return undefined which would short-circuit.
                // To test fail-soft, we override `now` to return something non-throwing
                // but inject a bad getRecentTools that throws.
                getRecentTools: () => {
                    throw new Error('ring buffer exploded');
                },
            });

            const signals = await new LiveSignals(deps).snapshot();

            // tool signal should be absent
            expect(signals.find(s => s.kind === 'tool')).toBeUndefined();

            // all other cheap signals should still be present
            expect(signals.find(s => s.kind === 'perch')).toBeDefined();
            expect(signals.find(s => s.kind === 'time')).toBeDefined();
            expect(signals.find(s => s.kind === 'day')).toBeDefined();
            expect(signals.find(s => s.kind === 'perch-next')).toBeDefined();

            // debug log should have been called
            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({ msg: 'LiveSignals: signal source threw, omitting' })
            );
        });

        test('continues after multiple signal sources throw', async () => {
            const debugSpy = spyOn(loggerModule.logger, 'debug');
            spies.push(debugSpy);

            const deps = makeDefaultDeps({
                getRecentTools: () => {
                    throw new Error('tools broken');
                },
                getRecentChannels: () => {
                    throw new Error('channels broken');
                },
            });

            const signals = await new LiveSignals(deps).snapshot();

            // Both tool and channel absent
            expect(signals.find(s => s.kind === 'tool')).toBeUndefined();
            expect(signals.find(s => s.kind === 'channel')).toBeUndefined();

            // Core signals still present
            expect(signals.find(s => s.kind === 'perch')).toBeDefined();
            expect(signals.find(s => s.kind === 'time')).toBeDefined();

            // Both broken sources should have triggered debug logs — filter to ours only
            // (concurrent test execution may add extra debug calls from sibling tests)
            const liveSignalDebugCalls = debugSpy.mock.calls.filter((args: unknown[]) => {
                const arg = args[0];
                if(typeof arg !== 'object' || arg === null) {
                    return false;
                }
                const record = arg as Record<string, unknown>;
                return record.msg === 'LiveSignals: signal source threw, omitting';
            });
            expect(liveSignalDebugCalls.length).toBeGreaterThanOrEqual(2);
        });
    });

    // -------------------------------------------------------------------------
    // overall snapshot shape
    // -------------------------------------------------------------------------
    describe.concurrent('snapshot shape', () => {
        test('with no ring-buffer entries or previous status, returns exactly perch+perch-next+time+day', async () => {
            const signals = await new LiveSignals(makeDefaultDeps()).snapshot();
            const kinds = signals.map(s => s.kind);
            expect(kinds).toContain('perch');
            expect(kinds).toContain('perch-next');
            expect(kinds).toContain('time');
            expect(kinds).toContain('day');
            expect(kinds).not.toContain('tool');
            expect(kinds).not.toContain('channel');
            expect(kinds).not.toContain('previous');
        });

        test('with all deps populated, returns all 7 signal kinds', async () => {
            const now = Date.now();
            const deps = makeDefaultDeps({
                getRecentTools:     () => [{ toolName: 'search', timestamp: now - 1000 }],
                getRecentChannels:  () => [{ channelId: createChannelId('111'), timestamp: now - 2000 }],
                resolveChannelName: () => 'general',
                getPreviousStatus:  () => 'previous text',
            });
            const signals = await new LiveSignals(deps).snapshot();
            const kinds = signals.map(s => s.kind);
            expect(kinds).toContain('perch');
            expect(kinds).toContain('perch-next');
            expect(kinds).toContain('time');
            expect(kinds).toContain('day');
            expect(kinds).toContain('tool');
            expect(kinds).toContain('channel');
            expect(kinds).toContain('previous');
        });

        test('every signal has non-empty kind, label, and content', async () => {
            const now = Date.now();
            const deps = makeDefaultDeps({
                getRecentTools:     () => [{ toolName: 'search', timestamp: now - 1000 }],
                getRecentChannels:  () => [{ channelId: createChannelId('222'), timestamp: now - 2000 }],
                resolveChannelName: () => 'general',
                getPreviousStatus:  () => 'prev',
            });
            const signals = await new LiveSignals(deps).snapshot();
            for(const s of signals) {
                expect(typeof s.kind).toBe('string');
                expect(s.kind.length).toBeGreaterThan(0);
                expect(typeof s.label).toBe('string');
                expect(s.label.length).toBeGreaterThan(0);
                expect(typeof s.content).toBe('string');
                expect(s.content.length).toBeGreaterThan(0);
            }
        });
    });
});
