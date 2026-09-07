import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createContextPolicy, type EventsDeltaSource, type StateTopSetSource } from '@/agent/session/context-policy';
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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn() } });

        expect(policy.shouldInjectUserMemory('u1')).toBe(true);
    });

    test('a second call within the window does not re-inject', () => {
        let t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn() } });

        policy.markInjected('u1');
        t += SIX_HOURS_MS - 1;

        expect(policy.shouldInjectUserMemory('u1')).toBe(false);
    });

    test('re-injects once the window has fully elapsed (>=)', () => {
        let t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn() } });

        policy.markInjected('u1');
        t += SIX_HOURS_MS;

        expect(policy.shouldInjectUserMemory('u1')).toBe(true);
    });

    test('marks are tracked independently per user', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn() } });

        policy.markInjected('u1');

        expect(policy.shouldInjectUserMemory('u1')).toBe(false);
        expect(policy.shouldInjectUserMemory('u2')).toBe(true);
    });

    test('resetAll re-arms every user', () => {
        const t = T0;
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet: jest.fn() } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn() } });

        const result = await policy.eventsDelta();

        expect(result).toEqual([]);
        expect(loadRecentEventsSince).not.toHaveBeenCalled();
    });

    test('after markEventsSeen at t0, eventsDelta calls loadRecentEventsSince(t - t0, 50, new Date(t)) exactly once and formats results', async () => {
        let t = T0;
        const item = makeItem({ path: createMemoryPath('/events/2'), content: 'a deployed thing' });
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([item]);
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn() } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn() } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn() }, eventLimit: 10 });

        policy.markEventsSeen();
        t += 1000;
        await policy.eventsDelta();

        expect(loadRecentEventsSince).toHaveBeenCalledWith(1000, 10, new Date(t));
    });

    test('resetAll clears the events mark, so the next eventsDelta returns [] again', async () => {
        let t = T0;
        const loadRecentEventsSince = jest.fn<EventsDeltaSource['loadRecentEventsSince']>().mockResolvedValue([makeItem()]);
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince, loadStateTopSet: jest.fn() } });

        policy.markEventsSeen();
        policy.resetAll();
        t += 1000;

        const result = await policy.eventsDelta();

        expect(result).toEqual([]);
        expect(loadRecentEventsSince).not.toHaveBeenCalled();
    });
});

describe('createContextPolicy — stateTopSetDelta / markStateTopSetSeen', () => {
    test('stateTopSetDelta returns {added:[],removed:[],changed:[]} before markStateTopSetSeen has ever been called', async () => {
        const t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>();
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet } });

        const result = await policy.stateTopSetDelta();

        expect(result).toEqual({ added: [], removed: [], changed: [] });
        expect(loadStateTopSet).not.toHaveBeenCalled();
    });

    test('markStateTopSetSeen fetches the current top set via loadStateTopSet', async () => {
        const t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>().mockResolvedValue([]);
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet } });

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
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet } });

        await policy.markStateTopSetSeen();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        expect(result).toEqual({ added: [], removed: [], changed: [] });
    });

    test('resetAll clears the state-top-set mark, so the next stateTopSetDelta behaves as first-mark again', async () => {
        let t = T0;
        const loadStateTopSet = jest.fn<StateTopSetSource['loadStateTopSet']>()
            .mockResolvedValueOnce([{ path: createMemoryPath('/state/a'), contentFingerprint: 'fp-a' }])
            .mockResolvedValueOnce([]);
        const policy = createContextPolicy({ now: () => t, userMemoryWindowMs: SIX_HOURS_MS, contextBuilder: { loadRecentEventsSince: jest.fn(), loadStateTopSet } });

        await policy.markStateTopSetSeen();
        policy.resetAll();
        t += 1000;

        const result = await policy.stateTopSetDelta();

        expect(result).toEqual({ added: [], removed: [], changed: [] });
        expect(loadStateTopSet).toHaveBeenCalledTimes(1);
    });
});
