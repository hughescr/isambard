import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { MemoryToolBackend } from '../storage/memory-tool';
import { ContentType, createMemoryPath, LayerName } from '../storage/memory-tool/types';

/**
 * Creates an MCP server for memory operations.
 *
 * Provides tools for:
 * - Viewing memories by path
 * - Storing self memories (identity/state layers)
 * - Storing user memories (per-user context)
 * - Logging events (events layer)
 * - Searching memories by tag with optional layer/limit filters
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
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    path: z.string().describe('Memory path (e.g., /identity/core-values, /users/{userId}/name, /events/{type}/{timestamp})'),
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
                'storeSelf',
                'Store self-knowledge in identity or state layer',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    layer:   z.enum(['identity', 'state']).describe('Layer: identity (core beliefs/values) or state (current context)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    name:    z.string().describe('Memory name (e.g., core-values, current-goals)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    content: z.string().describe('Memory content to store'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    tags:    z.array(z.string()).optional().describe('Optional tags for categorization'),
                },
                async (args) => {
                    try {
                        const path = createMemoryPath(`/${args.layer}/${args.name}`);
                        await backend.create({
                            path,
                            content:     args.content,
                            contentType: 'text/plain' as ContentType,
                            tags:        args.tags,
                        });
                        return {
                            content: [{ type: 'text' as const, text: `Memory stored at ${path}` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error storing self memory: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'storeUserMemory',
                'Store user-specific memory',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    userId:  z.string().describe('User identifier'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    name:    z.string().describe('Memory name (e.g., preferences, history)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    content: z.string().describe('Memory content to store'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    tags:    z.array(z.string()).optional().describe('Optional tags for categorization'),
                },
                async (args) => {
                    try {
                        const path = createMemoryPath(`/users/${args.userId}/${args.name}`);
                        await backend.create({
                            path,
                            content:     args.content,
                            contentType: 'text/plain' as ContentType,
                            tags:        args.tags,
                        });
                        return {
                            content: [{ type: 'text' as const, text: `User memory stored at ${path}` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error storing user memory: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'logEvent',
                'Log an event to the events layer',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    eventType: z.string().describe('Type of event (e.g., conversation, decision, learning)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    summary:   z.string().describe('Brief summary of the event'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    details:   z.string().optional().describe('Optional detailed content'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    tags:      z.array(z.string()).optional().describe('Optional tags for categorization'),
                },
                async (args) => {
                    try {
                        const timestamp = _.replace(new Date().toISOString(), /[:.]/g, '-');
                        const path = createMemoryPath(`/events/${args.eventType}/${timestamp}`);
                        const content = args.details
                            ? `${args.summary}\n\n${args.details}`
                            : args.summary;
                        await backend.create({
                            path,
                            content,
                            contentType: 'text/plain' as ContentType,
                            tags:        args.tags,
                        });
                        return {
                            content: [{ type: 'text' as const, text: `Event logged at ${path}` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error logging event: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'search',
                'Search memories by tag with optional filters',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    tag:   z.string().describe('Tag to search for'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    layer: z.enum(['identity', 'state', 'events']).optional().describe('Optional layer filter'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit: z.number().int().positive().optional().describe('Optional result limit'),
                },
                async (args) => {
                    try {
                        const results = await backend.searchByTag(
                            args.tag,
                            args.layer as LayerName | undefined,
                            args.limit ? { limit: args.limit } : undefined
                        );
                        if(results.items.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'No memories found matching tag' }],
                            };
                        }
                        const formatted = _.map(results.items, (r) => {
                            const preview = r.content ?? r.contentPreview ?? 'No content';
                            return `${r.path}: ${preview.substring(0, 200)}${preview.length > 200 ? '...' : ''}`;
                        }).join('\n\n');
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

            tool(
                'list',
                'List memories in a directory',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    path: z.string().optional().describe('Directory path (e.g., /, /identity, /users). Defaults to root /'),
                },
                async (args) => {
                    try {
                        const rawPath = args.path ?? '/';
                        // Normalize: strip trailing slash (except for root)
                        const dirPath = rawPath === '/' ? '/' : _.trimEnd(rawPath, '/');

                        // Check if path is a layer root - use listByLayer for efficient GSI1 query
                        const layerPaths: Record<string, LayerName> = {
                            '/events':   'events' as LayerName,
                            '/identity': 'identity' as LayerName,
                            '/state':    'state' as LayerName,
                        };
                        const layer = layerPaths[dirPath];

                        const results = layer
                            ? (logger.debug({ layer, dirPath, msg: 'Using GSI1 listByLayer for layer path' }), await backend.listByLayer(layer))
                            : (logger.debug({ dirPath, msg: 'Using directory list for non-layer path' }), await backend.list(dirPath));

                        if(results.items.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'Directory is empty' }],
                            };
                        }
                        const formatted = _.map(results.items, 'path').join('\n');
                        return {
                            content: [{ type: 'text' as const, text: formatted }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error listing directory: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),
        ],
    });
}
