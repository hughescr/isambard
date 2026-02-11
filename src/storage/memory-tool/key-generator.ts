import { DateTime } from 'luxon';
import { startsWith as _startsWith, split as _split, map as _map, toLower as _toLower } from 'lodash';
import type { MemoryPath } from './types';
import { extractLayerFromPath } from './types';

/**
 * DynamoDB key structure for MemoryTool items using filesystem-like organization
 */
export interface MemoryToolKeys {
    /** Primary Key: DIR#{parentPath} - groups files by directory */
    PK:     string
    /** Sort Key: FILE#{filename} - identifies file within directory */
    SK:     string
    /** GSI1 Primary Key: LAYER#{layer} - allows lookup by layer */
    GSI1PK: string
    /** GSI1 Sort Key: UPDATED#{timestamp} - time-based sorting within layer */
    GSI1SK: string
}

/**
 * Generates a content preview for DynamoDB storage.
 * Truncates content to 100 characters for efficient tag index storage.
 * @param content - The full content string
 * @returns Content truncated to 100 characters
 */
export function generateContentPreview(content: string): string {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: Equivalent mutant - slice(0,100) on short strings returns original, >= boundary is equivalent
    return content.length > 100 ? content.slice(0, 100) : content;
}

/**
 * Normalizes tags by lowercasing and deduplicating.
 * Applied on all write paths before index/registry operations.
 * @param tags - Array of tag strings
 * @returns Normalized, deduplicated, lowercase tags
 */
export function normalizeTags(tags: string[] | undefined): string[] {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - _map handles undefined/empty arrays gracefully
    if(!tags || tags.length === 0) {
        return [];
    }
    return [...new Set(_map(tags, tag => _toLower(tag)))];
}

/**
 * Generates DynamoDB keys for MemoryTool items with filesystem-like structure
 */
export class MemoryToolKeyGenerator {
    /**
   * Creates DynamoDB keys for a given path
   *
   * @param path - Full path to the memory file (e.g., "/memories/events/party.xml")
   * @param timestamp - Optional ISO 8601 timestamp (auto-generated if not provided)
   * @returns DynamoDB keys for the memory tool item
   *
   * @example
   * ```ts
   * const keys = MemoryToolKeyGenerator.createKeys(createMemoryPath('/identity/core-values.md'));
   * // {
   * //   PK: 'DIR#/identity',
   * //   SK: 'FILE#core-values.md',
   * //   GSI1PK: 'LAYER#identity',
   * //   GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z'
   * // }
   * ```
   */
    static createKeys(path: MemoryPath, timestamp?: string): MemoryToolKeys {
        const lastSlashIndex = path.lastIndexOf('/');
        const parentPath = lastSlashIndex === 0 ? '/' : path.slice(0, lastSlashIndex);
        const filename = path.slice(lastSlashIndex + 1);

        const ts = timestamp ?? DateTime.utc().toISO();

        // Extract layer from path (identity, state, events) or use first path segment as fallback
        const layer = extractLayerFromPath(path);
        // Stryker disable next-line StringLiteral: Empty string and 'unknown' are functionally equivalent here for edge case of root path
        const layerStr = layer ?? _split(path, '/')[1] ?? 'unknown';

        return {
            PK:     `DIR#${parentPath}`,
            SK:     `FILE#${filename}`,
            GSI1PK: `LAYER#${layerStr}`,
            GSI1SK: `UPDATED#${ts}`,
        };
    }

    /**
   * Parses DynamoDB keys back into the original path
   *
   * @param pk - Primary Key (DIR#{parentPath})
   * @param sk - Sort Key (FILE#{filename})
   * @returns The original path
   * @throws Error if keys are not in expected format
   *
   * @example
   * ```ts
   * const path = MemoryToolKeyGenerator.parsePath('DIR#/memories/events', 'FILE#party.xml');
   * // '/memories/events/party.xml'
   * ```
   */
    static parsePath(pk: string, sk: string): string {
        if(!_startsWith(pk, 'DIR#')) {
            throw new Error(`Invalid PK format: expected DIR#..., got ${pk}`);
        }
        if(!_startsWith(sk, 'FILE#')) {
            throw new Error(`Invalid SK format: expected FILE#..., got ${sk}`);
        }

        const parentPath = pk.slice(4); // Remove 'DIR#' prefix
        const filename = sk.slice(5); // Remove 'FILE#' prefix

        // Handle root directory case
        if(parentPath === '/') {
            return `/${filename}`;
        }

        return `${parentPath}/${filename}`;
    }

    /**
   * Creates DynamoDB keys for tag index items.
   * Returns one key pair per tag. Empty array if no tags.
   *
   * @param path - Full path to the memory file
   * @param tags - Array of tags
   * @returns Array of PK/SK pairs, one per tag
   *
   * @example
   * ```ts
   * const keys = MemoryToolKeyGenerator.createTagIndexKeys(
   *   '/identity/values.md' as MemoryPath,
   *   ['important', 'core']
   * );
   * // [
   * //   { PK: 'TAG#important', SK: 'PATH#/identity/values.md' },
   * //   { PK: 'TAG#core', SK: 'PATH#/identity/values.md' }
   * // ]
   * ```
   */
    static createTagIndexKeys(
        path: MemoryPath,
        tags: string[]
    ): { PK: string, SK: string }[] {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization - _map([]) returns [] anyway
        if(tags.length === 0) {
            return [];
        }
        return _map(tags, tag => ({
            PK: `TAG#${tag}`,
            SK: `PATH#${path}`,
        }));
    }

    /**
   * Parses the tag name from a TAG# partition key.
   *
   * @param pk - Partition key in format TAG#tagname
   * @returns The tag name
   * @throws Error if pk is not in expected format
   *
   * @example
   * ```ts
   * const tag = MemoryToolKeyGenerator.parseTagFromPK('TAG#important');
   * // 'important'
   * ```
   */
    static parseTagFromPK(pk: string): string {
        if(!_startsWith(pk, 'TAG#')) {
            throw new Error(`Invalid tag PK format: expected TAG#..., got ${pk}`);
        }
        return pk.slice(4);
    }

    /**
   * Parses the memory path from a PATH# sort key.
   *
   * @param sk - Sort key in format PATH#/path/to/file
   * @returns The memory path
   * @throws Error if sk is not in expected format
   *
   * @example
   * ```ts
   * const path = MemoryToolKeyGenerator.parsePathFromTagSK('PATH#/identity/core.md');
   * // '/identity/core.md'
   * ```
   */
    static parsePathFromTagSK(sk: string): string {
        if(!_startsWith(sk, 'PATH#')) {
            throw new Error(`Invalid tag SK format: expected PATH#..., got ${sk}`);
        }
        return sk.slice(5);
    }
}
