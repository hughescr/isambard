import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { MemoryPath, MemoryToolItemData } from '../../../src/storage/memory-tool/types';
import { textContent } from '../../setup';

// Helper to create mock memory item data
const createMockItem = (overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData => ({
    path:        '/mock/path' as MemoryPath,
    content:     'mock content',
    contentType: 'text/plain',
    metadata:    {},
    createdAt:   '2025-01-01T00:00:00.000Z',
    updatedAt:   '2025-01-01T00:00:00.000Z',
    ...overrides,
});

describe.concurrent('Memory MCP Server Search and List Tools', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:       mock(async () => createMockItem()),
            get:          mock(async () => undefined),
            update:       mock(async () => createMockItem()),
            'delete':     mock(async () => { /* intentionally empty */ }),
            list:         mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer:  mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTags: mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;
    });

    // Helper function to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createMemoryMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        const instance = server.instance as unknown as { _registeredTools: Record<string, { handler: (...args: unknown[]) => Promise<CallToolResult> }> };
        return instance._registeredTools[toolName].handler;
    };

    describe('search tool', () => {
        test('accepts and forwards users layer filter while rejecting arbitrary namespaces', async () => {
            const server = createMemoryMCPServer(mockBackend);
            const registered = (server.instance as unknown as { _registeredTools: Record<string, { inputSchema: { shape: { layer: { safeParse: (value: string) => { success: boolean } } } } }> })._registeredTools.search;
            expect(registered.inputSchema.shape.layer.safeParse('users').success).toBe(true);
            expect(registered.inputSchema.shape.layer.safeParse('unknown').success).toBe(false);
            await getToolHandler(server, 'search')({ tags: ['person'], layer: 'users' });
            expect(mockBackend.searchByTags).toHaveBeenCalledWith(new Set(['person']), 'users', undefined);
        });
        test('should return search results when memories found', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test1.md',
                        memoryPath:     '/memories/test1.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'First memory content',
                    },
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test2.md',
                        memoryPath:     '/memories/test2.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'Second memory content',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toContain('/memories/test1.md');
            expect(textContent(result.content[0])).toContain('/memories/test2.md');
            expect(textContent(result.content[0])).toContain('First memory content');
            expect(result.isError).toBeUndefined();
        });

        test('should return message when no memories found', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['nonexistent'] });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('No memories found matching tags');
            expect(result.isError).toBeUndefined();
        });

        test.each([
            { length: 300, 'char': 'A', shouldTruncate: true, description: 'truncate content preview to 200 characters' },
            { length: 201, 'char': 'C', shouldTruncate: true, description: 'mark a 201-character preview as truncated' },
            { length: 200, 'char': 'B', shouldTruncate: false, description: 'not truncate content exactly at 200 characters' },
        ])('should $description', async ({ length, char, shouldTruncate }) => {
            const content = char.repeat(length);
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test.md',
                        memoryPath:     '/memories/test.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: content,
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            expect(textContent(result.content[0])).toContain(char.repeat(200));
            if(shouldTruncate) {
                expect(textContent(result.content[0])).toContain('...');
                expect(textContent(result.content[0])).not.toContain(char.repeat(201));
            } else {
                expect(textContent(result.content[0])).not.toContain('...');
            }
        });

        test('should join multiple results with double newline', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test1.md',
                        memoryPath:     '/memories/test1.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'Content 1',
                    },
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test2.md',
                        memoryPath:     '/memories/test2.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'Content 2',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            expect(textContent(result.content[0])).toContain('\n\n');
            expect(textContent(result.content[0])).toMatch(/test1\.md.*\n\n.*test2\.md/);
        });

        test('should return error when backend.searchByTags throws Error', async () => {
            mockBackend.searchByTags = mock(async () => {
                throw new Error('Search failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error searching memories: Search failed');
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.searchByTags throws non-Error', async () => {
            mockBackend.searchByTags = mock(async () => {
                throw 'Database timeout';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error searching memories: Database timeout');
            expect(result.isError).toBe(true);
        });

        test('should stringify a symbol thrown by backend.searchByTags', async () => {
            mockBackend.searchByTags = mock(async () => {
                throw Symbol('search failure');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            let outcome: { kind: 'result', result: CallToolResult } | { kind: 'error', error: unknown };
            try {
                outcome = { kind: 'result', result: await handler({ tags: ['tag1'] }) };
            } catch (error) {
                outcome = { kind: 'error', error };
            }

            // A non-Error thrown value (here a Symbol) must be converted with String(), not
            // interpolated directly — interpolating a raw Symbol in a template literal throws.
            expect(outcome.kind).toBe('result');
            if(outcome.kind === 'result') {
                expect(textContent(outcome.result.content[0])).toBe('Error searching memories: Symbol(search failure)');
                expect(outcome.result.isError).toBe(true);
            }
        });

        test('should format results with path and content preview', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/note.md',
                        memoryPath:     '/memories/note.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'This is my note content',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            expect(textContent(result.content[0])).toBe('/memories/note.md: This is my note content');
        });

        test('shows an empty content preview verbatim rather than falling back to "No content"', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/empty.md',
                        memoryPath:     '/memories/empty.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: '',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            // contentPreview: '' is present (not nullish), so it must be shown as-is —
            // a falsy-based fallback would replace it with 'No content'.
            expect(textContent(result.content[0])).toBe('/memories/empty.md: ');
        });

        test('preserves leading/trailing whitespace in content preview rather than trimming it', async () => {
            const paddedContent = '  padded content  ';
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/pad.md',
                        memoryPath:     '/memories/pad.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: paddedContent,
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            expect(textContent(result.content[0])).toBe(`/memories/pad.md: ${paddedContent}`);
        });

        test('shows a missing memory path as "undefined" rather than falling back to "Unknown"', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/x.md',
                        // Bypass the TagIndexReadItem['memoryPath'] string type to simulate a
                        // backend row that has no memoryPath at runtime (a nullish-coalescing
                        // fallback would substitute 'Unknown' here instead).
                        memoryPath:     undefined as unknown as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           new Set(['tag1']),
                        contentPreview: 'content',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['tag1'] });

            // memoryPath is undefined; the current code interpolates it as literal
            // "undefined" text. A `?? 'Unknown'` fallback would show 'Unknown' instead.
            expect(textContent(result.content[0])).toBe('undefined: content');
        });
    });

    describe('list tool', () => {
        test('should return directory contents when items exist', async () => {
            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items: [
                    {
                        path:        '/identity/core-values' as MemoryPath,
                        content:     'My core values',
                        contentType: 'text/plain',
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/identity/beliefs' as MemoryPath,
                        content:     'My beliefs',
                        contentType: 'text/plain',
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            const result = await handler({ path: '/' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toContain('/identity/core-values');
            expect(textContent(result.content[0])).toContain('/identity/beliefs');
            expect(result.isError).toBeUndefined();
        });

        test('should return empty message for empty directory', async () => {
            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            const result = await handler({ path: '/empty' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Directory is empty');
            expect(result.isError).toBeUndefined();
        });

        test('should return error when backend.list throws Error', async () => {
            mockBackend.list = mock<MemoryToolBackend['list']>(async () => {
                throw new Error('Database connection failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            const result = await handler({ path: '/' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error listing directory: Database connection failed');
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.list throws non-Error', async () => {
            mockBackend.list = mock<MemoryToolBackend['list']>(async () => {
                throw 'Network error';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            const result = await handler({ path: '/' });

            expect(textContent(result.content[0])).toBe('Error listing directory: Network error');
            expect(result.isError).toBe(true);
        });

        test('should stringify a symbol thrown by backend.list', async () => {
            mockBackend.list = mock(async () => {
                throw Symbol('list failure');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');
            let outcome: { kind: 'result', result: CallToolResult } | { kind: 'error', error: unknown };
            try {
                outcome = { kind: 'result', result: await handler({ path: '/memories' }) };
            } catch (error) {
                outcome = { kind: 'error', error };
            }

            expect(outcome.kind).toBe('result');
            if(outcome.kind === 'result') {
                expect(textContent(outcome.result.content[0])).toBe('Error listing directory: Symbol(list failure)');
                expect(outcome.result.isError).toBe(true);
            }
        });

        test('should join multiple paths with newlines', async () => {
            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items: [
                    {
                        path:        '/users/alice/pref-1' as MemoryPath,
                        content:     'Preference 1',
                        contentType: 'text/plain',
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/users/alice/pref-2' as MemoryPath,
                        content:     'Preference 2',
                        contentType: 'text/plain',
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            const result = await handler({ path: '/users/alice' });

            expect(textContent(result.content[0])).toBe('/users/alice/pref-1\n/users/alice/pref-2');
        });

        describe('layer path routing', () => {
            test('should use listByLayer for /events path', async () => {
                mockBackend.listByLayer = mock<MemoryToolBackend['listByLayer']>(async () => ({
                    items: [
                        {
                            path:        '/events/conversation/2025-01-01T00-00-00Z' as MemoryPath,
                            content:     'Event content',
                            contentType: 'text/plain',
                            metadata:    {},
                            createdAt:   '2025-01-01T00:00:00.000Z',
                            updatedAt:   '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                const result = await handler({ path: '/events' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', undefined);
                expect(mockBackend.list).not.toHaveBeenCalled();
                expect(textContent(result.content[0])).toContain('/events/conversation/2025-01-01T00-00-00Z');
            });

            test('should use listByLayer for /identity path', async () => {
                mockBackend.listByLayer = mock<MemoryToolBackend['listByLayer']>(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path: '/identity' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', undefined);
                expect(mockBackend.list).not.toHaveBeenCalled();
            });

            test('should use listByLayer for /state path', async () => {
                mockBackend.listByLayer = mock<MemoryToolBackend['listByLayer']>(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path: '/state' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('state', undefined);
                expect(mockBackend.list).not.toHaveBeenCalled();
            });

            test.each([
                ['non-layer path', '/users/alice'],
                ['root path', '/'],
                ['nested layer path', '/events/conversation'],
            ])('should use regular list for %s', async (_description, path) => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path });

                expect(mockBackend.list).toHaveBeenCalledWith(path, undefined);
                expect(mockBackend.listByLayer).not.toHaveBeenCalled();
            });
        });
    });
});
