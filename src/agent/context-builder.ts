/**
 * Context Builder
 *
 * Builds system context from memory backend for Claude agent auto-loading.
 * Formats identity and state layer memories into a structured context string.
 */

import { map as _map, groupBy as _groupBy, isNumber as _isNumber } from 'lodash';
import type { MemoryToolBackend } from '../storage/memory-tool/backend';
import type { MemoryPath, LayerName } from '../storage/memory-tool/types';
import { extractLayerFromPath } from '../storage/memory-tool/types';

export interface ContextBuilderOptions {
    backend:            MemoryToolBackend
    maxIdentityTokens?: number   // Default: 500
    maxStateTokens?:    number   // Default: 300
}

export interface ContextBuilder {
    /**
     * Build system context from memories (identity + hot state)
     * @returns Formatted context string ready for inclusion in system prompt
     */
    buildSystemContext: () => Promise<string>

    /**
     * Load core identity (permanent, essential memories)
     * @returns Formatted identity string for system prompt
     */
    loadCoreIdentity: () => Promise<string>

    /**
     * Load recent context for a specific user
     * @param userId User ID to load context for
     * @param limit Maximum number of recent memories to load
     * @returns Array of recent memory texts
     */
    loadRecentContext: (userId: string, limit?: number) => Promise<string[]>

    /**
     * Update access stats when memories are used
     * @param paths Memory paths that were accessed
     */
    recordAccess: (paths: MemoryPath[]) => Promise<void>

    /**
     * Load recent events from the timeline
     * @param limit Maximum number of events to load
     * @returns Array of recent event summaries
     */
    loadRecentEvents: (limit?: number) => Promise<string[]>
}

const DEFAULT_MAX_IDENTITY_TOKENS = 500;
const DEFAULT_MAX_STATE_TOKENS = 300;
const CHARS_PER_TOKEN = 4;

/**
 * Creates a context builder for managing agent memory context
 */
export function createContextBuilder(options: ContextBuilderOptions): ContextBuilder {
    const { backend } = options;
    const maxIdentityTokens = options.maxIdentityTokens ?? DEFAULT_MAX_IDENTITY_TOKENS;
    const maxStateTokens = options.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS;

    const maxIdentityChars = maxIdentityTokens * CHARS_PER_TOKEN;
    const maxStateChars = maxStateTokens * CHARS_PER_TOKEN;

    return {
        loadCoreIdentity: async (): Promise<string> => {
            // Load identity layer items (permanent, auto-loaded)
            const result = await backend.listByLayer('identity' as LayerName);

            // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant - empty array join returns ''
            if(result.items.length === 0) {
                return '';
            }

            // Format and truncate if needed
            const content = _map(result.items, 'content').join('\n\n');
            if(content.length > maxIdentityChars) {
                return content.slice(0, maxIdentityChars - 3) + '...';
            }
            return content;
        },

        loadRecentContext: async (userId: string, limit = 3): Promise<string[]> => {
            // Load recent state/events for this user via tag search
            const result = await backend.searchByTag(`user:${userId}`, undefined, { limit });

            // Return in reverse chronological order (most recent first)
            return _map(result.items, 'content');
        },

        buildSystemContext: async (): Promise<string> => {
            // Get auto-load items from backend
            const items = await backend.getAutoLoadItems();

            if(items.length === 0) {
                return '=== MEMORY CONTEXT ===\n\n(No memories loaded)';
            }

            // Group items by layer
            const grouped = _groupBy(items, (item) => {
                const layer = extractLayerFromPath(item.path);
                // Stryker disable next-line StringLiteral: 'other' vs "" are equivalent since neither is rendered
                return layer ?? 'other';
            });

            const sections: string[] = ['=== MEMORY CONTEXT ===\n'];

            // Format identity layer
            // Stryker disable next-line ConditionalExpression,EqualityOperator: lodash groupBy never creates empty arrays
            if(grouped.identity && grouped.identity.length > 0) {
                sections.push('## Identity');

                const identityContent = _map(
                    grouped.identity,
                    item => `${item.path}:\n${item.content}`
                ).join('\n\n');

                // Truncate if necessary
                if(identityContent.length > maxIdentityChars) {
                    sections.push(identityContent.slice(0, maxIdentityChars - 3) + '...');
                } else {
                    sections.push(identityContent);
                }
            }

            // Format state layer as "Current State"
            // Stryker disable next-line ConditionalExpression,EqualityOperator: lodash groupBy never creates empty arrays
            if(grouped.state && grouped.state.length > 0) {
                sections.push('## Current State');

                const stateContent = _map(
                    grouped.state,
                    item => `${item.path}:\n${item.content}`
                ).join('\n\n');

                // Truncate if necessary
                if(stateContent.length > maxStateChars) {
                    sections.push(stateContent.slice(0, maxStateChars - 3) + '...');
                } else {
                    sections.push(stateContent);
                }
            }

            return sections.join('\n\n');
        },

        recordAccess: async (paths: MemoryPath[]): Promise<void> => {
            for(const path of paths) {
                // Get current item
                const item = await backend.get(path);

                if(!item) {
                    // Skip if item doesn't exist
                    continue;
                }

                // Get current access count from metadata
                // Stryker disable next-line OptionalChaining: metadata always exists per schema, ?. is defensive
                const currentAccessCount = _isNumber(item.metadata?.accessCount)
                    ? item.metadata.accessCount
                    : 0;

                // Update metadata with incremented access count and timestamp
                await backend.update(path, {
                    metadata: {
                        ...item.metadata,
                        accessCount:  currentAccessCount + 1,
                        lastAccessed: new Date().toISOString(),
                    },
                });
            }
        },

        loadRecentEvents: async (limit = 5): Promise<string[]> => {
            // Load recent events by time range (last 24 hours)
            const now = new Date();
            const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const result = await backend.searchByTimeRange(
                dayAgo.toISOString(),
                now.toISOString(),
                'events' as LayerName,
                { limit }
            );
            return _map(result, 'content');
        },
    };
}
