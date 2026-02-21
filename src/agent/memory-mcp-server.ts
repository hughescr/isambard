import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { MemoryToolBackend } from '../storage/memory-tool';
import { type LayerName, type MemoryPath, createMemoryPath, createLayerName, createContentType } from '../storage/memory-tool/types';

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
export function createMemoryMCPServer(
    backend: MemoryToolBackend,
    options?: { recordAccess?: (paths: MemoryPath[]) => Promise<void> }
) {
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
                async (args): Promise<CallToolResult> => {
                    try {
                        const memoryPath = createMemoryPath(args.path);
                        const result = await backend.get(memoryPath);
                        if(!result) {
                            return {
                                content: [{ type: 'text' as const, text: 'Memory not found' }],
                                isError: true,
                            };
                        }
                        // Fire-and-forget: record access for state-layer memories (scoring)
                        // Stryker disable next-line ConditionalExpression: recordAccess is fire-and-forget optimization
                        if(_.startsWith(args.path, '/state/') && options?.recordAccess) {
                            // Stryker disable BlockStatement: recordAccess catch is fire-and-forget
                            options.recordAccess([memoryPath]).catch((error: unknown) => {
                                logger.warn({ error, path: args.path, msg: 'Failed to record memory access' });
                            });
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
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'storeSelf',
                'Store self-knowledge in identity or state layer. Saving with the same name will replace existing content.',
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
                async (args): Promise<CallToolResult> => {
                    try {
                        const path = createMemoryPath(`/${args.layer}/${args.name}`);
                        const existing = await backend.get(path);
                        if(existing) {
                            await backend.update(path, { content: args.content, tags: args.tags ? new Set(args.tags) : undefined });
                        } else {
                            await backend.create({
                                path,
                                content:     args.content,
                                contentType: createContentType('text/plain'),
                                tags:        args.tags ? new Set(args.tags) : undefined,
                            });
                        }
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
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'storeUserMemory',
                'Store user-specific memory. Saving with the same userId and name will replace existing content.',
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
                async (args): Promise<CallToolResult> => {
                    try {
                        const path = createMemoryPath(`/users/${args.userId}/${args.name}`);
                        const existing = await backend.get(path);
                        if(existing) {
                            await backend.update(path, { content: args.content, tags: args.tags ? new Set(args.tags) : undefined });
                        } else {
                            await backend.create({
                                path,
                                content:     args.content,
                                contentType: createContentType('text/plain'),
                                tags:        args.tags ? new Set(args.tags) : undefined,
                            });
                        }
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
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }
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
                async (args): Promise<CallToolResult> => {
                    try {
                        const timestamp = _.replace(new Date().toISOString(), /[:.]/g, '-');
                        const path = createMemoryPath(`/events/${args.eventType}/${timestamp}`);
                        const content = args.details
                            ? `${args.summary}\n\n${args.details}`
                            : args.summary;
                        await backend.create({
                            path,
                            content,
                            contentType: createContentType('text/plain'),
                            tags:        args.tags ? new Set(args.tags) : undefined,
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
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'search',
                'Search memories by tag with optional filters',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    tags:      z.array(z.string()).min(1).describe('Tags to search for (AND semantics — items must have all tags)'),
                    // Stryker disable next-line StringLiteral: z.enum values and describe() are schema configuration
                    layer:     z.enum(['identity', 'state', 'events']).optional().describe('Optional layer filter'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().optional().describe('Optional result limit'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    cursor:    z.string().optional().describe('Pagination cursor from previous response'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startDate: z.string().datetime().optional().describe('Filter: items updated on or after this ISO8601 datetime'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endDate:   z.string().datetime().optional().describe('Filter: items updated on or before this ISO8601 datetime'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Build options object only if filter params provided
                        const options = (args.limit ?? args.cursor ?? args.startDate ?? args.endDate)
                            ? { limit: args.limit, cursor: args.cursor, startDate: args.startDate, endDate: args.endDate }
                            : undefined;
                        const results = await backend.searchByTags(
                            new Set(args.tags),
                            args.layer ? createLayerName(args.layer) : undefined,
                            options
                        );
                        if(results.items.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'No memories found matching tags' }],
                            };
                        }
                        let formatted = _.map(results.items, (r) => {
                            const preview = r.contentPreview ?? 'No content';
                            return `${r.memoryPath}: ${preview.substring(0, 200)}${preview.length > 200 ? '...' : ''}`;
                        }).join('\n\n');
                        if(results.nextCursor) {
                            formatted += `\n\n---\nMore results available. Use cursor: ${results.nextCursor}`;
                        }
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
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'list',
                'List memories in a directory',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    path:      z.string().optional().describe('Directory path (e.g., /, /identity, /users). Defaults to root /'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().optional().describe('Maximum number of results to return'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    cursor:    z.string().optional().describe('Pagination cursor from previous response'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startDate: z.string().datetime().optional().describe('Filter: items updated on or after this ISO8601 datetime'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endDate:   z.string().datetime().optional().describe('Filter: items updated on or before this ISO8601 datetime'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Stryker disable next-line StringLiteral: Default path for root directory
                        const rawPath = args.path ?? '/';
                        // Normalize: strip trailing slash (except for root)
                        // Stryker disable next-line StringLiteral: trimEnd('') is equivalent - paths work via prefix-based list query
                        const dirPath = rawPath === '/' ? '/' : _.trimEnd(rawPath, '/');

                        // Build options object only if filter params provided
                        const options = (args.limit ?? args.cursor ?? args.startDate ?? args.endDate)
                            ? { limit: args.limit, cursor: args.cursor, startDate: args.startDate, endDate: args.endDate }
                            : undefined;

                        // Check if path is a layer root - use listByLayer for efficient GSI1 query
                        const layerPaths: Record<string, LayerName> = {
                            '/events':   createLayerName('events'),
                            '/identity': createLayerName('identity'),
                            '/state':    createLayerName('state'),
                        };
                        const layer = layerPaths[dirPath];

                        // Stryker disable ObjectLiteral,StringLiteral: Logger debug objects - content not behavior-affecting
                        const results = layer
                            ? (logger.debug({ layer, dirPath, msg: 'Using GSI1 listByLayer for layer path' }), await backend.listByLayer(layer, options))
                            : (logger.debug({ dirPath, msg: 'Using directory list for non-layer path' }), await backend.list(dirPath, options));
                        // Stryker restore ObjectLiteral,StringLiteral

                        if(results.items.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'Directory is empty' }],
                            };
                        }
                        let formatted = _.map(results.items, 'path').join('\n');
                        if(results.nextCursor) {
                            formatted += `\n\n---\nMore results available. Use cursor: ${results.nextCursor}`;
                        }
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
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'listTags',
                'List all tags with their usage counts',
                // Stryker restore StringLiteral
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        const tagCounts = await backend.listTagCounts();
                        if(tagCounts.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'No tags found' }],
                            };
                        }
                        // Sort by count descending
                        const sortedCounts = _.orderBy(tagCounts, ['count'], ['desc']);
                        const formatted = _.map(sortedCounts, ({ tag, count }) => `${tag}: ${count}`).join('\n');
                        return {
                            content: [{ type: 'text' as const, text: formatted }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error listing tags: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'deleteMemory',
                'Delete a memory at the specified path. Returns the deleted content as confirmation.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    path: z.string().describe('Memory path to delete (e.g., /identity/old-values, /state/outdated)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await backend.delete(createMemoryPath(args.path));
                        if(!result) {
                            return {
                                content: [{ type: 'text' as const, text: `Memory not found at path: ${args.path}` }],
                                isError: true,
                            };
                        }
                        const tags = result.tags && result.tags.size > 0 ? [...result.tags].join(', ') : 'none';
                        return {
                            content: [{ type: 'text' as const, text: `Deleted memory at ${result.path}\nTags: ${tags}\nLast updated: ${result.updatedAt}\n\n${result.content}` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error deleting memory: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }
            ),
            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'updateTags',
                'Add or remove tags on an existing memory without changing its content.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    path:       z.string().describe('Memory path to update tags on'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    addTags:    z.array(z.string()).optional().describe('Tags to add to the memory'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    removeTags: z.array(z.string()).optional().describe('Tags to remove from the memory'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const addTags = args.addTags ?? [];
                        const removeTags = args.removeTags ?? [];
                        if(addTags.length === 0 && removeTags.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'Must provide at least one of addTags or removeTags (non-empty)' }],
                                isError: true,
                            };
                        }

                        const memoryPath = createMemoryPath(args.path);
                        const existing = await backend.get(memoryPath);
                        if(!existing) {
                            return {
                                content: [{ type: 'text' as const, text: `Memory not found at path: ${args.path}` }],
                                isError: true,
                            };
                        }

                        const beforeTags = new Set(existing.tags ?? []);
                        const newTags = new Set(beforeTags);
                        for(const tag of addTags) {
                            newTags.add(tag);
                        }
                        for(const tag of removeTags) {
                            newTags.delete(tag);
                        }

                        await backend.update(memoryPath, { tags: newTags, preserveUpdatedAt: true });

                        const beforeStr = beforeTags.size > 0 ? [...beforeTags].sort().join(', ') : '(none)';
                        const afterStr = newTags.size > 0 ? [...newTags].sort().join(', ') : '(none)';
                        return {
                            content: [{ type: 'text' as const, text: `Updated tags on ${args.path}\nBefore: ${beforeStr}\nAfter: ${afterStr}` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error updating tags: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),
        ],
    });
}
