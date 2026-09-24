import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createContextBuilder, formatMemoryPreview, type CalendarService } from '@/agent/context-builder';
import type { BlueskyClient } from '@/integrations/bsky';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { createMemoryPath } from '@/storage/memory-tool/types';

const NOW = new Date('2026-03-18T12:00:00.000Z');

function backend() {
    return new MemoryToolBackend({} as DynamoDBDocumentClient, 'test');
}

function item(path: string, content: string) {
    return {
        path:        createMemoryPath(path), content, contentType: 'text/plain' as const, metadata:    {},
        createdAt:   NOW.toISOString(), updatedAt:   NOW.toISOString(),
    };
}

afterEach(() => jest.useRealTimers());

describe('context builder final mutation boundaries', () => {
    test('default state-top-set time is the current clock time', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
        const store = backend();
        store.getStateItemsScored = mock(async () => []);

        await createContextBuilder({ backend: store }).loadStateTopSet();

        expect(store.getStateItemsScored).toHaveBeenCalledWith(expect.objectContaining({ now: NOW }));
    });

    test('hot-state preview contains its path once in the documented preview format', async () => {
        const store = backend();
        const memory = { ...item('/state/preview.md', 'p'.repeat(101)), updatedAt: '2026-03-18T10:00:00.000Z' };
        store.getStateItemsScored = mock(async () => [{ item: memory, score: 1 }]);

        const result = await createContextBuilder({
            backend: store, maxStateFullItems: 0, maxStatePreviewItems: 1,
        }).loadHotState(NOW);

        expect(result).toBe(`- /state/preview.md (2h ago): ${'p'.repeat(100)}...`);
    });

    test('default state item cap preserves exactly 2000 characters', async () => {
        const store = backend();
        const content = 's'.repeat(2000);
        store.getStateItemsScored = mock(async () => [{ item: item('/state/exact.md', content), score: 1 }]);
        const result = await createContextBuilder({ backend: store }).loadHotState(NOW);
        expect(result).toBe(`/state/exact.md:\n${content}`);
    });

    test('default state item cap truncates 2001 characters', async () => {
        const store = backend();
        store.getStateItemsScored = mock(async () => [{ item: item('/state/over.md', 's'.repeat(2001)), score: 1 }]);
        expect(await createContextBuilder({ backend: store }).loadHotState(NOW)).toContain(`${'s'.repeat(2000)}\n[truncated`);
    });

    test('default identity budget preserves exactly 20000 characters', async () => {
        const store = backend();
        const content = 'i'.repeat(20_000);
        store.listByLayer = mock(async () => ({ items: [item('/identity/exact.md', content)] }));
        expect(await createContextBuilder({ backend: store }).loadCoreIdentity()).toBe(content);
    });

    test('default identity budget truncates 20001 characters', async () => {
        const store = backend();
        store.listByLayer = mock(async () => ({ items: [item('/identity/over.md', 'i'.repeat(20_001))] }));
        const result = await createContextBuilder({ backend: store }).loadCoreIdentity();
        expect(result).toContain(`${'i'.repeat(19_997)}...`);
        expect(result).toContain('1 total identity memories');
    });

    test('default event item cap preserves exactly 2000 characters', async () => {
        const store = backend();
        const content = 'e'.repeat(2000);
        store.getStateItemsScored = mock(async () => []);
        store.searchByTimeRange = mock(async () => [item('/events/exact.md', content)]);
        const result = await createContextBuilder({ backend: store }).buildPerchContext(NOW);
        expect(result).toContain(`/events/exact.md (now):\n${content}`);
        expect(result).not.toContain('[truncated');
    });

    test('default event item cap truncates 2001 characters', async () => {
        const store = backend();
        store.getStateItemsScored = mock(async () => []);
        store.searchByTimeRange = mock(async () => [item('/events/over.md', 'e'.repeat(2001))]);
        expect(await createContextBuilder({ backend: store }).buildPerchContext(NOW)).toContain(`${'e'.repeat(2000)}\n[truncated`);
    });

    test('default user budget preserves a preview that exactly fills 10000 characters', async () => {
        const store = backend();
        const path = createMemoryPath(`/users/u/${'p'.repeat(9980)}`);
        const memory = item(path, 'x');
        const formatted = formatMemoryPreview(path, memory.content, undefined, memory.updatedAt, NOW);
        expect(formatted).toHaveLength(10_000);
        store.list = mock(async () => ({ items: [memory] }));
        expect(await createContextBuilder({ backend: store }).loadUserMemories('u', NOW)).toBe(formatted);
    });

    test('default user budget excludes a preview of 10001 characters', async () => {
        const store = backend();
        const path = createMemoryPath(`/users/u/${'p'.repeat(9981)}`);
        const memory = item(path, 'x');
        const formatted = formatMemoryPreview(path, memory.content, undefined, memory.updatedAt, NOW);
        expect(formatted).toHaveLength(10_001);
        store.list = mock(async () => ({ items: [memory] }));
        expect(await createContextBuilder({ backend: store }).loadUserMemories('u', NOW)).toContain('...and 1 more user memories');
    });

    test('hot-state overflow reports one item beyond the configured tiers', async () => {
        const store = backend();
        store.getStateItemsScored = mock(async () => [
            { item: item('/state/shown.md', 'shown'), score: 2 },
            { item: item('/state/overflow.md', 'overflow'), score: 1 },
        ]);
        const result = await createContextBuilder({ backend: store, maxStateFullItems: 1, maxStatePreviewItems: 0 }).loadHotState(NOW);
        expect(result).toContain('...and 1 more state memories');
    });

    test('default user-memory time uses the current clock', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
        const store = backend();
        store.list = mock(async () => ({ items: [{ ...item('/users/u/time.md', 'x'), updatedAt: '2026-03-18T10:00:00.000Z' }] }));
        expect(await createContextBuilder({ backend: store }).loadUserMemories('u')).toContain('(2h ago)');
    });

    test('calendar formatting honors the requested timezone across a day boundary', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
        const store = backend();
        store.list = mock(async () => ({ items: [] }));
        store.getStateItemsScored = mock(async () => []);
        store.searchByTimeRange = mock(async () => []);
        store.listByLayer = mock(async () => ({ items: [] }));
        const calendarService = {
            registry: { getAllCalendars: mock(async () => [{}]) },
            client:   { getContextEvents: mock(async () => ({ events: [{ uid: 'event', summary: 'Late event', time: { kind: 'timed', start: new Date('2026-03-19T06:30:00.000Z'), end: new Date('2026-03-19T07:00:00.000Z') }, calendarLabel: 'Main' }], failed: [] })) },
        } as unknown as CalendarService;
        const result = await createContextBuilder({ backend: store, calendarService }).buildUserMessagePrefix('u', 'America/Los_Angeles');
        expect(result).toContain('Today (Wed Mar 18)');
    });

    test('calendar day labels use the context clock captured before loading calendars', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-18T23:59:00.000Z'));
        const store = backend();
        store.list = mock(async () => ({ items: [] }));
        store.getStateItemsScored = mock(async () => []);
        store.searchByTimeRange = mock(async () => []);
        store.listByLayer = mock(async () => ({ items: [] }));
        const calendarService = {
            registry: { getAllCalendars: mock(async () => [{}]) },
            client:   { getContextEvents: mock(async () => {
                jest.setSystemTime(new Date('2026-03-19T00:00:00.000Z'));
                return { events: [{ uid: 'event', summary: 'Late event', time: { kind: 'timed', start: new Date('2026-03-18T22:00:00.000Z'), end: new Date('2026-03-18T22:30:00.000Z') }, calendarLabel: 'Main' }], failed: [] };
            }) },
        } as unknown as CalendarService;

        const result = await createContextBuilder({ backend: store, calendarService }).buildUserMessagePrefix('u', 'UTC');

        expect(result).toContain('Today (Wed Mar 18)');
    });

    test('older event previews measure age from the event to the context clock', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
        const store = backend();
        store.list = mock(async () => ({ items: [] }));
        store.getStateItemsScored = mock(async () => []);
        store.searchByTimeRange = mock(async () => [
            { ...item('/events/older.md', 'event'), updatedAt: '2026-03-18T10:00:00.000Z' },
            item('/events/recent.md', 'recent'),
        ]);
        const result = await createContextBuilder({ backend: store, maxEventFullItems: 1 }).buildUserMessagePrefix('u');
        expect(result).toContain('- /events/older.md (2h ago): event');
    });

    test('full event rendering measures age from the event to the context clock', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
        const store = backend();
        store.list = mock(async () => ({ items: [] }));
        store.getStateItemsScored = mock(async () => []);
        store.searchByTimeRange = mock(async () => [{ ...item('/events/full.md', 'event'), updatedAt: '2026-03-18T10:00:00.000Z' }]);
        const result = await createContextBuilder({ backend: store }).buildUserMessagePrefix('u');
        expect(result).toContain('/events/full.md (2h ago):\nevent');
    });

    test('user-memory budget includes an item that exactly fills it', async () => {
        const store = backend();
        const path = createMemoryPath('/users/u/exact');
        let content = '';
        let formatted = formatMemoryPreview(path, content, undefined, NOW.toISOString(), NOW);
        for(let index = 0; formatted.length % 4 !== 0 && index < 4; index++) {
            content += 'x';
            formatted = formatMemoryPreview(path, content, undefined, NOW.toISOString(), NOW);
        }
        expect(formatted.length % 4).toBe(0);
        store.list = mock(async () => ({ items: [item(path, content)] }));

        const result = await createContextBuilder({ backend: store, maxUserTokens: formatted.length / 4 }).loadUserMemories('u', NOW);

        expect(result).toBe(formatted);
    });

    test('user-memory budget excludes an item one character over it', async () => {
        const store = backend();
        const path = createMemoryPath('/users/u/over');
        let content = '';
        let formatted = formatMemoryPreview(path, content, undefined, NOW.toISOString(), NOW);
        for(let index = 0; formatted.length % 4 !== 1 && index < 4; index++) {
            content += 'x';
            formatted = formatMemoryPreview(path, content, undefined, NOW.toISOString(), NOW);
        }
        expect(formatted.length % 4).toBe(1);
        store.list = mock(async () => ({ items: [item(path, content)] }));

        const result = await createContextBuilder({ backend: store, maxUserTokens: (formatted.length - 1) / 4 }).loadUserMemories('u', NOW);

        expect(result).not.toContain(formatted);
        expect(result).toContain('...and 1 more user memories');
    });

    test('user-memory accounting counts each rendered preview once', async () => {
        const store = backend();
        const firstPath = createMemoryPath('/users/u/first');
        const secondPath = createMemoryPath('/users/u/second');
        const content = 'x';
        const first = formatMemoryPreview(firstPath, content, undefined, NOW.toISOString(), NOW);
        let secondContent = 'x';
        let second = formatMemoryPreview(secondPath, secondContent, undefined, NOW.toISOString(), NOW);
        for(let index = 0; (first.length + second.length) % 4 !== 0 && index < 4; index++) {
            secondContent += 'x';
            second = formatMemoryPreview(secondPath, secondContent, undefined, NOW.toISOString(), NOW);
        }
        expect((first.length + second.length) % 4).toBe(0);
        store.list = mock(async () => ({ items: [item(firstPath, content), item(secondPath, secondContent)] }));

        const result = await createContextBuilder({ backend: store, maxUserTokens: (first.length + second.length) / 4 }).loadUserMemories('u', NOW);

        expect(result).toContain(first);
        expect(result).toContain(second);
        expect(result).not.toContain('more user memories');
    });
});

test('an empty but present Bluesky cursor still indicates an additional page', async () => {
    const store = backend();
    store.getStateItemsScored = mock(async () => []);
    store.searchByTimeRange = mock(async () => []);
    store.listByLayer = mock(async () => ({ items: [] }));
    const bskyDMService = {
        client: {
            listConversations: mock(async () => ({
                conversations: [{
                    id:          'convo',
                    rev:         '1',
                    members:     [{ did: 'did:alice', handle: 'alice.bsky.social' }],
                    muted:       false,
                    unreadCount: 1,
                }],
                cursor: '',
            })),
            ownHandle: 'izzy.bsky.social',
        } as unknown as BlueskyClient,
    };

    const result = await createContextBuilder({ backend: store, bskyDMService }).buildPerchContext(NOW);

    expect(result).toContain('You have 1+ DMs');
    expect(result).toContain('More conversations available');
});
