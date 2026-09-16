import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import * as loggerModule from '@hughescr/logger';
import { DateTime } from 'luxon';
import { LiveSignals, type LiveSignalsDepsInternal } from '@/agent/live-signals';
import type { MemoryToolItemData } from '@/storage';

const NOW = Date.parse('2026-05-03T10:00:00Z');

function deps(overrides: Partial<LiveSignalsDepsInternal> = {}): LiveSignalsDepsInternal {
    return {
        timezone:           'UTC',
        now:                () => DateTime.fromMillis(NOW, { zone: 'UTC' }),
        nowMs:              () => NOW,
        getRecentTools:     () => [],
        getRecentChannels:  () => [],
        resolveChannelName: () => undefined,
        getPreviousStatus:  () => undefined,
        idleSignalsConfig:  {
            bskyDiscoverEnabled:      false,
            bskyForYouEnabled:        false,
            bskyNotificationsEnabled: false,
            activityLogEnabled:       true,
            bskyDiscoverCacheMs:      60_000,
            bskyForYouCacheMs:        60_000,
            bskyNotificationsCacheMs: 60_000,
            activityLogCacheMs:       60_000,
        },
        ...overrides,
    };
}

/** Drain snapshot's finite promise chain without advancing the clock. */
async function drain(): Promise<void> {
    let chain = Promise.resolve();
    for(let step = 0; step < 20; step++) {
        chain = chain.then(() => undefined);
    }
    await chain;
}

describe('LiveSignals boundary contracts', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('relative age reports completed minutes rather than rounding up', async () => {
        const signals = await new LiveSignals(deps({
            getRecentTools: () => [{ toolName: 'search', timestamp: NOW - 119_000 }],
        })).snapshot();
        expect(signals.find(signal => signal.kind === 'tool')?.content).toBe('1m ago: search');
    });

    test.each([
        ['/events/conversation', 'conversation'],
        ['/other/project/deploy/stamp', 'project'],
        ['/events//stamp', 'event'],
    ])('activity path %s renders type %s', async (path, activityType) => {
        const item: MemoryToolItemData = {
            path:        path as MemoryToolItemData['path'],
            content:     'entry',
            contentType: 'text/plain',
            metadata:    {},
            createdAt:   new Date(NOW).toISOString(),
            updatedAt:   new Date(NOW).toISOString(),
        };
        const signals = await new LiveSignals(deps({ loadRecentActivityLog: async () => [item] })).snapshot();
        expect(signals.filter(signal => signal.kind === 'activity')).toEqual([
            { kind: 'activity', label: 'activity', content: `${activityType} just now` },
        ]);
    });

    test('an asynchronous source rejecting with null does not discard healthy signals', async () => {
        const debugSpy = spyOn(loggerModule.logger, 'debug');
        const signals = await new LiveSignals(deps({
            loadRecentActivityLog: async () => [],
            nowMs:                 () => {
                // Exercise non-Error rejection isolation at the dependency boundary.
                throw null;
            },
        })).snapshot();
        expect(signals.find(signal => signal.kind === 'time')?.content).toBe('late morning');
        expect(signals.some(signal => signal.kind === 'activity')).toBe(false);
        // A non-Error rejection is stringified so the structured log's error field is always a string.
        expect(debugSpy).toHaveBeenCalledWith({ error: 'null', msg: 'LiveSignals: signal source threw, omitting' });
    });

    test('cold snapshot waits up to two seconds, then omits a blocked activity fetch', async () => {
        const refresh = Promise.withResolvers<MemoryToolItemData[]>();
        const live = new LiveSignals(deps({ loadRecentActivityLog: () => refresh.promise }));
        let settled = false;
        const pending = live.snapshot().then((signals) => {
            settled = true;
            return signals;
        });
        try {
            jest.advanceTimersByTime(1999);
            await drain();
            expect(settled).toBe(false);
            jest.advanceTimersByTime(1);
            await drain();
            expect(settled).toBe(true);
            const signals = await pending;
            expect(signals.some(signal => signal.kind === 'activity')).toBe(false);
        } finally {
            refresh.resolve([]);
            await pending;
        }
    });
});
