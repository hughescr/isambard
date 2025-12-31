/* eslint-disable @typescript-eslint/unbound-method -- Mock functions don't have proper this binding */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { mock } from 'bun:test';
import { split as _split, repeat as _repeat } from 'lodash';
import { logger } from '@hughescr/logger';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath, ContentType } from '@/storage/memory-tool/types';

describe('Memory Tool Handlers - Search Operations', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:   mock(async () => ({})),
            get:      mock(async () => undefined),
            update:   mock(async () => ({})),
            'delete': mock(async () => { /* intentionally empty */ }),
            list:     mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;
    });

    describe('search', () => {
        const searchHandler = async (
            backend: MemoryToolBackend,
            params: { tags?: string[], layer?: string, time_range?: { start: string, end: string }, limit?: number }
        ): Promise<string> => {
            const { search } = await import('@/storage/memory-tool/handlers');
            return search(backend, params as Parameters<typeof search>[1]);
        };

        it('should search by single tag', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note.md' as MemoryPath,
                        content:     'This is a note with some content that is longer than 100 characters to test preview truncation behavior',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain('/state/note.md');
            expect(result).toContain('This is a note with some content');
            expect(mockBackend.searchByTag).toHaveBeenCalledWith('tag1', undefined, { limit: undefined });
        });

        it('should search with multiple tags using AND logic', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1', 'tag2'] });

            expect(result).toContain('/state/note1.md');
            expect(result).not.toContain('/state/note2.md');
        });

        it('should not filter when exactly one tag provided', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            // Both items should be included since we only have one tag
            expect(result).toContain('/state/note1.md');
            expect(result).toContain('/state/note2.md');
        });

        it('should filter with three tags using AND logic', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2', 'tag3'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1', 'tag2', 'tag3'] });

            expect(result).toContain('/state/note1.md');
            expect(result).not.toContain('/state/note2.md');
        });

        it('should search by time range', async () => {
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/log.md' as MemoryPath,
                    content:     'Event log',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T00:00:00.000Z',
                    updatedAt:   '2025-01-15T00:00:00.000Z',
                },
            ]);

            const result = await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(result).toContain('/events/log.md');
            expect(mockBackend.searchByTimeRange).toHaveBeenCalledWith(
                '2025-01-10T00:00:00.000Z',
                '2025-01-20T00:00:00.000Z',
                undefined,
                { limit: undefined }
            );
        });

        it('should search by layer only', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { layer: 'identity' });

            expect(result).toContain('/identity/core.md');
            expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { limit: undefined });
        });

        it('should truncate content preview to 100 characters', async () => {
            const longContent = _repeat('A', 200);
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/long.md' as MemoryPath,
                        content:     longContent,
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain(_repeat('A', 100));
            expect(result).toContain('...');
            expect(result).not.toContain(_repeat('A', 101));
        });

        it('should return "No results found" when search returns empty', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['nonexistent'] });

            expect(result).toContain('No results found');
        });

        it('should return "No results found" when no search criteria provided', async () => {
            // Set up spies to verify backend methods are NOT called
            mockBackend.searchByTag = mock(async () => ({ items: [], nextCursor: undefined }));
            mockBackend.searchByTimeRange = mock(async () => []);
            mockBackend.listByLayer = mock(async () => ({ items: [], nextCursor: undefined }));

            const result = await searchHandler(mockBackend, {});

            expect(result).toBe('No results found');
            // Verify backend search methods were NOT called since no criteria provided
            expect(mockBackend.searchByTag).not.toHaveBeenCalled();
            expect(mockBackend.searchByTimeRange).not.toHaveBeenCalled();
            expect(mockBackend.listByLayer).not.toHaveBeenCalled();
        });

        it('should return "No results found" when layer search returns empty', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { layer: 'identity' });

            expect(result).toBe('No results found');
        });

        it('should use empty tag array as no tags', async () => {
            const result = await searchHandler(mockBackend, { tags: [] });

            expect(result).toBe('No results found');
        });

        it('should not truncate content preview at exactly 100 characters', async () => {
            const exactContent = _repeat('A', 100);
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/exact.md' as MemoryPath,
                        content:     exactContent,
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain(_repeat('A', 100));
            expect(result).not.toContain('...');
        });

        it('should join search results with double newline', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Content 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Content 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(result).toContain('\n\n');
            expect(result).toContain('note1.md');
            expect(result).toContain('note2.md');
        });

        it('should apply limit parameter', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'], limit: 5 });

            expect(result).toContain('/state/note1.md');
            expect(mockBackend.searchByTag).toHaveBeenCalledWith('tag1', undefined, { limit: 5 });
        });

        it('should pass undefined limit to searchByTimeRange when limit not specified', async () => {
            mockBackend.searchByTimeRange = mock(async () => []);

            await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(mockBackend.searchByTimeRange).toHaveBeenCalledWith(
                '2025-01-10T00:00:00.000Z',
                '2025-01-20T00:00:00.000Z',
                undefined,
                { limit: undefined }
            );
        });

        it('should include compact timestamp in search results', async () => {
            // Use a date that's 2 days before now
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            const updatedAt = twoDaysAgo.toISOString();

            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note.md' as MemoryPath,
                        content:     'Note content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   updatedAt,
                        updatedAt:   updatedAt,
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            // Should include compact timestamp after path
            expect(result).toContain('/state/note.md (2d ago)');
            expect(result).toContain('Note content');
        });

        it('should show hours for recent search results', async () => {
            // Use a date that's 3 hours before now
            const threeHoursAgo = new Date();
            threeHoursAgo.setHours(threeHoursAgo.getHours() - 3);
            const updatedAt = threeHoursAgo.toISOString();

            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/recent.md' as MemoryPath,
                        content:     'Recent content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   updatedAt,
                        updatedAt:   updatedAt,
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await searchHandler(mockBackend, { tags: ['tag1'] });

            // Should include compact timestamp with hours
            expect(result).toContain('/state/recent.md (3h ago)');
        });
    });

    describe('recall', () => {
        const recallHandler = async (
            backend: MemoryToolBackend,
            params: { max_items?: number, include_layers?: string[] }
        ): Promise<string> => {
            const { recall } = await import('@/storage/memory-tool/handlers');
            return recall(backend, params as Parameters<typeof recall>[1]);
        };

        it('should return auto-load items grouped by layer', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity');
            expect(result).toContain('state');
            expect(result).toContain('/identity/core.md');
            expect(result).toContain('/state/current.md');
            expect(result).toContain('Core identity');
            expect(result).toContain('Current state');
        });

        it('should filter layers based on include_layers parameter', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, { include_layers: ['identity'] });

            expect(result).toContain('identity');
            expect(result).toContain('/identity/core.md');
            expect(result).not.toContain('state');
            expect(result).not.toContain('/state/current.md');
        });

        it('should skip empty layers', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity');
            expect(result).not.toContain('state:');
            expect(result).not.toContain('events:');
        });

        it('should return empty message when no items', async () => {
            mockBackend.getAutoLoadItems = mock(async () => []);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('No auto-load memories found');
        });

        it('should pass max_items to getAutoLoadItems', async () => {
            mockBackend.getAutoLoadItems = mock(async () => []);

            await recallHandler(mockBackend, { max_items: 50 });

            expect(mockBackend.getAutoLoadItems).toHaveBeenCalledWith({
                maxIdentityItems: 50,
                maxStateItems:    50,
            });
        });

        it('should group items by "other" when layer is null', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/unknown.md' as MemoryPath,
                    content:     'Unknown layer',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('other:');
            expect(result).toContain('/unknown.md');
        });

        it('should include "other" layer items when include_layers is not specified', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/unknown.md' as MemoryPath,
                    content:     'Unknown layer',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('other:');
        });

        it('should join layer sections with double newline', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/state/current.md' as MemoryPath,
                    content:     'Current state',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('\n\n');
            expect(result).toContain('identity:');
            expect(result).toContain('state:');
        });

        it('should join layer items with single newline', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/identity/secondary.md' as MemoryPath,
                    content:     'Secondary identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity:\n  /identity/core.md\n    Core identity\n  /identity/secondary.md');
        });

        it('should filter out "other" layer when include_layers is specified', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
                {
                    path:        '/unknown.md' as MemoryPath,
                    content:     'Unknown',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, { include_layers: ['identity'] });

            expect(result).toContain('identity:');
            expect(result).toContain('/identity/core.md');
            // "other" layer should still be included even when include_layers is specified
            expect(result).toContain('other:');
            expect(result).toContain('/unknown.md');
        });

        it('should skip truly empty layer with zero items', async () => {
            mockBackend.getAutoLoadItems = mock(async () => [
                {
                    path:        '/identity/core.md' as MemoryPath,
                    content:     'Core identity',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            ]);

            const result = await recallHandler(mockBackend, {});

            expect(result).toContain('identity:');
            // State and events layers should be completely absent, not shown as empty
            expect(result).not.toContain('state:');
            expect(result).not.toContain('events:');
            // Verify result doesn't contain multiple empty sections
            const sections = _split(result, '\n\n');
            expect(sections.length).toBe(1); // Only identity section
        });
    });

    describe('list_by_layer', () => {
        const listByLayerHandler = async (
            backend: MemoryToolBackend,
            params: { layer: string, include_content?: boolean, limit?: number }
        ): Promise<string> => {
            const { list_by_layer } = await import('@/storage/memory-tool/handlers');
            return list_by_layer(backend, params as Parameters<typeof list_by_layer>[1]);
        };

        it('should list items by layer without content', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

            expect(result).toContain('/identity/core.md');
            expect(result).not.toContain('Core identity');
            expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { limit: undefined });
        });

        it('should include content with line numbers when requested', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Line 1\nLine 2\nLine 3',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity', include_content: true });

            expect(result).toContain('/identity/core.md');
            expect(result).toContain('1:Line 1');
            expect(result).toContain('2:Line 2');
            expect(result).toContain('3:Line 3');
        });

        it('should apply limit parameter', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/state/note.md' as MemoryPath,
                        content:     'Note',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'state', limit: 10 });

            expect(result).toContain('/state/note.md');
            expect(mockBackend.listByLayer).toHaveBeenCalledWith('state', { limit: 10 });
        });

        it('should return empty message when no items found', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

            expect(result).toContain('No items found');
        });

        it('should join items with double newline when include_content is false', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/identity/secondary.md' as MemoryPath,
                        content:     'Secondary',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

            // Results joined with double newline, each path includes timestamp
            expect(result).toContain('/identity/core.md');
            expect(result).toContain('/identity/secondary.md');
            expect(result).toContain('\n\n');
        });

        it('should include compact timestamp in path listing', async () => {
            // Use a date that's 2 days before now
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            const updatedAt = twoDaysAgo.toISOString();

            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   updatedAt,
                        updatedAt:   updatedAt,
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

            // Should include compact timestamp after path
            expect(result).toContain('/identity/core.md (2d ago)');
        });

        it('should include timestamp in path with content', async () => {
            // Use a date that's 5 hours before now
            const fiveHoursAgo = new Date();
            fiveHoursAgo.setHours(fiveHoursAgo.getHours() - 5);
            const updatedAt = fiveHoursAgo.toISOString();

            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Line 1\nLine 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   updatedAt,
                        updatedAt:   updatedAt,
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await listByLayerHandler(mockBackend, { layer: 'identity', include_content: true });

            // Should include timestamp in path header
            expect(result).toContain('/identity/core.md (5h ago)');
            expect(result).toContain('1:Line 1');
            expect(result).toContain('2:Line 2');
        });
    });

    describe('search query building and logging', () => {
        let debugSpy: ReturnType<typeof spyOn>;

        const searchHandler = async (
            backend: MemoryToolBackend,
            params: { tags?: string[], layer?: string, time_range?: { start: string, end: string }, limit?: number }
        ): Promise<string> => {
            const { search } = await import('@/storage/memory-tool/handlers');
            return search(backend, params as Parameters<typeof search>[1]);
        };

        beforeEach(() => {
            debugSpy = spyOn(logger, 'debug');
        });

        it('should log search with tags joined by comma as query', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note.md' as MemoryPath,
                        content:     'Note content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1', 'tag2'],
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { tags: ['tag1', 'tag2'] });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'tag1,tag2',
                    resultCount: 1,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log search with layer as query when no tags provided', async () => {
            mockBackend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { layer: 'identity' });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'identity',
                    resultCount: 1,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log search with time_range as query when no tags or layer provided', async () => {
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/log.md' as MemoryPath,
                    content:     'Event log',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-15T00:00:00.000Z',
                    updatedAt:   '2025-01-15T00:00:00.000Z',
                },
            ]);

            await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'time_range',
                    resultCount: 1,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log search with empty query and zero results when no criteria provided', async () => {
            await searchHandler(mockBackend, {});

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       '',
                    resultCount: 0,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log correct result count in search', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/state/note1.md' as MemoryPath,
                        content:     'Note 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note2.md' as MemoryPath,
                        content:     'Note 2',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/state/note3.md' as MemoryPath,
                        content:     'Note 3',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'tag1',
                    resultCount: 3,
                    msg:         'Memory search: "tag1" (3 results)',
                })
            );
        });
    });
});
