/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Handler return values are typed as any in tests */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { repeat as _repeat } from 'lodash';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { MemoryPath, ContentType, MemoryToolItemData } from '../../../src/storage/memory-tool/types';

// Helper to create mock memory item data
const createMockItem = (overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData => ({
    path:        '/mock/path' as MemoryPath,
    content:     'mock content',
    contentType: 'text/plain' as ContentType,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Need to access private _registeredTools
    const getToolHandler = (server: any, toolName: string): any => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing private property
        return server.instance._registeredTools[toolName].handler;
    };

    describe('search tool', () => {
        test('should return search results when memories found', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test1.md',
                        memoryPath:     '/memories/test1.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['tag1'],
                        contentPreview: 'First memory content',
                    },
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test2.md',
                        memoryPath:     '/memories/test2.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['tag1'],
                        contentPreview: 'Second memory content',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ tags: ['tag1'] });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('/memories/test1.md');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('/memories/test2.md');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('First memory content');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return message when no memories found', async () => {
            mockBackend.searchByTags = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ tags: ['nonexistent'] });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('No memories found matching tags');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test.each([
            { length: 300, 'char': 'A', shouldTruncate: true, description: 'truncate content preview to 200 characters' },
            { length: 200, 'char': 'B', shouldTruncate: false, description: 'not truncate content exactly at 200 characters' },
        ])('should $description', async ({ length, char, shouldTruncate }) => {
            const content = _repeat(char, length);
            mockBackend.searchByTags = mock(async () => ({
                items: [
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test.md',
                        memoryPath:     '/memories/test.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['tag1'],
                        contentPreview: content,
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ tags: ['tag1'] });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain(_repeat(char, 200));
            if(shouldTruncate) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('...');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).not.toContain(_repeat(char, 201));
            } else {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).not.toContain('...');
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
                        tags:           ['tag1'],
                        contentPreview: 'Content 1',
                    },
                    {
                        PK:             'TAG#tag1' as const,
                        SK:             '/memories/test2.md',
                        memoryPath:     '/memories/test2.md' as MemoryPath,
                        layer:          'identity' as const,
                        updatedAt:      '2025-01-01T00:00:00.000Z',
                        tags:           ['tag1'],
                        contentPreview: 'Content 2',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ tags: ['tag1'] });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('\n\n');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toMatch(/test1\.md.*\n\n.*test2\.md/);
        });

        test('should return error when backend.searchByTags throws Error', async () => {
            mockBackend.searchByTags = mock(async () => {
                throw new Error('Search failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ tags: ['tag1'] });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error searching memories: Search failed');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.searchByTags throws non-Error', async () => {
            mockBackend.searchByTags = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Database timeout';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ tags: ['tag1'] });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error searching memories: Database timeout');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
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
                        tags:           ['tag1'],
                        contentPreview: 'This is my note content',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ tags: ['tag1'] });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('/memories/note.md: This is my note content');
        });
    });

    describe('list tool', () => {
        test('should return directory contents when items exist', async () => {
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/identity/core-values' as MemoryPath,
                        content:     'My core values',
                        contentType: 'text/plain' as ContentType,
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/identity/beliefs' as MemoryPath,
                        content:     'My beliefs',
                        contentType: 'text/plain' as ContentType,
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('/identity/core-values');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('/identity/beliefs');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return empty message for empty directory', async () => {
            mockBackend.list = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/empty' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Directory is empty');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        test('should return error when backend.list throws Error', async () => {
            mockBackend.list = mock(async () => {
                throw new Error('Database connection failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error listing directory: Database connection failed');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.list throws non-Error', async () => {
            mockBackend.list = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Network error';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error listing directory: Network error');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should join multiple paths with newlines', async () => {
            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/users/alice/pref-1' as MemoryPath,
                        content:     'Preference 1',
                        contentType: 'text/plain' as ContentType,
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                    {
                        path:        '/users/alice/pref-2' as MemoryPath,
                        content:     'Preference 2',
                        contentType: 'text/plain' as ContentType,
                        metadata:    {},
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                    },
                ],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'list');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/users/alice' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('/users/alice/pref-1\n/users/alice/pref-2');
        });

        describe('layer path routing', () => {
            test('should use listByLayer for /events path', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items: [
                        {
                            path:        '/events/conversation/2025-01-01T00-00-00Z' as MemoryPath,
                            content:     'Event content',
                            contentType: 'text/plain' as ContentType,
                            metadata:    {},
                            createdAt:   '2025-01-01T00:00:00.000Z',
                            updatedAt:   '2025-01-01T00:00:00.000Z',
                        },
                    ],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                const result = await handler({ path: '/events' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', undefined);
                expect(mockBackend.list).not.toHaveBeenCalled();
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('/events/conversation/2025-01-01T00-00-00Z');
            });

            test('should use listByLayer for /identity path', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/identity' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', undefined);
                expect(mockBackend.list).not.toHaveBeenCalled();
            });

            test('should use listByLayer for /state path', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/state' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('state', undefined);
                expect(mockBackend.list).not.toHaveBeenCalled();
            });

            test('should use regular list for non-layer paths', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/users/alice' });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/alice', undefined);
                expect(mockBackend.listByLayer).not.toHaveBeenCalled();
            });

            test('should use regular list for root path', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/' });

                expect(mockBackend.list).toHaveBeenCalledWith('/', undefined);
                expect(mockBackend.listByLayer).not.toHaveBeenCalled();
            });

            test('should use regular list for nested layer paths', async () => {
                // Nested paths like /events/conversation should use regular list for directory browsing
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/events/conversation' });

                expect(mockBackend.list).toHaveBeenCalledWith('/events/conversation', undefined);
                expect(mockBackend.listByLayer).not.toHaveBeenCalled();
            });
        });
    });
});
