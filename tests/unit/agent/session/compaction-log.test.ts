import { describe, test, expect, mock } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import { logCompactionSummary } from '@/agent/session/compaction-log';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath, MemoryToolItemData } from '@/storage/memory-tool/types';

const createMockItem = (overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData => ({
    path:        '/events/compaction/mock' as MemoryPath,
    content:     'summary',
    contentType: 'text/plain',
    metadata:    {},
    createdAt:   '2026-09-05T00:00:00.000Z',
    updatedAt:   '2026-09-05T00:00:00.000Z',
    ...overrides,
});

describe('logCompactionSummary', () => {
    test('writes one row at /events/compaction/<ts> tagged auto-logged/compaction/<role>', async () => {
        const create = mock(async (input: unknown) => createMockItem({ path: (input as { path: string }).path as MemoryPath }));
        const memoryBackend = { create } as unknown as MemoryToolBackend;
        const clock = new FakeClock(Date.parse('2026-09-05T10:15:30.000Z'));

        await logCompactionSummary({ memoryBackend, clock }, { role: 'conversation', summary: 'compacted the last 40 turns' });

        expect(create).toHaveBeenCalledTimes(1);
        const input = create.mock.calls[0]?.[0] as { path: string, content: string, contentType: string, tags: Set<string>, ttl?: number };
        expect(input.path).toBe('/events/compaction/2026-09-05T10-15-30-000Z');
        expect(input.path).not.toContain(':');
        expect(input.content).toBe('compacted the last 40 turns');
        expect(input.contentType).toBe('text/plain');
        expect([...input.tags].toSorted((a, b) => a.localeCompare(b))).toEqual(['auto-logged', 'compaction', 'conversation']);
    });

    test('sets a 30-day TTL from the injected clock', async () => {
        const create = mock(async (input: unknown) => createMockItem({ path: (input as { path: string }).path as MemoryPath }));
        const memoryBackend = { create } as unknown as MemoryToolBackend;
        const pinnedNow = Date.parse('2026-09-05T10:15:30.000Z');
        const clock = new FakeClock(pinnedNow);

        await logCompactionSummary({ memoryBackend, clock }, { role: 'perch', summary: 'x' });

        const input = create.mock.calls[0]?.[0] as { ttl?: number };
        expect(input.ttl).toBe(Math.floor(pinnedNow / 1000) + 30 * 86_400);
    });

    test('returns the memory path the summary was written to', async () => {
        const create = mock(async (input: unknown) => createMockItem({ path: (input as { path: string }).path as MemoryPath }));
        const memoryBackend = { create } as unknown as MemoryToolBackend;
        const clock = new FakeClock(Date.parse('2026-09-05T10:15:30.000Z'));

        const path = await logCompactionSummary({ memoryBackend, clock }, { role: 'conversation', summary: 'x' });

        const input = create.mock.calls[0]?.[0] as { path: string };
        expect(path).toBe(input.path);
    });

    test('propagates a backend.create() rejection', async () => {
        const failure = new Error('DynamoDB failure');
        const create = mock(async () => {
            throw failure;
        });
        const memoryBackend = { create } as unknown as MemoryToolBackend;
        const clock = new FakeClock(Date.parse('2026-09-05T10:15:30.000Z'));

        await expect(logCompactionSummary({ memoryBackend, clock }, { role: 'conversation', summary: 'x' })).rejects.toBe(failure);
    });
});
