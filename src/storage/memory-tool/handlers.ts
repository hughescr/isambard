/**
 * Memory Tool Handlers
 *
 * High-level handler functions for memory tool operations.
 * Provides a thin coordination layer over the backend CRUD operations.
 */

import { ZodError } from 'zod';
import { split as _split, map as _map, endsWith as _endsWith, replace as _replace, isError as _isError } from 'lodash';
import { memoryPathSchema, type MemoryPath, type ContentType } from './types';
import type { MemoryToolBackend } from './backend';
import {
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    TextNotFoundError,
    TextNotUniqueError,
    InvalidLineNumberError
} from './errors';

/**
 * Validates and converts a string path to a MemoryPath
 * @throws InvalidPathError if path is invalid
 */
function validatePath(path: string): MemoryPath {
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
function formatLineNumbers(content: string, range?: [number, number]): string {
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
function detectContentType(path: string): ContentType {
    if(_endsWith(path, '.md')) {
        return 'text/markdown';
    }
    if(_endsWith(path, '.json')) {
        return 'application/json';
    }
    return 'text/plain';
}

/**
 * Creates a new memory at the specified path
 */
export async function create(
    backend: MemoryToolBackend,
    params: { path: string, file_text: string }
): Promise<string> {
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
    const memoryPath = validatePath(params.path);

    // Try to get as a file first
    const item = await backend.get(memoryPath);

    if(item) {
        // It's a file - return formatted content
        return formatLineNumbers(item.content, params.view_range);
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
        for(const item of listResult.items) {
            try {
                await backend.delete(item.path);
                deleteCount++;
            } catch (error: unknown) {
                const errorMessage = _isError(error) ? error.message : String(error);
                // eslint-disable-next-line no-console -- Logging deletion failures
                console.warn(`Failed to delete ${item.path}: ${errorMessage}`);
            }
        }
        return `Recursively deleted ${deleteCount} memories under ${params.path}`;
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
    const memoryPath = validatePath(params.path);

    const item = await backend.get(memoryPath);
    if(!item) {
        throw new PathNotFoundError(params.path);
    }

    const lines = _split(item.content, '\n');

    // Validate line number (0-indexed insertion, so valid range is 0 to lines.length)
    if(params.insert_line < 0 || params.insert_line > lines.length) {
        throw new InvalidLineNumberError(params.path, params.insert_line, lines.length);
    }

    // Insert the new text
    lines.splice(params.insert_line, 0, params.insert_text);
    const newContent = lines.join('\n');

    await backend.update(memoryPath, { content: newContent });

    return `Text inserted at line ${params.insert_line} in ${params.path}`;
}

/**
 * Replaces text in a memory (must be unique occurrence)
 */
export async function str_replace(
    backend: MemoryToolBackend,
    params: { path: string, old_str: string, new_str: string }
): Promise<string> {
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
        // eslint-disable-next-line no-console -- Logging rename cleanup failures
        console.warn(`Failed to delete original memory at ${params.path} after rename: ${errorMessage}`);
    }

    return `Memory renamed from ${params.path} to ${params.new_path}`;
}
