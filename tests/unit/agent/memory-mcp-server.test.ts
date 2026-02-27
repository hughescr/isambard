import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { MemoryPath, ContentType, MemoryToolItemData, TagIndexItem } from '../../../src/storage/memory-tool/types';
import { mockLogger, textContent } from '../../setup';

interface SafeParseResult { success: boolean }
interface UnwrappedSchema { safeParse: (v: unknown) => SafeParseResult }
interface ToolInputSchema { shape: Record<string, { safeParse: (v: unknown) => SafeParseResult, unwrap: () => UnwrappedSchema }> }
interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: ToolInputSchema
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

// Helper to create mock memory item data
const createMockItem = (overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData => ({
    path:        '/mock/path' as MemoryPath,
    content:     'mock content',
    contentType: 'text/plain' as ContentType,
    metadata:    {},

    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
});

// Helper to create mock tag index item
const createMockTagIndexItem = (overrides: Partial<TagIndexItem> = {}): TagIndexItem => ({
    PK:             'TAG#mock',
    SK:             'PATH#/mock/path',
    memoryPath:     '/mock/path',
    layer:          'identity',
    updatedAt:      '2025-01-01T00:00:00.000Z',
    tags:           new Set<string>(),
    contentPreview: 'mock preview',
    ...overrides,
});

describe.concurrent('createMemoryMCPServer', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();

        mockBackend = {
            create:        mock(async () => createMockItem()),
            get:           mock(async () => undefined),
            update:        mock(async () => createMockItem()),
            'delete':      mock(async () => { /* intentionally empty */ }),
            list:          mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer:   mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTags:  mock(async () => ({ items: [], nextCursor: undefined })),
            listTagCounts: mock(async () => []),
        } as unknown as MemoryToolBackend;
    });

    // Helper function to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createMemoryMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    describe('createMemoryMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createMemoryMCPServer(mockBackend);

            expect(server).toBeDefined();
            expect(server.name).toBe('memory');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['view', 'View memory by path'],
            ['storeSelf', 'Store self-knowledge in identity or state layer. Saving with the same name will replace existing content.'],
            ['storeUserMemory', 'Store user-specific memory. Saving with the same userId and name will replace existing content.'],
            ['logEvent', 'Log an event to the events layer'],
            ['search', 'Search memories by tag with optional filters'],
            ['deleteMemory', 'Delete a memory at the specified path. Returns the deleted content as confirmation.'],
            ['updateTags', 'Add or remove tags on an existing memory without changing its content.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createMemoryMCPServer(mockBackend);
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(tool.description).toBe(expectedDescription);
        });

        test.each([
            ['view', ['path']],
            ['storeSelf', ['layer', 'name', 'content', 'tags']],
            ['storeUserMemory', ['userId', 'name', 'content', 'tags']],
            ['logEvent', ['eventType', 'summary', 'details', 'tags']],
            ['search', ['tags', 'layer', 'limit']],
            ['deleteMemory', ['path']],
            ['updateTags', ['path', 'addTags', 'removeTags']],
        ])('should have %s tool with required input schema fields', (toolName, requiredFields) => {
            const server = createMemoryMCPServer(mockBackend);
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(tool.inputSchema).toBeDefined();
            expect(tool.inputSchema.shape).toBeDefined();

            // Check all required fields are present
            for(const field of requiredFields) {
                expect(tool.inputSchema.shape[field]).toBeDefined();
            }
        });

        test.each([
            ['view',            { readOnlyHint: true,  destructiveHint: false, idempotentHint: false, openWorldHint: false }],
            ['storeSelf',       { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }],
            ['storeUserMemory', { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }],
            ['logEvent',        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
            ['search',          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
            ['list',            { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
            ['listTags',        { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
            ['deleteMemory',    { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false }],
            ['updateTags',      { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
        ])('should have %s tool with correct annotations', (toolName, expectedAnnotations) => {
            const server = createMemoryMCPServer(mockBackend);
            const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(tool.annotations).toEqual(expectedAnnotations);
        });

        test('should validate search tags parameter accepts multiple tags', () => {
            const server = createMemoryMCPServer(mockBackend);
            const searchTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.search;
            const result = searchTool.inputSchema.shape.tags.safeParse(['tag1', 'tag2']);
            expect(result.success).toBe(true);
        });
    });

    describe('view tool', () => {
        test('should return memory content when found', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/memories/test.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            const result = await handler({ path: '/memories/test.md' });

            expect(result.content).toBeDefined();
            expect(result.content.length).toBe(1);
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Test content');
            expect(result.isError).toBeUndefined();
        });

        test('should return error when memory not found', async () => {
            mockBackend.get = mock(async () => undefined);

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            const result = await handler({ path: '/memories/nonexistent.md' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Memory not found');
            expect(result.isError).toBe(true);
        });

        test('should return error message when backend.get throws Error', async () => {
            mockBackend.get = mock(async () => {
                throw new Error('Database connection failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            const result = await handler({ path: '/memories/test.md' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error viewing memory: Database connection failed');
            expect(result.isError).toBe(true);
        });

        test('should return error message when backend.get throws non-Error', async () => {
            mockBackend.get = mock(async () => {
                throw 'String error message';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            const result = await handler({ path: '/memories/test.md' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('Error viewing memory: String error message');
            expect(result.isError).toBe(true);
        });

        test('should call recordAccess for state-layer paths', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path:    '/state/test' as MemoryPath,
                content: 'Test content',
            }));

            const recordAccess = mock(async () => { /* intentionally empty */ });
            const server = createMemoryMCPServer(mockBackend, { recordAccess });
            const handler = getToolHandler(server, 'view');

            await handler({ path: '/state/test' });

            // Flush microtask queue to let fire-and-forget promise settle
            await Promise.resolve();
            await Promise.resolve();

            expect(recordAccess).toHaveBeenCalledTimes(1);
            expect(recordAccess).toHaveBeenCalledWith(['/state/test']);
        });

        test('should not call recordAccess for identity-layer paths', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path:    '/identity/test' as MemoryPath,
                content: 'Test content',
            }));

            const recordAccess = mock(async () => { /* intentionally empty */ });
            const server = createMemoryMCPServer(mockBackend, { recordAccess });
            const handler = getToolHandler(server, 'view');

            await handler({ path: '/identity/test' });

            // Flush microtask queue to let fire-and-forget promise settle
            await Promise.resolve();
            await Promise.resolve();

            expect(recordAccess).not.toHaveBeenCalled();
        });

        test('should not call recordAccess for events-layer paths', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path:    '/events/test/timestamp' as MemoryPath,
                content: 'Test content',
            }));

            const recordAccess = mock(async () => { /* intentionally empty */ });
            const server = createMemoryMCPServer(mockBackend, { recordAccess });
            const handler = getToolHandler(server, 'view');

            await handler({ path: '/events/test/timestamp' });

            // Flush microtask queue to let fire-and-forget promise settle
            await Promise.resolve();
            await Promise.resolve();

            expect(recordAccess).not.toHaveBeenCalled();
        });

        test('should not call recordAccess when option is undefined', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path:    '/state/test' as MemoryPath,
                content: 'Test content',
            }));

            const server = createMemoryMCPServer(mockBackend); // No options
            const handler = getToolHandler(server, 'view');

            const result = await handler({ path: '/state/test' });

            // Should still return content successfully
            expect(textContent(result.content[0])).toBe('Test content');
            expect(result.isError).toBeUndefined();
        });

        test('should return content even when recordAccess rejects', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path:    '/state/test' as MemoryPath,
                content: 'Test content',
            }));

            const recordAccess = mock(async () => {
                throw new Error('recordAccess failed');
            });
            const server = createMemoryMCPServer(mockBackend, { recordAccess });
            const handler = getToolHandler(server, 'view');

            const result = await handler({ path: '/state/test' });

            // Flush microtask queue to let fire-and-forget promise settle
            await Promise.resolve();
            await Promise.resolve();

            // Should still return content successfully (fire-and-forget)
            expect(textContent(result.content[0])).toBe('Test content');
            expect(result.isError).toBeUndefined();
            expect(recordAccess).toHaveBeenCalledTimes(1);

            // Verify warning was logged for the recordAccess failure
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: expect.any(Error),
                    path:  '/state/test',
                    msg:   'Failed to record memory access',
                })
            );
        });
    });

    describe('storeSelf tool', () => {
        test.each([
            ['identity', 'core-values', 'My core values'],
            ['state', 'current-goals', 'Current goals'],
        ])('should store %s memory successfully', async (layer, name, content) => {
            mockBackend.create = mock(async () => ({
                path:        `/${layer}/${name}` as MemoryPath,
                content,
                contentType: 'text/plain' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            const result = await handler({ layer, name, content });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe(`Memory stored at /${layer}/${name}`);
            expect(result.isError).toBeUndefined();

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        `/${layer}/${name}`,
                content,
                contentType: 'text/plain',
                tags:        undefined,
            });
        });

        test('should pass tags to backend.create when provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            await handler({ layer: 'identity', name: 'values', content: 'Values', tags: ['core', 'important'] });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/identity/values',
                content:     'Values',
                contentType: 'text/plain',
                tags:        new Set(['core', 'important']),
            });
        });

        test('should return error when backend.create throws Error', async () => {
            mockBackend.create = mock(async () => {
                throw new Error('Path already exists');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            const result = await handler({ layer: 'identity', name: 'test', content: 'Content' });

            expect(textContent(result.content[0])).toBe('Error storing self memory: Path already exists');
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.create throws non-Error', async () => {
            mockBackend.create = mock(async () => {
                throw { code: 'VALIDATION_ERROR' };
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            const result = await handler({ layer: 'state', name: 'test', content: 'Content' });

            expect(textContent(result.content[0])).toContain('Error storing self memory:');
            expect(result.isError).toBe(true);
        });

        describe('upsert behavior', () => {
            test('should call backend.update when item already exists', async () => {
                // Mock existing item
                mockBackend.get = mock(async () => ({
                    path:        '/identity/core-values' as MemoryPath,
                    content:     'Old values',
                    contentType: 'text/plain' as ContentType,
                    metadata:    {},

                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                }));
                mockBackend.update = mock(async () => createMockItem({
                    path:    '/identity/core-values' as MemoryPath,
                    content: 'Updated values',
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'storeSelf');

                const result = await handler({ layer: 'identity', name: 'core-values', content: 'Updated values', tags: ['core'] });

                // Should call update, not create
                expect(mockBackend.update).toHaveBeenCalledWith('/identity/core-values', {
                    content: 'Updated values',
                    tags:    new Set(['core']),
                });
                expect(mockBackend.create).not.toHaveBeenCalled();

                expect(textContent(result.content[0])).toBe('Memory stored at /identity/core-values');
                expect(result.isError).toBeUndefined();
            });

            test('should call backend.create when item does not exist', async () => {
                // Mock no existing item
                mockBackend.get = mock(async () => undefined);
                mockBackend.create = mock(async () => createMockItem({
                    path:    '/state/current-goals' as MemoryPath,
                    content: 'New goals',
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'storeSelf');

                const result = await handler({ layer: 'state', name: 'current-goals', content: 'New goals' });

                // Should call create, not update
                expect(mockBackend.create).toHaveBeenCalledWith({
                    path:        '/state/current-goals',
                    content:     'New goals',
                    contentType: 'text/plain',
                    tags:        undefined,
                });
                expect(mockBackend.update).not.toHaveBeenCalled();

                expect(textContent(result.content[0])).toBe('Memory stored at /state/current-goals');
                expect(result.isError).toBeUndefined();
            });
        });

        describe('layer enum validation', () => {
            test.each([
                ['identity', true],
                ['state', true],
                ['invalid', false],
                ['', false],
                ['events', false],
            ])('should validate layer value "%s" as %s', (value, expectedSuccess) => {
                const server = createMemoryMCPServer(mockBackend);
                const storeSelfTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.storeSelf;
                const result = storeSelfTool.inputSchema.shape.layer.safeParse(value);
                expect(result.success).toBe(expectedSuccess);
            });
        });
    });

    describe('search tool layer enum validation', () => {
        test.each([
            ['identity', true],
            ['state', true],
            ['events', true],
            ['invalid', false],
            ['', false],
        ])('should validate search layer value "%s" as %s', (value, expectedSuccess) => {
            const server = createMemoryMCPServer(mockBackend);
            const searchTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.search;
            const result = searchTool.inputSchema.shape.layer.unwrap().safeParse(value);
            expect(result.success).toBe(expectedSuccess);
        });
    });

    describe('storeUserMemory tool', () => {
        test('should store user memory successfully', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/users/user123/preferences' as MemoryPath,
                content:     'User preferences',
                contentType: 'text/plain' as ContentType,
                metadata:    {},

                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            const result = await handler({ userId: 'user123', name: 'preferences', content: 'User preferences' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toBe('User memory stored at /users/user123/preferences');
            expect(result.isError).toBeUndefined();
        });

        test('should call backend.create with correct path including userId', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            await handler({ userId: 'alice', name: 'history', content: 'Conversation history' });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/users/alice/history',
                content:     'Conversation history',
                contentType: 'text/plain',
                tags:        undefined,
            });
        });

        test('should pass tags to backend.create when provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            await handler({ userId: 'bob', name: 'notes', content: 'Notes', tags: ['personal', 'work'] });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/users/bob/notes',
                content:     'Notes',
                contentType: 'text/plain',
                tags:        new Set(['personal', 'work']),
            });
        });

        test('should return error when backend.create throws Error', async () => {
            mockBackend.create = mock(async () => {
                throw new Error('Storage quota exceeded');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            const result = await handler({ userId: 'user1', name: 'test', content: 'Content' });

            expect(textContent(result.content[0])).toBe('Error storing user memory: Storage quota exceeded');
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.create throws non-Error', async () => {
            mockBackend.create = mock(async () => {
                throw 'Network error';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            const result = await handler({ userId: 'user1', name: 'test', content: 'Content' });

            expect(textContent(result.content[0])).toBe('Error storing user memory: Network error');
            expect(result.isError).toBe(true);
        });

        describe('upsert behavior', () => {
            test('should call backend.update when item already exists', async () => {
                // Mock existing item
                mockBackend.get = mock(async () => ({
                    path:        '/users/alice/preferences' as MemoryPath,
                    content:     'Old preferences',
                    contentType: 'text/plain' as ContentType,
                    metadata:    {},

                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                }));
                mockBackend.update = mock(async () => createMockItem({
                    path:    '/users/alice/preferences' as MemoryPath,
                    content: 'Updated preferences',
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'storeUserMemory');

                const result = await handler({ userId: 'alice', name: 'preferences', content: 'Updated preferences', tags: ['personal'] });

                // Should call update, not create
                expect(mockBackend.update).toHaveBeenCalledWith('/users/alice/preferences', {
                    content: 'Updated preferences',
                    tags:    new Set(['personal']),
                });
                expect(mockBackend.create).not.toHaveBeenCalled();

                expect(textContent(result.content[0])).toBe('User memory stored at /users/alice/preferences');
                expect(result.isError).toBeUndefined();
            });

            test('should call backend.create when item does not exist', async () => {
                // Mock no existing item
                mockBackend.get = mock(async () => undefined);
                mockBackend.create = mock(async () => createMockItem({
                    path:    '/users/bob/notes' as MemoryPath,
                    content: 'New notes',
                }));

                const server = createMemoryMCPServer(mockBackend);
                const handler = getToolHandler(server, 'storeUserMemory');

                const result = await handler({ userId: 'bob', name: 'notes', content: 'New notes' });

                // Should call create, not update
                expect(mockBackend.create).toHaveBeenCalledWith({
                    path:        '/users/bob/notes',
                    content:     'New notes',
                    contentType: 'text/plain',
                    tags:        undefined,
                });
                expect(mockBackend.update).not.toHaveBeenCalled();

                expect(textContent(result.content[0])).toBe('User memory stored at /users/bob/notes');
                expect(result.isError).toBeUndefined();
            });
        });
    });

    describe('logEvent tool', () => {
        test('should log event with summary only and return success message', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            const result = await handler({ eventType: 'conversation', summary: 'Had a discussion about testing' });

            expect(result.content).toBeDefined();
            expect(result.content[0].type).toBe('text');
            expect(textContent(result.content[0])).toMatch(/^Event logged at \/events\/conversation\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
            expect(result.isError).toBeUndefined();
        });

        test('should log event with summary and details combining content', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            await handler({
                eventType: 'decision',
                summary:   'Decided to use TypeScript',
                details:   'Detailed reasoning about the decision',
            });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'Decided to use TypeScript\n\nDetailed reasoning about the decision',
                })
            );
        });

        test('should call backend.create with summary only when no details provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            await handler({ eventType: 'learning', summary: 'Learned about mutation testing' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'Learned about mutation testing',
                })
            );
        });

        test('should pass tags to backend.create when provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            await handler({ eventType: 'error', summary: 'An error occurred', tags: ['critical', 'bug'] });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    tags: new Set(['critical', 'bug']),
                })
            );
        });

        test('should generate path with events prefix and eventType', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            await handler({ eventType: 'test', summary: 'Test event' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: expect.stringMatching(/^\/events\/test\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/),
                })
            );
        });

        test('should generate path without colons or dots', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            await handler({ eventType: 'verify', summary: 'Verify timestamp format' });

            // Get the path that was passed to create
            const calledPath = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0].path as string;
            expect(calledPath).not.toContain(':');
            expect(calledPath).not.toContain('.');
        });

        test('should return error when backend.create throws Error', async () => {
            mockBackend.create = mock(async () => {
                throw new Error('DynamoDB write failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            const result = await handler({ eventType: 'test', summary: 'Test' });

            expect(textContent(result.content[0])).toBe('Error logging event: DynamoDB write failed');
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.create throws non-Error', async () => {
            mockBackend.create = mock(async () => {
                throw { statusCode: 500 };
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            const result = await handler({ eventType: 'test', summary: 'Test' });

            expect(textContent(result.content[0])).toContain('Error logging event:');
            expect(result.isError).toBe(true);
        });
    });

    describe('listTags tool', () => {
        test('should return "No tags found" when no tags exist', async () => {
            mockBackend.listTagCounts = mock(async () => []);

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            const result = await handler({});

            expect(textContent(result.content[0])).toBe('No tags found');
        });

        test('should return formatted tag list sorted by count descending', async () => {
            mockBackend.listTagCounts = mock(async () => [
                { tag: 'important', count: 5 },
                { tag: 'personal', count: 8 },
                { tag: 'work', count: 3 },
            ]);

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            const result = await handler({});

            expect(textContent(result.content[0])).toBe('personal: 8\nimportant: 5\nwork: 3');
        });

        test('should handle errors gracefully', async () => {
            mockBackend.listTagCounts = mock(async () => {
                throw new Error('Database error');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            const result = await handler({});

            expect(textContent(result.content[0])).toContain('Error listing tags:');
            expect(textContent(result.content[0])).toContain('Database error');
            expect(result.isError).toBe(true);
        });

        test('should handle non-Error throws gracefully', async () => {
            mockBackend.listTagCounts = mock(async () => {
                throw { statusCode: 500 };
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            const result = await handler({});

            expect(textContent(result.content[0])).toContain('Error listing tags:');
            expect(result.isError).toBe(true);
        });
    });

    describe('deleteMemory tool', () => {
        test('should return deleted memory details on success', async () => {
            mockBackend.delete = mock(async () => createMockItem({
                path:      '/state/old-goals' as MemoryPath,
                content:   'Old goals content',
                tags:      new Set(['goals', 'outdated']),
                updatedAt: '2025-06-01T12:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'deleteMemory');

            const result = await handler({ path: '/state/old-goals' });

            expect(textContent(result.content[0])).toContain('Deleted memory at /state/old-goals');
            expect(textContent(result.content[0])).toContain('Tags: goals, outdated');
            expect(textContent(result.content[0])).toContain('Last updated: 2025-06-01T12:00:00.000Z');
            expect(textContent(result.content[0])).toContain('Old goals content');
            expect(result.isError).toBeUndefined();

            expect(mockBackend.delete).toHaveBeenCalledWith('/state/old-goals');
        });

        test('should show "none" when deleted memory has no tags', async () => {
            mockBackend.delete = mock(async () => createMockItem({
                path:    '/identity/test' as MemoryPath,
                content: 'Test content',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'deleteMemory');

            const result = await handler({ path: '/identity/test' });

            expect(textContent(result.content[0])).toContain('Tags: none');
            expect(result.isError).toBeUndefined();
        });

        test('should show "none" when deleted memory has empty tags array', async () => {
            mockBackend.delete = mock(async () => createMockItem({
                path:    '/identity/test' as MemoryPath,
                content: 'Test content',
                tags:    new Set<string>(),
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'deleteMemory');

            const result = await handler({ path: '/identity/test' });

            expect(textContent(result.content[0])).toContain('Tags: none');
            expect(result.isError).toBeUndefined();
        });

        test('should return error when memory not found', async () => {
            mockBackend.delete = mock(async () => undefined);

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'deleteMemory');

            const result = await handler({ path: '/nonexistent/path' });

            expect(textContent(result.content[0])).toBe('Memory not found at path: /nonexistent/path');
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.delete throws Error', async () => {
            mockBackend.delete = mock(async () => {
                throw new Error('DynamoDB delete failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'deleteMemory');

            const result = await handler({ path: '/state/test' });

            expect(textContent(result.content[0])).toBe('Error deleting memory: DynamoDB delete failed');
            expect(result.isError).toBe(true);
        });

        test('should return error when backend.delete throws non-Error', async () => {
            mockBackend.delete = mock(async () => {
                throw 'Network timeout';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'deleteMemory');

            const result = await handler({ path: '/state/test' });

            expect(textContent(result.content[0])).toBe('Error deleting memory: Network timeout');
            expect(result.isError).toBe(true);
        });
    });

    describe('search tool', () => {
        test('should show "No content" when memory item has no contentPreview', async () => {
            const itemWithoutPreview = createMockTagIndexItem({
                memoryPath:     '/identity/test.md',
                PK:             'TAG#test',
                SK:             'PATH#/identity/test.md',
                contentPreview: undefined, // No preview
                tags:           new Set(['test']),
            });

            mockBackend.searchByTags = mock(async () => ({
                items:      [itemWithoutPreview],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['test'] });

            expect(textContent(result.content[0])).toContain('/identity/test.md: No content');
            expect(result.isError).toBeUndefined();
        });

        test('should show contentPreview when available', async () => {
            const itemWithPreview = createMockTagIndexItem({
                memoryPath:     '/identity/test.md',
                PK:             'TAG#test',
                SK:             'PATH#/identity/test.md',
                contentPreview: 'Test preview content',
                tags:           new Set(['test']),
            });

            mockBackend.searchByTags = mock(async () => ({
                items:      [itemWithPreview],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            const result = await handler({ tags: ['test'] });

            expect(textContent(result.content[0])).toContain('/identity/test.md: Test preview content');
            expect(result.isError).toBeUndefined();
        });
    });

    describe('updateTags tool', () => {
        test('should add tags to memory with existing tags', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['existing', 'old']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            await handler({ path: '/state/test', addTags: ['new1', 'new2'] });

            expect(mockBackend.update).toHaveBeenCalledWith('/state/test', {
                tags:              new Set(['existing', 'new1', 'new2', 'old']),
                preserveUpdatedAt: true,
            });
        });

        test('should remove tags from memory', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['keep', 'remove-me']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            await handler({ path: '/state/test', removeTags: ['remove-me'] });

            expect(mockBackend.update).toHaveBeenCalledWith('/state/test', {
                tags:              new Set(['keep']),
                preserveUpdatedAt: true,
            });
        });

        test('should add and remove tags simultaneously', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['a', 'b', 'c']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            await handler({ path: '/state/test', addTags: ['d'], removeTags: ['b'] });

            expect(mockBackend.update).toHaveBeenCalledWith('/state/test', {
                tags:              new Set(['a', 'c', 'd']),
                preserveUpdatedAt: true,
            });
        });

        test('should remove tag when it appears in both addTags and removeTags (remove wins)', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['existing']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            await handler({ path: '/state/test', addTags: ['conflict', 'new'], removeTags: ['conflict'] });

            expect(mockBackend.update).toHaveBeenCalledWith('/state/test', {
                tags:              new Set(['existing', 'new']),
                preserveUpdatedAt: true,
            });
        });

        test('should return response showing before and after tags', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/events/test/2026-01-26T07-19-53-557Z' as MemoryPath,
                tags: new Set(['debugging', 'discord']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/events/test/2026-01-26T07-19-53-557Z', addTags: ['catch-up'], removeTags: ['discord'] });

            expect(textContent(result.content[0])).toBe('Updated tags on /events/test/2026-01-26T07-19-53-557Z\nBefore: debugging, discord\nAfter: catch-up, debugging');

            expect(mockBackend.update).toHaveBeenCalledWith('/events/test/2026-01-26T07-19-53-557Z', {
                tags:              new Set(['catch-up', 'debugging']),
                preserveUpdatedAt: true,
            });
        });

        test('should return error when memory not found', async () => {
            mockBackend.get = mock(async () => undefined);

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/nonexistent/path', addTags: ['test'] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Memory not found at path: /nonexistent/path');
        });

        test('should return error when backend.get throws Error', async () => {
            mockBackend.get = mock(async () => {
                throw new Error('Database error');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', addTags: ['test'] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error updating tags: Database error');
        });

        test('should return error when backend.get throws non-Error', async () => {
            mockBackend.get = mock(async () => {
                throw 'Connection reset';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', addTags: ['test'] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error updating tags: Connection reset');
        });

        test('should return error when backend.update throws Error', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['existing']),
            }));
            mockBackend.update = mock(async () => {
                throw new Error('Write failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', addTags: ['test'] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error updating tags: Write failed');
        });

        test('should return error when backend.update throws non-Error', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['existing']),
            }));
            mockBackend.update = mock(async () => {
                throw 'Timeout';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', addTags: ['test'] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Error updating tags: Timeout');
        });

        test('should return validation error when neither addTags nor removeTags provided', async () => {
            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Must provide at least one of addTags or removeTags (non-empty)');
        });

        test('should return validation error when both arrays are empty', async () => {
            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', addTags: [], removeTags: [] });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toBe('Must provide at least one of addTags or removeTags (non-empty)');
        });

        test('should handle adding tags that are already present (idempotent)', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['a', 'b']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            await handler({ path: '/state/test', addTags: ['a', 'b'] });

            expect(mockBackend.update).toHaveBeenCalledWith('/state/test', {
                tags:              new Set(['a', 'b']),
                preserveUpdatedAt: true,
            });
        });

        test('should handle removing non-existent tags', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['a', 'b']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            await handler({ path: '/state/test', removeTags: ['nonexistent'] });

            expect(mockBackend.update).toHaveBeenCalledWith('/state/test', {
                tags:              new Set(['a', 'b']),
                preserveUpdatedAt: true,
            });
        });

        test('should handle memory with no existing tags', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                // No tags property
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            await handler({ path: '/state/test', addTags: ['new-tag'] });

            expect(mockBackend.update).toHaveBeenCalledWith('/state/test', {
                tags:              new Set(['new-tag']),
                preserveUpdatedAt: true,
            });
        });

        test('should show "(none)" in Before when memory had no tags', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: undefined,
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', addTags: ['new'] });

            expect(textContent(result.content[0])).toContain('Before: (none)');
            expect(textContent(result.content[0])).toContain('After: new');
        });

        test('should show "(none)" in After when all tags are removed', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['only-tag']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', removeTags: ['only-tag'] });

            expect(textContent(result.content[0])).toContain('Before: only-tag');
            expect(textContent(result.content[0])).toContain('After: (none)');
        });

        test('should sort tags alphabetically in before/after display', async () => {
            mockBackend.get = mock(async () => createMockItem({
                path: '/state/test' as MemoryPath,
                tags: new Set(['zebra', 'apple', 'mango']),
            }));
            mockBackend.update = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'updateTags');

            const result = await handler({ path: '/state/test', addTags: ['banana'] });

            expect(textContent(result.content[0])).toContain('Before: apple, mango, zebra');
            expect(textContent(result.content[0])).toContain('After: apple, banana, mango, zebra');
        });
    });
});
