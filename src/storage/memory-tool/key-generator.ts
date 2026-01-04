import { startsWith as _startsWith, split as _split } from 'lodash';
import type { MemoryPath } from './types';
import { extractLayerFromPath } from './types';

/**
 * DynamoDB key structure for MemoryTool items using filesystem-like organization
 */
export interface MemoryToolKeys {
    /** Primary Key: DIR#{parentPath} - groups files by directory */
    PK:      string
    /** Sort Key: FILE#{filename} - identifies file within directory */
    SK:      string
    /** GSI1 Primary Key: LAYER#{layer} - allows lookup by layer */
    GSI1PK:  string
    /** GSI1 Sort Key: UPDATED#{timestamp} - time-based sorting within layer */
    GSI1SK:  string
    /** GSI2 Primary Key: TAG#{tag} - allows lookup by tag (optional) */
    GSI2PK?: string
    /** GSI2 Sort Key: LAYER#{layer}#UPDATED#{timestamp} - tag queries with layer and time filtering (optional) */
    GSI2SK?: string
}

/**
 * Generates a content preview for DynamoDB storage.
 * Truncates content to 100 characters for efficient GSI2 projection.
 * @param content - The full content string
 * @returns Content truncated to 100 characters
 */
export function generateContentPreview(content: string): string {
    // Stryker disable next-line ConditionalExpression: Equivalent mutant - slice(0,100) on short strings returns original
    return content.length > 100 ? content.slice(0, 100) : content;
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
   * const keys = MemoryToolKeyGenerator.createKeys('/identity/core-values.md' as MemoryPath);
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

        const ts = timestamp ?? new Date().toISOString();

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
   * Creates optional GSI2 keys for tag-based queries
   *
   * @param path - Full path to the memory file (for extracting layer)
   * @param tags - Optional array of tags (uses first tag only)
   * @param timestamp - Optional ISO 8601 timestamp (auto-generated if not provided)
   * @returns GSI2 keys if tags are present, null otherwise
   *
   * @example
   * ```ts
   * const tagKeys = MemoryToolKeyGenerator.createTagKeys(
   *   '/identity/core-values.md' as MemoryPath,
   *   ['beliefs', 'philosophy'],
   *   '2024-01-15T10:30:00.000Z'
   * );
   * // {
   * //   GSI2PK: 'TAG#beliefs',
   * //   GSI2SK: 'LAYER#identity#UPDATED#2024-01-15T10:30:00.000Z'
   * // }
   * ```
   */
    static createTagKeys(
        path: MemoryPath,
        tags?: string[],
        timestamp?: string
    ): Pick<MemoryToolKeys, 'GSI2PK' | 'GSI2SK'> | null {
        // Return null if no tags provided
        if(!tags || tags.length === 0) {
            return null;
        }

        // Use first tag only
        const tag = tags[0];
        const ts = timestamp ?? new Date().toISOString();

        // Extract layer from path (or use first path segment as fallback)
        const layer = extractLayerFromPath(path);
        // Stryker disable next-line StringLiteral: Empty string and 'unknown' are functionally equivalent here for edge case of root path
        const layerStr = layer ?? _split(path, '/')[1] ?? 'unknown';

        return {
            GSI2PK: `TAG#${tag}`,
            GSI2SK: `LAYER#${layerStr}#UPDATED#${ts}`,
        };
    }

    /**
   * Creates DynamoDB keys for version history items
   *
   * @param path - Full path to the memory file
   * @param version - Version number of the snapshot
   * @param timestamp - ISO 8601 timestamp when version was created
   * @returns DynamoDB keys for the version history item
   *
   * @example
   * ```ts
   * const keys = MemoryToolKeyGenerator.createVersionKeys(
   *   '/test/file.md' as MemoryPath,
   *   2,
   *   '2024-01-15T10:30:00.000Z'
   * );
   * // {
   * //   PK: 'DIR#/test',
   * //   SK: 'VERSION#2#2024-01-15T10:30:00.000Z'
   * // }
   * ```
   */
    static createVersionKeys(path: MemoryPath, version: number, timestamp: string): { PK: string, SK: string } {
        const lastSlashIndex = path.lastIndexOf('/');
        const parentPath = lastSlashIndex === 0 ? '/' : path.slice(0, lastSlashIndex);

        return {
            PK: `DIR#${parentPath}`,
            SK: `VERSION#${version}#${timestamp}`,
        };
    }
}
