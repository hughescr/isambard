import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpTextResult } from './mcp-helpers';
import { type MemoryToolBackend, type LayerName, type MemoryPath, createMemoryPath, createContentType, createSearchableNamespace, LAYER_NAMES, SELF_LAYER_NAME_VALUES, SEARCHABLE_NAMESPACE_VALUES, encodeOne, type VectorIndex, type EmbedderLike } from '@/storage';

const SEARCH_LAYER_FILTER_DESCRIPTION = 'Optional filter: a memory layer (identity, state, events), or users for per-person memories';

/**
 * Upserts a memory at the given path: updates if it exists, creates if it does not.
 * Returns the memory path string for use in success messages.
 */
async function upsertMemory(
    backend: MemoryToolBackend,
    path: MemoryPath,
    content: string,
    tags: string[] | undefined
): Promise<MemoryPath> {
    const existing = await backend.get(path);
    await (existing
        ? backend.update(path, { content, tags: tags ? new Set(tags) : undefined })
        : backend.create({
            path,
            content,
            contentType: createContentType('text/plain'),
            tags:        tags ? new Set(tags) : undefined,
        }));
    return path;
}

/**
 * Appends cursor pagination info to a formatted results string when a next page exists.
 */
function appendCursorInfo(formatted: string, nextCursor: string | undefined): string {
    if(nextCursor) {
        return `${formatted}\n\n---\nMore results available. Use cursor: ${nextCursor}`;
    }
    return formatted;
}

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
    options?: {
        recordAccess?: (paths: MemoryPath[]) => Promise<void>
        /** Optional vector index for semantic search */
        vectorIndex?:  VectorIndex
        /** Optional embedder for encoding semantic search queries */
        embedder?:     EmbedderLike
    }
) {
    // Build semantic_search tool only when both vector deps are present.
    // When absent, the tool is not registered at all (not even as a stub that errors).
    const semanticSearchTools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = options?.vectorIndex && options.embedder
        ? [
            tool(
                'semantic_search',
                'Semantic search over memories by content similarity. Use the `search` tool for tag-based filtering instead. The query is embedded the same way memory content is, so phrase it in the form a matching memory would take — declarative statements rather than questions.',
                {
                    query: z.string().describe('Natural language query to search for semantically similar memories'),
                    layer: z.enum(SEARCHABLE_NAMESPACE_VALUES).optional().describe(SEARCH_LAYER_FILTER_DESCRIPTION),
                    // The default lives in the handler: the Agent SDK's bundled-zod validator rejects an omitted zod `.default()` field.
                    limit: z.number().int().positive().optional().describe('Maximum number of results to return (default: 5)'),
                },
                // eslint-disable-next-line @stylistic/no-extra-parens -- Babel 8 needs this disambiguation in Stryker's ternary array parser.
                (async (args): Promise<CallToolResult> => {
                    // At this point options.vectorIndex and options.embedder are guaranteed non-null
                    // because this tool is only registered when both are present.
                    const vectorIndex = options.vectorIndex!;
                    const embedder    = options.embedder!;
                    try {
                        const queryVec = await encodeOne(embedder, args.query);

                        // Query the vector index for nearest neighbors
                        const layerFilter = args.layer ? createSearchableNamespace(args.layer) : undefined;
                        const queryResults = vectorIndex.query(queryVec, args.limit ?? 5, layerFilter);

                        // Fetch full items by their domain paths in parallel
                        const itemPromises = queryResults.map(async (r) => {
                            const item = await backend.get(r.path);
                            return { r, item };
                        });
                        const resolvedItems = await Promise.all(itemPromises);

                        // Fire-and-forget: record access for state-layer memories (scoring)
                        if(options.recordAccess) {
                            const statePaths = resolvedItems
                                .filter(({ item }) => item?.path.startsWith('/state/'))
                                .map(({ item }) => item!.path);
                            // Stryker disable next-line llm: statePaths.length is always a nonnegative integer, so > 0 and >= 1 are identical here.
                            if(statePaths.length > 0) {
                                options.recordAccess(statePaths).catch((error: unknown) => {
                                    logger.warn({ error, paths: statePaths, msg: 'Failed to record memory access from semantic_search' });
                                });
                            }
                        }

                        // Format results: 200-char preview with '...' suffix for longer content, joined by blank lines
                        const PREVIEW_LIMIT = 200;
                        const ELLIPSIS = '...';
                        const RESULT_SEPARATOR = '\n\n';
                        // Empty string for the else branch of the ellipsis ternary (no suffix when content fits)
                        const NO_ELLIPSIS = '';
                        const formatted = resolvedItems
                            .filter(({ item }) => item !== undefined)
                            .map(({ r, item }) => {
                                // Truncate content to PREVIEW_LIMIT chars; suffix is ELLIPSIS if truncated, otherwise nothing
                                const content = item!.content;
                                const preview = content.slice(0, PREVIEW_LIMIT);
                                const isTruncated = content.length > PREVIEW_LIMIT;
                                const ellipsis = isTruncated ? ELLIPSIS : NO_ELLIPSIS;
                                return `${item!.path} [distance: ${r.distance}, layer: ${r.layer}]\n${preview}${ellipsis}`;
                            })
                            .join(RESULT_SEPARATOR);

                        // Stryker disable next-line llm: formatted is always a string, so !formatted and formatted.length === 0 select only the empty string.
                        if(!formatted) {
                            return mcpTextResult('No semantically similar memories found');
                        }
                        return mcpTextResult(formatted);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error in semantic search: ${message}` }],
                            isError: true,
                        };
                    }
                }),
                // Tool annotations: semantic_search is read-only, non-destructive, non-idempotent (results vary by index state), closed-world
                {
                    annotations: {
                        readOnlyHint:    true,
                        destructiveHint: false,
                        idempotentHint:  false,
                        openWorldHint:   false,
                    },
                }
            ),
        ]
        : [];

    return createSdkMcpServer({
        name:       'memory',
        version:    '1.0.0',
        // Memory tools are used on every turn: never defer them behind ToolSearch.
        alwaysLoad: true,
        tools:      [
            tool(
                'view',
                'View memory by path',
                {
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
                        // Stryker disable next-line llm: options is an object or undefined, so optional chaining and `&&` agree.
                        if(args.path.startsWith('/state/') && options?.recordAccess) {
                            options.recordAccess([memoryPath]).catch((error: unknown) => {
                                logger.warn({ error, path: args.path, msg: 'Failed to record memory access' });
                            });
                        }
                        return mcpTextResult(result.content);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error viewing memory: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'storeSelf',
                'Store self-knowledge in identity or state layer. Saving with the same name will replace existing content.',
                {
                    layer:   z.enum(SELF_LAYER_NAME_VALUES).describe('Layer: identity (core beliefs/values) or state (current context)'),
                    name:    z.string().describe('Memory name (e.g., core-values, current-goals)'),
                    content: z.string().describe('Memory content to store'),
                    tags:    z.array(z.string()).optional().describe('Optional tags for categorization'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const path = createMemoryPath(`/${args.layer}/${args.name}`);
                        await upsertMemory(backend, path, args.content, args.tags);
                        return mcpTextResult(`Memory stored at ${path}`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error storing self memory: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'storeUserMemory',
                'Store user-specific memory. Saving with the same userId and name will replace existing content.',
                {
                    userId:  z.string().describe('User identifier'),
                    name:    z.string().describe('Memory name (e.g., preferences, history)'),
                    content: z.string().describe('Memory content to store'),
                    tags:    z.array(z.string()).optional().describe('Optional tags for categorization'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const path = createMemoryPath(`/users/${args.userId}/${args.name}`);
                        await upsertMemory(backend, path, args.content, args.tags);
                        return mcpTextResult(`User memory stored at ${path}`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error storing user memory: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'logEvent',
                'Log an event to the events layer',
                {
                    eventType: z.string().describe('Type of event (e.g., conversation, decision, learning)'),
                    summary:   z.string().describe('Brief summary of the event'),
                    details:   z.string().optional().describe('Optional detailed content'),
                    tags:      z.array(z.string()).optional().describe('Optional tags for categorization'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Stryker disable next-line llm: adding the hyphen to the class only replaces each ISO-date hyphen with itself, so the timestamp is unchanged.
                        const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
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
                        return mcpTextResult(`Event logged at ${path}`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error logging event: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'search',
                'Search memories by tag with optional filters',
                {
                    tags:      z.array(z.string()).min(1).describe('Tags to search for (AND semantics — items must have all tags)'),
                    layer:     z.enum(SEARCHABLE_NAMESPACE_VALUES).optional().describe(SEARCH_LAYER_FILTER_DESCRIPTION),
                    limit:     z.number().int().positive().optional().describe('Optional result limit'),
                    cursor:    z.string().optional().describe('Pagination cursor from previous response'),
                    startDate: z.iso.datetime().optional().describe('Filter: items updated on or after this ISO8601 datetime'),
                    endDate:   z.iso.datetime().optional().describe('Filter: items updated on or before this ISO8601 datetime'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Build queryOptions object only if filter params provided
                        const queryOptions = (args.limit ?? args.cursor ?? args.startDate ?? args.endDate)
                            ? { limit: args.limit, cursor: args.cursor, startDate: args.startDate, endDate: args.endDate }
                            : undefined;
                        const results = await backend.searchByTags(
                            new Set(args.tags),
                            args.layer ? createSearchableNamespace(args.layer) : undefined,
                            queryOptions
                        );
                        // Stryker disable next-line llm: array length is always nonnegative, so === 0 and <= 0 are identical here.
                        if(results.items.length === 0) {
                            return mcpTextResult('No memories found matching tags');
                        }
                        const formatted = results.items.map((r) => {
                            const preview = r.contentPreview ?? 'No content';
                            // Stryker disable next-line llm: fixed nonnegative ordered bounds make slice(0, 200) and substring(0, 200) identical.
                            return `${r.memoryPath}: ${preview.slice(0, 200)}${preview.length > 200 ? '...' : ''}`;
                        }).join('\n\n');
                        return mcpTextResult(appendCursorInfo(formatted, results.nextCursor));
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error searching memories: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // semantic_search tool is conditionally included above (see semanticSearchTools).
            // It is only registered when both vectorIndex and embedder are present.
            ...semanticSearchTools,

            tool(
                'list',
                'List memories in a directory',
                {
                    path:      z.string().optional().describe('Directory path (e.g., /, /identity, /users). Defaults to root /'),
                    limit:     z.number().int().positive().optional().describe('Maximum number of results to return'),
                    cursor:    z.string().optional().describe('Pagination cursor from previous response'),
                    startDate: z.iso.datetime().optional().describe('Filter: items updated on or after this ISO8601 datetime'),
                    endDate:   z.iso.datetime().optional().describe('Filter: items updated on or before this ISO8601 datetime'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const rawPath = args.path ?? '/';
                        // Normalize: strip trailing slash (except for root)
                        let dirPath = rawPath;
                        while(dirPath !== '/' && dirPath.endsWith('/')) {
                            dirPath = dirPath.slice(0, -1);
                        }

                        // Build queryOptions object only if filter params provided
                        // Stryker disable next-line llm: the expression is only a truthiness test, where undefined and false select the same branch.
                        const queryOptions = (args.limit ?? args.cursor ?? args.startDate ?? args.endDate)
                            ? { limit: args.limit, cursor: args.cursor, startDate: args.startDate, endDate: args.endDate }
                            : undefined;

                        // Check if path is a layer root - use listByLayer for efficient GSI1 query
                        const layerPaths: Record<string, LayerName> = Object.fromEntries(LAYER_NAMES.map(layer => [`/${layer}`, layer]));
                        const layer = layerPaths[dirPath];

                        const results = layer
                            ? (logger.debug({ layer, dirPath, msg: 'Using GSI1 listByLayer for layer path' }), await backend.listByLayer(layer, queryOptions))
                            : (logger.debug({ dirPath, msg: 'Using directory list for non-layer path' }), await backend.list(dirPath, queryOptions));

                        if(results.items.length === 0) {
                            return mcpTextResult('Directory is empty');
                        }
                        const formatted = results.items.map(item => item.path).join('\n');
                        return mcpTextResult(appendCursorInfo(formatted, results.nextCursor));
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error listing directory: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            tool(
                'listTags',
                'List all tags with their usage counts',
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        const tagCounts = await backend.listTagCounts();
                        // Stryker disable next-line llm: tagCounts is a defined array, so === 0, !length, and optional-chained length === 0 are identical.
                        if(tagCounts.length === 0) {
                            return mcpTextResult('No tags found');
                        }
                        // Sort by count descending
                        const sortedCounts = tagCounts.toSorted((a, b) => b.count - a.count);
                        const formatted = sortedCounts.map(({ tag, count }) => `${tag}: ${count}`).join('\n');
                        return mcpTextResult(formatted);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error listing tags: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            tool(
                'deleteMemory',
                'Delete a memory at the specified path. Returns the deleted content as confirmation.',
                {
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
                        // Stryker disable next-line llm: Set.size is always a nonnegative integer, so > 0 and >= 1 are identical here.
                        const tags = result.tags && result.tags.size > 0 ? [...result.tags].join(', ') : 'none';
                        return mcpTextResult(`Deleted memory at ${result.path}\nTags: ${tags}\nLast updated: ${result.updatedAt}\n\n${result.content}`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error deleting memory: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }
            ),
            tool(
                'updateTags',
                'Add or remove tags on an existing memory without changing its content.',
                {
                    path:       z.string().describe('Memory path to update tags on'),
                    addTags:    z.array(z.string()).optional().describe('Tags to add to the memory'),
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

                        const beforeTags = new Set(existing.tags);
                        const newTags = new Set(beforeTags);
                        for(const tag of addTags) {
                            newTags.add(tag);
                        }
                        for(const tag of removeTags) {
                            newTags.delete(tag);
                        }

                        await backend.update(memoryPath, { tags: newTags, preserveUpdatedAt: true });

                        // Stryker disable next-line llm: Set.size is a non-negative integer, so `> 0` and `!== 0` agree.
                        const beforeStr = beforeTags.size > 0 ? [...beforeTags].toSorted((a, b) => a.localeCompare(b)).join(', ') : '(none)';
                        const afterStr = newTags.size > 0 ? [...newTags].toSorted((a, b) => a.localeCompare(b)).join(', ') : '(none)';
                        return mcpTextResult(`Updated tags on ${args.path}\nBefore: ${beforeStr}\nAfter: ${afterStr}`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error updating tags: ${message}` }],
                            isError: true,
                        };
                    }
                },
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),
        ],
    });
}
