import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import _ from 'lodash';
import type { MemoryToolBackend } from '../storage/memory-tool';
import { ContentType, createMemoryPath } from '../storage/memory-tool/types';

/**
 * Creates an MCP server for memory operations.
 *
 * Provides tools for:
 * - Viewing memories by path
 * - Storing new memories
 * - Searching memories by tag/content
 *
 * This server wraps the existing DynamoDB memory backend for use with the Claude Agent SDK.
 */
export function createMemoryMCPServer(backend: MemoryToolBackend) {
    return createSdkMcpServer({
        name:    'memory',
        version: '1.0.0',
        tools:   [
            tool(
                'view',
                'View memory by path',
                {
                    path: z.string().describe('Memory path (e.g., /memories/identity/core)'),
                },
                async (args) => {
                    try {
                        const result = await backend.get(createMemoryPath(args.path));
                        if(!result) {
                            return {
                                content: [{ type: 'text' as const, text: 'Memory not found' }],
                                isError: true,
                            };
                        }
                        return {
                            content: [{ type: 'text' as const, text: result.content }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error viewing memory: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'store',
                'Store new memory',
                {
                    path:    z.string().describe('Memory path (e.g., /memories/state/user-preferences)'),
                    content: z.string().describe('Memory content to store'),
                },
                async (args) => {
                    try {
                        await backend.create({
                            path:        createMemoryPath(args.path),
                            content:     args.content,
                            contentType: 'text/plain' as ContentType,
                        });
                        return {
                            content: [{ type: 'text' as const, text: 'Memory stored successfully' }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error storing memory: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'search',
                'Search memories by tag or content',
                {
                    query: z.string().describe('Search query (tag or content fragment)'),
                },
                async (args) => {
                    try {
                        const results = await backend.searchByTag(args.query);
                        if(results.items.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'No memories found matching query' }],
                            };
                        }
                        const formatted = _.map(results.items,
                            r => `${r.path}: ${r.content.substring(0, 200)}${r.content.length > 200 ? '...' : ''}`
                        ).join('\n\n');
                        return {
                            content: [{ type: 'text' as const, text: formatted }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error searching memories: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),
        ],
    });
}
