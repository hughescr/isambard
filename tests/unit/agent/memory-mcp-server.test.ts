/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Handler return values are typed as any in tests */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
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

describe('createMemoryMCPServer', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:      mock(async () => createMockItem()),
            get:         mock(async () => undefined),
            update:      mock(async () => createMockItem()),
            'delete':    mock(async () => { /* intentionally empty */ }),
            list:        mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTag: mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;
    });

    // Helper function to get tool handler from server instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Need to access private _registeredTools
    const getToolHandler = (server: any, toolName: string): any => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing private property
        return server.instance._registeredTools[toolName].handler;
    };

    describe('createMemoryMCPServer function', () => {
        it('should create MCP server with correct name', () => {
            const server = createMemoryMCPServer(mockBackend);

            expect(server).toBeDefined();
            expect(server.name).toBe('memory');
        });

        it('should create MCP server with instance', () => {
            const server = createMemoryMCPServer(mockBackend);

            expect(server.instance).toBeDefined();
        });

        it('should create MCP server with type', () => {
            const server = createMemoryMCPServer(mockBackend);

            expect(server.type).toBe('sdk');
        });

        it('should create MCP server with version 1.0.0', () => {
            const server = createMemoryMCPServer(mockBackend);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing server version
            expect((server.instance as any).server._serverInfo.version).toBe('1.0.0');
        });

        it('should have view tool with description', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const viewTool = (server.instance as any)._registeredTools.view;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(viewTool.description).toBe('View memory by path');
        });

        it('should have storeSelf tool with description', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(storeSelfTool.description).toBe('Store self-knowledge in identity or state layer');
        });

        it('should have storeUserMemory tool with description', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const storeUserMemoryTool = (server.instance as any)._registeredTools.storeUserMemory;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(storeUserMemoryTool.description).toBe('Store user-specific memory');
        });

        it('should have logEvent tool with description', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const logEventTool = (server.instance as any)._registeredTools.logEvent;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(logEventTool.description).toBe('Log an event to the events layer');
        });

        it('should have search tool with description', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.search;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(searchTool.description).toBe('Search memories by tag with optional filters');
        });

        it('should have view tool with path input schema', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const viewTool = (server.instance as any)._registeredTools.view;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(viewTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(viewTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema path
            expect(viewTool.inputSchema.shape.path).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema description
            expect(viewTool.inputSchema.shape.path.description).toContain('Memory path');
        });

        it('should have storeSelf tool with layer, name, content, and tags input schema', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(storeSelfTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(storeSelfTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema layer
            expect(storeSelfTool.inputSchema.shape.layer).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema name
            expect(storeSelfTool.inputSchema.shape.name).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema content
            expect(storeSelfTool.inputSchema.shape.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema tags
            expect(storeSelfTool.inputSchema.shape.tags).toBeDefined();
        });

        it('should have storeUserMemory tool with userId, name, content, and tags input schema', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const storeUserMemoryTool = (server.instance as any)._registeredTools.storeUserMemory;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(storeUserMemoryTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(storeUserMemoryTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema userId
            expect(storeUserMemoryTool.inputSchema.shape.userId).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema name
            expect(storeUserMemoryTool.inputSchema.shape.name).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema content
            expect(storeUserMemoryTool.inputSchema.shape.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema tags
            expect(storeUserMemoryTool.inputSchema.shape.tags).toBeDefined();
        });

        it('should have logEvent tool with eventType, summary, details, and tags input schema', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const logEventTool = (server.instance as any)._registeredTools.logEvent;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(logEventTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(logEventTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema eventType
            expect(logEventTool.inputSchema.shape.eventType).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema summary
            expect(logEventTool.inputSchema.shape.summary).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema details
            expect(logEventTool.inputSchema.shape.details).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema tags
            expect(logEventTool.inputSchema.shape.tags).toBeDefined();
        });

        it('should have search tool with tag, layer, and limit input schema', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.search;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(searchTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(searchTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema tag
            expect(searchTool.inputSchema.shape.tag).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema layer
            expect(searchTool.inputSchema.shape.layer).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema limit
            expect(searchTool.inputSchema.shape.limit).toBeDefined();
        });
    });

    describe('view tool', () => {
        it('should return memory content when found', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/memories/test.md' as MemoryPath,
                content:     'Test content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/memories/test.md' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content.length).toBe(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Test content');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        it('should return error when memory not found', async () => {
            mockBackend.get = mock(async () => undefined);

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/memories/nonexistent.md' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Memory not found');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should return error message when backend.get throws Error', async () => {
            mockBackend.get = mock(async () => {
                throw new Error('Database connection failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/memories/test.md' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error viewing memory: Database connection failed');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should return error message when backend.get throws non-Error', async () => {
            mockBackend.get = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'String error message';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/memories/test.md' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error viewing memory: String error message');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should call backend.get with correct memory path', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/memories/identity/core.md' as MemoryPath,
                content:     'Core identity',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ path: '/memories/identity/core.md' });

            expect(mockBackend.get).toHaveBeenCalledWith('/memories/identity/core.md');
        });

        it('should return content as text type with const assertion', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/test.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/markdown' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'view');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/test.md' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
        });
    });

    describe('storeSelf tool', () => {
        it('should store identity memory successfully', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/identity/core-values' as MemoryPath,
                content:     'My core values',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ layer: 'identity', name: 'core-values', content: 'My core values' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Memory stored at /identity/core-values');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        it('should store state memory successfully', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/state/current-goals' as MemoryPath,
                content:     'Current goals',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ layer: 'state', name: 'current-goals', content: 'Current goals' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Memory stored at /state/current-goals');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        it('should call backend.create with correct path for identity layer', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ layer: 'identity', name: 'beliefs', content: 'My beliefs' });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/identity/beliefs',
                content:     'My beliefs',
                contentType: 'text/plain',
                tags:        undefined,
            });
        });

        it('should call backend.create with correct path for state layer', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ layer: 'state', name: 'context', content: 'Current context' });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/state/context',
                content:     'Current context',
                contentType: 'text/plain',
                tags:        undefined,
            });
        });

        it('should pass tags to backend.create when provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ layer: 'identity', name: 'values', content: 'Values', tags: ['core', 'important'] });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/identity/values',
                content:     'Values',
                contentType: 'text/plain',
                tags:        ['core', 'important'],
            });
        });

        it('should return error when backend.create throws Error', async () => {
            mockBackend.create = mock(async () => {
                throw new Error('Path already exists');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ layer: 'identity', name: 'test', content: 'Content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error storing self memory: Path already exists');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should return error when backend.create throws non-Error', async () => {
            mockBackend.create = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw { code: 'VALIDATION_ERROR' };
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ layer: 'state', name: 'test', content: 'Content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('Error storing self memory:');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should use text/plain content type', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ layer: 'identity', name: 'test', content: 'Content' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    contentType: 'text/plain',
                })
            );
        });

        describe('layer enum validation', () => {
            it('should have layer schema that accepts identity', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = storeSelfTool.inputSchema.shape.layer.safeParse('identity');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(true);
            });

            it('should have layer schema that accepts state', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = storeSelfTool.inputSchema.shape.layer.safeParse('state');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(true);
            });

            it('should have layer schema that rejects invalid values', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = storeSelfTool.inputSchema.shape.layer.safeParse('invalid');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(false);
            });

            it('should have layer schema that rejects empty string', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = storeSelfTool.inputSchema.shape.layer.safeParse('');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(false);
            });

            it('should have layer schema that rejects events for storeSelf', () => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = storeSelfTool.inputSchema.shape.layer.safeParse('events');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(false);
            });
        });
    });

    describe('storeUserMemory tool', () => {
        it('should store user memory successfully', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/users/user123/preferences' as MemoryPath,
                content:     'User preferences',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ userId: 'user123', name: 'preferences', content: 'User preferences' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('User memory stored at /users/user123/preferences');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        it('should call backend.create with correct path including userId', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ userId: 'alice', name: 'history', content: 'Conversation history' });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/users/alice/history',
                content:     'Conversation history',
                contentType: 'text/plain',
                tags:        undefined,
            });
        });

        it('should pass tags to backend.create when provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ userId: 'bob', name: 'notes', content: 'Notes', tags: ['personal', 'work'] });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/users/bob/notes',
                content:     'Notes',
                contentType: 'text/plain',
                tags:        ['personal', 'work'],
            });
        });

        it('should return error when backend.create throws Error', async () => {
            mockBackend.create = mock(async () => {
                throw new Error('Storage quota exceeded');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ userId: 'user1', name: 'test', content: 'Content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error storing user memory: Storage quota exceeded');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should return error when backend.create throws non-Error', async () => {
            mockBackend.create = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Network error';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ userId: 'user1', name: 'test', content: 'Content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error storing user memory: Network error');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should use text/plain content type', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeUserMemory');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ userId: 'user1', name: 'test', content: 'Content' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    contentType: 'text/plain',
                })
            );
        });
    });

    describe('logEvent tool', () => {
        it('should log event with summary only and return success message', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ eventType: 'conversation', summary: 'Had a discussion about testing' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toMatch(/^Event logged at \/events\/conversation\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        it('should log event with summary and details combining content', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
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

        it('should call backend.create with summary only when no details provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ eventType: 'learning', summary: 'Learned about mutation testing' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'Learned about mutation testing',
                })
            );
        });

        it('should pass tags to backend.create when provided', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ eventType: 'error', summary: 'An error occurred', tags: ['critical', 'bug'] });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    tags: ['critical', 'bug'],
                })
            );
        });

        it('should generate path with events prefix and eventType', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ eventType: 'test', summary: 'Test event' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: expect.stringMatching(/^\/events\/test\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/),
                })
            );
        });

        it('should generate path without colons or dots', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ eventType: 'verify', summary: 'Verify timestamp format' });

            // Get the path that was passed to create
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Accessing mock calls
            const calledPath = (mockBackend.create as any).mock.calls[0][0].path as string;
            expect(calledPath).not.toContain(':');
            expect(calledPath).not.toContain('.');
        });

        it('should return error when backend.create throws Error', async () => {
            mockBackend.create = mock(async () => {
                throw new Error('DynamoDB write failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ eventType: 'test', summary: 'Test' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error logging event: DynamoDB write failed');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should return error when backend.create throws non-Error', async () => {
            mockBackend.create = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw { statusCode: 500 };
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ eventType: 'test', summary: 'Test' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('Error logging event:');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should use text/plain content type', async () => {
            mockBackend.create = mock(async () => createMockItem());

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'logEvent');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ eventType: 'test', summary: 'Test' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    contentType: 'text/plain',
                })
            );
        });
    });
});
