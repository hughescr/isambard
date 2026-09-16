import { describe, expect, mock, test } from 'bun:test';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { search } from '@/storage/memory-tool/handlers';
import type { MemoryPath } from '@/storage/memory-tool/types';

const timestamp = '2025-01-01T00:00:00.000Z';

function backendWithTagItems(contentPreviews: string[]): MemoryToolBackend {
    return {
        searchByTags: mock(async () => ({
            items: contentPreviews.map((contentPreview, index) => ({
                PK:         'TAG#tag',
                SK:         `/state/note-${index}.md`,
                memoryPath: `/state/note-${index}.md` as MemoryPath,
                layer:      'state' as const,
                updatedAt:  timestamp,
                tags:       new Set(['tag']),
                contentPreview,
            })),
            nextCursor: undefined,
        })),
    } as unknown as MemoryToolBackend;
}

describe('memory handler tag-search formatting', () => {
    test('preserves empty previews and indents non-empty previews', async () => {
        const emptyPreview = await search(backendWithTagItems(['']), { tags: ['tag'] });
        expect(emptyPreview).toMatch(/\n {2}$/);

        const contentPreview = await search(backendWithTagItems(['content']), { tags: ['tag'] });
        expect(contentPreview).toMatch(/\n {2}content$/);
    });
});
