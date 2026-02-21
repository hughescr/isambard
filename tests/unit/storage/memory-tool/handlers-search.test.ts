import { describe, it, test, expect, beforeEach } from 'bun:test';
import { mock } from 'bun:test';
import { split as _split, repeat as _repeat } from 'lodash';
import { mockLogger } from '../../../setup';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath, ContentType } from '@/storage/memory-tool/types';

// Helper to create a minimal mock backend for concurrent tests
const createMockBackend = (): MemoryToolBackend => ({
    create:   mock(async () => ({})),
    get:      mock(async () => undefined),
    update:   mock(async () => ({})),
    'delete': mock(async () => undefined),
    list:     mock(async () => ({ items: [], nextCursor: undefined })),
}) as unknown as MemoryToolBackend;

describe('Memory Tool Handlers - Search Operations', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();

        mockBackend = createMockBackend();
    });

    describe('search', () => {
        const searchHandler = async (
            backend: MemoryToolBackend,
            params: { tags?: string[], layer?: string, time_range?: { start: string, end: string }, limit?: number }
        ): Promise<string> => {
            const { search } = await import('@/storage/memory-tool/handlers');
            return search(backend, params as Parameters<typeof search>[1]);
        };

        describe('mock verification', () => {
            it('should search by single tag', async () => {
                mockBackend.searchByTags = mock(async () => ({
                    items: [
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/note.md',
                            memoryPath:     '/state/note.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      '2025-01-01T00:00:00.000Z',
                            tags:           new Set(['tag1']),
                            contentPreview: 'This is a note with some content that is longer than 100 characters to test preview truncation behavior',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(mockBackend, { tags: ['tag1'] });

                expect(result).toContain('/state/note.md');
                expect(result).toContain('This is a note with some content');
                expect(mockBackend.searchByTags).toHaveBeenCalledWith(new Set(['tag1']), undefined, { limit: undefined });
            });

            it('should search by time range', async () => {
                mockBackend.searchByTimeRange = mock(async () => [
                    {
                        path:        '/events/log.md' as MemoryPath,
                        content:     'Event log',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-15T00:00:00.000Z',
                        updatedAt: '2025-01-15T00:00:00.000Z',
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

                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(mockBackend, { layer: 'identity' });

                expect(result).toContain('/identity/core.md');
                expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { limit: undefined });
            });

            it('should return "No results found" when no search criteria provided', async () => {
                // Set up spies to verify backend methods are NOT called
                mockBackend.searchByTags = mock(async () => ({ items: [], nextCursor: undefined }));
                mockBackend.searchByTimeRange = mock(async () => []);
                mockBackend.listByLayer = mock(async () => ({ items: [], nextCursor: undefined }));

                const result = await searchHandler(mockBackend, {});

                expect(result).toBe('No results found');
                // Verify backend search methods were NOT called since no criteria provided
                expect(mockBackend.searchByTags).not.toHaveBeenCalled();
                expect(mockBackend.searchByTimeRange).not.toHaveBeenCalled();
                expect(mockBackend.listByLayer).not.toHaveBeenCalled();
            });

            it('should apply limit parameter', async () => {
                mockBackend.searchByTags = mock(async () => ({
                    items: [
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/note1.md',
                            memoryPath:     '/state/note1.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      '2025-01-01T00:00:00.000Z',
                            tags:           new Set(['tag1']),
                            contentPreview: 'Note 1',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(mockBackend, { tags: ['tag1'], limit: 5 });

                expect(result).toContain('/state/note1.md');
                expect(mockBackend.searchByTags).toHaveBeenCalledWith(new Set(['tag1']), undefined, { limit: 5 });
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
        });

        describe('output formatting', () => {
            test('should truncate content preview to 100 characters', async () => {
                const backend = createMockBackend();
                const longContent = _repeat('A', 200);
                backend.searchByTags = mock(async () => ({
                    items: [
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/long.md',
                            memoryPath:     '/state/long.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      '2025-01-01T00:00:00.000Z',
                            tags:           new Set(['tag1']),
                            contentPreview: longContent,
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(backend, { tags: ['tag1'] });

                expect(result).toContain(_repeat('A', 100));
                expect(result).toContain('...');
                expect(result).not.toContain(_repeat('A', 101));
            });

            test('should return "No results found" when search returns empty', async () => {
                const backend = createMockBackend();
                backend.searchByTags = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(backend, { tags: ['nonexistent'] });

                expect(result).toContain('No results found');
            });

            test('should return "No results found" when layer search returns empty', async () => {
                const backend = createMockBackend();
                backend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(backend, { layer: 'identity' });

                expect(result).toBe('No results found');
            });

            test('should use empty tag array as no tags', async () => {
                const backend = createMockBackend();
                const result = await searchHandler(backend, { tags: [] });

                expect(result).toBe('No results found');
            });

            test('should not truncate content preview at exactly 100 characters', async () => {
                const backend = createMockBackend();
                const exactContent = _repeat('A', 100);
                backend.searchByTags = mock(async () => ({
                    items: [
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/exact.md',
                            memoryPath:     '/state/exact.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      '2025-01-01T00:00:00.000Z',
                            tags:           new Set(['tag1']),
                            contentPreview: exactContent,
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(backend, { tags: ['tag1'] });

                expect(result).toContain(_repeat('A', 100));
                expect(result).not.toContain('...');
            });

            test('should join search results with double newline', async () => {
                const backend = createMockBackend();
                backend.searchByTags = mock(async () => ({
                    items: [
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/note1.md',
                            memoryPath:     '/state/note1.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      '2025-01-01T00:00:00.000Z',
                            tags:           new Set(['tag1']),
                            contentPreview: 'Content 1',
                        },
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/note2.md',
                            memoryPath:     '/state/note2.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      '2025-01-01T00:00:00.000Z',
                            tags:           new Set(['tag1']),
                            contentPreview: 'Content 2',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(backend, { tags: ['tag1'] });

                expect(result).toContain('\n\n');
                expect(result).toContain('note1.md');
                expect(result).toContain('note2.md');
            });

            test('should include compact timestamp in search results', async () => {
                const backend = createMockBackend();
                // Use a date that's 2 days before now
                const twoDaysAgo = new Date();
                twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
                const updatedAt = twoDaysAgo.toISOString();

                backend.searchByTags = mock(async () => ({
                    items: [
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/note.md',
                            memoryPath:     '/state/note.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      updatedAt,
                            tags:           new Set(['tag1']),
                            contentPreview: 'Note content',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(backend, { tags: ['tag1'] });

                // Should include compact timestamp after path
                expect(result).toContain('/state/note.md (2d ago)');
                expect(result).toContain('Note content');
            });

            test('should show hours for recent search results', async () => {
                const backend = createMockBackend();
                // Use a date that's 3 hours before now
                const threeHoursAgo = new Date();
                threeHoursAgo.setHours(threeHoursAgo.getHours() - 3);
                const updatedAt = threeHoursAgo.toISOString();

                backend.searchByTags = mock(async () => ({
                    items: [
                        {
                            PK:             'TAG#tag1' as const,
                            SK:             '/state/recent.md',
                            memoryPath:     '/state/recent.md' as MemoryPath,
                            layer:          'state' as const,
                            updatedAt:      updatedAt,
                            tags:           new Set(['tag1']),
                            contentPreview: 'Recent content',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await searchHandler(backend, { tags: ['tag1'] });

                // Should include compact timestamp with hours
                expect(result).toContain('/state/recent.md (3h ago)');
            });
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

        describe('mock verification', () => {
            it('should pass max_items to getAutoLoadItems', async () => {
                mockBackend.getAutoLoadItems = mock(async () => []);

                await recallHandler(mockBackend, { max_items: 50 });

                expect(mockBackend.getAutoLoadItems).toHaveBeenCalledWith({
                    maxIdentityItems: 50,
                    maxStateItems:    50,
                });
            });
        });

        describe('output formatting', () => {
            test('should return auto-load items grouped by layer', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/state/current.md' as MemoryPath,
                        content:     'Current state',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('identity');
                expect(result).toContain('state');
                expect(result).toContain('/identity/core.md');
                expect(result).toContain('/state/current.md');
                expect(result).toContain('Core identity');
                expect(result).toContain('Current state');
            });

            test('should show "[no content]" when item has null content in recall', async () => {
                // This test specifically targets the mutant that changes
                // `item.content ?? '[no content]'` at line 423.
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/empty.md' as MemoryPath,
                        content:     undefined as unknown as string,
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('/identity/empty.md');
                expect(result).toContain('[no content]');
            });

            test('should filter layers based on include_layers parameter', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/state/current.md' as MemoryPath,
                        content:     'Current state',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, { include_layers: ['identity'] });

                expect(result).toContain('identity');
                expect(result).toContain('/identity/core.md');
                expect(result).not.toContain('state');
                expect(result).not.toContain('/state/current.md');
            });

            test('should skip empty layers', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('identity');
                expect(result).not.toContain('state:');
                expect(result).not.toContain('events:');
            });

            test('should return empty message when no items', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => []);

                const result = await recallHandler(backend, {});

                expect(result).toContain('No auto-load memories found');
            });

            test('should group items by "other" when layer is null', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/unknown.md' as MemoryPath,
                        content:     'Unknown layer',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('other:');
                expect(result).toContain('/unknown.md');
            });

            test('should include "other" layer items when include_layers is not specified', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/unknown.md' as MemoryPath,
                        content:     'Unknown layer',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('other:');
            });

            test('should join layer sections with double newline', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/state/current.md' as MemoryPath,
                        content:     'Current state',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('\n\n');
                expect(result).toContain('identity:');
                expect(result).toContain('state:');
            });

            test('should join layer items with single newline', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/identity/secondary.md' as MemoryPath,
                        content:     'Secondary identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('identity:\n  /identity/core.md\n    Core identity\n  /identity/secondary.md');
            });

            test('should filter out "other" layer when include_layers is specified', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/unknown.md' as MemoryPath,
                        content:     'Unknown',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, { include_layers: ['identity'] });

                expect(result).toContain('identity:');
                expect(result).toContain('/identity/core.md');
                // "other" layer should still be included even when include_layers is specified
                expect(result).toContain('other:');
                expect(result).toContain('/unknown.md');
            });

            test('should skip truly empty layer with zero items', async () => {
                const backend = createMockBackend();
                backend.getAutoLoadItems = mock(async () => [
                    {
                        path:        '/identity/core.md' as MemoryPath,
                        content:     'Core identity',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ]);

                const result = await recallHandler(backend, {});

                expect(result).toContain('identity:');
                // State and events layers should be completely absent, not shown as empty
                expect(result).not.toContain('state:');
                expect(result).not.toContain('events:');
                // Verify result doesn't contain multiple empty sections
                const sections = _split(result, '\n\n');
                expect(sections.length).toBe(1); // Only identity section
            });
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

        describe('mock verification', () => {
            it('should list items by layer without content', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/identity/core.md' as MemoryPath,
                            content:     'Core identity',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(mockBackend, { layer: 'identity' });

                expect(result).toContain('/identity/core.md');
                expect(result).not.toContain('Core identity');
                expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { limit: undefined });
            });

            it('should apply limit parameter', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/state/note.md' as MemoryPath,
                            content:     'Note',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(mockBackend, { layer: 'state', limit: 10 });

                expect(result).toContain('/state/note.md');
                expect(mockBackend.listByLayer).toHaveBeenCalledWith('state', { limit: 10 });
            });
        });

        describe('output formatting', () => {
            test('should include content with line numbers when requested', async () => {
                const backend = createMockBackend();
                backend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/identity/core.md' as MemoryPath,
                            content:     'Line 1\nLine 2\nLine 3',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(backend, { layer: 'identity', include_content: true });

                expect(result).toContain('/identity/core.md');
                expect(result).toContain('1:Line 1');
                expect(result).toContain('2:Line 2');
                expect(result).toContain('3:Line 3');
            });

            test('should return empty message when no items found', async () => {
                const backend = createMockBackend();
                backend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(backend, { layer: 'identity' });

                expect(result).toContain('No items found');
            });

            test('should show "[no content]" when include_content is true and item has null content', async () => {
                // This test specifically targets the mutant that changes
                // `item.content ? formatLineNumbers(item.content) : '[no content]'` at line 453.
                const backend = createMockBackend();
                backend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/identity/empty.md' as MemoryPath,
                            content:     undefined as unknown as string,
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(backend, { layer: 'identity', include_content: true });

                expect(result).toContain('/identity/empty.md');
                expect(result).toContain('[no content]');
            });

            test('should join items with double newline when include_content is false', async () => {
                const backend = createMockBackend();
                backend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/identity/core.md' as MemoryPath,
                            content:     'Core identity',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                        {
                            path:        '/identity/secondary.md' as MemoryPath,
                            content:     'Secondary',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(backend, { layer: 'identity' });

                // Results joined with double newline, each path includes timestamp
                expect(result).toContain('/identity/core.md');
                expect(result).toContain('/identity/secondary.md');
                expect(result).toContain('\n\n');
            });

            test('should include compact timestamp in path listing', async () => {
                const backend = createMockBackend();
                // Use a date that's 2 days before now
                const twoDaysAgo = new Date();
                twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
                const updatedAt = twoDaysAgo.toISOString();

                backend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/identity/core.md' as MemoryPath,
                            content:     'Core identity',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: updatedAt,
                            updatedAt: updatedAt,
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(backend, { layer: 'identity' });

                // Should include compact timestamp after path
                expect(result).toContain('/identity/core.md (2d ago)');
            });

            test('should include timestamp in path with content', async () => {
                const backend = createMockBackend();
                // Use a date that's 5 hours before now
                const fiveHoursAgo = new Date();
                fiveHoursAgo.setHours(fiveHoursAgo.getHours() - 5);
                const updatedAt = fiveHoursAgo.toISOString();

                backend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/identity/core.md' as MemoryPath,
                            content:     'Line 1\nLine 2',
                            contentType: 'text/markdown' as ContentType,
                            metadata:    {},

                            createdAt: updatedAt,
                            updatedAt: updatedAt,
                        },
                    ],
                    nextCursor: undefined,
                }));

                const result = await listByLayerHandler(backend, { layer: 'identity', include_content: true });

                // Should include timestamp in path header
                expect(result).toContain('/identity/core.md (5h ago)');
                expect(result).toContain('1:Line 1');
                expect(result).toContain('2:Line 2');
            });
        });
    });

    describe('search query building and logging', () => {
        const searchHandler = async (
            backend: MemoryToolBackend,
            params: { tags?: string[], layer?: string, time_range?: { start: string, end: string }, limit?: number }
        ): Promise<string> => {
            const { search } = await import('@/storage/memory-tool/handlers');
            return search(backend, params as Parameters<typeof search>[1]);
        };

        it('should log search with tags joined by comma as query', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/state/note.md',
                        memoryPath:     '/state/note.md' as MemoryPath,
                        layer:          'state' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1', 'tag2']),
                        contentPreview: 'Note content',
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { tags: ['tag1', 'tag2'] });

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'tag1,tag2',
                    resultCount: 1,
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

                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { layer: 'identity' });

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'identity',
                    resultCount: 1,
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

                    createdAt: '2025-01-15T00:00:00.000Z',
                    updatedAt: '2025-01-15T00:00:00.000Z',
                },
            ]);

            await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'time_range',
                    resultCount: 1,
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should log search with empty query and zero results when no criteria provided', async () => {
            await searchHandler(mockBackend, {});

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       '',
                    resultCount: 0,
                    msg:         expect.stringContaining('Memory search:'),
                })
            );
        });

        it('should format time_range search with content preview (>100 chars)', async () => {
            const longContent = _repeat('B', 150);
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/log.md' as MemoryPath,
                    content:     longContent,
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},

                    createdAt: '2025-01-15T00:00:00.000Z',
                    updatedAt: '2025-01-15T00:00:00.000Z',
                },
            ]);

            const result = await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(result).toContain(_repeat('B', 100));
            expect(result).toContain('...');
            expect(result).not.toContain(_repeat('B', 101));
        });

        it('should format time_range search with content preview (<=100 chars)', async () => {
            const shortContent = 'Short event log';
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/short.md' as MemoryPath,
                    content:     shortContent,
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},

                    createdAt: '2025-01-15T00:00:00.000Z',
                    updatedAt: '2025-01-15T00:00:00.000Z',
                },
            ]);

            const result = await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(result).toContain('Short event log');
            expect(result).not.toContain('...');
        });

        it('should format time_range search with no content', async () => {
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/empty.md' as MemoryPath,
                    content:     undefined as unknown as string,
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},

                    createdAt: '2025-01-15T00:00:00.000Z',
                    updatedAt: '2025-01-15T00:00:00.000Z',
                },
            ]);

            const result = await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(result).toContain('[no content]');
        });

        it('should format time_range search with contentPreview field', async () => {
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:           '/events/preview.md' as MemoryPath,
                    content:        'Full content that is very long',
                    contentPreview: 'Preview text from field',
                    contentType:    'text/markdown' as ContentType,
                    metadata:       {},

                    createdAt: '2025-01-15T00:00:00.000Z',
                    updatedAt: '2025-01-15T00:00:00.000Z',
                },
            ]);

            const result = await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(result).toContain('Preview text from field');
            expect(result).not.toContain('Full content');
        });

        it('should join time_range search results with double newline', async () => {
            mockBackend.searchByTimeRange = mock(async () => [
                {
                    path:        '/events/log1.md' as MemoryPath,
                    content:     'Log 1',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},

                    createdAt: '2025-01-15T00:00:00.000Z',
                    updatedAt: '2025-01-15T00:00:00.000Z',
                },
                {
                    path:        '/events/log2.md' as MemoryPath,
                    content:     'Log 2',
                    contentType: 'text/markdown' as ContentType,
                    metadata:    {},

                    createdAt: '2025-01-16T00:00:00.000Z',
                    updatedAt: '2025-01-16T00:00:00.000Z',
                },
            ]);

            const result = await searchHandler(mockBackend, {
                time_range: { start: '2025-01-10T00:00:00.000Z', end: '2025-01-20T00:00:00.000Z' },
            });

            expect(result).toContain('\n\n');
            expect(result).toContain('log1.md');
            expect(result).toContain('log2.md');
        });

        it('should log correct result count in search', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/state/note1.md',
                        memoryPath:     '/state/note1.md' as MemoryPath,
                        layer:          'state' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'Note 1',
                    },
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/state/note2.md',
                        memoryPath:     '/state/note2.md' as MemoryPath,
                        layer:          'state' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'Note 2',
                    },
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/state/note3.md',
                        memoryPath:     '/state/note3.md' as MemoryPath,
                        layer:          'state' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'Note 3',
                    },
                ],
                nextCursor: undefined,
            }));

            await searchHandler(mockBackend, { tags: ['tag1'] });

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    query:       'tag1',
                    resultCount: 3,
                    msg:         'Memory search: "tag1" (3 results)',
                })
            );
        });
    });
});
