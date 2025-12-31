/**
 * Memory Tool Basic Handlers
 *
 * Basic handler functions for memory tool operations: create, view, delete, insert.
 * Also exports utility functions used by both basic and advanced handlers.
 */

import { logger } from '@hughescr/logger';
import { ZodError } from 'zod';
import {
    split as _split,
    map as _map,
    endsWith as _endsWith,
    isError as _isError
} from 'lodash';
import { memoryPathSchema, type MemoryPath, type ContentType } from './types';
import type { MemoryToolBackend } from './backend';
import {
    PathNotFoundError,
    InvalidPathError,
    InvalidLineNumberError
} from './errors';
import { formatMemoryTimestamp } from '@/utils/time';

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
        for(const item of listResult.items) {
            try {
                await backend.delete(item.path);
                deleteCount++;
            } catch (error: unknown) {
                const errorMessage = _isError(error) ? error.message : String(error);
                logger.warn({ path: item.path, error: errorMessage, msg: `Failed to delete ${item.path}: ${errorMessage}` });
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
    const { path } = params;
    logger.debug({ path, msg: `Memory insert: ${path}` });
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
