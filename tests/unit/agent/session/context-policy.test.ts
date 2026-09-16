import { afterEach, describe, expect, jest, test } from 'bun:test';
import { makeHealthEntry, makeHealthRegistry } from '../../../helpers/fake-health-registry';
import { dayWindow } from '@/agent/session/calendar-delta';
import { createContextPolicy, type EventsDeltaSource, type StateTopSetSource, type CalendarAgendaSource } from '@/agent/session/context-policy';
import type { CalendarEvent } from '@/integrations/caldav';
import { serviceNameSchema, type ServiceHealthEntry, type ServiceName } from '@/services/types';
import { createMemoryPath, type MemoryToolItemData } from '@/storage';

const T0 = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const TZ = 'America/Los_Angeles';

function makeItem(overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData {
    return {
        path:        createMemoryPath('/events/1'),
        content:     'something happened',
        contentType: 'text/plain',
        metadata:    {},
        createdAt:   new Date(T0).toISOString(),
        updatedAt:   new Date(T0).toISOString(),
        ...overrides,
    };
}

/** A `CalendarEvent` guaranteed to fall inside `nowMs`'s local `TZ` day window, so `toAgenda` keeps it. */
function makeEvent(nowMs: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    const window = dayWindow(nowMs, TZ);
    return {
        uid:           'uid-1',
        summary:       'Standup',
        start:         new Date(window.startMs + HOUR_MS),
        end:           new Date(window.startMs + HOUR_MS + 30 * 60 * 1000),
        isAllDay:      false,
        calendarLabel: 'Work',
        ...overrides,
    };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('createContextPolicy — shouldInjectUserMemory / markInjected (fingerprint-based, R1)', () => {
    test('first contact injects (no fingerprint recorded yet)', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        expect(policy.shouldInjectUserMemory('u1', 'about u1')).toBe(true);
    });

    test('the same block content does not re-inject, no matter how much time passes', () => {
        let t = T0;
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markInjected('u1', 'about u1');
        t += 365 * 24 * 60 * 60 * 1000;

        expect(policy.shouldInjectUserMemory('u1', 'about u1')).toBe(false);
    });

    test('a changed block re-injects immediately, with no elapsed time', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markInjected('u1', 'about u1 v1');

        expect(policy.shouldInjectUserMemory('u1', 'about u1 v2')).toBe(true);
    });

    test('marks are tracked independently per user', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markInjected('u1', 'about u1');

        expect(policy.shouldInjectUserMemory('u1', 'about u1')).toBe(false);
        expect(policy.shouldInjectUserMemory('u2', 'about u1')).toBe(true);
    });

    test('resetAll re-arms every user, even for an unchanged block', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markInjected('u1', 'about u1');
        policy.markInjected('u2', 'about u2');
        policy.resetAll();

        expect(policy.shouldInjectUserMemory('u1', 'about u1')).toBe(true);
        expect(policy.shouldInjectUserMemory('u2', 'about u2')).toBe(true);
    });
});

describe('createContextPolicy — eventsSinceMs / markEventsSeenAt (R1)', () => {
    test('eventsSinceMs is undefined before any mark', () => {
        const policy = createContextPolicy({ now: () => T0, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        expect(policy.eventsSinceMs()).toBeUndefined();
    });

    test('markEventsSeen sets eventsSinceMs to the current clock time', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markEventsSeen();

        expect(policy.eventsSinceMs()).toBe(t);
    });

    test('markEventsSeenAt seeds an arbitrary mark, independent of the current clock time', () => {
        const policy = createContextPolicy({ now: () => T0, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markEventsSeenAt(T0 - 5000);

        expect(policy.eventsSinceMs()).toBe(T0 - 5000);
    });

    test('resetAll does NOT clear the events mark', () => {
        const policy = createContextPolicy({ now: () => T0, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markEventsSeenAt(T0 - 1000);
        policy.resetAll();

        expect(policy.eventsSinceMs()).toBe(T0 - 1000);
    });
});

describe('createContextPolicy — eventsDelta / markEventsSeen', () => {
    test('eventsDelta returns [] before markEventsSeen has ever been called', async () => {
        const t = T0;
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>();
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        const result = await policy.eventsDelta();

        expect(result).toEqual([]);
        expect(loadRecentEventsSince).not.toHaveBeenCalled();
    });

    test('after markEventsSeen at t0, eventsDelta calls loadRecentEventsSince(t - t0, 50, new Date(t)) exactly once and formats results', async () => {
        let t = T0;
        const item = makeItem({ path: createMemoryPath('/events/2'), content: 'a deployed thing' });
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([item]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markEventsSeen();
        const advanceMs = 90_000;
        t += advanceMs;

        const result = await policy.eventsDelta();

        expect(loadRecentEventsSince).toHaveBeenCalledTimes(1);
        expect(loadRecentEventsSince).toHaveBeenCalledWith(advanceMs, 50, new Date(t));
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('/events/2');
        expect(result[0]).toContain('a deployed thing');
    });

    test('eventsDelta result is exactly one formatMemoryPreview line per item, in order', async () => {
        let t = T0;
        const itemA = makeItem({ path: createMemoryPath('/events/a'), content: 'first' });
        const itemB = makeItem({ path: createMemoryPath('/events/b'), content: 'second' });
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([itemA, itemB]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markEventsSeen();
        t += 1000;

        const result = await policy.eventsDelta();

        expect(result).toHaveLength(2);
        expect(result[0]).toContain('/events/a');
        expect(result[0]).toContain('first');
        expect(result[1]).toContain('/events/b');
        expect(result[1]).toContain('second');
    });

    test('respects a custom eventLimit', async () => {
        let t = T0;
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() }, eventLimit: 10 });

        policy.markEventsSeen();
        t += 1000;
        await policy.eventsDelta();

        expect(loadRecentEventsSince).toHaveBeenCalledWith(1000, 10, new Date(t));
    });

    test('resetAll does NOT clear the events mark (R1: the events mark survives compaction/reset), so eventsDelta still queries against it', async () => {
        let t = T0;
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([makeItem()]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() } });

        policy.markEventsSeen();
        policy.resetAll();
        t += 1000;

        const result = await policy.eventsDelta();

        expect(result).toHaveLength(1);
        expect(loadRecentEventsSince).toHaveBeenCalledWith(1000, 50, new Date(t));
    });
});

describe('createContextPolicy — stateTopSetDelta / markStateTopSetSeen', () => {
    test('stateTopSetDelta returns {added:[],removed:[],changed:[]} before markStateTopSetSeen has ever been called', async () => {
        const t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>();
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        const result = await policy.stateTopSetDelta();

        expect(result).toEqual({ added: [], removed: [], changed: [] });
        expect(loadStateTopSet).not.toHaveBeenCalled();
    });

    test('markStateTopSetSeen fetches the current top set via loadStateTopSet', async () => {
        const t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>().mockResolvedValue([]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();

        expect(loadStateTopSet).toHaveBeenCalledTimes(1);
        expect(loadStateTopSet).toHaveBeenCalledWith(new Date(t));
    });

    test('a path present now but absent from the last mark appears in added', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' }])
            .mockResolvedValueOnce([
                { path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' },
                { path: createMemoryPath('/state/b'), contentFingerprint: 'fp-b' },
            ]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        expect(result.added).toEqual(['/state/b']);
        expect(result.removed).toEqual([]);
        expect(result.changed).toEqual([]);
        expect(loadStateTopSet).toHaveBeenLastCalledWith(new Date(t));
    });

    test('a path present at the last mark but absent now appears in removed', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([
                { path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' },
                { path: createMemoryPath('/state/b'), contentFingerprint: 'fp-b' },
            ])
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' }]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        expect(result.added).toEqual([]);
        expect(result.removed).toEqual(['/state/b']);
        expect(result.changed).toEqual([]);
    });

    test('a path present at both marks with a different contentFingerprint appears in changed, not added or removed', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a-v1' }])
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a-v2' }]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        expect(result.added).toEqual([]);
        expect(result.removed).toEqual([]);
        expect(result.changed).toEqual(['/state/a']);
    });

    test('a path unchanged across two calls is reported in neither', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' }])
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' }]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        expect(result).toEqual({ added: [], removed: [], changed: [] });
    });

    test('multiple added paths appear in currentItems iteration order, not reversed', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' }])
            .mockResolvedValueOnce([
                { path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' },
                { path: createMemoryPath('/state/x'), contentFingerprint: 'fp-x' },
                { path: createMemoryPath('/state/y'), contentFingerprint: 'fp-y' },
            ]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        // A reversed (unshift) build would report ['/state/y', '/state/x'] instead.
        expect(result.added).toEqual(['/state/x', '/state/y']);
    });

    test('multiple changed paths appear in currentItems iteration order, not reversed', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([
                { path: createMemoryPath('/state/x'), contentFingerprint: 'fp-x-v1' },
                { path: createMemoryPath('/state/y'), contentFingerprint: 'fp-y-v1' },
            ])
            .mockResolvedValueOnce([
                { path: createMemoryPath('/state/x'), contentFingerprint: 'fp-x-v2' },
                { path: createMemoryPath('/state/y'), contentFingerprint: 'fp-y-v2' },
            ]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        // A reversed (unshift) build would report ['/state/y', '/state/x'] instead.
        expect(result.changed).toEqual(['/state/x', '/state/y']);
    });

    test('multiple removed paths appear in baseline iteration order, not reversed', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([
                { path: createMemoryPath('/state/x'), contentFingerprint: 'fp-x' },
                { path: createMemoryPath('/state/y'), contentFingerprint: 'fp-y' },
            ])
            .mockResolvedValueOnce([]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        // A reversed (unshift) build would report ['/state/y', '/state/x'] instead.
        expect(result.removed).toEqual(['/state/x', '/state/y']);
    });

    test('resetAll clears the state-top-set mark, so the next stateTopSetDelta behaves as first-mark again', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' }])
            .mockResolvedValueOnce([]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet, loadCalendarAgenda: jest.fn() } });

        await policy.markStateTopSetSeen();
        policy.resetAll();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        expect(result).toEqual({ added: [], removed: [], changed: [] });
        expect(loadStateTopSet).toHaveBeenCalledTimes(1);
    });
});

describe('createContextPolicy — calendarDelta / markCalendarSeen', () => {
    test('the first calendarDelta call for a user polls and reports isFirst with empty lists', async () => {
        const t = T0;
        const events = [makeEvent(t)];
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue(events);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        const result = await policy.calendarDelta('u1', TZ);

        expect(loadCalendarAgenda).toHaveBeenCalledTimes(1);
        expect(loadCalendarAgenda).toHaveBeenCalledWith('u1', new Date(t));
        expect(result.polled).toBe(true);
        expect(result.isFirst).toBe(true);
        expect(result.added).toEqual([]);
        expect(result.removed).toEqual([]);
        expect(result.changed).toEqual([]);
        expect(result.agenda).toHaveLength(1);
        expect(result.agenda[0].uid).toBe('uid-1');
        expect(result.events).toEqual(events);
    });

    test('calendarDelta window-scopes the raw events field to the day window, dropping events the CalDAV rolling query fetched from outside it', async () => {
        const t = T0;
        const window = dayWindow(t, TZ);
        const inWindowEvent = makeEvent(t, { uid: 'in-window' });
        // Entirely before the window: both start and end are before window.startMs.
        const outOfWindowEvent = makeEvent(t, {
            uid:   'out-of-window',
            start: new Date(window.startMs - 2 * HOUR_MS),
            end:   new Date(window.startMs - HOUR_MS),
        });
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([outOfWindowEvent, inWindowEvent]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        const result = await policy.calendarDelta('u1', TZ);

        // A dropped `eventsInWindow` call would report both raw fetched events here, unscoped.
        expect(result.events).toEqual([inWindowEvent]);
        expect(result.agenda).toHaveLength(1);
        expect(result.agenda[0].uid).toBe('in-window');
    });

    test('a second call inside the poll interval reuses the cache instead of polling again', async () => {
        let t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([makeEvent(t)]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        await policy.calendarDelta('u1', TZ);
        t += HOUR_MS - 1;

        const result = await policy.calendarDelta('u1', TZ);

        expect(loadCalendarAgenda).toHaveBeenCalledTimes(1);
        expect(result.polled).toBe(false);
    });

    test('a call at/after the poll interval re-polls', async () => {
        let t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([makeEvent(t)]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        await policy.calendarDelta('u1', TZ);
        t += HOUR_MS;

        const result = await policy.calendarDelta('u1', TZ);

        expect(loadCalendarAgenda).toHaveBeenCalledTimes(2);
        expect(result.polled).toBe(true);
    });

    test('respects a custom calendarPollIntervalMs', async () => {
        let t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([makeEvent(t)]);
        const policy = createContextPolicy({
            now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda }, calendarPollIntervalMs: 5 * 60_000,
        });

        await policy.calendarDelta('u1', TZ);
        t += 5 * 60_000;
        await policy.calendarDelta('u1', TZ);

        expect(loadCalendarAgenda).toHaveBeenCalledTimes(2);
    });

    test('a local-day rollover forces a re-poll even well inside the poll interval', async () => {
        // Start one minute before local midnight in TZ, so crossing into the next day takes far
        // less elapsed time than the default 60-minute poll interval -- isolating the rollover
        // trigger from the elapsed-time trigger (both are near-simultaneously true near T0 itself).
        let t = dayWindow(T0, TZ).endMs - 60_000;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockImplementation((_userId, now) => Promise.resolve([makeEvent(now.getTime())]));
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        await policy.calendarDelta('u1', TZ);
        t += 2 * 60_000; // crosses local midnight, well under calendarPollIntervalMs (1 hour)

        const result = await policy.calendarDelta('u1', TZ);

        expect(loadCalendarAgenda).toHaveBeenCalledTimes(2);
        expect(result.polled).toBe(true);
    });

    test('markCalendarSeen before any calendarDelta call for that user is a no-op', async () => {
        const t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([makeEvent(t)]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        expect(() => policy.markCalendarSeen('u1')).not.toThrow();

        const result = await policy.calendarDelta('u1', TZ);
        expect(result.isFirst).toBe(true);
    });

    test('markCalendarSeen commits the last polled agenda as the baseline, so a later unchanged poll reports no diff', async () => {
        let t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([makeEvent(t)]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        await policy.calendarDelta('u1', TZ);
        policy.markCalendarSeen('u1');
        t += HOUR_MS;

        const result = await policy.calendarDelta('u1', TZ);

        expect(result.isFirst).toBe(false);
        expect(result.added).toEqual([]);
        expect(result.removed).toEqual([]);
        expect(result.changed).toEqual([]);
    });

    test('an added event is reported after a poll picks it up and the prior agenda was marked', async () => {
        let t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>()
            .mockResolvedValueOnce([makeEvent(t, { uid: 'uid-1' })])
            .mockResolvedValueOnce([makeEvent(t, { uid: 'uid-1' }), makeEvent(t, { uid: 'uid-2', start: new Date(dayWindow(t, TZ).startMs + 3 * HOUR_MS), end: new Date(dayWindow(t, TZ).startMs + 4 * HOUR_MS) })]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        await policy.calendarDelta('u1', TZ);
        policy.markCalendarSeen('u1');
        t += HOUR_MS;

        const result = await policy.calendarDelta('u1', TZ);

        expect(result.added.map(entry => entry.uid)).toEqual(['uid-2']);
        expect(result.removed).toEqual([]);
        expect(result.changed).toEqual([]);
    });

    test('calendar poll cache and baseline are tracked independently per user', async () => {
        const t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([makeEvent(t)]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        await policy.calendarDelta('u1', TZ);
        policy.markCalendarSeen('u1');

        const result = await policy.calendarDelta('u2', TZ);

        expect(result.isFirst).toBe(true);
        expect(loadCalendarAgenda).toHaveBeenCalledTimes(2);
    });

    test('resetAll clears the calendar poll cache and baselines, so the next calendarDelta polls and reports isFirst again', async () => {
        let t = T0;
        const loadCalendarAgenda = jest.fn<CalendarAgendaSource['loadCalendarAgenda']>().mockResolvedValue([makeEvent(t)]);
        const policy = createContextPolicy({ now: () => t, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda } });

        await policy.calendarDelta('u1', TZ);
        policy.markCalendarSeen('u1');
        policy.resetAll();
        t += 1000;

        const result = await policy.calendarDelta('u1', TZ);

        expect(loadCalendarAgenda).toHaveBeenCalledTimes(2);
        expect(result.polled).toBe(true);
        expect(result.isFirst).toBe(true);
    });
});

describe('createContextPolicy — healthNote / markHealthSeen', () => {
    function makeContextBuilder() {
        return { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn(), loadCalendarAgenda: jest.fn() };
    }

    /**
     * Builds a full `getAll()`-shaped entries record for every known {@link ServiceName}, all
     * `'online'` unless overridden — so a test only has to spell out the services it cares about,
     * matching the real `ServiceHealthRegistry.getAll()` contract of always covering every
     * service (never a partial record).
     */
    function makeEntries(overrides: Partial<Record<ServiceName, Partial<ServiceHealthEntry>>> = {}): Record<ServiceName, ServiceHealthEntry> {
        return Object.fromEntries(serviceNameSchema.options.map(name => [
            name,
            makeHealthEntry({ state: 'online', ...overrides[name] }),
        ])) as Record<ServiceName, ServiceHealthEntry>;
    }

    test('returns undefined when no healthRegistry was supplied', () => {
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder() });

        expect(policy.healthNote()).toBeUndefined();
        expect(() => policy.markHealthSeen()).not.toThrow();
    });

    test('surfaces a pre-existing outage the first time healthNote is called (unmarked baseline is treated as all-online)', () => {
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ email: { state: 'offline' } }), summary: 'email: offline' });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        expect(policy.healthNote()).toBe('email: offline');
    });

    test('a disabled service produces no note, exactly like an online one', () => {
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ bluesky: { state: 'disabled' } }), summary: undefined });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        expect(policy.healthNote()).toBeUndefined();
    });

    test('does not re-render when only the volatile rendered text (elapsed time, retry countdown) changes but the service state does not', () => {
        // Reproduces the bug: buildStatusSummary()'s text embeds a live relative-time display and
        // a whole-second retry countdown, so it differs on nearly every call during an ongoing
        // outage even though the underlying service state (getAll()) hasn't moved at all.
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ caldav: { state: 'offline' } }), summary: 'caldav: offline (offline 3m) retry in ~45s' });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('caldav: offline (offline 4m) retry in ~22s');

        expect(policy.healthNote()).toBeUndefined();
    });

    test('returns undefined at construction/first mark when everything is already online', () => {
        const healthRegistry = makeHealthRegistry({ entries: makeEntries(), summary: undefined });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        expect(policy.healthNote()).toBeUndefined();
    });

    test('renders "All services are back online." on the transition from an outage back to nominal', () => {
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ email: { state: 'offline' } }), summary: 'email: offline' });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();
        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries());
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue(undefined);

        expect(policy.healthNote()).toBe('All services are back online.');
    });

    test('renders the new summary again when the set of failing services changes without ever going fully online', () => {
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ email: { state: 'offline' } }), summary: 'email: offline' });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();
        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries({ email: { state: 'offline' }, bluesky: { state: 'offline' } }));
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('email: offline\nbluesky: offline');

        expect(policy.healthNote()).toBe('email: offline\nbluesky: offline');
    });

    test('a different lastError code for an already-offline service still counts as a real state change', () => {
        const healthRegistry = makeHealthRegistry({
            entries: makeEntries({ caldav: { state: 'offline', lastError: { code: 'ECONNRESET', message: 'reset' } } }), summary: 'caldav: offline [ECONNRESET]',
        });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();
        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries({ caldav: { state: 'offline', lastError: { code: 'ETIMEDOUT', message: 'timeout' } } }));
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('caldav: offline [ETIMEDOUT]');

        expect(policy.healthNote()).toBe('caldav: offline [ETIMEDOUT]');
    });

    test('markHealthSeen without a healthRegistry never throws', () => {
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder() });

        expect(() => policy.markHealthSeen()).not.toThrow();
    });

    test('markHealthSeen commits the state healthNote() actually observed, not a later re-sample (a mid-turn recovery must still surface as a note)', () => {
        // healthNote() runs at envelope-build time; markHealthSeen() runs after the turn settles,
        // potentially much later. If the registry's state changes in between, markHealthSeen()
        // must still commit what healthNote() saw, not whatever getAll() answers when it is
        // finally called -- otherwise a transition that landed mid-turn is marked seen without
        // ever having been rendered to the user.
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ email: { state: 'offline' } }), summary: 'email: offline' });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote(); // observes the outage
        // Email recovers while the turn is still in flight, before markHealthSeen() is called.
        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries());
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue(undefined);
        policy.markHealthSeen();

        // Next turn: still online. The recovery note must still render, because the committed
        // baseline was the outage healthNote() actually showed, not the online state that landed
        // during the race.
        expect(policy.healthNote()).toBe('All services are back online.');
    });

    test('resetAll re-arms the health mark, so an unchanged ongoing outage is surfaced again', () => {
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ email: { state: 'offline' } }), summary: 'email: offline' });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();
        policy.resetAll();

        expect(policy.healthNote()).toBe('email: offline');
    });

    test('healthStateKey joins multi-service entries with | rather than concatenating them (a dropped separator must not let a two-service key collide with an unrelated single-service key)', () => {
        // bluesky has no lastError (code falls back to ''), caldav's code is 'A'. Correctly
        // joined with '|' the key is 'bluesky:offline:|caldav:offline:A'. If the '|' join were
        // ever weakened to '' (concatenation), the key would instead be
        // 'bluesky:offline:caldav:offline:A' -- indistinguishable from a single bluesky entry
        // whose own lastError.code happens to be the literal text 'caldav:offline:A' below.
        const healthRegistry = makeHealthRegistry({
            entries: makeEntries({ bluesky: { state: 'offline' }, caldav: { state: 'offline', lastError: { code: 'A', message: 'x' } } }),
            summary: 'two offline',
        });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();

        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries({ bluesky: { state: 'offline', lastError: { code: 'caldav:offline:A', message: 'y' } } }));
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('one offline');

        // A real two-services-to-one-service transition must still be reported as a change --
        // a dropped '|' separator would wrongly collapse it into "no change".
        expect(policy.healthNote()).toBe('one offline');
    });

    // If the `entry.lastError?.code ?? ''` fallback default were ever replaced by a non-empty
    // placeholder -- an arbitrary string, the literal 'unknown', or the `?? ''` being dropped
    // entirely (leaving the bare `undefined` interpolated by the template as the literal text
    // "undefined") -- an entry with no lastError would produce the exact same key as a
    // *different* entry whose real lastError.code happens to equal that placeholder text. A real
    // code-less-to-coded transition must still be reported as a change in every case.
    test.each([
        ['an arbitrary placeholder', 'Stryker was here!'],
        ['the literal fallback candidate "unknown"', 'unknown'],
        ['the literal fallback candidate "undefined"', 'undefined'],
    ])('healthStateKey falls back to an empty string, never %s, when an entry has no lastError.code', (_label, craftedCode) => {
        const healthRegistry = makeHealthRegistry({ entries: makeEntries({ bluesky: { state: 'offline' } }), summary: 'bluesky offline, no code' });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();

        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries({ bluesky: { state: 'offline', lastError: { code: craftedCode, message: 'z' } } }));
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('bluesky offline, coded');

        expect(policy.healthNote()).toBe('bluesky offline, coded');
    });

    test('healthStateKey builds lines in iteration (sorted) order, not reversed -- a shrinking outage must not collide with the prior multi-service key', () => {
        // bluesky offline (no code) + caldav offline (code 'A') sorts as
        // ["bluesky:offline:", "caldav:offline:A"]. Correctly pushed and joined with '|' that is
        // "bluesky:offline:|caldav:offline:A". If `lines.push` were ever swapped for
        // `lines.unshift`, the same two entries would instead build "caldav:offline:A|bluesky:offline:"
        // (caldav's line first). bluesky then recovers (a real, must-report change) while caldav's
        // lastError.code is crafted to read literally "A|bluesky:offline:" -- under the reversed
        // build this single remaining line is byte-identical to the old two-line reversed key, so
        // a reversed `lines` array would wrongly report no change at all.
        const healthRegistry = makeHealthRegistry({
            entries: makeEntries({ bluesky: { state: 'offline' }, caldav: { state: 'offline', lastError: { code: 'A', message: 'x' } } }),
            summary: 'two offline',
        });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();

        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries({ caldav: { state: 'offline', lastError: { code: 'A|bluesky:offline:', message: 'y' } } }));
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('bluesky recovered');

        expect(policy.healthNote()).toBe('bluesky recovered');
    });

    test('healthStateKey separates lines with | rather than , (a weakened separator must not let a shrinking outage collide with a crafted single-line key)', () => {
        // discord offline (no code) + email offline (code 'X') correctly joins to
        // "discord:offline:|email:offline:X". If the '|' join were ever weakened to ',', the same
        // two lines would instead join to "discord:offline:,email:offline:X". discord then recovers
        // (a real, must-report change) while email's lastError.code is crafted to read literally
        // ",email:offline:X" -- under a ',' join the single remaining discord line
        // ("discord:offline:,email:offline:X") is byte-identical to the old ','-joined two-line
        // key, so a ',' separator would wrongly report no change at all.
        const healthRegistry = makeHealthRegistry({
            entries: makeEntries({ discord: { state: 'offline' }, email: { state: 'offline', lastError: { code: 'X', message: 'x' } } }),
            summary: 'two offline',
        });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();

        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries({ discord: { state: 'offline', lastError: { code: ',email:offline:X', message: 'y' } } }));
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('email recovered');

        expect(policy.healthNote()).toBe('email recovered');
    });

    test('healthStateKey keys on lastError.code, not lastError.message -- an unchanged message must not mask a real code change', () => {
        // caldav's code changes (A -> B) while its message stays exactly the same ('same'). The
        // real state genuinely changed (a different failure code) and must be reported. If the
        // key were ever built from `lastError.message` instead of `lastError.code`, the unchanged
        // message would produce an identical key and the change would be wrongly suppressed.
        const healthRegistry = makeHealthRegistry({
            entries: makeEntries({ caldav: { state: 'offline', lastError: { code: 'A', message: 'same' } } }),
            summary: 'caldav: offline [A]',
        });
        const policy = createContextPolicy({ now: () => T0, contextBuilder: makeContextBuilder(), healthRegistry });

        policy.healthNote();
        policy.markHealthSeen();

        jest.spyOn(healthRegistry, 'getAll').mockReturnValue(makeEntries({ caldav: { state: 'offline', lastError: { code: 'B', message: 'same' } } }));
        jest.spyOn(healthRegistry, 'buildStatusSummary').mockReturnValue('caldav: offline [B]');

        expect(policy.healthNote()).toBe('caldav: offline [B]');
    });
});
