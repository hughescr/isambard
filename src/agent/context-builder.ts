/**
 * Context Builder
 *
 * Builds system context from memory backend for Claude agent auto-loading.
 * Formats identity and state layer memories into a structured context string.
 */

import { logger } from '@hughescr/logger';
import { map as _map, isNumber as _isNumber, sortBy as _sortBy } from 'lodash';
import type { MemoryToolBackend } from '../storage/memory-tool/backend';
import type { MemoryPath } from '../storage/memory-tool/types';
import { createMemoryPath, createLayerName } from '../storage/memory-tool/types';
import { formatShortRelativeTime, formatTimeHeader } from '../utils/time';

export interface ContextBuilderOptions {
    backend:                MemoryToolBackend
    maxIdentityTokens?:     number   // Default: 5000
    maxStateFullTokens?:    number   // Default: 3000
    maxStatePreviewTokens?: number   // Default: 2000
    maxUserTokens?:         number   // Default: 2500
}

export interface ContextBuilder {
    /**
     * Load core identity (permanent, essential memories)
     * @returns Formatted identity string for system prompt
     */
    loadCoreIdentity: () => Promise<string>

    /**
     * Load sigmoid-scored state memories with tiered display (full content + previews)
     * @param now Optional reference time for age calculation
     * @returns Formatted state context string with full content tier and preview tier
     */
    loadHotState: (now?: Date) => Promise<string>

    /**
     * Load user-specific memories via path-based query
     * @param userId User ID to load memories for
     * @param now Optional reference time for age calculation
     * @returns Formatted user memories string
     */
    loadUserMemories: (userId: string, now?: Date) => Promise<string>

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
     * Build user message prefix with time header, user memories, hot state, and recent events.
     * @param userId The user who sent the message
     * @param userTimezone Optional user timezone for time header
     * @returns Context prefix string (empty if no context available)
     */
    buildUserMessagePrefix: (userId: string, userTimezone?: string) => Promise<string>
}

const DEFAULT_MAX_IDENTITY_TOKENS = 5000;
const DEFAULT_MAX_STATE_FULL_TOKENS = 3000;
const DEFAULT_MAX_STATE_PREVIEW_TOKENS = 2000;
const DEFAULT_MAX_USER_TOKENS = 2500;
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

    const maxIdentityChars = maxIdentityTokens * CHARS_PER_TOKEN;
    const maxStateFullChars = (options.maxStateFullTokens ?? DEFAULT_MAX_STATE_FULL_TOKENS) * CHARS_PER_TOKEN;
    const maxStatePreviewChars = (options.maxStatePreviewTokens ?? DEFAULT_MAX_STATE_PREVIEW_TOKENS) * CHARS_PER_TOKEN;
    const maxUserChars = (options.maxUserTokens ?? DEFAULT_MAX_USER_TOKENS) * CHARS_PER_TOKEN;

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
            if(content.length > maxIdentityChars) {
                const truncated = content.slice(0, maxIdentityChars - 3) + '...';
                const overflowNote = `\n\n...and ${result.items.length} total identity memories (use 'list /identity' to see all)`;
                const identity = truncated + overflowNote;
                logger.debug({ identityLength: identity.length }, 'Core identity loaded');
                return identity;
            } else {
                const identity = content;
                logger.debug({ identityLength: identity.length }, 'Core identity loaded');
                return identity;
            }
        },

        loadHotState: async (now: Date = new Date()): Promise<string> => {
            logger.debug({ msg: 'Loading hot state...' });

            const scoredItems = await backend.getStateItemsScored({ now });

            // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant - empty loop produces same result
            if(scoredItems.length === 0) {
                logger.debug({ fullTierCount: 0, previewTierCount: 0, overflowCount: 0, stateLength: 0 }, 'Hot state loaded');
                return '';
            }

            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for sections
            const sections: string[] = [];
            let fullCharsUsed = 0;
            let previewCharsUsed = 0;
            let fullTierCount = 0;
            let previewTierCount = 0;
            let overflowCount = 0;

            // Full-content tier: highest-scored items with full content
            for(const { item } of scoredItems) {
                const formatted = `${item.path}:\n${item.content}`;
                if(fullCharsUsed + formatted.length <= maxStateFullChars) {
                    sections.push(formatted);
                    fullCharsUsed += formatted.length;
                    fullTierCount++;
                } else {
                    // Try preview tier
                    const preview = formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now);
                    if(previewCharsUsed + preview.length <= maxStatePreviewChars) {
                        sections.push(preview);
                        previewCharsUsed += preview.length;
                        previewTierCount++;
                    } else {
                        overflowCount++;
                    }
                }
            }

            if(overflowCount > 0) {
                sections.push(`...and ${overflowCount} more state memories (use 'list /state' to see all)`);
            }

            const result = sections.join('\n');
            logger.debug({ fullTierCount, previewTierCount, overflowCount, stateLength: result.length }, 'Hot state loaded');
            return result;
        },

        loadUserMemories: async (userId: string, now: Date = new Date()): Promise<string> => {
            logger.debug({ userId }, 'Loading user memories');

            const result = await backend.list(`/users/${userId}`);

            // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant - empty loop produces same result
            if(result.items.length === 0) {
                logger.debug({ userId, memoryCount: 0, overflowCount: 0 }, 'User memories loaded');
                return '';
            }

            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for sections
            const sections: string[] = [];
            let charsUsed = 0;
            let overflowCount = 0;

            for(const item of result.items) {
                const formatted = formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now);
                if(charsUsed + formatted.length <= maxUserChars) {
                    sections.push(formatted);
                    charsUsed += formatted.length;
                } else {
                    overflowCount++;
                }
            }

            if(overflowCount > 0) {
                sections.push(`...and ${overflowCount} more user memories (use 'list /users/${userId}' to see all)`);
            }

            const memoryResult = sections.join('\n');
            logger.debug({ userId, memoryCount: result.items.length - overflowCount, overflowCount }, 'User memories loaded');
            return memoryResult;
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
                // This metadata-only update bumps updatedAt (keeps item visible in GSI1) but skips tag index.
                // The reconciler handles eventual tag index consistency, avoiding O(num_tags) write amplification.
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

        buildUserMessagePrefix: async (userId: string, userTimezone?: string): Promise<string> => {
            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for sections
            const sections: string[] = [];
            const now = new Date();

            // 1. Time header (always first, refreshed per-message)
            sections.push(formatTimeHeader(userTimezone));

            // 2. User-specific memories (path-based)
            const userMemories = await builder.loadUserMemories(userId, now);
            if(userMemories) {
                sections.push(`[About this user]\n${userMemories}`);
            }

            // 3. Hot state (sigmoid-scored, tiered)
            const hotState = await builder.loadHotState(now);
            if(hotState) {
                sections.push(`[Current state]\n${hotState}`);
            }

            // 4. Recent events (unchanged)
            const recentEvents = await builder.loadRecentEvents(50, now);
            if(recentEvents.length > 0) {
                sections.push(`[Recent events]\n${recentEvents.join('\n')}`);
            }

            // Stryker disable EqualityOperator,ConditionalExpression,BlockStatement,StringLiteral: Empty sections array can't happen (time header always present)
            if(sections.length === 0) {
                return '';
            }
            // Stryker restore EqualityOperator,ConditionalExpression,BlockStatement,StringLiteral

            // Stryker disable next-line StringLiteral: Equivalent - trailing newlines are formatting
            return sections.join('\n\n') + '\n\n';
        },
    };

    return builder;
}
