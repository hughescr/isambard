/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Handler return values are typed as any in tests */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { MemoryPath, ContentType, MemoryToolItemData } from '../../../src/storage/memory-tool/types';

// Helper to create mock memory item data
const createMockItem = (overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData => ({
    path:        '/mock/path' as MemoryPath,
    content:     'mock content',
    contentType: 'text/plain' as ContentType,
    metadata:    {},
    version:     1,
    createdAt:   '2025-01-01T00:00:00.000Z',
    updatedAt:   '2025-01-01T00:00:00.000Z',
    ...overrides,
});

describe.concurrent('Memory MCP Server Pagination', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:      mock(async () => createMockItem()),
            get:         mock(async () => undefined),
            update:      mock(async () => createMockItem()),
            'delete':    mock(async () => { /* intentionally empty */ }),
            list:        mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer: mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTag: mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;
    });

    // Helper function to get tool handler from server instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Need to access private _registeredTools
    const getToolHandler = (server: any, toolName: string): any => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing private property
        return server.instance._registeredTools[toolName].handler;
    };

    describe('list tool pagination', () => {
        describe('schema', () => {
            test('should have limit parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema
                expect(listTool.inputSchema.shape.limit).toBeDefined();
            });

            test('should have cursor parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema
                expect(listTool.inputSchema.shape.cursor).toBeDefined();
            });

            test('should accept positive integer for limit', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = listTool.inputSchema.shape.limit.unwrap().safeParse(10);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(true);
            });

            test('should reject non-positive limit', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = listTool.inputSchema.shape.limit.unwrap().safeParse(0);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(false);
            });

            test('should reject negative limit', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = listTool.inputSchema.shape.limit.unwrap().safeParse(-5);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(false);
            });

            test('should reject non-integer limit', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = listTool.inputSchema.shape.limit.unwrap().safeParse(1.5);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(false);
            });
        });

        describe('backend calls with options', () => {
            test('should pass limit to backend.list for non-layer paths', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/users/alice', limit: 10 });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/alice', { limit: 10 });
            });

            test('should pass cursor to backend.list for non-layer paths', async () => {
                const testCursor = 'dGVzdC1jdXJzb3I=';
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/users/alice', cursor: testCursor });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/alice', { cursor: testCursor });
            });

            test('should pass both limit and cursor to backend.list', async () => {
                const testCursor = 'dGVzdC1jdXJzb3I=';
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/users/alice', limit: 5, cursor: testCursor });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/alice', { limit: 5, cursor: testCursor });
            });

            test('should pass limit to backend.listByLayer for layer paths', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/events', limit: 20 });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', { limit: 20 });
            });

            test('should pass cursor to backend.listByLayer for layer paths', async () => {
                const testCursor = 'bGF5ZXItY3Vyc29y';
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/identity', cursor: testCursor });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { cursor: testCursor });
            });

            test('should pass both limit and cursor to backend.listByLayer', async () => {
                const testCursor = 'c3RhdGUtY3Vyc29y';
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/state', limit: 15, cursor: testCursor });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('state', { limit: 15, cursor: testCursor });
            });

            test('should not pass options when neither limit nor cursor provided', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/users/bob' });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/bob', undefined);
            });

            test('should not pass options to listByLayer when neither limit nor cursor provided', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/events' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', undefined);
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

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                const result = await handler({ path: '/users/alice', limit: 1 });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('/users/alice/pref1');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('---');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('More results available. Use cursor:');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
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

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                const result = await handler({ path: '/events', limit: 1 });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('/events/test/2025-01-01');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('More results available. Use cursor:');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
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

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                const result = await handler({ path: '/users/alice' });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toBe('/users/alice/pref1');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).not.toContain('---');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).not.toContain('cursor');
            });
        });
    });

    describe('search tool pagination', () => {
        describe('schema', () => {
            test('should have cursor parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const searchTool = (server.instance as any)._registeredTools.search;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema
                expect(searchTool.inputSchema.shape.cursor).toBeDefined();
            });

            test('should accept string for cursor', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const searchTool = (server.instance as any)._registeredTools.search;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = searchTool.inputSchema.shape.cursor.unwrap().safeParse('some-cursor-value');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(true);
            });
        });

        describe('backend calls with cursor', () => {
            test('should pass cursor to backend.searchByTag', async () => {
                const testCursor = 'c2VhcmNoLWN1cnNvcg==';
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ tag: 'important', cursor: testCursor });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('important', undefined, { cursor: testCursor });
            });

            test('should pass both limit and cursor to backend.searchByTag', async () => {
                const testCursor = 'c2VhcmNoLWN1cnNvcg==';
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ tag: 'important', limit: 10, cursor: testCursor });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('important', undefined, { limit: 10, cursor: testCursor });
            });

            test('should pass layer, limit, and cursor to backend.searchByTag', async () => {
                const testCursor = 'ZnVsbC1vcHRpb25z';
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ tag: 'active', layer: 'state', limit: 5, cursor: testCursor });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('active', 'state', { limit: 5, cursor: testCursor });
            });

            test('should pass only cursor when limit not provided', async () => {
                const testCursor = 'b25seS1jdXJzb3I=';
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ tag: 'test', layer: 'identity', cursor: testCursor });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('test', 'identity', { cursor: testCursor });
            });
        });

        describe('nextCursor in response', () => {
            test('should include nextCursor in response when backend returns one', async () => {
                const returnedCursor = 'c2VhcmNoLW5leHQ=';
                mockBackend.searchByTag = mock(async () => ({
                    items: [
                        createMockItem({
                            path:    '/memories/result1' as MemoryPath,
                            content: 'First result',
                            tags:    ['important'],
                        }),
                    ],
                    nextCursor: returnedCursor,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                const result = await handler({ tag: 'important', limit: 1 });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('/memories/result1');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('---');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('More results available. Use cursor:');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain(returnedCursor);
            });

            test('should not include cursor section when no nextCursor', async () => {
                mockBackend.searchByTag = mock(async () => ({
                    items: [
                        createMockItem({
                            path:    '/memories/result1' as MemoryPath,
                            content: 'Only result',
                            tags:    ['tag1'],
                        }),
                    ],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                const result = await handler({ tag: 'tag1' });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toBe('/memories/result1: Only result');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).not.toContain('---');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).not.toContain('cursor');
            });

            test('should format multiple results with nextCursor correctly', async () => {
                const returnedCursor = 'bXVsdGlwbGUtcmVzdWx0cw==';
                mockBackend.searchByTag = mock(async () => ({
                    items: [
                        createMockItem({
                            path:    '/memories/result1' as MemoryPath,
                            content: 'First result',
                            tags:    ['tag1'],
                        }),
                        createMockItem({
                            path:    '/memories/result2' as MemoryPath,
                            content: 'Second result',
                            tags:    ['tag1'],
                        }),
                    ],
                    nextCursor: returnedCursor,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                const result = await handler({ tag: 'tag1', limit: 2 });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('/memories/result1');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('/memories/result2');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain('\n\n---\nMore results available. Use cursor:');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.content[0].text).toContain(returnedCursor);
            });
        });
    });

    describe('list tool date filtering', () => {
        describe('schema', () => {
            test('should have startDate parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema
                expect(listTool.inputSchema.shape.startDate).toBeDefined();
            });

            test('should have endDate parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema
                expect(listTool.inputSchema.shape.endDate).toBeDefined();
            });

            test('should accept valid ISO8601 datetime for startDate', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = listTool.inputSchema.shape.startDate.unwrap().safeParse('2024-01-01T00:00:00.000Z');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(true);
            });

            test('should reject invalid datetime for startDate', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const listTool = (server.instance as any)._registeredTools.list;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = listTool.inputSchema.shape.startDate.unwrap().safeParse('not-a-date');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(false);
            });
        });

        describe('backend calls with date options', () => {
            test('should pass startDate to backend.listByLayer for layer paths', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/events', startDate: '2024-01-01T00:00:00.000Z' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', { startDate: '2024-01-01T00:00:00.000Z' });
            });

            test('should pass endDate to backend.listByLayer for layer paths', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/identity', endDate: '2024-12-31T23:59:59.999Z' });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('identity', { endDate: '2024-12-31T23:59:59.999Z' });
            });

            test('should pass both dates to backend.listByLayer', async () => {
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({
                    path:      '/state',
                    startDate: '2024-01-01T00:00:00.000Z',
                    endDate:   '2024-06-30T23:59:59.999Z',
                });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('state', {
                    startDate: '2024-01-01T00:00:00.000Z',
                    endDate:   '2024-06-30T23:59:59.999Z',
                });
            });

            test('should pass dates with limit and cursor to backend.listByLayer', async () => {
                const testCursor = 'dGVzdC1jdXJzb3I=';
                mockBackend.listByLayer = mock(async () => ({
                    items:      [],
                    nextCursor: undefined,
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({
                    path:      '/events',
                    startDate: '2024-01-01T00:00:00.000Z',
                    limit:     10,
                    cursor:    testCursor,
                });

                expect(mockBackend.listByLayer).toHaveBeenCalledWith('events', {
                    startDate: '2024-01-01T00:00:00.000Z',
                    limit:     10,
                    cursor:    testCursor,
                });
            });

            test('should pass dates to backend.list for non-layer paths', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'list');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ path: '/users/alice', startDate: '2024-01-01T00:00:00.000Z' });

                expect(mockBackend.list).toHaveBeenCalledWith('/users/alice', { startDate: '2024-01-01T00:00:00.000Z' });
            });
        });
    });

    describe('search tool date filtering', () => {
        describe('schema', () => {
            test('should have startDate parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const searchTool = (server.instance as any)._registeredTools.search;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema
                expect(searchTool.inputSchema.shape.startDate).toBeDefined();
            });

            test('should have endDate parameter in input schema', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const searchTool = (server.instance as any)._registeredTools.search;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema
                expect(searchTool.inputSchema.shape.endDate).toBeDefined();
            });

            test('should accept valid ISO8601 datetime for startDate', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const searchTool = (server.instance as any)._registeredTools.search;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = searchTool.inputSchema.shape.startDate.unwrap().safeParse('2024-01-01T00:00:00.000Z');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(true);
            });
        });

        describe('backend calls with date options', () => {
            test('should pass startDate to backend.searchByTag', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ tag: 'important', startDate: '2024-01-01T00:00:00.000Z' });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('important', undefined, { startDate: '2024-01-01T00:00:00.000Z' });
            });

            test('should pass endDate to backend.searchByTag', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({ tag: 'active', endDate: '2024-12-31T23:59:59.999Z' });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('active', undefined, { endDate: '2024-12-31T23:59:59.999Z' });
            });

            test('should pass both dates to backend.searchByTag', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({
                    tag:       'recent',
                    startDate: '2024-01-01T00:00:00.000Z',
                    endDate:   '2024-06-30T23:59:59.999Z',
                });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('recent', undefined, {
                    startDate: '2024-01-01T00:00:00.000Z',
                    endDate:   '2024-06-30T23:59:59.999Z',
                });
            });

            test('should pass layer and dates to backend.searchByTag', async () => {
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({
                    tag:       'important',
                    layer:     'identity',
                    startDate: '2024-01-01T00:00:00.000Z',
                });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('important', 'identity', { startDate: '2024-01-01T00:00:00.000Z' });
            });

            test('should pass all options to backend.searchByTag', async () => {
                const testCursor = 'c2VhcmNoLWN1cnNvcg==';
                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'search');

                // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
                await handler({
                    tag:       'tag1',
                    layer:     'events',
                    limit:     5,
                    cursor:    testCursor,
                    startDate: '2024-01-01T00:00:00.000Z',
                    endDate:   '2024-12-31T23:59:59.999Z',
                });

                expect(mockBackend.searchByTag).toHaveBeenCalledWith('tag1', 'events', {
                    limit:     5,
                    cursor:    testCursor,
                    startDate: '2024-01-01T00:00:00.000Z',
                    endDate:   '2024-12-31T23:59:59.999Z',
                });
            });
        });
    });
});
