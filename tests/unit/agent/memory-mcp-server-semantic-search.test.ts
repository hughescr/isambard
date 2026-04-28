/**
 * Tests for the semantic_search tool in memory-mcp-server.ts
 *
 * Covers:
 * - Unavailable when vector index not configured
 * - Unavailable when embedder not configured
 * - Successful KNN lookup and item hydration
 * - Empty query results
 * - All looked-up items deleted (pk/sk exist in vector index but not DynamoDB)
 * - Layer filter forwarded to vectorIndex.query
 * - Limit parameter used correctly
 * - Error handling (embed failure, vectorIndex.query failure, backend.get failure)
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import type { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import { createMemoryPath, type MemoryPath, type MemoryToolItemData } from '../../../src/storage/memory-tool/types';
import type { Embedder } from '../../../src/storage/memory-vec';
import type { VectorIndex } from '../../../src/storage/memory-vec-store/backend';
import type { VectorQueryResult } from '../../../src/storage/memory-vec-store/types';
import { mockLogger, textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool | undefined> }

/** Helper to get tool handler from server instance */
function getToolHandler(server: ReturnType<typeof createMemoryMCPServer>, toolName: string): (...args: unknown[]) => Promise<CallToolResult> {
    const tool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
    if(!tool) {
        throw new Error(`Tool not found: ${toolName}`);
    }
    return tool.handler;
}

/** Make a mock MemoryToolItemData */
function makeItem(overrides: Partial<MemoryToolItemData> = {}): MemoryToolItemData {
    return {
        path:        '/identity/test-item' as MemoryPath,
        content:     'test content',
        contentType: 'text/plain',
        metadata:    {},
        createdAt:   '2025-01-01T00:00:00.000Z',
        updatedAt:   '2025-01-01T00:00:00.000Z',
        ...overrides,
    };
}

/** Make a mock VectorQueryResult */
function makeQueryResult(pk: string, sk: string, distance: number, layer = 'identity'): VectorQueryResult {
    return { pk, sk, layer, distance };
}

describe('semantic_search MCP tool', () => {
    let mockBackend:     MemoryToolBackend;
    let mockVectorIndex: VectorIndex;
    let mockEmbedder:    Embedder;

    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();

        mockBackend = {
            create:        mock(async () => makeItem()),
            get:           mock(async () => undefined),
            update:        mock(async () => makeItem()),
            'delete':      mock(async () => {}),
            list:          mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer:   mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTags:  mock(async () => ({ items: [], nextCursor: undefined })),
            listTagCounts: mock(async () => []),
        } as unknown as MemoryToolBackend;

        mockVectorIndex = {
            isClosed: false,
            query:    mock((): VectorQueryResult[] => []),
            upsert:   mock(() => {}),
            'delete': mock(() => {}),
            getHash:  mock((): string | undefined => undefined),
            close:    mock(() => {}),
        } as unknown as VectorIndex;

        mockEmbedder = {
            encode: mock(async () => ({ data: new Uint8Array(128).fill(0xAB) })),
            close:  mock(async () => {}),
        } as unknown as Embedder;
    });

    describe('unavailability guards', () => {
        test('semantic_search tool is absent (not registered) when neither vectorIndex nor embedder provided', () => {
            const server = createMemoryMCPServer(mockBackend);
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            // Tool must not be in the tool list at all — not even as a stub that errors
            expect(registeredTool).toBeUndefined();
        });

        test('semantic_search tool is absent (not registered) when vectorIndex provided but embedder missing', () => {
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            expect(registeredTool).toBeUndefined();
        });

        test('semantic_search tool is absent (not registered) when embedder provided but vectorIndex missing', () => {
            const server = createMemoryMCPServer(mockBackend, { embedder: mockEmbedder });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            expect(registeredTool).toBeUndefined();
        });
    });

    describe('empty results', () => {
        test('returns "No semantically similar memories found" when vectorIndex returns empty array', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([]);
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'test query', limit: 5 });

            expect(result.isError).toBeUndefined();
            expect(result.content[0]).toMatchObject({ type: 'text', text: 'No semantically similar memories found' });
        });

        test('returns "No semantically similar memories found" when all hydrated items are undefined (deleted)', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/identity', 'FILE#item1', 10),
            ]);
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(undefined);

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'test query', limit: 5 });

            expect(result.isError).toBeUndefined();
            expect(result.content[0]).toMatchObject({ type: 'text', text: 'No semantically similar memories found' });
        });
    });

    describe('successful search', () => {
        test('calls embedder.encode with the query text', async () => {
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'my search query', limit: 5 });

            expect(mockEmbedder.encode).toHaveBeenCalledWith(['my search query']);
        });

        test('calls vectorIndex.query with 128-byte slice of embed result and limit', async () => {
            const mockVec = new Uint8Array(256).fill(0xAB); // >128 bytes to test slice
            (mockEmbedder.encode as ReturnType<typeof mock>).mockResolvedValue({ data: mockVec });

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'test query', limit: 3 });

            const callArgs = (mockVectorIndex.query as ReturnType<typeof mock>).mock.calls[0] as [Uint8Array, number, unknown];
            expect(callArgs[0]).toHaveLength(128);
            expect(callArgs[1]).toBe(3);
        });

        test('passes layer filter to vectorIndex.query when provided', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([]);
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'test', limit: 5, layer: 'identity' });

            const callArgs = (mockVectorIndex.query as ReturnType<typeof mock>).mock.calls[0] as [Uint8Array, number, string | undefined];
            expect(callArgs[2]).toBe('identity');
        });

        test('passes undefined layer to vectorIndex.query when not provided', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([]);
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'test', limit: 5 });

            const callArgs = (mockVectorIndex.query as ReturnType<typeof mock>).mock.calls[0] as [Uint8Array, number, string | undefined];
            expect(callArgs[2]).toBeUndefined();
        });

        test('returns formatted results with path, distance, layer, and content preview', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/identity', 'FILE#core-values', 42, 'identity'),
            ]);
            const item = makeItem({
                path:    '/identity/core-values' as MemoryPath,
                content: 'Be kind and thoughtful',
            });
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(item);

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'values', limit: 5 });

            const text = textContent(result.content[0]);
            expect(text).toContain('/identity/core-values');
            expect(text).toContain('distance: 42');
            expect(text).toContain('layer: identity');
            expect(text).toContain('Be kind and thoughtful');
        });

        test('truncates content preview to 200 chars and appends ellipsis', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#long-item', 10, 'state'),
            ]);
            const longContent = 'x'.repeat(300);
            const item = makeItem({ path: '/state/long-item' as MemoryPath, content: longContent });
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(item);

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'long', limit: 5 });

            const text = textContent(result.content[0]);
            // Exact check: preview is exactly 200 chars, not 300, followed by '...'
            expect(text).toContain(`${'x'.repeat(200)}...`);
            // The preview must NOT contain the 201st character followed by '...'
            expect(text).not.toContain(`${'x'.repeat(201)}...`);
        });

        test('preview is exactly 200 chars when content exceeds 200 — not the full content', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#long-item', 10, 'state'),
            ]);
            // Use distinguishable characters: first 200 = 'a', rest = 'b'
            const longContent = 'a'.repeat(200) + 'b'.repeat(100);
            const item = makeItem({ path: '/state/long-item' as MemoryPath, content: longContent });
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(item);

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'long', limit: 5 });

            const text = textContent(result.content[0]);
            // Should contain the 200-char prefix with '...'
            expect(text).toContain(`${'a'.repeat(200)}...`);
            // Should NOT contain any 'b' characters (they were truncated)
            expect(text).not.toContain('b');
        });

        test('ellipsis is exactly "..." (three dots, not another string)', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#long-item', 10, 'state'),
            ]);
            const item = makeItem({ path: '/state/long-item' as MemoryPath, content: 'z'.repeat(300) });
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(item);

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'long', limit: 5 });

            const text = textContent(result.content[0]);
            // The text should end with exactly '...' not 'Stryker was here!' or similar
            expect(text.endsWith('...')).toBe(true);
        });

        test('does not append ellipsis when content is 200 chars or fewer', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#short-item', 5, 'state'),
            ]);
            const shortContent = 'y'.repeat(200);
            const item = makeItem({ path: '/state/short-item' as MemoryPath, content: shortContent });
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(item);

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'short', limit: 5 });

            const text = textContent(result.content[0]);
            expect(text).not.toContain('...');
            // Verify the result ends with exactly the full content — no extra suffix appended
            // This catches StringLiteral mutants that replace '' with 'Stryker was here!' or similar
            expect(text.endsWith('y'.repeat(200))).toBe(true);
        });

        test('multiple results are separated by a blank line', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/identity', 'FILE#item-a', 5, 'identity'),
                makeQueryResult('DIR#/state', 'FILE#item-b', 10, 'state'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>)
                .mockResolvedValueOnce(makeItem({ path: '/identity/item-a' as MemoryPath, content: 'FIRST_ITEM' }))
                .mockResolvedValueOnce(makeItem({ path: '/state/item-b' as MemoryPath, content: 'SECOND_ITEM' }));

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'test', limit: 5 });

            const text = textContent(result.content[0]);
            // Each item is formatted as "path [distance, layer]\ncontent"
            // Two items joined with \n\n means splitting on \n\n gives exactly 2 parts
            const parts = text.split('\n\n');
            expect(parts).toHaveLength(2);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- noUncheckedIndexedAccess; parts has exactly 2 items per check above
            expect(parts[0]!).toContain('FIRST_ITEM');
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- noUncheckedIndexedAccess; parts has exactly 2 items per check above
            expect(parts[1]!).toContain('SECOND_ITEM');
        });

        test('resolves paths from DynamoDB pk/sk via MemoryToolKeyGenerator.parsePath', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/events/conversation', 'FILE#2025-01-01T00-00-00-000Z', 20, 'events'),
            ]);
            const item = makeItem({ path: '/events/conversation/2025-01-01T00-00-00-000Z' as MemoryPath });
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(item);

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'conversation', limit: 5 });

            // Verify that backend.get was called with the correct path
            const getArg = (mockBackend.get as ReturnType<typeof mock>).mock.calls[0] as unknown[];
            expect(getArg[0]).toBe('/events/conversation/2025-01-01T00-00-00-000Z');
        });

        test('returns results for multiple query hits in parallel', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/identity', 'FILE#item-a', 5, 'identity'),
                makeQueryResult('DIR#/state', 'FILE#item-b', 10, 'state'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>)
                .mockResolvedValueOnce(makeItem({ path: '/identity/item-a' as MemoryPath, content: 'content A' }))
                .mockResolvedValueOnce(makeItem({ path: '/state/item-b' as MemoryPath, content: 'content B' }));

            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'test', limit: 5 });

            const text = textContent(result.content[0]);
            expect(text).toContain('content A');
            expect(text).toContain('content B');
        });
    });

    describe('error handling', () => {
        test('returns isError=true when embedder.encode throws', async () => {
            (mockEmbedder.encode as ReturnType<typeof mock>).mockRejectedValue(new Error('embed failed'));
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'test', limit: 5 });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Error in semantic search: embed failed');
        });

        test('returns isError=true when vectorIndex.query throws', async () => {
            (mockEmbedder.encode as ReturnType<typeof mock>).mockResolvedValue({ data: new Uint8Array(128) });
            (mockVectorIndex.query as ReturnType<typeof mock>).mockImplementation(() => {
                throw new Error('sqlite error');
            });
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'test', limit: 5 });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Error in semantic search: sqlite error');
        });

        test('returns isError=true when backend.get throws', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/identity', 'FILE#item1', 10, 'identity'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB error'));
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            const result = await handler({ query: 'test', limit: 5 });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Error in semantic search: DynamoDB error');
        });
    });

    describe('recordAccess for /state/ results', () => {
        test('calls recordAccess with /state/ paths when results include state items', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#current-mood', 5, 'state'),
                makeQueryResult('DIR#/identity', 'FILE#core-values', 10, 'identity'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>)
                .mockResolvedValueOnce(makeItem({ path: '/state/current-mood' as MemoryPath, content: 'feeling good' }))
                .mockResolvedValueOnce(makeItem({ path: '/identity/core-values' as MemoryPath, content: 'be kind' }));

            const recordAccess = mock(async (): Promise<void> => undefined);
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder, recordAccess });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'test', limit: 5 });

            // Allow the fire-and-forget promise to settle
            await Promise.resolve();

            expect(recordAccess).toHaveBeenCalledTimes(1);
            const calledWith = (recordAccess as ReturnType<typeof mock>).mock.calls[0] as [MemoryPath[]];
            expect(calledWith[0]).toEqual([createMemoryPath('/state/current-mood')]);
        });

        test('does NOT call recordAccess when results contain no /state/ items', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/identity', 'FILE#core-values', 10, 'identity'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(
                makeItem({ path: '/identity/core-values' as MemoryPath, content: 'be kind' })
            );

            const recordAccess = mock(async (): Promise<void> => undefined);
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder, recordAccess });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'test', limit: 5 });

            await Promise.resolve();

            expect(recordAccess).not.toHaveBeenCalled();
        });

        test('does NOT call recordAccess when results are empty', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([]);

            const recordAccess = mock(async (): Promise<void> => undefined);
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder, recordAccess });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'test', limit: 5 });

            await Promise.resolve();

            expect(recordAccess).not.toHaveBeenCalled();
        });

        test('does NOT call recordAccess when option is absent', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#current-mood', 5, 'state'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(
                makeItem({ path: '/state/current-mood' as MemoryPath, content: 'feeling good' })
            );

            // No recordAccess option provided
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const handler = getToolHandler(server, 'semantic_search');
            // Should not throw even without recordAccess
            expect(handler({ query: 'test', limit: 5 })).resolves.toBeDefined();
        });

        test('logs a warning when recordAccess rejects', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#current-mood', 5, 'state'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>).mockResolvedValue(
                makeItem({ path: '/state/current-mood' as MemoryPath, content: 'feeling good' })
            );

            const accessError = new Error('recordAccess failed');
            const recordAccess = mock(async (): Promise<void> => {
                throw accessError;
            });
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder, recordAccess });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'test', limit: 5 });

            // Allow the fire-and-forget .catch handler to run
            await Promise.resolve();

            expect(mockLogger.warn).toHaveBeenCalledWith({
                error: accessError,
                paths: [createMemoryPath('/state/current-mood')],
                msg:   'Failed to record memory access from semantic_search',
            });
        });

        test('calls recordAccess only with /state/ paths — multiple state items', async () => {
            (mockVectorIndex.query as ReturnType<typeof mock>).mockReturnValue([
                makeQueryResult('DIR#/state', 'FILE#mood', 3, 'state'),
                makeQueryResult('DIR#/state', 'FILE#goals', 7, 'state'),
            ]);
            (mockBackend.get as ReturnType<typeof mock>)
                .mockResolvedValueOnce(makeItem({ path: '/state/mood' as MemoryPath, content: 'happy' }))
                .mockResolvedValueOnce(makeItem({ path: '/state/goals' as MemoryPath, content: 'learn more' }));

            const recordAccess = mock(async (): Promise<void> => undefined);
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder, recordAccess });
            const handler = getToolHandler(server, 'semantic_search');
            await handler({ query: 'state', limit: 5 });

            await Promise.resolve();

            expect(recordAccess).toHaveBeenCalledTimes(1);
            const calledWith = (recordAccess as ReturnType<typeof mock>).mock.calls[0] as [MemoryPath[]];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- noUncheckedIndexedAccess; calledWith has 1 element per toHaveBeenCalledTimes(1) above
            const paths = calledWith[0]!;
            expect(paths).toContain(createMemoryPath('/state/mood'));
            expect(paths).toContain(createMemoryPath('/state/goals'));
            expect(paths).toHaveLength(2);
        });
    });

    describe('tool registration', () => {
        test('semantic_search tool is registered with correct description when vectorIndex and embedder are provided', () => {
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            expect(registeredTool).toBeDefined();
            expect(registeredTool?.description).toBe('Semantic search over memories by content similarity. Use the `search` tool for tag-based filtering instead. The query is embedded the same way memory content is, so phrase it in the form a matching memory would take — declarative statements rather than questions.');
        });

        test('semantic_search tool is NOT registered when neither vectorIndex nor embedder are provided', () => {
            const server = createMemoryMCPServer(mockBackend);
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            expect(registeredTool).toBeUndefined();
        });

        test('semantic_search tool is NOT registered when vectorIndex is provided but embedder is absent', () => {
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            expect(registeredTool).toBeUndefined();
        });

        test('semantic_search tool is NOT registered when embedder is provided but vectorIndex is absent', () => {
            const server = createMemoryMCPServer(mockBackend, { embedder: mockEmbedder });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            expect(registeredTool).toBeUndefined();
        });

        test('semantic_search tool has correct annotations — readOnly=true, destructive=false, idempotent=false, openWorld=false', () => {
            const server = createMemoryMCPServer(mockBackend, { vectorIndex: mockVectorIndex, embedder: mockEmbedder });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.semantic_search;
            expect(registeredTool).toBeDefined();
            // Verify BooleanLiteral values: readOnlyHint=true, destructiveHint=false, idempotentHint=false, openWorldHint=false
            expect(registeredTool?.annotations.readOnlyHint).toBe(true);
            expect(registeredTool?.annotations.destructiveHint).toBe(false);
            expect(registeredTool?.annotations.idempotentHint).toBe(false);
            expect(registeredTool?.annotations.openWorldHint).toBe(false);
        });
    });
});
