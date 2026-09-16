import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { ContentTooLargeError, TextNotFoundError, TextNotUniqueError } from '@/errors/storage';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { consolidate, create, insert, list_by_layer, recall, rename, search, str_replace as strReplace } from '@/storage/memory-tool/handlers';
import { createLayerName, type ContentType, type MemoryPath, type MemoryToolItemData } from '@/storage/memory-tool/types';

const timestamp = '2025-01-01T00:00:00.000Z';

function item(path: string, content: string, contentType: ContentType = 'text/markdown'): MemoryToolItemData {
    return {
        path:      path as MemoryPath,
        content,
        contentType,
        metadata:  {},
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

function backend(): MemoryToolBackend {
    return {
        create:            mock(async input => item(input.path, input.content, input.contentType)),
        get:               mock(async () => undefined),
        update:            mock(async (path, input) => item(path, input.content ?? 'unchanged')),
        'delete':          mock(async () => undefined),
        list:              mock(async () => ({ items: [], nextCursor: undefined })),
        searchByTags:      mock(async () => ({ items: [], nextCursor: undefined })),
        listByLayer:       mock(async () => ({ items: [], nextCursor: undefined })),
        searchByTimeRange: mock(async () => []),
        getAutoLoadItems:  mock(async () => []),
    } as unknown as MemoryToolBackend;
}

function deferred<T>() {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return { promise, resolve: settle };
}

async function expectPending<T>(operation: Promise<T>): Promise<void> {
    const outcome = await Promise.race([
        operation.then(() => 'settled' as const),
        Bun.sleep(10).then(() => 'pending' as const),
    ]);
    expect(outcome).toBe('pending');
}

describe('memory handler public contract boundaries', () => {
    test.each([
        '/state/note.md.backup',
        '/state/data.json.bak',
    ])('content type detection requires a terminal extension: %s', async (path) => {
        const store = backend();
        await create(store, { path, file_text: 'content' });
        expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'text/plain' }));
    });

    test('insert preserves caller whitespace and enforces the byte limit for multibyte text', async () => {
        const store = backend();
        store.get = mock(async () => item('/state/note.md', 'existing'));

        await insert(store, { path: '/state/note.md', insert_line: 0, insert_text: '  exact whitespace  ' });
        expect(store.update).toHaveBeenLastCalledWith('/state/note.md', {
            content: '  exact whitespace  \nexisting',
        });

        await expect(insert(store, {
            path:        '/state/note.md',
            insert_line: 0,
            insert_text: 'é'.repeat(175_000),
        })).rejects.toThrow(ContentTooLargeError);
    });

    test('replacement distinguishes an empty memory from a missing path and counts UTF-8 bytes', async () => {
        const store = backend();
        store.get = mock(async () => item('/state/note.md', ''));
        await expect(strReplace(store, {
            path: '/state/note.md', old_str: 'absent', new_str: 'replacement',
        })).rejects.toThrow(TextNotFoundError);

        store.get = mock(async () => item('/state/note.md', 'x'));
        await expect(strReplace(store, {
            path: '/state/note.md', old_str: 'x', new_str: 'é'.repeat(175_001),
        })).rejects.toThrow(ContentTooLargeError);
    });

    test('replacement rejects an empty search string as non-unique without writing', async () => {
        const store = backend();
        store.get = mock(async () => item('/state/note.md', 'ab'));

        try {
            await strReplace(store, { path: '/state/note.md', old_str: '', new_str: 'X' });
            throw new Error('expected empty search string to be rejected');
        } catch (error) {
            expect(error).toBeInstanceOf(TextNotUniqueError);
            expect((error as TextNotUniqueError).context.count).toBe(3);
        }
        expect(store.update).not.toHaveBeenCalled();

        await strReplace(store, { path: '/state/note.md', old_str: 'a', new_str: '$&X' });
        expect(store.update).toHaveBeenCalledWith('/state/note.md', { content: 'aXb' });
    });

    test.each(['insert', 'replace'] as const)('%s resolves only after its update persists', async (operationName) => {
        const store = backend();
        store.get = mock(async () => item('/state/note.md', 'old'));
        const update = deferred<MemoryToolItemData>();
        store.update = mock(() => update.promise);
        const operation = operationName === 'insert'
            ? insert(store, { path: '/state/note.md', insert_line: 0, insert_text: 'new' })
            : strReplace(store, { path: '/state/note.md', old_str: 'old', new_str: 'new' });

        await expectPending(operation);
        update.resolve(item('/state/note.md', 'new'));
        await expect(operation).resolves.toContain(operationName === 'insert' ? 'inserted' : 'replaced');
    });

    test('rename waits for the copied memory before deleting its source', async () => {
        const store = backend();
        store.get = mock(async path => (path === '/state/source.md' ? item(path, 'source') : undefined));
        const created = deferred<MemoryToolItemData>();
        store.create = mock(() => created.promise);

        const operation = rename(store, { path: '/state/source.md', new_path: '/state/target.md' });
        await expectPending(operation);
        expect(store.delete).not.toHaveBeenCalled();
        created.resolve(item('/state/target.md', 'source'));
        await operation;
        expect(store.delete).toHaveBeenCalledWith('/state/source.md');
    });

    test('search previews preserve exact 99/100/101 character boundaries and append truncation markers', async () => {
        const store = backend();
        store.searchByTags = mock(async () => ({
            items: [{
                PK:             'TAG#tag', SK:             '/state/tagged.md', memoryPath:     '/state/tagged.md' as MemoryPath,
                layer:          'state', updatedAt:      timestamp, tags:           new Set(['tag']), contentPreview: 'T'.repeat(101),
            }],
            nextCursor: undefined,
        }));
        const tagged = await search(store, { tags: ['tag'] });
        expect(tagged).toContain(`${'T'.repeat(100)}...`);

        store.searchByTimeRange = mock(async () => [
            item('/state/content.md', 'C'.repeat(101)),
            { ...item('/state/preview.md', 'unused'), contentPreview: 'P'.repeat(99) },
        ]);
        const ranged = await search(store, { time_range: { start: timestamp, end: timestamp } });
        expect(ranged).toContain(`${'C'.repeat(100)}...`);
        expect(ranged).toContain(`  ${'P'.repeat(99)}`);
        expect(ranged).not.toContain(`${'P'.repeat(99)}...`);
    });

    test('recall preserves empty legacy content and emits layers in identity-state-events order', async () => {
        const store = backend();
        store.getAutoLoadItems = mock(async () => [
            item('/events/event.md', 'event'),
            item('/state/empty.md', ''),
            item('/identity/core.md', 'identity'),
        ]);

        const result = await recall(store, {});
        expect(result).not.toContain('[no content]');
        expect(result.indexOf('identity:')).toBeLessThan(result.indexOf('state:'));
        expect(result.indexOf('state:')).toBeLessThan(result.indexOf('events:'));
        expect(result).toContain('  /state/empty.md\n    ');
    });

    test('consolidate derives content type from the target and waits for creation before deleting sources', async () => {
        const store = backend();
        const created = deferred<MemoryToolItemData>();
        store.create = mock(() => created.promise);

        const operation = consolidate(store, {
            source_paths: ['/state/source.md'],
            target_path:  '/state/summary.json',
            summary:      '{}',
        });
        await expectPending(operation);
        expect(store.create).toHaveBeenCalledWith({
            path: '/state/summary.json', content: '{}', contentType: 'application/json',
        });
        expect(store.delete).not.toHaveBeenCalled();
        created.resolve(item('/state/summary.json', '{}', 'application/json'));
        await operation;
        expect(store.delete).toHaveBeenCalledWith('/state/source.md');
    });
});

/**
 * User-visible output contracts that the `toContain` assertions in
 * handlers-search.test.ts cannot distinguish from their mutants.
 */
describe('memory handler output formatting contracts', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    function layerBackend(items: MemoryToolItemData[]): MemoryToolBackend {
        const store = backend();
        store.listByLayer = mock(async () => ({ items, nextCursor: undefined }));
        return store;
    }

    function layerItem(createdAt: string, updatedAt: string, content: string): MemoryToolItemData {
        return {
            path:        '/state/note.md' as MemoryPath,
            content,
            contentType: 'text/markdown',
            metadata:    {},
            createdAt,
            updatedAt,
        };
    }

    test('create measures UTF-8 bytes rather than UTF-16 code units', async () => {
        const store = backend();
        // 175_001 UTF-16 code units, but 350_002 UTF-8 bytes: only the byte count crosses the limit.
        await expect(create(store, { path: '/state/big.md', file_text: 'é'.repeat(175_001) }))
            .rejects.toThrow(ContentTooLargeError);
        expect(store.create).not.toHaveBeenCalled();
    });

    test('the empty-layer message names the requested layer', async () => {
        const store = layerBackend([]);

        expect(await list_by_layer(store, { layer: createLayerName('events') })).toBe('No items found in layer: events');
    });

    test('the rendered timestamp comes from updatedAt, not createdAt', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
        const store = layerBackend([
            layerItem('2026-04-01T12:00:00.000Z', '2026-05-10T09:00:00.000Z', 'note'),
        ]);

        expect(await list_by_layer(store, { layer: createLayerName('state') })).toBe('/state/note.md (3h ago)');
    });

    test('a content listing prints the path line before the content', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
        const store = layerBackend([
            layerItem('2026-04-01T12:00:00.000Z', '2026-05-10T09:00:00.000Z', 'Line 1\nLine 2'),
        ]);

        expect(await list_by_layer(store, { layer: createLayerName('state'), include_content: true }))
            .toBe('/state/note.md (3h ago)\n1:Line 1\n2:Line 2');
    });

    test('a preview that reaches 100 characters with trailing whitespace still gets the truncation marker', async () => {
        const store = backend();
        // generateContentPreview slices the first 100 characters verbatim, so a
        // truncated preview can end in whitespace; trimming before measuring the
        // length would drop the marker on a preview that really was truncated.
        const preview = `${'T'.repeat(98)}  `;
        store.searchByTimeRange = mock(async () => [
            { ...item('/state/padded.md', 'unused'), contentPreview: preview },
        ]);

        const ranged = await search(store, { time_range: { start: timestamp, end: timestamp } });

        expect(ranged).toContain(`${preview}...`);
    });
});
