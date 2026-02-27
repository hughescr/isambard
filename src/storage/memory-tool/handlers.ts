/**
 * Memory Tool Handlers
 *
 * Handler functions for memory tool operations.
 */

import { logger } from '@hughescr/logger';
import _endsWith from 'lodash/endsWith';
import _groupBy from 'lodash/groupBy';
import _includes from 'lodash/includes';
import _isError from 'lodash/isError';
import _map from 'lodash/map';
import _replace from 'lodash/replace';
import _split from 'lodash/split';
import { ZodError } from 'zod';
import type { MemoryToolBackend } from './backend';
import {
    memoryPathSchema,
    type MemoryPath,
    type ContentType,
    type LayerName,
    extractLayerFromPath
} from './types';
import {
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    InvalidLineNumberError,
    TextNotFoundError,
    TextNotUniqueError
} from '@/errors';
import { formatShortRelativeTime } from '@/utils';

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
 */
export function formatLineNumbers(content: string): string {
    const lines = _split(content, '\n');
    return _map(lines, (line, index) => `${index + 1}:${line}`).join('\n');
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
        path:    memoryPath,
        content: params.file_text,
        contentType,
    });

    return `Memory successfully created at ${params.path}`;
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
        metadata:    {
            ...sourceItem.metadata,
            previouslyKnownAs:     params.path,
            previouslyKnownAsTags: sourceItem.tags ? [...sourceItem.tags] : [],
        },
        tags: sourceItem.tags,
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
        // Tag-based search with optional layer filter — uses tag index
        const result = await backend.searchByTags(new Set(params.tags), params.layer, { limit: params.limit });
        // Tag index items have preview data directly — format from TagIndexItem fields
        const query = params.tags.join(',');
        logger.debug({ query, resultCount: result.items.length, msg: `Memory search: "${query}" (${result.items.length} results)` });

        if(result.items.length === 0) {
            return 'No results found';
        }

        const formatted = _map(result.items, (item) => {
            const preview = item.contentPreview.length > 100 ? `${item.contentPreview.slice(0, 100)}...` : item.contentPreview;
            const timestamp = formatShortRelativeTime(new Date(item.updatedAt));
            return `${item.memoryPath} (${timestamp})\n  ${preview}`;
        });

        return formatted.join('\n\n');
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

    const query = params.layer ?? 'time_range';
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
            // Stryker disable next-line EqualityOperator: Boundary difference for 100-char content cutoff is cosmetic
            return item.content.length > 100 ? `${item.content.slice(0, 100)}...` : item.content;
        };
        // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: Preview truncation indicator is cosmetic formatting
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
    const grouped = _groupBy(items, (item): string => {
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
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Record indexing typed as always defined but may be undefined for missing keys
        if(!layerItems || layerItems.length === 0) {
            continue;
        }

        // Skip if not in include_layers filter
        if(params.include_layers && layer !== 'other' && !_includes(params.include_layers, layer)) {
            continue;
        }

        const formatted = _map(layerItems, (item) => {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: content may be absent at runtime despite types
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
        path:    targetPath,
        content: params.summary,
        contentType,
    });

    // Delete sources if requested
    if(!params.keep_sources) {
        const failedDeletions: string[] = [];
        for(const sourcePath of sourcePaths) {
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential: best-effort DynamoDB delete per source path
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
