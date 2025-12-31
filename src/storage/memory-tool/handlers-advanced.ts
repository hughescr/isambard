/**
 * Memory Tool Advanced Handlers
 *
 * Advanced handler functions for memory tool operations:
 * str_replace, rename, search, recall, list_by_layer, consolidate.
 */

import { logger } from '@hughescr/logger';
import {
    split as _split,
    map as _map,
    replace as _replace,
    isError as _isError,
    filter as _filter,
    every as _every,
    includes as _includes,
    groupBy as _groupBy
} from 'lodash';
import { type LayerName, extractLayerFromPath } from './types';
import type { MemoryToolBackend } from './backend';
import {
    PathNotFoundError,
    PathAlreadyExistsError,
    TextNotFoundError,
    TextNotUniqueError
} from './errors';
import { formatShortRelativeTime } from '@/utils/time';
import { validatePath, formatLineNumbers, detectContentType } from './handlers-basic';

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
    } catch (error: unknown) {
        const errorMessage = _isError(error) ? error.message : String(error);
        logger.warn({ path: params.path, error: errorMessage, msg: `Failed to delete original memory at ${params.path} after rename: ${errorMessage}` });
    }

    return `Memory renamed from ${params.path} to ${params.new_path}`;
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
        // Stryker disable next-line ConditionalExpression,EqualityOperator: Testing params.tags.length > 1 vs >= 1 requires implementation-specific behavior
        if(params.tags.length > 1) {
            // Stryker disable next-line MethodExpression: params.tags.slice(1) vs params.tags produces functionally equivalent behavior for length > 1
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
    const formatted = _map(items, (item) => {
        const preview = item.content.length > 100
            ? `${item.content.slice(0, 100)}...`
            : item.content;
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
            return `  ${item.path}\n    ${item.content}`;
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
            const contentWithLines = formatLineNumbers(item.content);
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
        for(const sourcePath of sourcePaths) {
            try {
                await backend.delete(sourcePath);
            } catch (error: unknown) {
                const errorMessage = _isError(error) ? error.message : String(error);
                logger.warn({ path: sourcePath, error: errorMessage, msg: `Failed to delete source ${sourcePath} during consolidation: ${errorMessage}` });
            }
        }
    }

    return `Memories consolidated into ${params.target_path}`;
}
