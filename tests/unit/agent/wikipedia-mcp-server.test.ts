import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createWikipediaMCPServer } from '../../../src/agent/wikipedia-mcp-server';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

const mockArticle = {
    title:        'Test Article',
    extract:      'This is a test article extract.',
    description:  'A test article',
    thumbnail:    { source: 'https://example.com/thumb.jpg' },
    content_urls: {
        desktop: { page: 'https://en.wikipedia.org/wiki/Test_Article' },
    },
};

describe.concurrent('createWikipediaMCPServer', () => {
    const originalFetch = globalThis.fetch;
    let mockFetch: ReturnType<typeof mock>;

    beforeEach(() => {
        mockFetch = mock(() => Response.json(mockArticle));
        globalThis.fetch = mockFetch as unknown as typeof fetch;
    });

    afterAll(() => {
        globalThis.fetch = originalFetch;
    });

    describe('server metadata', () => {
        test('should create MCP server with correct properties', () => {
            const server = createWikipediaMCPServer();

            expect(server).toBeDefined();
            expect(server.name).toBe('wikipedia');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
        });
    });

    describe('tool registration', () => {
        test('should register getRandomArticle tool with correct description', () => {
            const server = createWikipediaMCPServer();
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.getRandomArticle;

            expect(registeredTool).toBeDefined();
            expect(registeredTool.description).toBe('Fetch a random Wikipedia article summary. Returns structured JSON with title, extract, description, thumbnail URL, and full article URL.');
        });

        test('should have correct annotations on getRandomArticle', () => {
            const server = createWikipediaMCPServer();
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.getRandomArticle;

            expect(registeredTool.annotations).toBeDefined();
            expect(registeredTool.annotations.readOnlyHint).toBe(true);
            expect(registeredTool.annotations.idempotentHint).toBe(false);
        });
    });

    describe('getRandomArticle tool', () => {
        const getHandler = (): ((...args: unknown[]) => Promise<CallToolResult>) => {
            const server = createWikipediaMCPServer();
            return (server.instance as unknown as RegisteredToolInstance)._registeredTools.getRandomArticle.handler;
        };

        test('should return article data on successful fetch', async () => {
            const handler = getHandler();
            const result = await handler({});

            expect(result.content).toBeDefined();
            expect(result.content).toHaveLength(1);
            const parsed = JSON.parse(textContent(result.content[0]));
            expect(parsed).toEqual(mockArticle);
        });

        test('should return error result on HTTP 403 error', async () => {
            mockFetch = mock(() => Promise.resolve(new Response('Forbidden', { status: 403, statusText: 'Forbidden' })));
            globalThis.fetch = mockFetch as unknown as typeof fetch;

            const handler = getHandler();
            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(result.content).toHaveLength(1);
            expect(textContent(result.content[0])).toContain('Wikipedia API returned 403: Forbidden');
        });

        test('should return error result on network failure', async () => {
            mockFetch = mock(() => Promise.reject(new Error('Network failure')));
            globalThis.fetch = mockFetch as unknown as typeof fetch;

            const handler = getHandler();
            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(result.content).toHaveLength(1);
            expect(textContent(result.content[0])).toContain('Network failure');
        });

        test('should send correct User-Agent headers', async () => {
            const handler = getHandler();
            await handler({});

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
            const headers = fetchOptions.headers as Record<string, string>;
            expect(headers['User-Agent']).toBe('Isambard/1.0 (https://github.com/hughescr/isambard)');
            expect(headers['Api-User-Agent']).toBe('Isambard/1.0 (https://github.com/hughescr/isambard)');
        });

        test('should use redirect: follow option', async () => {
            const handler = getHandler();
            await handler({});

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(fetchOptions.redirect).toBe('follow');
        });

        test('should fetch from the correct Wikipedia API URL', async () => {
            const handler = getHandler();
            await handler({});

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url] = mockFetch.mock.calls[0] as [string];
            expect(url).toBe('https://en.wikipedia.org/api/rest_v1/page/random/summary');
        });
    });
});
