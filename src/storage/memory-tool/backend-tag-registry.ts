import { difference as _difference } from 'lodash';
import { logger } from '@hughescr/logger';
import type { MemoryPath, MemoryToolItemData, ContentType } from './types';
import { ConflictError } from '../errors';

/** Path where the tag registry is stored */
export const TAG_REGISTRY_PATH = '/state/tag-registry' as MemoryPath;

/** Maximum number of retries for tag registry operations */
const MAX_RETRIES = 3;

/** Shape of the tag registry content (JSON stored as string) */
export type TagRegistry = Record<string, number>;  // tag name -> count

/** Callbacks for registry operations to avoid circular dependencies */
export interface TagRegistryCallbacks {
    get:          (path: MemoryPath) => Promise<MemoryToolItemData | undefined>
    create:       (input: { path: MemoryPath, content: string, contentType: ContentType, metadata?: Record<string, unknown> }) => Promise<MemoryToolItemData>
    updateDirect: (path: MemoryPath, existing: MemoryToolItemData, input: { content: string }) => Promise<MemoryToolItemData>
}

/**
 * Parses tag registry content from JSON string.
 */
export function parseTagRegistry(content: string): TagRegistry {
    try {
        return JSON.parse(content) as TagRegistry;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Catch clause requires parameter
    } catch (_e: unknown) {
        return {};
    }
}

/**
 * Helper function to check if an error is a ConflictError.
 */
// Stryker disable all: ConditionalExpression mutant on line 39 (instanceof Object → true) causes TypeError that escapes catch block
function isConflictError(error: unknown): boolean {
    return error instanceof ConflictError
      || (error !== null

        && error instanceof Object
        && 'name' in error
        && error.name === 'ConflictError');
}
// Stryker restore all

/**
 * Computes tag changes between old and new tag arrays.
 *
 * @returns Object with `added` and `removed` tag arrays
 */
export function computeTagChanges(
    oldTags: string[] | undefined,
    newTags: string[] | undefined
): { added: string[], removed: string[] } {
    const old = oldTags ?? [];
    const updated = newTags ?? [];

    return {
        added:   _difference(updated, old),
        removed: _difference(old, updated),
    };
}

/**
 * Updates the tag registry with new tag counts.
 * Uses atomic read-modify-write pattern with retry on ConflictError.
 *
 * @param tags - Tags to increment counts for
 * @param callbacks - Backend callbacks for get/create/update
 */
export async function updateTagRegistry(
    tags: string[],
    callbacks: TagRegistryCallbacks
): Promise<void> {
    if(tags.length === 0) {
        return;
    }

    // Stryker disable next-line UpdateOperator: attempt++ → attempt-- creates infinite loop (timeout expected)
    for(let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const existing = await callbacks.get(TAG_REGISTRY_PATH);

            if(!existing) {
                // Create new registry with initial counts
                const registry: TagRegistry = {};
                for(const tag of tags) {
                    registry[tag] = 1;
                }
                await callbacks.create({
                    path:        TAG_REGISTRY_PATH,
                    content:     JSON.stringify(registry),
                    contentType: 'application/json',
                    metadata:    { type: 'tag-registry' },
                });
                return; // Success
            }

            // Update existing registry
            const registry = parseTagRegistry(existing.content);
            for(const tag of tags) {
                registry[tag] = (registry[tag] ?? 0) + 1;
            }
            await callbacks.updateDirect(TAG_REGISTRY_PATH, existing, {
                content: JSON.stringify(registry),
            });
            return; // Success
        } catch (error) {
            // Check if it's a ConflictError (version mismatch)
            if(isConflictError(error) && attempt < MAX_RETRIES) {
                logger.debug({ attempt, tags, msg: 'Tag registry conflict, retrying' });
                continue; // Retry with fresh data
            }

            // Either not a conflict error, or we've exhausted retries
            logger.warn({ error, tags, attempt, msg: 'Failed to update tag registry' });
            return;
        }
    }
}

/**
 * Decrements tag counts in the registry.
 * Removes tags that reach zero.
 * Uses retry on ConflictError.
 *
 * @param tags - Tags to decrement counts for
 * @param callbacks - Backend callbacks for get/update
 */
export async function decrementTagRegistry(
    tags: string[],
    callbacks: TagRegistryCallbacks
): Promise<void> {
    if(tags.length === 0) {
        return;
    }

    // Stryker disable next-line UpdateOperator: attempt++ → attempt-- creates infinite loop (timeout expected)
    for(let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const existing = await callbacks.get(TAG_REGISTRY_PATH);
            if(!existing) {
                return; // No registry to decrement
            }

            const registry = parseTagRegistry(existing.content);
            let modified = false;

            for(const tag of tags) {
                if(registry[tag] !== undefined) {
                    registry[tag]--;
                    modified = true;
                    if(registry[tag] <= 0) {
                        delete registry[tag];
                    }
                }
            }

            if(modified) {
                await callbacks.updateDirect(TAG_REGISTRY_PATH, existing, {
                    content: JSON.stringify(registry),
                });
            }
            return; // Success
        } catch (error) {
            // Check if it's a ConflictError (version mismatch)
            // Stryker disable next-line EqualityOperator,ConditionalExpression: Retry boundary tested via behavior
            if(isConflictError(error) && attempt < MAX_RETRIES) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability only
                logger.debug({ attempt, tags, msg: 'Tag registry conflict, retrying' });
                continue; // Retry with fresh data
            }

            // Either not a conflict error, or we've exhausted retries
            logger.warn({ error, tags, attempt, msg: 'Failed to decrement tag registry' });
            return;
        }
    }
}
