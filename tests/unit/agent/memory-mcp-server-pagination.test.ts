import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { MemoryPath, ContentType, MemoryToolItemData, TagIndexItem } from '../../../src/storage/memory-tool/types';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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

// Helper to create mock tag index item
const createMockTagIndexItem = (overrides: Partial<TagIndexItem> = {}): TagIndexItem => ({
    PK:             'TAG#mock',
    SK:             'PATH#/mock/path',
    memoryPath:     '/mock/path',
    layer:          'state',
    updatedAt:      '2025-01-01T00:00:00.000Z',
    tags:           new Set(['mock']),
    contentPreview: 'mock content',
    ...overrides,
});

describe.concurrent('Memory MCP Server Pagination', () => {
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

    interface SafeParseResult { success: boolean }
    interface UnwrappedSchema { safeParse: (v: unknown) => SafeParseResult }
    interface ToolInputSchema { shape: Record<string, { unwrap: () => UnwrappedSchema }> }
    interface RegisteredTool { handler: (...args: unknown[]) => Promise<CallToolResult>, inputSchema: ToolInputSchema }
    interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool> }
    // Helper function to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createMemoryMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    describe('list tool pagination', () => {
        describe('schema', () => {
            test('should have pagination parameters in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                const listTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.list;

                expect(listTool.inputSchema.shape.limit).toBeDefined();
                expect(listTool.inputSchema.shape.cursor).toBeDefined();
            });

            test.each([
                ['positive integer', 10, true],
                ['zero', 0, false],
                ['negative', -5, false],
                ['non-integer', 1.5, false],
            ])('should validate limit: %s', (_label, value, shouldPass) => {
                const server = createMemoryMCPServer(mockBackend);
                const listTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.list;
                const result = listTool.inputSchema.shape.limit.unwrap().safeParse(value);
                expect(result.success).toBe(shouldPass);
            });
        });

        describe('backend calls with options', () => {
            test.each([
                ['limit only', { limit: 10 }, { limit: 10 }],
                ['cursor only', { cursor: 'dGVzdA==' }, { cursor: 'dGVzdA==' }],
                ['both limit and cursor', { limit: 5, cursor: 'Y3Vyc29y' }, { limit: 5, cursor: 'Y3Vyc29y' }],
                ['no options', {}, undefined],
            ])('should pass %s to backend.list for non-layer paths', async (_label, handlerArgs, expectedOptions) => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path: '/users/alice', ...handlerArgs });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/alice', expectedOptions);
            });

            test.each([
                ['limit only', { limit: 20 }, { limit: 20 }],
                ['cursor only', { cursor: 'bGF5ZXI=' }, { cursor: 'bGF5ZXI=' }],
                ['both limit and cursor', { limit: 15, cursor: 'c3RhdGU=' }, { limit: 15, cursor: 'c3RhdGU=' }],
                ['no options', {}, undefined],
            ])('should pass %s to backend.listByLayer for layer paths', async (_label, handlerArgs, expectedOptions) => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path: '/events', ...handlerArgs });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', expectedOptions);
            });
        });

        describe('nextCursor in response', () => {
            test('should include nextCursor in response when backend returns one', async () => {
                const returnedCursor = 'bmV4dC1wYWdlLWN1cnNvcg==';
                mockBackend.list = mock(async () => ({
                    items: [
                        createMockItem({ path: '/users/alice/pref1' as MemoryPath }),
                    ],
                    nextCursor: returnedCursor,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                const result = await handler({ path: '/users/alice', limit: 1 });

                expect(result.content[0].text).toContain('/users/alice/pref1');
                expect(result.content[0].text).toContain('---');
                expect(result.content[0].text).toContain('More results available. Use cursor:');
                expect(result.content[0].text).toContain(returnedCursor);
            });

            test('should include nextCursor from listByLayer in response', async () => {
                const returnedCursor = 'bGF5ZXItbmV4dC1jdXJzb3I=';
                mockBackend.listByLayer = mock(async () => ({
                    items: [
                        createMockItem({ path: '/events/test/2025-01-01' as MemoryPath }),
                    ],
                    nextCursor: returnedCursor,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                const result = await handler({ path: '/events', limit: 1 });

                expect(result.content[0].text).toContain('/events/test/2025-01-01');
                expect(result.content[0].text).toContain('More results available. Use cursor:');
                expect(result.content[0].text).toContain(returnedCursor);
            });

            test('should not include cursor section when no nextCursor', async () => {
                mockBackend.list = mock(async () => ({
                    items: [
                        createMockItem({ path: '/users/alice/pref1' as MemoryPath }),
                    ],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                const result = await handler({ path: '/users/alice' });

                expect(result.content[0].text).toBe('/users/alice/pref1');
                expect(result.content[0].text).not.toContain('---');
                expect(result.content[0].text).not.toContain('cursor');
            });
        });

        describe('default path', () => {
            test('should use root path "/" when path is not provided', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({});

                // Without path argument, should default to '/' and use backend.list
                expect(mockBackend.list).toHaveBeenCalledWith('/', undefined);
            });

            test('should use root path "/" when path is explicitly undefined', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path: undefined });

                expect(mockBackend.list).toHaveBeenCalledWith('/', undefined);
            });
        });
    });

    describe('search tool pagination', () => {
        describe('schema', () => {
            test('should have cursor parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                const searchTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.search;

                expect(searchTool.inputSchema.shape.cursor).toBeDefined();
                const result = searchTool.inputSchema.shape.cursor.unwrap().safeParse('some-cursor-value');
                expect(result.success).toBe(true);
            });
        });

        describe('backend calls with cursor', () => {
            test.each([
                ['cursor only', { tags: ['important'], cursor: 'Y3Vyc29y' }, new Set(['important']), undefined, { cursor: 'Y3Vyc29y' }],
                ['limit and cursor', { tags: ['important'], limit: 10, cursor: 'Y3Vyc29y' }, new Set(['important']), undefined, { limit: 10, cursor: 'Y3Vyc29y' }],
                ['layer, limit, and cursor', { tags: ['active'], layer: 'state', limit: 5, cursor: 'c3RhdGU=' }, new Set(['active']), 'state', { limit: 5, cursor: 'c3RhdGU=' }],
                ['layer and cursor only', { tags: ['test'], layer: 'identity', cursor: 'aWRlbnRpdHk=' }, new Set(['test']), 'identity', { cursor: 'aWRlbnRpdHk=' }],
            ])('should pass %s to backend.searchByTags', async (_label, handlerArgs, expectedTags, expectedLayer, expectedOptions) => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                await handler(handlerArgs);

                expect(mockBackend.searchByTags).toHaveBeenCalledWith(expectedTags, expectedLayer, expectedOptions);
            });
        });

        describe('nextCursor in response', () => {
            test('should include nextCursor in response when backend returns one', async () => {
                const returnedCursor = 'c2VhcmNoLW5leHQ=';
                mockBackend.searchByTags = mock(async () => ({
                    items: [
                        createMockTagIndexItem({
                            PK:             'TAG#important',
                            SK:             'PATH#/memories/result1',
                            memoryPath:     '/memories/result1',
                            layer:          'events',
                            tags:           new Set(['important']),
                            contentPreview: 'First result',
                        }),
                    ],
                    nextCursor: returnedCursor,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                const result = await handler({ tags: ['important'], limit: 1 });

                expect(result.content[0].text).toContain('/memories/result1');
                expect(result.content[0].text).toContain('---');
                expect(result.content[0].text).toContain('More results available. Use cursor:');
                expect(result.content[0].text).toContain(returnedCursor);
            });

            test('should not include cursor section when no nextCursor', async () => {
                mockBackend.searchByTags = mock(async () => ({
                    items: [
                        createMockTagIndexItem({
                            PK:             'TAG#tag1',
                            SK:             'PATH#/memories/result1',
                            memoryPath:     '/memories/result1',
                            tags:           new Set(['tag1']),
                            contentPreview: 'Only result',
                        }),
                    ],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                const result = await handler({ tags: ['tag1'] });

                expect(result.content[0].text).toBe('/memories/result1: Only result');
                expect(result.content[0].text).not.toContain('---');
                expect(result.content[0].text).not.toContain('cursor');
            });

            test('should format multiple results with nextCursor correctly', async () => {
                const returnedCursor = 'bXVsdGlwbGUtcmVzdWx0cw==';
                mockBackend.searchByTags = mock(async () => ({
                    items: [
                        createMockTagIndexItem({
                            PK:             'TAG#tag1',
                            SK:             'PATH#/memories/result1',
                            memoryPath:     '/memories/result1',
                            tags:           new Set(['tag1']),
                            contentPreview: 'First result',
                        }),
                        createMockTagIndexItem({
                            PK:             'TAG#tag1',
                            SK:             'PATH#/memories/result2',
                            memoryPath:     '/memories/result2',
                            tags:           new Set(['tag1']),
                            contentPreview: 'Second result',
                        }),
                    ],
                    nextCursor: returnedCursor,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                const result = await handler({ tags: ['tag1'], limit: 2 });

                expect(result.content[0].text).toContain('/memories/result1');
                expect(result.content[0].text).toContain('/memories/result2');
                expect(result.content[0].text).toContain('\n\n---\nMore results available. Use cursor:');
                expect(result.content[0].text).toContain(returnedCursor);
            });
        });
    });

    describe('list tool date filtering', () => {
        describe('schema', () => {
            test('should have date parameters in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                const listTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.list;

                expect(listTool.inputSchema.shape.startDate).toBeDefined();
                expect(listTool.inputSchema.shape.endDate).toBeDefined();
            });

            test.each([
                ['valid ISO8601', '2024-01-01T00:00:00.000Z', true],
                ['invalid string', 'not-a-date', false],
            ])('should validate startDate: %s', (_label, value, shouldPass) => {
                const server = createMemoryMCPServer(mockBackend);
                const listTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.list;
                const result = listTool.inputSchema.shape.startDate.unwrap().safeParse(value);
                expect(result.success).toBe(shouldPass);
            });
        });

        describe('backend calls with date options', () => {
            test.each([
                ['startDate only', { startDate: '2024-01-01T00:00:00.000Z' }, { startDate: '2024-01-01T00:00:00.000Z' }],
                ['endDate only', { endDate: '2024-12-31T23:59:59.999Z' }, { endDate: '2024-12-31T23:59:59.999Z' }],
                ['both dates', { startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-06-30T23:59:59.999Z' }, { startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-06-30T23:59:59.999Z' }],
                ['dates with limit and cursor', { startDate: '2024-01-01T00:00:00.000Z', limit: 10, cursor: 'dGVzdA==' }, { startDate: '2024-01-01T00:00:00.000Z', limit: 10, cursor: 'dGVzdA==' }],
            ])('should pass %s to backend.listByLayer for layer paths', async (_label, handlerArgs, expectedOptions) => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path: '/events', ...handlerArgs });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', expectedOptions);
            });

            test('should pass dates to backend.list for non-layer paths', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                await handler({ path: '/users/alice', startDate: '2024-01-01T00:00:00.000Z' });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/alice', { startDate: '2024-01-01T00:00:00.000Z' });
            });
        });
    });

    describe('search tool date filtering', () => {
        describe('schema', () => {
            test('should have date parameters in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                const searchTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.search;

                expect(searchTool.inputSchema.shape.startDate).toBeDefined();
                expect(searchTool.inputSchema.shape.endDate).toBeDefined();
                const result = searchTool.inputSchema.shape.startDate.unwrap().safeParse('2024-01-01T00:00:00.000Z');
                expect(result.success).toBe(true);
            });
        });

        describe('backend calls with date options', () => {
            test.each([
                ['startDate only', { startDate: '2024-01-01T00:00:00.000Z' }, { startDate: '2024-01-01T00:00:00.000Z' }],
                ['endDate only', { endDate: '2024-12-31T23:59:59.999Z' }, { endDate: '2024-12-31T23:59:59.999Z' }],
                ['both dates', { startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-06-30T23:59:59.999Z' }, { startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-06-30T23:59:59.999Z' }],
                ['layer and dates', { layer: 'identity', startDate: '2024-01-01T00:00:00.000Z' }, { startDate: '2024-01-01T00:00:00.000Z' }],
                ['all options', { layer: 'events', limit: 5, cursor: 'Y3Vyc29y', startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-12-31T23:59:59.999Z' }, { limit: 5, cursor: 'Y3Vyc29y', startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-12-31T23:59:59.999Z' }],
            ])('should pass %s to backend.searchByTags', async (_label, handlerArgs, expectedOptions) => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');
                const tags = ['test'];
                const layer = 'layer' in handlerArgs ? handlerArgs.layer : undefined;

                await handler({ tags, ...handlerArgs });

                expect(mockBackend.searchByTags).toHaveBeenCalledWith(new Set(tags), layer, expectedOptions);
            });
        });
    });
});
