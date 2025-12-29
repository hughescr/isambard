/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Handler return values are typed as any in tests */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { repeat as _repeat } from 'lodash';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import type { MemoryPath, ContentType } from '../../../src/storage/memory-tool/types';

describe('createMemoryMCPServer', () => {
    let mockBackend: MemoryToolBackend;

    beforeEach(() => {
        mockBackend = {
            create:      mock(async () => ({})),
            get:         mock(async () => undefined),
            update:      mock(async () => ({})),
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

        it('should have store tool with description', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const storeTool = (server.instance as any)._registeredTools.store;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(storeTool.description).toBe('Store new memory');
        });

        it('should have search tool with description', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.search;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(searchTool.description).toBe('Search memories by tag or content');
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

        it('should have store tool with path and content input schema', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const storeTool = (server.instance as any)._registeredTools.store;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(storeTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(storeTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema path
            expect(storeTool.inputSchema.shape.path).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema description
            expect(storeTool.inputSchema.shape.path.description).toContain('Memory path');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema content
            expect(storeTool.inputSchema.shape.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema description
            expect(storeTool.inputSchema.shape.content.description).toContain('Memory content');
        });

        it('should have search tool with query input schema', () => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const searchTool = (server.instance as any)._registeredTools.search;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(searchTool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(searchTool.inputSchema.shape).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema query
            expect(searchTool.inputSchema.shape.query).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema description
            expect(searchTool.inputSchema.shape.query.description).toContain('Search query');
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

    describe('store tool', () => {
        it('should store memory successfully', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/memories/test.md' as MemoryPath,
                content:     'New content',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'store');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/memories/test.md', content: 'New content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Memory stored successfully');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        it('should call backend.create with correct parameters', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/memories/state/user-prefs.md' as MemoryPath,
                content:     'User preferences',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'store');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ path: '/memories/state/user-prefs.md', content: 'User preferences' });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/memories/state/user-prefs.md',
                content:     'User preferences',
                contentType: 'text/plain',
            });
        });

        it('should return error when backend.create throws Error', async () => {
            mockBackend.create = mock(async () => {
                throw new Error('Path already exists');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'store');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/memories/test.md', content: 'Content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error storing memory: Path already exists');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should return error when backend.create throws non-Error', async () => {
            mockBackend.create = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw { code: 'INVALID_PATH' };
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'store');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/memories/test.md', content: 'Content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('Error storing memory:');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should use text/plain content type', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/memories/test.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'store');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ path: '/memories/test.md', content: 'Content' });

            expect(mockBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    contentType: 'text/plain',
                })
            );
        });

        it('should return content as text type with const assertion', async () => {
            mockBackend.create = mock(async () => ({
                path:        '/test.md' as MemoryPath,
                content:     'Content',
                contentType: 'text/plain' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'store');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ path: '/test.md', content: 'Content' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
        });
    });

    describe('search tool', () => {
        it('should return search results when memories found', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/memories/test1.md' as MemoryPath,
                        content:     'First memory content',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/memories/test2.md' as MemoryPath,
                        content:     'Second memory content',
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

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

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

        it('should return message when no memories found', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'nonexistent' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('No memories found matching query');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBeUndefined();
        });

        it('should truncate content preview to 200 characters', async () => {
            const longContent = _repeat('A', 300);
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/memories/long.md' as MemoryPath,
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

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain(_repeat('A', 200));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('...');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).not.toContain(_repeat('A', 201));
        });

        it('should not truncate content exactly at 200 characters', async () => {
            const exactContent = _repeat('B', 200);
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/memories/exact.md' as MemoryPath,
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

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain(_repeat('B', 200));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).not.toContain('...');
        });

        it('should join multiple results with double newline', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/memories/test1.md' as MemoryPath,
                        content:     'Content 1',
                        contentType: 'text/markdown' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00.000Z',
                        updatedAt:   '2025-01-01T00:00:00.000Z',
                        tags:        ['tag1'],
                    },
                    {
                        path:        '/memories/test2.md' as MemoryPath,
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

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('\n\n');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toMatch(/test1\.md.*\n\n.*test2\.md/);
        });

        it('should call backend.searchByTag with query', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ query: 'my-search-query' });

            expect(mockBackend.searchByTag).toHaveBeenCalledWith('my-search-query');
        });

        it('should return error when backend.searchByTag throws Error', async () => {
            mockBackend.searchByTag = mock(async () => {
                throw new Error('Search failed');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error searching memories: Search failed');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should return error when backend.searchByTag throws non-Error', async () => {
            mockBackend.searchByTag = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Database timeout';
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('Error searching memories: Database timeout');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        it('should format results with path and content preview', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        '/memories/note.md' as MemoryPath,
                        content:     'This is my note content',
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

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('/memories/note.md: This is my note content');
        });

        it('should return content as text type with const assertion', async () => {
            mockBackend.searchByTag = mock(async () => ({
                items:      [],
                nextCursor: undefined,
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'search');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ query: 'tag1' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
        });
    });
});
