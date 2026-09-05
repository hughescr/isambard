import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createContextPolicy, type EventsDeltaSource } from '@/agent/session/context-policy';
import { createMemoryPath, type MemoryToolItemData } from '@/storage';

const T0 = 1_700_000_000_000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

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

afterEach(() => {
    jest.restoreAllMocks();
});

describe('createContextPolicy — shouldInjectUserMemory / markInjected', () => {
    test('first contact injects (no mark yet)', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn() } });

        expect(policy.shouldInjectUserMemory('u1')).toBe(true);
    });

    test('a second call within the window does not re-inject', () => {
        let t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn() } });

        policy.markInjected('u1');
        t += SIX_HOURS_MS - 1;

        expect(policy.shouldInjectUserMemory('u1')).toBe(false);
    });

    test('re-injects once the window has fully elapsed (>=)', () => {
        let t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn() } });

        policy.markInjected('u1');
        t += SIX_HOURS_MS;

        expect(policy.shouldInjectUserMemory('u1')).toBe(true);
    });

    test('marks are tracked independently per user', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn() } });

        policy.markInjected('u1');

        expect(policy.shouldInjectUserMemory('u1')).toBe(false);
        expect(policy.shouldInjectUserMemory('u2')).toBe(true);
    });

    test('resetAll re-arms every user', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn() } });

        policy.markInjected('u1');
        policy.markInjected('u2');
        policy.resetAll();

        expect(policy.shouldInjectUserMemory('u1')).toBe(true);
        expect(policy.shouldInjectUserMemory('u2')).toBe(true);
    });
});

describe('createContextPolicy — eventsDelta / markEventsSeen', () => {
    test('eventsDelta returns [] before markEventsSeen has ever been called', async () => {
        const t = T0;
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>();
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince } });

        const result = await policy.eventsDelta();

        expect(result).toEqual([]);
        expect(loadRecentEventsSince).not.toHaveBeenCalled();
    });

    test('after markEventsSeen at t0, eventsDelta calls loadRecentEventsSince(t - t0, 50, new Date(t)) exactly once and formats results', async () => {
        let t = T0;
        const item = makeItem({ path: createMemoryPath('/events/2'), content: 'a deployed thing' });
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([item]);
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince }, eventLimit: 10 });

        policy.markEventsSeen();
        t += 1000;
        await policy.eventsDelta();

        expect(loadRecentEventsSince).toHaveBeenCalledWith(1000, 10, new Date(t));
    });

    test('resetAll clears the events mark, so the next eventsDelta returns [] again', async () => {
        let t = T0;
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([makeItem()]);
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince } });

        policy.markEventsSeen();
        policy.resetAll();
        t += 1000;

        const result = await policy.eventsDelta();

        expect(result).toEqual([]);
        expect(loadRecentEventsSince).not.toHaveBeenCalled();
    });
});
