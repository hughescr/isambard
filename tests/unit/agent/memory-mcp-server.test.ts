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

describe.concurrent('createMemoryMCPServer', () => {
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

    describe('createMemoryMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createMemoryMCPServer(mockBackend);

            expect(server).toBeDefined();
            expect(server.name).toBe('memory');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing server version
            expect((server.instance as any).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['view', 'View memory by path'],
            ['storeSelf', 'Store self-knowledge in identity or state layer. Saving with the same name will replace existing content.'],
            ['storeUserMemory', 'Store user-specific memory. Saving with the same userId and name will replace existing content.'],
            ['logEvent', 'Log an event to the events layer'],
            ['search', 'Search memories by tag with optional filters'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool description
            expect(tool.description).toBe(expectedDescription);
        });

        test.each([
            ['view', ['path']],
            ['storeSelf', ['layer', 'name', 'content', 'tags']],
            ['storeUserMemory', ['userId', 'name', 'content', 'tags']],
            ['logEvent', ['eventType', 'summary', 'details', 'tags']],
            ['search', ['tag', 'layer', 'limit']],
        ])('should have %s tool with required input schema fields', (toolName, requiredFields) => {
            const server = createMemoryMCPServer(mockBackend);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const tool = (server.instance as any)._registeredTools[toolName];

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking input schema
            expect(tool.inputSchema).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema properties
            expect(tool.inputSchema.shape).toBeDefined();

            // Check all required fields are present
            for(const field of requiredFields) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking schema field
                expect(tool.inputSchema.shape[field]).toBeDefined();
            }
        });
    });

    describe('view tool', () => {
        test('should return memory content when found', async () => {
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

        test('should return error when memory not found', async () => {
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

        test('should return error message when backend.get throws Error', async () => {
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

        test('should return error message when backend.get throws non-Error', async () => {
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
                version:     1,
                createdAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:   '2025-01-01T00:00:00.000Z',
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'storeSelf');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({ layer, name, content });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].type).toBe('text');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe(`Memory stored at /${layer}/${name}`);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
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

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            await handler({ layer: 'identity', name: 'values', content: 'Values', tags: ['core', 'important'] });

            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/identity/values',
                content:     'Values',
                contentType: 'text/plain',
                tags:        ['core', 'important'],
            });
        });

        test('should return error when backend.create throws Error', async () => {
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

        test('should return error when backend.create throws non-Error', async () => {
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

        describe('layer enum validation', () => {
            test.each([
                ['identity', true],
                ['state', true],
                ['invalid', false],
                ['', false],
                ['events', false],
            ])('should validate layer value "%s" as %s', (value, expectedSuccess) => {
                const server = createMemoryMCPServer(mockBackend);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
                const storeSelfTool = (server.instance as any)._registeredTools.storeSelf;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing schema
                const result = storeSelfTool.inputSchema.shape.layer.safeParse(value);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
                expect(result.success).toBe(expectedSuccess);
            });
        });
    });

    describe('storeUserMemory tool', () => {
        test('should store user memory successfully', async () => {
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

        test('should call backend.create with correct path including userId', async () => {
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

        test('should pass tags to backend.create when provided', async () => {
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

        test('should return error when backend.create throws Error', async () => {
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

        test('should return error when backend.create throws non-Error', async () => {
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
    });

    describe('logEvent tool', () => {
        test('should log event with summary only and return success message', async () => {
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

        test('should log event with summary and details combining content', async () => {
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

        test('should call backend.create with summary only when no details provided', async () => {
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

        test('should pass tags to backend.create when provided', async () => {
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

        test('should generate path with events prefix and eventType', async () => {
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

        test('should generate path without colons or dots', async () => {
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

        test('should return error when backend.create throws Error', async () => {
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

        test('should return error when backend.create throws non-Error', async () => {
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
    });

    describe('listTags tool', () => {
        test('should return "No tags found" when registry does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({});

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('No tags found');
        });

        test('should return "No tags found" when registry is empty', async () => {
            mockBackend.get = mock(async () => createMockItem({
                content: JSON.stringify({}),
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({});

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('No tags found');
        });

        test('should return formatted tag list sorted by count descending', async () => {
            mockBackend.get = mock(async () => createMockItem({
                content: JSON.stringify({ important: 5, work: 3, personal: 8 }),
            }));

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({});

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toBe('personal: 8\nimportant: 5\nwork: 3');
        });

        test('should handle errors gracefully', async () => {
            mockBackend.get = mock(async () => {
                throw new Error('Database error');
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({});

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('Error listing tags:');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('Database error');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });

        test('should handle non-Error throws gracefully', async () => {
            mockBackend.get = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw { statusCode: 500 };
            });

            const server = createMemoryMCPServer(mockBackend);
            const handler = getToolHandler(server, 'listTags');

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Calling handler
            const result = await handler({});

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.content[0].text).toContain('Error listing tags:');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing result
            expect(result.isError).toBe(true);
        });
    });
});
