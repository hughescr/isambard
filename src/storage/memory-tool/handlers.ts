/**
 * Memory Tool Handlers
 *
 * Handler functions for memory tool operations.
 */

import { logger } from '@hughescr/logger';
import { ZodError } from 'zod';
import {
    split as _split,
    map as _map,
    endsWith as _endsWith,
    isError as _isError,
    replace as _replace,
    filter as _filter,
    every as _every,
    includes as _includes,
    groupBy as _groupBy
} from 'lodash';
import {
    memoryPathSchema,
    type MemoryPath,
    type ContentType,
    type LayerName,
    extractLayerFromPath
} from './types';
import type { MemoryToolBackend } from './backend';
import {
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    InvalidLineNumberError,
    TextNotFoundError,
    TextNotUniqueError
} from './errors';
import { formatMemoryTimestamp, formatShortRelativeTime } from '@/utils/time';

// === Utility Functions ===

/**
 * Validates and converts a string path to a MemoryPath
 * @throws InvalidPathError if path is invalid
 */
export function validatePath(path: string): MemoryPath {
    try {
        return memoryPathSchema.parse(path);
    } catch (error) {
        if(error instanceof ZodError) {
            const message = _map(error.issues, 'message').join(', ');
            throw new InvalidPathError(path, message);
        }
        throw error;
    }
}

/**
 * Formats content with line numbers
 * @param content The content to format
 * @param range Optional [start, end] line range (1-indexed, inclusive)
 */
export function formatLineNumbers(content: string, range?: [number, number]): string {
    const lines = _split(content, '\n');
    const start = range ? range[0] - 1 : 0;
    const end = range ? range[1] : lines.length;

    return _map(
        lines.slice(start, end),
        (line, index) => `${start + index + 1}:${line}`
    ).join('\n');
}

/**
 * Detects content type from file path extension
 */
export function detectContentType(path: string): ContentType {
    if(_endsWith(path, '.md')) {
        return 'text/markdown';
    }
    if(_endsWith(path, '.json')) {
        return 'application/json';
    }
    return 'text/plain';
}

// === Basic Handlers ===

/**
 * Creates a new memory at the specified path
 */
export async function create(
    backend: MemoryToolBackend,
    params: { path: string, file_text: string }
): Promise<string> {
    const { path } = params;
    logger.debug({ path, msg: `Memory create: ${path}` });
    const memoryPath = validatePath(params.path);
    const contentType = detectContentType(params.path);

    await backend.create({
        path:        memoryPath,
        content:     params.file_text,
        contentType: contentType,
    });

    return `Memory successfully created at ${params.path}`;
}

/**
 * Views a memory or lists directory contents
 */
export async function view(
    backend: MemoryToolBackend,
    params: { path: string, view_range?: [number, number] }
): Promise<string> {
    const { path } = params;
    logger.debug({ path, msg: `Memory view: ${path}` });
    const memoryPath = validatePath(params.path);

    // Try to get as a file first
    const item = await backend.get(memoryPath);

    if(item) {
        // It's a file - return formatted content with header
        const timestamp = formatMemoryTimestamp(item.updatedAt);
        const header = `File: ${params.path} ${timestamp}`;
        const content = formatLineNumbers(item.content, params.view_range);
        return `${header}\n${content}`;
    }

    // Try as a directory
    const parentPath = memoryPath === '/' ? '' : memoryPath;
    const listResult = await backend.list(parentPath);

    if(listResult.items.length > 0) {
        // It's a directory - return listing
        const listing = _map(
            listResult.items,
            item => `${item.path} (${item.contentType})`
        ).join('\n');
        return `Directory contents:\n${listing}`;
    }

    // Neither file nor directory
    throw new PathNotFoundError(params.path);
}

/**
 * Deletes a memory or recursively deletes directory contents
 */
export async function delete_memory(
    backend: MemoryToolBackend,
    params: { path: string }
): Promise<string> {
    const { path } = params;
    logger.debug({ path, msg: `Memory delete: ${path}` });
    const memoryPath = validatePath(params.path);

    // Check if it's a file
    const item = await backend.get(memoryPath);

    if(item) {
        // It's a file - delete it
        await backend.delete(memoryPath);
        return `Memory at ${params.path} deleted successfully`;
    }

    // Try as a directory
    const parentPath = memoryPath === '/' ? '' : memoryPath;
    const listResult = await backend.list(parentPath);

    if(listResult.items.length > 0) {
        // It's a directory - delete all contents
        let deleteCount = 0;
        const failedPaths: string[] = [];
        for(const item of listResult.items) {
            try {
                await backend.delete(item.path);
                deleteCount++;
            } catch (error: unknown) {
                const errorMessage = _isError(error) ? error.message : String(error);
                logger.warn({ path: item.path, error: errorMessage, msg: `Failed to delete ${item.path}: ${errorMessage}` });
                failedPaths.push(item.path);
            }
        }

        if(failedPaths.length === 0) {
            return `Recursively deleted ${deleteCount} memories under ${params.path}`;
        } else {
            return `Recursively deleted ${deleteCount} memories under ${params.path}. Failed to delete ${failedPaths.length} items: ${failedPaths.join(', ')}`;
        }
    }

    // Neither file nor directory
    throw new PathNotFoundError(params.path);
}

/**
 * Inserts text at a specific line number
 */
export async function insert(
    backend: MemoryToolBackend,
    params: { path: string, insert_line: number, insert_text: string }
): Promise<string> {
    const { path } = params;
    logger.debug({ path, msg: `Memory insert: ${path}` });
    const memoryPath = validatePath(params.path);

    const item = await backend.get(memoryPath);
    if(!item) {
        throw new PathNotFoundError(params.path);
    }

    const lines = _split(item.content, '\n');

    // Validate line number (0-indexed insertion, so valid range is 0 to lines.length)
    if(!Number.isInteger(params.insert_line) || params.insert_line < 0 || params.insert_line > lines.length) {
        throw new InvalidLineNumberError(params.path, params.insert_line, lines.length);
    }

    // Insert the new text
    lines.splice(params.insert_line, 0, params.insert_text);
    const newContent = lines.join('\n');

    await backend.update(memoryPath, { content: newContent });

    return `Text inserted at line ${params.insert_line} in ${params.path}`;
}

// === Advanced Handlers ===

/**
 * Replaces text in a memory (must be unique occurrence)
 */
export async function str_replace(
    backend: MemoryToolBackend,
    params: { path: string, old_str: string, new_str: string }
): Promise<string> {
    const { path } = params;
    logger.debug({ path, msg: `Memory str_replace: ${path}` });
    const memoryPath = validatePath(params.path);

    const item = await backend.get(memoryPath);
    if(!item) {
        throw new PathNotFoundError(params.path);
    }

    // Count occurrences
    const occurrences = _split(item.content, params.old_str).length - 1;

    if(occurrences === 0) {
        throw new TextNotFoundError(params.path, params.old_str);
    }

    if(occurrences > 1) {
        throw new TextNotUniqueError(params.path, params.old_str, occurrences);
    }

    // Replace the text
    const newContent = _replace(item.content, params.old_str, params.new_str);

    await backend.update(memoryPath, { content: newContent });

    return `Text replaced in ${params.path}`;
}

/**
 * Renames a memory by creating a copy and deleting the original
 */
export async function rename(
    backend: MemoryToolBackend,
    params: { path: string, new_path: string }
): Promise<string> {
    const oldPath = validatePath(params.path);
    const newPath = validatePath(params.new_path);

    // Check source exists
    const sourceItem = await backend.get(oldPath);
    if(!sourceItem) {
        throw new PathNotFoundError(params.path);
    }

    // Check destination doesn't exist
    const destItem = await backend.get(newPath);
    if(destItem) {
        throw new PathAlreadyExistsError(params.new_path);
    }

    // Create new memory with same content
    await backend.create({
        path:        newPath,
        content:     sourceItem.content,
        contentType: sourceItem.contentType,
        metadata:    sourceItem.metadata,
        tags:        sourceItem.tags,
    });

    // Delete old memory
    try {
        await backend.delete(oldPath);
        return `Memory renamed from ${params.path} to ${params.new_path}`;
    } catch (error: unknown) {
        const errorMessage = _isError(error) ? error.message : String(error);
        logger.warn({ path: params.path, error: errorMessage, msg: `Failed to delete original memory at ${params.path} after rename: ${errorMessage}` });
        return `Memory renamed from ${params.path} to ${params.new_path} (warning: original file at ${params.path} could not be deleted)`;
    }
}

/**
 * Searches for memories based on tags, layer, and/or time range
 */
export async function search(
    backend: MemoryToolBackend,
    params: {
        tags?:       string[]
        layer?:      LayerName
        time_range?: { start: string, end: string }
        limit?:      number
    }
): Promise<string> {
    let items;

    if(params.tags && params.tags.length > 0) {
        // Tag-based search with optional layer filter
        const result = await backend.searchByTag(params.tags[0], params.layer, { limit: params.limit });
        items = result.items;

        // Apply AND logic for multiple tags
        // Stryker disable next-line ConditionalExpression,EqualityOperator: Equivalent mutant - changing > 1 to >= 1 makes remainingTags=[], and _every([]) is always true (no-op filter)
        if(params.tags.length > 1) {
            // Stryker disable next-line MethodExpression: Equivalent mutant - all items already have params.tags[0] from searchByTag, so including it in filter is redundant
            const remainingTags = params.tags.slice(1);
            items = _filter(items, item =>
                _every(remainingTags, tag => item.tags && _includes(item.tags, tag))
            );
        }
    } else if(params.time_range) {
        // Time range search with optional layer filter
        items = await backend.searchByTimeRange(
            params.time_range.start,
            params.time_range.end,
            params.layer,
            // Stryker disable next-line ObjectLiteral: { limit: undefined } is equivalent to {}
            { limit: params.limit }
        );
    } else if(params.layer) {
        // Layer-only search
        // Stryker disable next-line ObjectLiteral: { limit: undefined } is equivalent to {}
        const result = await backend.listByLayer(params.layer, { limit: params.limit });
        items = result.items;
    } else {
        // No search criteria provided
        logger.debug({ query: '', resultCount: 0, msg: 'Memory search: "" (0 results)' });
        return 'No results found';
    }

    const query = params.tags?.join(',') ?? params.layer ?? 'time_range';
    logger.debug({ query, resultCount: items.length, msg: `Memory search: "${query}" (${items.length} results)` });

    if(items.length === 0) {
        return 'No results found';
    }

    // Format results with 100-char previews and compact timestamps
    // Use contentPreview with fallback for migration period
    const formatted = _map(items, (item) => {
        const getPreviewFromContent = () => {
            if(!item.content) {
                return '[no content]';
            }
            return item.content.length > 100 ? `${item.content.slice(0, 100)}...` : item.content;
        };
        const getPreviewFromField = () => (item.contentPreview && item.contentPreview.length >= 100 ? `${item.contentPreview}...` : item.contentPreview);
        const preview = item.contentPreview ? getPreviewFromField() : getPreviewFromContent();
        const timestamp = formatShortRelativeTime(new Date(item.updatedAt));
        return `${item.path} (${timestamp})\n  ${preview}`;
    });

    return formatted.join('\n\n');
}

/**
 * Recalls auto-load items grouped by layer
 */
export async function recall(
    backend: MemoryToolBackend,
    params: {
        max_items?:      number
        include_layers?: LayerName[]
    }
): Promise<string> {
    const options = params.max_items
        ? {
            maxIdentityItems: params.max_items,
            maxStateItems:    params.max_items,
        }
        : undefined;

    const items = await backend.getAutoLoadItems(options);

    if(items.length === 0) {
        return 'No auto-load memories found';
    }

    // Group by layer
    const grouped = _groupBy(items, (item) => {
        const layer = extractLayerFromPath(item.path);
        return layer ?? 'other';
    });

    // Layer order: identity, state, events
    const layerOrder = ['identity', 'state', 'events', 'other'] as const;

    const sections: string[] = [];

    for(const layer of layerOrder) {
        const layerItems = grouped[layer];

        // Skip empty layers
        // Stryker disable next-line ConditionalExpression: layerItems.length === 0 vs false produces equivalent behavior since both skip the layer
        if(!layerItems || layerItems.length === 0) {
            continue;
        }

        // Skip if not in include_layers filter
        if(params.include_layers && layer !== 'other' && !_includes(params.include_layers, layer)) {
            continue;
        }

        const formatted = _map(layerItems, (item) => {
            return `  ${item.path}\n    ${item.content ?? '[no content]'}`;
        });

        sections.push(`${layer}:\n${formatted.join('\n')}`);
    }

    return sections.join('\n\n');
}

/**
 * Lists all memories in a specific layer
 */
export async function list_by_layer(
    backend: MemoryToolBackend,
    params: {
        layer:            LayerName
        include_content?: boolean
        limit?:           number
    }
): Promise<string> {
    const result = await backend.listByLayer(params.layer, { limit: params.limit });

    if(result.items.length === 0) {
        return `No items found in layer: ${params.layer}`;
    }

    const formatted = _map(result.items, (item) => {
        const timestamp = formatShortRelativeTime(new Date(item.updatedAt));
        const pathWithTimestamp = `${item.path} (${timestamp})`;
        if(params.include_content) {
            const contentWithLines = item.content ? formatLineNumbers(item.content) : '[no content]';
            return `${pathWithTimestamp}\n${contentWithLines}`;
        }
        return pathWithTimestamp;
    });

    return formatted.join('\n\n');
}

/**
 * Consolidates multiple memories into a single summary
 */
export async function consolidate(
    backend: MemoryToolBackend,
    params: {
        source_paths:  string[]
        target_path:   string
        summary:       string
        keep_sources?: boolean
    }
): Promise<string> {
    // Validate all paths
    const targetPath = validatePath(params.target_path);
    const sourcePaths = _map(params.source_paths, path => validatePath(path));

    // Check target doesn't exist
    const existing = await backend.get(targetPath);
    if(existing) {
        throw new PathAlreadyExistsError(params.target_path);
    }

    // Create summary at target
    const contentType = detectContentType(params.target_path);
    await backend.create({
        path:        targetPath,
        content:     params.summary,
        contentType: contentType,
    });

    // Delete sources if requested
    if(!params.keep_sources) {
        const failedDeletions: string[] = [];
        for(const sourcePath of sourcePaths) {
            try {
                await backend.delete(sourcePath);
            } catch (error: unknown) {
                failedDeletions.push(sourcePath);
                const errorMessage = _isError(error) ? error.message : String(error);
                logger.warn({ path: sourcePath, error: errorMessage, msg: `Failed to delete source ${sourcePath} during consolidation: ${errorMessage}` });
            }
        }

        if(failedDeletions.length > 0) {
            return `Memories consolidated into ${params.target_path}. WARNING: Failed to delete ${failedDeletions.length} source(s): ${failedDeletions.join(', ')}`;
        }
    }

    return `Memories consolidated into ${params.target_path}`;
}
