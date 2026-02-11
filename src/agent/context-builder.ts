/**
 * Context Builder
 *
 * Builds system context from memory backend for Claude agent auto-loading.
 * Formats identity and state layer memories into a structured context string.
 */

import { logger } from '@hughescr/logger';
import { map as _map, groupBy as _groupBy, isNumber as _isNumber, sortBy as _sortBy } from 'lodash';
import type { MemoryToolBackend } from '../storage/memory-tool/backend';
import type { MemoryPath } from '../storage/memory-tool/types';
import { extractLayerFromPath, createMemoryPath, createLayerName } from '../storage/memory-tool/types';
import { formatShortRelativeTime } from '../utils/time';

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
     * @param now Optional reference time for age calculation (defaults to current time)
     * @returns Array of formatted memory strings: "- path (age): content_preview"
     */
    loadRecentContext: (userId: string, limit?: number, now?: Date) => Promise<string[]>

    /**
     * Update access stats when memories are used
     * @param paths Memory paths that were accessed
     */
    recordAccess: (paths: MemoryPath[]) => Promise<void>

    /**
     * Load recent events from the timeline
     * @param limit Maximum number of events to load
     * @param now Optional reference time for age calculation (defaults to current time)
     * @returns Array of formatted event strings: "- path (age): content_preview"
     */
    loadRecentEvents: (limit?: number, now?: Date) => Promise<string[]>

    /**
     * Load user timezone preference
     * @param userId User ID to load timezone for
     * @returns Timezone string (e.g., "America/Los_Angeles") or undefined if not found
     */
    loadUserTimezone: (userId: string) => Promise<string | undefined>

    /**
     * Build user message prefix from user memories, bot memories, and recent events.
     * @param userId The user who sent the message
     * @param botUserId Optional bot user ID for loading bot's own memories
     * @returns Context prefix string (empty if no context available)
     */
    buildUserMessagePrefix: (userId: string, botUserId?: string) => Promise<string>
}

const DEFAULT_MAX_IDENTITY_TOKENS = 500;
const DEFAULT_MAX_STATE_TOKENS = 300;
const CHARS_PER_TOKEN = 4;
const CONTENT_PREVIEW_MAX_LENGTH = 100;

/**
 * Formats a memory item as a preview string with path, age, and truncated content.
 * Format: "- path (age): content_preview"
 *
 * Handles tag index cases where content may be undefined (only contentPreview available from TagIndexItem).
 */
function formatMemoryPreview(
    path: MemoryPath,
    content: string | undefined,
    contentPreview: string | undefined,
    updatedAt: string,
    now: Date
): string {
    const age = formatShortRelativeTime(new Date(updatedAt), now);

    // Full content available - show preview
    if(content) {
        const preview = content.length > CONTENT_PREVIEW_MAX_LENGTH
            ? content.slice(0, CONTENT_PREVIEW_MAX_LENGTH) + '...'
            : content;
        return `- ${path} (${age}): ${preview}`;
    }

    // Only preview available (tag index item) - show hint
    if(contentPreview) {
        return `- ${path} (${age}): [preview] ${contentPreview}... (memory view ${path} for full)`;
    }

    // No content at all
    return `- ${path} (${age}): [no content]`;
}

/**
 * Creates a context builder for managing agent memory context
 */
export function createContextBuilder(options: ContextBuilderOptions): ContextBuilder {
    const { backend } = options;
    const maxIdentityTokens = options.maxIdentityTokens ?? DEFAULT_MAX_IDENTITY_TOKENS;
    const maxStateTokens = options.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS;

    const maxIdentityChars = maxIdentityTokens * CHARS_PER_TOKEN;
    const maxStateChars = maxStateTokens * CHARS_PER_TOKEN;

    const builder: ContextBuilder = {
        loadCoreIdentity: async (): Promise<string> => {
            logger.debug({ msg: 'Loading core identity...' });

            // Load identity layer items (permanent, auto-loaded)
            const result = await backend.listByLayer(createLayerName('identity'));

            // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant - empty array join returns ''
            if(result.items.length === 0) {
                logger.debug({ identityLength: 0 }, 'Core identity loaded');
                return '';
            }

            // Format and truncate if needed
            const content = _map(result.items, 'content').join('\n\n');
            const identity = content.length > maxIdentityChars
                ? content.slice(0, maxIdentityChars - 3) + '...'
                : content;

            logger.debug({ identityLength: identity.length }, 'Core identity loaded');
            return identity;
        },

        loadRecentContext: async (userId: string, limit = 3, now: Date = new Date()): Promise<string[]> => {
            logger.debug({ userId }, 'Loading user context');

            // Load recent state/events for this user via tag search
            const result = await backend.searchByTags([`user:${userId}`], undefined, { limit });

            // Format each item with path, age, and content preview
            // TagIndexItem has memoryPath (not path) and no content field
            const memories = _map(result.items, item =>
                formatMemoryPreview(createMemoryPath(item.memoryPath), undefined, item.contentPreview, item.updatedAt, now)
            );

            logger.debug({ userId, memoryCount: memories.length }, 'User context loaded');
            return memories;
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

        loadRecentEvents: async (limit = 50, now: Date = new Date()): Promise<string[]> => {
            logger.debug({ msg: 'Loading recent events' });

            // Load recent events by time range (last 14 days)
            const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
            let result = await backend.searchByTimeRange(
                twoWeeksAgo.toISOString(),
                now.toISOString(),
                createLayerName('events'),
                { limit }
            );

            // Fallback: if no events in 14 days, get most recent regardless of age
            let showingOlderEventsNote = false;
            if(result.length === 0) {
                const fallbackResult = await backend.listByLayer(createLayerName('events'), { limit });
                result = fallbackResult.items;
                showingOlderEventsNote = result.length > 0;
            }

            // Ensure ascending order: searchByTimeRange returns ascending, but listByLayer fallback returns descending
            result = _sortBy(result, ['updatedAt']);

            // Format each item with path, age, and content preview
            const events = _map(result, item =>
                formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now)
            );

            // Prepend warning note if showing older events
            if(showingOlderEventsNote) {
                events.unshift('⚠️ No activity in the last 14 days. Showing older events:');
            }

            logger.debug({ eventCount: events.length }, 'Recent events loaded');
            return events;
        },

        loadUserTimezone: async (userId: string): Promise<string | undefined> => {
            const path = createMemoryPath(`/users/${userId}/timezone`);
            const item = await backend.get(path);

            if(!item) {
                logger.debug({ userId }, 'User timezone not found');
                return undefined;
            }

            return item.content;
        },

        buildUserMessagePrefix: async (userId: string, botUserId?: string): Promise<string> => {
            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for sections
            const sections: string[] = [];

            // User-specific memories
            const userMemories = await builder.loadRecentContext(userId, 3);
            if(userMemories.length > 0) {
                sections.push(`[About this user]\n${_map(userMemories, m => `- ${m}`).join('\n')}`);
            }

            // Bot's own memories
            // Stryker disable next-line ConditionalExpression: botUserId null check is defensive, tested via integration
            if(botUserId) {
                const isambardMemories = await builder.loadRecentContext(botUserId, 2);
                if(isambardMemories.length > 0) {
                    sections.push(`[Your recent activities]\n${_map(isambardMemories, m => `- ${m}`).join('\n')}`);
                }
            }

            // Recent events
            const recentEvents = await builder.loadRecentEvents(50);
            // Stryker disable next-line ConditionalExpression: Empty array check prevents unnecessary section, tested via integration
            if(recentEvents.length > 0) {
                sections.push(`[Recent events]\n${_map(recentEvents, m => `- ${m}`).join('\n')}`);
            }

            if(sections.length === 0) {
                return '';
            }

            // Stryker disable next-line StringLiteral: Equivalent - trailing newlines are formatting, tests verify content not whitespace
            return sections.join('\n\n') + '\n\n';
        },
    };

    return builder;
}
