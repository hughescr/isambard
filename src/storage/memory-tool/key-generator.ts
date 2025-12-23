import { startsWith as _startsWith } from 'lodash';
import type { MemoryPath } from './types';

/**
 * DynamoDB key structure for MemoryTool items using filesystem-like organization
 */
export interface MemoryToolKeys {
    /** Primary Key: DIR#{parentPath} - groups files by directory */
    PK:     string
    /** Sort Key: FILE#{filename} - identifies file within directory */
    SK:     string
    /** GSI1 Primary Key: PATH#{fullPath} - allows lookup by full path */
    GSI1PK: string
    /** GSI1 Sort Key: CREATED#{timestamp} - time-based sorting */
    GSI1SK: string
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
   * const keys = MemoryToolKeyGenerator.createKeys('/memories/events/party.xml' as MemoryPath);
   * // {
   * //   PK: 'DIR#/memories/events',
   * //   SK: 'FILE#party.xml',
   * //   GSI1PK: 'PATH#/memories/events/party.xml',
   * //   GSI1SK: 'CREATED#2024-01-15T10:30:00.000Z'
   * // }
   * ```
   */
    static createKeys(path: MemoryPath, timestamp?: string): MemoryToolKeys {
        const lastSlashIndex = path.lastIndexOf('/');
        const parentPath = lastSlashIndex === 0 ? '/' : path.slice(0, lastSlashIndex);
        const filename = path.slice(lastSlashIndex + 1);

        const ts = timestamp ?? new Date().toISOString();

        return {
            PK:     `DIR#${parentPath}`,
            SK:     `FILE#${filename}`,
            GSI1PK: `PATH#${path}`,
            GSI1SK: `CREATED#${ts}`,
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
}
