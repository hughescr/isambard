/**
 * Tests for LiveSignals aggregator.
 *
 * All tests inject a frozen Luxon DateTime clock so they are timezone-aware
 * and deterministic.  No real timers are used.
 */

import { describe, test, expect, afterEach, spyOn, jest, mock } from 'bun:test';
import * as loggerModule from '@hughescr/logger';
import { DateTime } from 'luxon';
import { LiveSignals, type LiveSignalsDepsInternal, type RecentTool, type RecentChannel } from '@/agent/live-signals';
import { createChannelId } from '@/agent/types';
import type { BskyFeedItem, BskyNotification, BlueskyClient } from '@/integrations/bsky';
import type { MemoryToolItemData } from '@/storage';

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

function makeDefaultDeps(overrides: Partial<LiveSignalsDepsInternal> = {}): LiveSignalsDepsInternal {
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

        // FIX C: toolSignal must use this.getNowMs() so injected clock is respected
        test('FIX C: tool signal uses injected nowMs for deterministic relative-time output', async () => {
            // Fixed injected "now" = 1_000_000_000 ms epoch
            const fixedNowMs = 1_000_000_000;
            // Tool timestamp is exactly 11 minutes before fixedNowMs
            const toolTimestamp = fixedNowMs - 11 * 60 * 1000;
            const tools: RecentTool[] = [
                { toolName: 'memory.recall', timestamp: toolTimestamp },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({
                getRecentTools: () => tools,
                nowMs:          () => fixedNowMs,
            })).snapshot();
            const tool = signals.find(s => s.kind === 'tool');
            // With injectable clock, relative time is exactly 11m ago
            expect(tool).toBeDefined();
            expect(tool!.content).toBe('11m ago: memory.recall');
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

        // FIX C: channelSignal must use this.getNowMs() so injected clock is respected
        test('FIX C: channel signal uses injected nowMs for deterministic relative-time output', async () => {
            // Fixed injected "now" = 2_000_000_000 ms epoch
            const fixedNowMs = 2_000_000_000;
            // Channel timestamp is exactly 7 minutes before fixedNowMs
            const channelTimestamp = fixedNowMs - 7 * 60 * 1000;
            const channels: RecentChannel[] = [
                { channelId: chanId, timestamp: channelTimestamp },
            ];
            const signals = await new LiveSignals(makeDefaultDeps({
                getRecentChannels:  () => channels,
                resolveChannelName: () => 'test-chan',
                nowMs:              () => fixedNowMs,
            })).snapshot();
            const channel = signals.find(s => s.kind === 'channel');
            // With injectable clock, relative time is exactly 7m ago
            expect(channel).toBeDefined();
            expect(channel!.content).toBe('7m ago: #test-chan');
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

    // =========================================================================
    // Step 4: network-fetched signal tests
    // =========================================================================

    // -------------------------------------------------------------------------
    // Helpers and fake client factories
    // -------------------------------------------------------------------------

    function makeFeedItem(text: string, handle: string): BskyFeedItem {
        return {
            post: {
                uri:         `at://did:test/${handle}/1`,
                cid:         'cid1',
                author:      { did: `did:test:${handle}`, handle },
                text,
                createdAt:   '2026-01-01T00:00:00Z',
                replyCount:  0,
                likeCount:   0,
                repostCount: 0,
                indexedAt:   '2026-01-01T00:00:00Z',
            },
        };
    }

    function makeNotification(reason: BskyNotification['reason'], handle: string, indexedAt = '2026-05-03T10:00:00Z'): BskyNotification {
        return {
            reason,
            uri:    `at://did:test/${handle}/notif1`,
            author: { did: `did:test:${handle}`, handle },
            indexedAt,
        };
    }

    function makeActivityItem(
        activityType: string,
        updatedAt: string,
        tags = new Set<string>(['auto-logged', activityType])
    ): MemoryToolItemData {
        return {
            path:        `/events/activity/${activityType}/2026-01-01T00-00-00-000Z` as MemoryToolItemData['path'],
            content:     `[auto] ${activityType} happened`,
            contentType: 'text/plain',
            metadata:    {},
            createdAt:   updatedAt,
            updatedAt,
            tags,
        };
    }

    /** Manual logEvent item: /events/{eventType}/{ts} (one fewer path segment than auto-logged) */
    function makeManualEventItem(
        eventType: string,
        updatedAt: string
    ): MemoryToolItemData {
        return {
            path:        `/events/${eventType}/2026-01-01T00-00-00-000Z` as MemoryToolItemData['path'],
            content:     `${eventType} happened`,
            contentType: 'text/plain',
            metadata:    {},
            createdAt:   updatedAt,
            updatedAt,
        };
    }

    /** Full IdleSignalsConfig with all flags on and standard TTLs. */
    const FULL_CONFIG = {
        bskyDiscoverEnabled:      true,
        bskyForYouEnabled:        true,
        bskyNotificationsEnabled: true,
        activityLogEnabled:       true,
        bskyDiscoverCacheMs:      30 * 60_000,
        bskyForYouCacheMs:        30 * 60_000,
        bskyNotificationsCacheMs: 30 * 60_000,
        activityLogCacheMs:       15 * 60_000,
    } as const;

    /** Make a minimal BlueskyClient mock (only the methods LiveSignals calls). */
    function makeBskyClient(overrides: {
        getFeed?:          (name: string, limit?: number) => Promise<{ items: BskyFeedItem[], cursor?: string }>
        getNotifications?: (limit?: number) => Promise<{ notifications: BskyNotification[], cursor?: string }>
    } = {}): BlueskyClient {
        return {
            getFeed: mock(async (name: string, limit?: number): Promise<{ items: BskyFeedItem[], cursor?: string }> => {
                if(overrides.getFeed) {
                    return overrides.getFeed(name, limit);
                }
                return { items: [] };
            }),
            getNotifications: mock(async (_limit?: number): Promise<{ notifications: BskyNotification[], cursor?: string }> => {
                if(overrides.getNotifications) {
                    return overrides.getNotifications(_limit);
                }
                return { notifications: [] };
            }),
        } as unknown as BlueskyClient;
    }

    // -------------------------------------------------------------------------
    // bsky-discover
    // -------------------------------------------------------------------------
    describe('bsky-discover signals', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('happy path: cache populates and snapshot includes items', async () => {
            const item1 = makeFeedItem('Hello world', 'alice.bsky');
            const item2 = makeFeedItem('Another post', 'bob.bsky');
            const client = makeBskyClient({
                getFeed: async () => ({ items: [item1, item2] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const discover = signals.filter(s => s.kind === 'bsky-discover');
            expect(discover).toHaveLength(2);
            expect(discover[0].label).toBe('bsky-discover');
            expect(discover[0].content).toContain('Hello world');
            expect(discover[0].content).toContain('@alice.bsky');
            expect(discover[1].content).toContain('Another post');
        });

        test('cache hit: second call within TTL does not re-fetch', async () => {
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem('Post', 'alice.bsky')] }),
            });
            let nowMs = 1_000_000;
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
                nowMs:             () => nowMs,
            }));
            await ls.snapshot();
            nowMs += 60_000; // advance 1 minute — still within 30-min TTL
            const signals = await ls.snapshot();
            // getFeed should have been called only once (the first snapshot)
            const getFeedMock = client.getFeed as ReturnType<typeof mock>;
            expect(getFeedMock.mock.calls.filter(args => args[0] === 'discover').length).toBe(1);
            // Signal kind and label are correct from fresh cache path
            const discover = signals.filter(s => s.kind === 'bsky-discover');
            expect(discover).toHaveLength(1);
            expect(discover[0].label).toBe('bsky-discover');
        });

        test('cache fresh at exact TTL boundary: no background refresh when elapsed === ttlMs', async () => {
            let callCount = 0;
            const client = makeBskyClient({
                getFeed: async () => {
                    callCount++;
                    return { items: [makeFeedItem('Exact boundary post', 'alice.bsky')] };
                },
            });
            let nowMs = 1_000_000;
            const ttlMs = 5000;
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false, bskyDiscoverCacheMs: ttlMs },
                nowMs:             () => nowMs,
            }));
            // First call: cold start, populates cache
            await ls.snapshot();
            expect(callCount).toBe(1);
            // Advance to exactly ttlMs elapsed — cache should still be fresh (> not >=)
            nowMs += ttlMs;
            await ls.snapshot();
            // Flush any microtasks — a stale path would kick a background refresh
            await Promise.resolve();
            await Promise.resolve();
            // Still fresh: no second fetch triggered (elapsed === ttlMs, NOT > ttlMs)
            expect(callCount).toBe(1);
        });

        test('cache miss: stale entry triggers background refresh; snapshot returns cached items', async () => {
            const item = makeFeedItem('Old post', 'alice.bsky');
            let callCount = 0;
            const client = makeBskyClient({
                getFeed: async () => {
                    callCount++;
                    return { items: [item] };
                },
            });
            let nowMs = 1_000_000;
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false, bskyDiscoverCacheMs: 5000 },
                nowMs:             () => nowMs,
            }));
            // First call: cold start, populates cache
            await ls.snapshot();
            expect(callCount).toBe(1);
            // Advance past TTL
            nowMs += 10_000;
            // Second call: stale — returns cached items and fires background refresh
            const signals = await ls.snapshot();
            // Returns the stale cached items immediately (non-blocking)
            const discover = signals.filter(s => s.kind === 'bsky-discover');
            expect(discover).toHaveLength(1);
            expect(discover[0].label).toBe('bsky-discover');
            // Background refresh should eventually complete (await it)
            await Promise.resolve();
            await Promise.resolve();
            expect(callCount).toBe(2);
        });

        test('first-call timeout: snapshot returns empty if initial fetch takes too long', async () => {
            // getFeed hangs — never resolves during the test
            const client = makeBskyClient({
                getFeed: async () => new Promise<{ items: BskyFeedItem[] }>(() => {
                    // never resolves
                }),
            });
            // Override setTimeout so the bootstrap timer fires immediately
            const originalSetTimeout = globalThis.setTimeout;

            (globalThis as unknown as Record<string, unknown>).setTimeout = (fn: () => void) => {
                fn();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim for return type
                return 0 as any;
            };
            try {
                const ls = new LiveSignals(makeDefaultDeps({
                    bskyClient:        client,
                    idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
                }));
                const signals = await ls.snapshot();
                expect(signals.filter(s => s.kind === 'bsky-discover')).toHaveLength(0);
            } finally {
                (globalThis as unknown as Record<string, unknown>).setTimeout = originalSetTimeout;
            }
        });

        test('feature flag off: no fetch, no signals', async () => {
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem('Post', 'alice.bsky')] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.filter(s => s.kind === 'bsky-discover')).toHaveLength(0);
            const getFeedMock = client.getFeed as ReturnType<typeof mock>;
            expect(getFeedMock.mock.calls.filter(args => args[0] === 'discover').length).toBe(0);
        });

        test('missing bskyClient: bsky-discover signals are skipped without errors', async () => {
            const ls = new LiveSignals(makeDefaultDeps({
                idleSignalsConfig: FULL_CONFIG,
            }));
            const signals = await ls.snapshot();
            expect(signals.filter(s => s.kind === 'bsky-discover')).toHaveLength(0);
        });

        test('bsky-discover error isolation: other signals still returned', async () => {
            const debugSpy = spyOn(loggerModule.logger, 'debug');
            const client = makeBskyClient({
                getFeed: async (name: string) => {
                    if(name === 'discover') {
                        throw new Error('bsky discover down');
                    }
                    return { items: [] };
                },
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.find(s => s.kind === 'perch')).toBeDefined();
            expect(signals.find(s => s.kind === 'time')).toBeDefined();
            // Debug log should mention the failure
            const discoverFailCalls = debugSpy.mock.calls.filter((args: unknown[]) => {
                const arg = args[0];
                if(typeof arg !== 'object' || arg === null) {
                    return false;
                }
                const r = arg as Record<string, unknown>;
                return typeof r.msg === 'string' && r.msg.includes('bsky-discover');
            });
            expect(discoverFailCalls.length).toBeGreaterThanOrEqual(1);
            debugSpy.mockRestore();
        });

        test('truncates long post text to 120 chars and appends ellipsis', async () => {
            const longText = 'A'.repeat(130);
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem(longText, 'alice.bsky')] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const discover = signals.find(s => s.kind === 'bsky-discover');
            expect(discover!.content).toContain('…');
            // snippet portion is exactly 120 A's — NOT 121+
            expect(discover!.content).toContain('A'.repeat(120));
            expect(discover!.content).not.toContain('A'.repeat(121));
        });

        test('text at exactly 120 chars is NOT truncated (boundary: > not >=)', async () => {
            const exactText = 'B'.repeat(120);
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem(exactText, 'alice.bsky')] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const discover = signals.find(s => s.kind === 'bsky-discover');
            // Exactly at boundary: should not be truncated
            expect(discover!.content).not.toContain('…');
            expect(discover!.content).toContain('B'.repeat(120));
        });

        test('short text is not truncated', async () => {
            const shortText = 'Short post';
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem(shortText, 'alice.bsky')] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const discover = signals.find(s => s.kind === 'bsky-discover');
            expect(discover!.content).not.toContain('…');
            expect(discover!.content).toContain('Short post');
        });

        test('newlines in post text are replaced with spaces and leading/trailing spaces are trimmed', async () => {
            // Leading/trailing newlines become spaces, which are then trimmed
            const multiline = '\nLine one\nLine two\n';
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem(multiline, 'alice.bsky')] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const discover = signals.find(s => s.kind === 'bsky-discover');
            // Content should not contain newlines
            expect(discover!.content).not.toContain('\n');
            // Leading/trailing spaces from newline replacement should be trimmed
            // Without trim: content would be '" Line one Line two " — @alice.bsky'
            // With trim: content would be '"Line one Line two" — @alice.bsky'
            expect(discover!.content).toContain('"Line one Line two"');
        });
    });

    // -------------------------------------------------------------------------
    // bsky-foryou
    // -------------------------------------------------------------------------
    describe('bsky-foryou signals', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('happy path: populates from for-you feed', async () => {
            const items = [
                makeFeedItem('For you post 1', 'alice.bsky'),
                makeFeedItem('For you post 2', 'bob.bsky'),
            ];
            const client = makeBskyClient({
                getFeed: async (name: string) => (name === 'for-you' ? { items } : { items: [] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const forYou = signals.filter(s => s.kind === 'bsky-foryou');
            expect(forYou).toHaveLength(2);
            expect(forYou[0].label).toBe('bsky-foryou');
            expect(forYou[0].content).toContain('For you post 1');
        });

        test('cache hit: second call within TTL does not re-fetch for-you', async () => {
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem('Post', 'alice.bsky')] }),
            });
            let nowMs = 2_000_000;
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
                nowMs:             () => nowMs,
            }));
            await ls.snapshot();
            nowMs += 60_000;
            const signals = await ls.snapshot();
            const getFeedMock = client.getFeed as ReturnType<typeof mock>;
            expect(getFeedMock.mock.calls.filter(args => args[0] === 'for-you').length).toBe(1);
            // Signal kind and label are correct from fresh cache path
            const forYou = signals.filter(s => s.kind === 'bsky-foryou');
            expect(forYou).toHaveLength(1);
            expect(forYou[0].label).toBe('bsky-foryou');
        });

        test('cache miss: stale entry triggers background refresh; snapshot returns cached items', async () => {
            const item = makeFeedItem('Old for-you post', 'bob.bsky');
            let callCount = 0;
            const client = makeBskyClient({
                getFeed: async () => {
                    callCount++;
                    return { items: [item] };
                },
            });
            let nowMs = 3_000_000;
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false, bskyForYouCacheMs: 5000 },
                nowMs:             () => nowMs,
            }));
            // First call: cold start, populates cache
            await ls.snapshot();
            expect(callCount).toBe(1);
            // Advance past TTL
            nowMs += 10_000;
            // Second call: stale — returns cached items and fires background refresh
            const signals = await ls.snapshot();
            // Returns the stale cached items immediately (non-blocking)
            const forYou = signals.filter(s => s.kind === 'bsky-foryou');
            expect(forYou).toHaveLength(1);
            // Background refresh should eventually complete (await it)
            await Promise.resolve();
            await Promise.resolve();
            expect(callCount).toBe(2);
        });

        test('feature flag off: for-you is skipped', async () => {
            const client = makeBskyClient({
                getFeed: async () => ({ items: [makeFeedItem('Post', 'alice.bsky')] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.filter(s => s.kind === 'bsky-foryou')).toHaveLength(0);
        });

        test('bsky-foryou error does not break other signals', async () => {
            const client = makeBskyClient({
                getFeed: async (name: string) => {
                    if(name === 'for-you') {
                        throw new Error('for-you broken');
                    }
                    return { items: [] };
                },
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.find(s => s.kind === 'perch')).toBeDefined();
        });
    });

    // -------------------------------------------------------------------------
    // bsky-notifications
    // -------------------------------------------------------------------------
    describe('bsky-notifications signal', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('happy path: mentions rendered as single summary signal', async () => {
            const notifs = [
                makeNotification('mention', 'alice.bsky', '2026-05-03T12:00:00Z'),
                makeNotification('mention', 'bob.bsky',  '2026-05-03T11:00:00Z'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.label).toBe('bsky-notifications');
            expect(notifSignal!.content).toContain('2 mentions');
            // Latest notification is alice (later timestamp)
            expect(notifSignal!.content).toContain('@alice.bsky');
        });

        test('mixed notifications: likes, reposts, follows counted separately', async () => {
            const notifs = [
                makeNotification('like',   'alice.bsky'),
                makeNotification('like',   'bob.bsky'),
                makeNotification('repost', 'carol.bsky'),
                makeNotification('follow', 'dave.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.content).toContain('2 likes');
            expect(notifSignal!.content).toContain('1 repost');
            expect(notifSignal!.content).toContain('1 new follower');
            // Non-mention notifications are NOT counted as mentions
            expect(notifSignal!.content).not.toContain('mention');
        });

        test('singular like count: 1 like vs multiple reposts — ensures correct like filter', async () => {
            // Tests that likeCount filters by reason === 'like' (not !=='like')
            // With 1 like and 2 reposts, mutating to !=='like' would produce likeCount=2 (reposts)
            const notifs = [
                makeNotification('like',   'alice.bsky'),
                makeNotification('repost', 'bob.bsky'),
                makeNotification('repost', 'carol.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.content).toContain('1 like');
            expect(notifSignal!.content).not.toContain('Stryker');
            expect(notifSignal!.content).toContain('2 reposts');
        });

        test('no notifications: signal is omitted', async () => {
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: [] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.find(s => s.kind === 'bsky-notifications')).toBeUndefined();
        });

        test('cache hit: second call within TTL does not re-fetch notifications', async () => {
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: [makeNotification('like', 'alice.bsky')] }),
            });
            let nowMs = 3_000_000;
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
                nowMs:             () => nowMs,
            }));
            await ls.snapshot();
            nowMs += 60_000;
            await ls.snapshot();
            const getNotifMock = client.getNotifications as ReturnType<typeof mock>;
            expect(getNotifMock.mock.calls.length).toBe(1);
        });

        test('feature flag off: notifications signal is skipped', async () => {
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: [makeNotification('like', 'alice.bsky')] }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.find(s => s.kind === 'bsky-notifications')).toBeUndefined();
        });

        test('notifications error does not break other signals', async () => {
            const client = makeBskyClient({
                getNotifications: async () => {
                    throw new Error('notif API broken');
                },
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.find(s => s.kind === 'perch')).toBeDefined();
        });

        test('reply and quote notifications counted as mentions', async () => {
            const notifs = [
                makeNotification('mention', 'alice.bsky'),
                makeNotification('reply',   'bob.bsky'),
                makeNotification('quote',   'carol.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.content).toContain('3 mentions');
        });

        test('singular/plural forms: 1 mention, 2 reposts, 2 follows', async () => {
            // Tests singular vs plural forms: '1 mention' not '1 mentions', '2 reposts' not '2 repost'
            // Also verifies parts array starts empty (no garbage prefix from initial value)
            const notifs = [
                makeNotification('mention', 'alice.bsky'),
                makeNotification('repost',  'bob.bsky'),
                makeNotification('repost',  'carol.bsky'),
                makeNotification('follow',  'dave.bsky'),
                makeNotification('follow',  'eve.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            // Singular mention
            expect(notifSignal!.content).toContain('1 mention');
            expect(notifSignal!.content).not.toContain('1 mentions');
            // Plural reposts
            expect(notifSignal!.content).toContain('2 reposts');
            expect(notifSignal!.content).not.toContain('2 repost,');
            // Plural followers
            expect(notifSignal!.content).toContain('2 new followers');
            expect(notifSignal!.content).not.toContain('2 new follower,');
            // Verify no garbage prefix from initial parts array, no garbage suffix from '' replacements
            expect(notifSignal!.content).not.toContain('Stryker');
        });

        test('singular repost and follower forms', async () => {
            // Tests that repostCount === 1 gives '1 repost' (not '1 reposts')
            // and followCount === 1 gives '1 new follower' (not '1 new followers')
            const notifs = [
                makeNotification('repost', 'alice.bsky'),
                makeNotification('follow', 'bob.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.content).toContain('1 repost');
            expect(notifSignal!.content).not.toContain('1 reposts');
            expect(notifSignal!.content).toContain('1 new follower');
            expect(notifSignal!.content).not.toContain('1 new followers');
            expect(notifSignal!.content).not.toContain('Stryker');
        });

        test('only reposts: no mention/like/follow labels in output', async () => {
            // Guards for mentionCount > 0, likeCount > 0, followCount > 0 are tested here:
            // With counts of zero, those labels should NOT appear (>0, not >=0)
            const notifs = [
                makeNotification('repost', 'alice.bsky'),
                makeNotification('repost', 'bob.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.content).toContain('2 reposts');
            // Zero-count categories should not appear at all
            expect(notifSignal!.content).not.toContain('mention');
            expect(notifSignal!.content).not.toContain('like');
            expect(notifSignal!.content).not.toContain('follower');
        });

        test('only likes: no mention/repost/follow labels in output', async () => {
            // Verifies that non-like notifications are NOT counted as likes (=== vs !==)
            // Also verifies zero-count repost/follow guards work (>0 not >=0)
            const notifs = [
                makeNotification('like', 'alice.bsky'),
                makeNotification('like', 'bob.bsky'),
                makeNotification('like', 'carol.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.content).toContain('3 likes');
            // Zero-count categories should not appear
            expect(notifSignal!.content).not.toContain('mention');
            expect(notifSignal!.content).not.toContain('repost');
            expect(notifSignal!.content).not.toContain('follower');
        });

        test('only follows: no mention/like/repost labels in output', async () => {
            // Verifies zero-count guards work: mentionCount/likeCount/repostCount all 0 with >=0 mutant
            const notifs = [
                makeNotification('follow', 'alice.bsky'),
                makeNotification('follow', 'bob.bsky'),
            ];
            const client = makeBskyClient({
                getNotifications: async () => ({ notifications: notifs }),
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:        client,
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            const notifSignal = signals.find(s => s.kind === 'bsky-notifications');
            expect(notifSignal).toBeDefined();
            expect(notifSignal!.content).toContain('2 new followers');
            // Zero-count categories should not appear
            expect(notifSignal!.content).not.toContain('mention');
            expect(notifSignal!.content).not.toContain('like');
            expect(notifSignal!.content).not.toContain('repost');
        });
    });

    // -------------------------------------------------------------------------
    // activity-log signals
    // -------------------------------------------------------------------------
    describe('activity-log signals', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        function makeActivityDeps(
            items: MemoryToolItemData[],
            nowMs?: () => number,
            configOverride?: Partial<typeof FULL_CONFIG>
        ): LiveSignalsDepsInternal {
            return makeDefaultDeps({
                loadRecentActivityLog: async (_limit: number) => items,
                idleSignalsConfig:     {
                    ...FULL_CONFIG,
                    bskyDiscoverEnabled:      false,
                    bskyForYouEnabled:        false,
                    bskyNotificationsEnabled: false,
                    ...configOverride,
                },
                nowMs,
            });
        }

        test('happy path: activity items rendered as signals', async () => {
            const now = new Date('2026-05-03T10:00:00Z');
            const items = [
                makeActivityItem('perch-end',   new Date(now.getTime() - 22 * 60_000).toISOString()),
                makeActivityItem('bsky-post-sent', new Date(now.getTime() - 5 * 60_000).toISOString()),
            ];
            const ls = new LiveSignals(makeActivityDeps(items, () => now.getTime()));
            const signals = await ls.snapshot();
            const activity = signals.filter(s => s.kind === 'activity');
            expect(activity.length).toBeGreaterThanOrEqual(2);
            expect(activity.some(s => s.content.includes('perch-end') && s.content.includes('22m ago'))).toBe(true);
            expect(activity.some(s => s.content.includes('bsky-post-sent') && s.content.includes('5m ago'))).toBe(true);
        });

        test('includes all items regardless of tags (no auto-logged filter)', async () => {
            // After the fix: both manual and auto-logged items appear in the activity signal
            const items = [
                makeActivityItem('perch-end', '2026-05-03T09:00:00Z', new Set(['perch-end'])), // no auto-logged tag
                makeActivityItem('perch-start', '2026-05-03T09:30:00Z'),                       // has auto-logged tag
            ];
            const ls = new LiveSignals(makeActivityDeps(items));
            const signals = await ls.snapshot();
            const activity = signals.filter(s => s.kind === 'activity');
            // Both items should appear now (no filter on auto-logged tag)
            expect(activity).toHaveLength(2);
            expect(activity.some(s => s.content.includes('perch-end'))).toBe(true);
            expect(activity.some(s => s.content.includes('perch-start'))).toBe(true);
        });

        test('cache hit: second call within TTL does not re-fetch', async () => {
            let callCount = 0;
            const items = [makeActivityItem('perch-end', '2026-05-03T09:00:00Z')];
            let nowMs = 5_000_000;
            const ls = new LiveSignals(makeDefaultDeps({
                loadRecentActivityLog: async (_limit: number) => {
                    callCount++;
                    return items;
                },
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, bskyNotificationsEnabled: false },
                nowMs:             () => nowMs,
            }));
            await ls.snapshot();
            nowMs += 60_000; // still within 15-min TTL
            await ls.snapshot();
            expect(callCount).toBe(1);
        });

        test('stale cache triggers background refresh; snapshot returns cached items', async () => {
            let callCount = 0;
            const items = [makeActivityItem('perch-end', '2026-05-03T09:00:00Z')];
            let nowMs = 5_000_000;
            const ls = new LiveSignals(makeDefaultDeps({
                loadRecentActivityLog: async (_limit: number) => {
                    callCount++;
                    return items;
                },
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogCacheMs: 5000 },
                nowMs:             () => nowMs,
            }));
            await ls.snapshot();
            expect(callCount).toBe(1);
            nowMs += 10_000; // past TTL
            const signals = await ls.snapshot();
            // Returns stale cached items immediately
            expect(signals.filter(s => s.kind === 'activity').length).toBeGreaterThanOrEqual(1);
            // Background refresh eventually fires
            await Promise.resolve();
            await Promise.resolve();
            expect(callCount).toBe(2);
        });

        test('feature flag off: activity-log is skipped', async () => {
            let callCount = 0;
            const ls = new LiveSignals(makeDefaultDeps({
                loadRecentActivityLog: async () => {
                    callCount++;
                    return [];
                },
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, bskyNotificationsEnabled: false, activityLogEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.filter(s => s.kind === 'activity')).toHaveLength(0);
            expect(callCount).toBe(0);
        });

        test('missing loadRecentActivityLog: activity signals are skipped without errors', async () => {
            const ls = new LiveSignals(makeDefaultDeps({
                idleSignalsConfig: FULL_CONFIG,
            }));
            const signals = await ls.snapshot();
            expect(signals.filter(s => s.kind === 'activity')).toHaveLength(0);
        });

        test('activity-log fetch error does not break other signals', async () => {
            const ls = new LiveSignals(makeDefaultDeps({
                loadRecentActivityLog: async () => {
                    throw new Error('DDB read failed');
                },
                idleSignalsConfig: { ...FULL_CONFIG, bskyDiscoverEnabled: false, bskyForYouEnabled: false, bskyNotificationsEnabled: false },
            }));
            const signals = await ls.snapshot();
            expect(signals.find(s => s.kind === 'perch')).toBeDefined();
            expect(signals.find(s => s.kind === 'time')).toBeDefined();
        });

        test('returns at most 3 activity signals (last 3 of sorted items)', async () => {
            const items = [
                makeActivityItem('perch-start', '2026-05-03T08:00:00Z'),
                makeActivityItem('perch-end',   '2026-05-03T09:00:00Z'),
                makeActivityItem('perch-start', '2026-05-03T10:00:00Z'),
                makeActivityItem('perch-end',   '2026-05-03T11:00:00Z'),
            ];
            const ls = new LiveSignals(makeActivityDeps(items));
            const signals = await ls.snapshot();
            expect(signals.filter(s => s.kind === 'activity')).toHaveLength(3);
        });

        // Path-parsing: both auto-logged and manual event path shapes work
        test('auto-logged path /events/activity/{type}/{ts} renders type correctly', async () => {
            const now = new Date('2026-05-03T10:00:00Z');
            const items = [makeActivityItem('perch-end', new Date(now.getTime() - 10 * 60_000).toISOString())];
            const ls = new LiveSignals(makeActivityDeps(items, () => now.getTime()));
            const signals = await ls.snapshot();
            const activity = signals.filter(s => s.kind === 'activity');
            expect(activity).toHaveLength(1);
            expect(activity[0].content).toContain('perch-end');
        });

        test('manual path /events/{eventType}/{ts} renders eventType correctly', async () => {
            const now = new Date('2026-05-03T10:00:00Z');
            const items = [makeManualEventItem('conversation', new Date(now.getTime() - 5 * 60_000).toISOString())];
            const ls = new LiveSignals(makeActivityDeps(items, () => now.getTime()));
            const signals = await ls.snapshot();
            const activity = signals.filter(s => s.kind === 'activity');
            expect(activity).toHaveLength(1);
            expect(activity[0].content).toContain('conversation');
        });

        test('mixed path shapes: both auto-logged and manual events render correctly', async () => {
            const now = new Date('2026-05-03T10:00:00Z');
            const items = [
                makeActivityItem('perch-end', new Date(now.getTime() - 20 * 60_000).toISOString()),
                makeManualEventItem('conversation', new Date(now.getTime() - 5 * 60_000).toISOString()),
            ];
            const ls = new LiveSignals(makeActivityDeps(items, () => now.getTime()));
            const signals = await ls.snapshot();
            const activity = signals.filter(s => s.kind === 'activity');
            expect(activity).toHaveLength(2);
            expect(activity.some(s => s.content.includes('perch-end'))).toBe(true);
            expect(activity.some(s => s.content.includes('conversation'))).toBe(true);
        });

        test('manual /events/activity/{ts} path (eventType="activity") renders type as "activity" not the timestamp', async () => {
            // When a user literally does logEvent({eventType: 'activity', ...}), the path is
            // /events/activity/{ts} — 4 parts. Without the length===5 guard, pathParts[3] would
            // be the timestamp, rendering it as the activity type.
            const now = new Date('2026-05-03T10:00:00Z');
            const ts = new Date(now.getTime() - 5 * 60_000).toISOString();
            const manualActivityItem: MemoryToolItemData = {
                path:        `/events/activity/${ts}` as MemoryToolItemData['path'],
                content:     'activity happened',
                contentType: 'text/plain',
                metadata:    {},
                createdAt:   ts,
                updatedAt:   ts,
            };
            const ls = new LiveSignals(makeActivityDeps([manualActivityItem], () => now.getTime()));
            const signals = await ls.snapshot();
            const activity = signals.filter(s => s.kind === 'activity');
            expect(activity).toHaveLength(1);
            // Should render 'activity' as the type, NOT the ISO timestamp as type
            expect(activity[0].content).toMatch(/^activity /);
            expect(activity[0].content).not.toContain(ts);
        });

        test('returns last 3 items (no filter, pure slice(-3))', async () => {
            // 4 items total; after removing filter, all 4 are candidates and last 3 are taken
            const items = [
                makeActivityItem('perch-start', '2026-05-03T08:00:00Z'),
                makeManualEventItem('conversation', '2026-05-03T09:00:00Z'),
                makeActivityItem('perch-end', '2026-05-03T10:00:00Z'),
                makeActivityItem('email-sent', '2026-05-03T11:00:00Z'),
            ];
            const ls = new LiveSignals(makeActivityDeps(items));
            const signals = await ls.snapshot();
            const activity = signals.filter(s => s.kind === 'activity');
            expect(activity).toHaveLength(3);
            // The oldest (perch-start) should NOT appear
            expect(activity.some(s => s.content.includes('perch-start'))).toBe(false);
            // The 3 most recent should appear
            expect(activity.some(s => s.content.includes('conversation'))).toBe(true);
            expect(activity.some(s => s.content.includes('perch-end'))).toBe(true);
            expect(activity.some(s => s.content.includes('email-sent'))).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // Cross-source error isolation
    // -------------------------------------------------------------------------
    describe('cross-source error isolation', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('bsky throwing does not break activity-log signal emission', async () => {
            const activityItems = [makeActivityItem('perch-end', '2026-05-03T09:00:00Z')];
            const client = makeBskyClient({
                getFeed: async () => {
                    throw new Error('all bsky down');
                },
                getNotifications: async () => {
                    throw new Error('notifs down');
                },
            });
            const ls = new LiveSignals(makeDefaultDeps({
                bskyClient:            client,
                loadRecentActivityLog: async () => activityItems,
                idleSignalsConfig:     FULL_CONFIG,
            }));
            const signals = await ls.snapshot();
            // activity signal should still appear
            expect(signals.find(s => s.kind === 'activity')).toBeDefined();
            // core signals still present
            expect(signals.find(s => s.kind === 'perch')).toBeDefined();
        });
    });
});
