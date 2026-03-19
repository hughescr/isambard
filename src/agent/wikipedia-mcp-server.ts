import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult } from './mcp-helpers';

const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/api/rest_v1/page/random/summary';

// Stryker disable ObjectLiteral,StringLiteral: HTTP headers are configuration values
const WIKIPEDIA_HEADERS = {
    'User-Agent':     'Isambard/1.0 (https://github.com/hughescr/isambard)',
    'Api-User-Agent': 'Isambard/1.0 (https://github.com/hughescr/isambard)',
};
// Stryker restore ObjectLiteral,StringLiteral

/**
 * Creates an MCP server for Wikipedia article discovery and retrieval.
 *
 * Provides two tools:
 * - getRandomArticle: Fetches a random Wikipedia article summary
 * - getArticle: Fetches a Wikipedia article's full source content by title
 *
 * This server is used during perch time for breadth exploration,
 * giving the agent a serendipitous entry point into unexpected topics.
 */
export function createWikipediaMCPServer() {
    return createSdkMcpServer({
        name:    'wikipedia',
        version: '1.0.0',
        tools:   [
            tool(
                'getRandomArticle',
                'Fetch a random Wikipedia article summary. Returns structured JSON with title, extract, description, thumbnail URL, and full article URL.',
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        const response = await fetch(WIKIPEDIA_API_URL, {
                            headers:  WIKIPEDIA_HEADERS,
                            redirect: 'follow',
                        });

                        if(!response.ok) {
                            return mcpErrorResult(new Error(`Wikipedia API returned ${response.status}: ${response.statusText}`));
                        }

                        const data: unknown = await response.json();
                        return mcpJsonResult(data);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Random Article', readOnlyHint: true, idempotentHint: false } }
            ),
            tool(
                'getArticle',
                'Fetch a Wikipedia article\'s full source content by title. Returns JSON with title, source (wikitext), and metadata.',
                // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                { title: z.string().describe('The Wikipedia article title (e.g. "Albert Einstein", "Quantum_mechanics")') },
                async ({ title }): Promise<CallToolResult> => {
                    try {
                        const url = `https://en.wikipedia.org/w/rest.php/v1/page/${encodeURIComponent(title)}`;
                        const response = await fetch(url, {
                            headers:  WIKIPEDIA_HEADERS,
                            redirect: 'follow',
                        });

                        if(!response.ok) {
                            return mcpErrorResult(new Error(`Wikipedia API returned ${response.status}: ${response.statusText}`));
                        }

                        const data: unknown = await response.json();
                        return mcpJsonResult(data);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Article', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
