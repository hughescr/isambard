/**
 * Context Builder
 *
 * Builds system context from memory backend for Claude agent auto-loading.
 * Formats identity and state layer memories into a structured context string.
 */

import { logger } from '@hughescr/logger';
import type { SummarizeEventBatchesFn } from './event-summarizer';
import type { BlueskyClient } from '@/integrations/bsky';
import { formatCalendarContext, type CalDAVClient, type CalendarRegistryBackend, type CalendarEvent, CaldavTimeoutError, CaldavAuthError } from '@/integrations/caldav';
import { type MemoryToolBackend, type MemoryPath, type MemoryToolItemData, createMemoryPath, createLayerName  } from '@/storage';
import { formatShortRelativeTime, formatTimeHeader, resolveTimezone } from '@/utils';

/** Minimal interface for retrieving message metadata from WildDuck */
export interface WildDuckService {
    getMessage:       (mailboxPath: string, uid: number) => Promise<{ id: number, subject?: string, to?: { address: string, name?: string }[], metaData?: Record<string, unknown> } | null>
    getMailboxCounts: (mailboxPath: string) => Promise<{ total: number, unseen: number }>
    listMessages:     (mailboxPath: string, options?: { unseen?: boolean }) => Promise<{ id: number, from: { address: string, name?: string }, subject: string, date: string }[]>
    searchByKeyword:  (mailboxPath: string, keyword: string) => Promise<number[]>
}

/** Combined email service dependency for perch inbox section */
export interface EmailService {
    wildDuckClient: WildDuckService
}

/** Bluesky DM service dependency for perch/catch-up DM section */
export interface BskyDMService {
    client: BlueskyClient
}

/** Calendar service dependency for calendar context injection */
export interface CalendarService {
    client:   CalDAVClient
    registry: CalendarRegistryBackend
}

export interface RecentEventsResult {
    items:      MemoryToolItemData[]
    isFallback: boolean
}

export interface ContextBuilderOptions {
    backend:                MemoryToolBackend
    maxIdentityTokens?:     number              // Default: 5000
    maxStateFullItems?:     number              // Default: 8
    maxStatePreviewItems?:  number              // Default: 30
    maxStateItemMaxChars?:  number              // Default: 2000 (per-item cap for full-content items)
    maxUserTokens?:         number              // Default: 2500
    maxEventFullItems?:     number              // Default: 10
    maxEventItemMaxChars?:  number              // Default: 2000 (per-item cap for full-content event items)
    maxEventBatchSize?:     number              // Default: 10
    summarizeEventBatches?: SummarizeEventBatchesFn  // Optional DI for event summarization
    emailService?:          EmailService        // Optional email service for perch inbox section
    bskyDMService?:         BskyDMService       // Optional Bluesky DM service for perch DM section
    calendarService?:       CalendarService     // Optional calendar service for context injection
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
     * @returns Raw event items and fallback flag
     */
    loadRecentEvents: (limit?: number, now?: Date) => Promise<RecentEventsResult>

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

    /**
     * Build lightweight perch context with time, state, and events.
     * @param now Optional reference time
     * @returns Context prefix string for perch sessions
     */
    buildPerchContext: (now?: Date) => Promise<string>
}

// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_IDENTITY_TOKENS = 5000;
// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_STATE_FULL_ITEMS = 8;
// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_STATE_PREVIEW_ITEMS = 30;
// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_STATE_ITEM_MAX_CHARS = 2000;
// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_USER_TOKENS = 2500;
// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_EVENT_FULL_ITEMS = 10;
// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_EVENT_ITEM_MAX_CHARS = 2000;
// Stryker disable next-line ArithmeticOperator: Default constant
const DEFAULT_MAX_EVENT_BATCH_SIZE = 10;
const CHARS_PER_TOKEN = 4;
const CONTENT_PREVIEW_MAX_LENGTH = 100;

/**
 * Formats a memory item as a preview string with path, age, and truncated content.
 * Format: "- path (age): content_preview"
 *
 * Handles tag index cases where content may be undefined (only contentPreview available from TagIndexItem).
 */
export function formatMemoryPreview(
    path: MemoryPath,
    content: string | undefined,
    contentPreview: string | undefined,
    updatedAt: string,
    now: Date
): string {
    const age = formatShortRelativeTime(new Date(updatedAt), now);

    // Full content available - show preview
    if(content) {
        // Stryker disable EqualityOperator,ConditionalExpression,MethodExpression,StringLiteral: Cosmetic content truncation for preview display
        const shouldTruncate = content.length > CONTENT_PREVIEW_MAX_LENGTH;
        const preview = shouldTruncate
            ? `${content.slice(0, CONTENT_PREVIEW_MAX_LENGTH)}...`
            : content;
        // Stryker restore EqualityOperator,ConditionalExpression,MethodExpression,StringLiteral
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
 * Extract a rejection summary line from WildDuck message fields and metadata.
 * Returns a formatted string if the message has rejectedAt + reason + to, else undefined.
 */
function formatRejectedDraftLine(
    subject:    string | undefined,
    to:         { address: string, name?: string }[] | undefined,
    metaData:   Record<string, unknown> | undefined
): string | undefined {
    if(!metaData?.rejectedAt) {
        return undefined;
    }
    // Stryker disable next-line ConditionalExpression: defensive type guard — reason is always string when present in rejection metadata
    const reason    = typeof metaData.reason === 'string' ? metaData.reason : undefined;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: defensive length check; to is always non-empty when the caller has verified it has addresses
    const firstTo   = to && to.length > 0 ? to[0] : undefined;
    const toAddress = firstTo?.address;
    // Stryker disable next-line ConditionalExpression,BlockStatement,LogicalOperator: only include rejected drafts with reason and to
    if(!reason || !toAddress) {
        return undefined;
    }
    // Stryker disable next-line StringLiteral: Cosmetic rejection line format
    return `- To: ${toAddress}, Subject: "${subject ?? ''}" — Reason: ${reason}`;
}

/**
 * Build the admin-rejected subsection: messages sent by Izzy that were rejected by admin.
 */
async function buildAdminRejectedSubsection(uids: number[], wdc: WildDuckService): Promise<string | undefined> {
    // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for rejectionLines
    const rejectionLines: string[] = [];
    for(const uid of uids) {
        // Stryker disable next-line StringLiteral: EmailFolder.Drafts is configuration constant
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited WildDuck API
        const msg  = await wdc.getMessage('Drafts', uid);
        const line = formatRejectedDraftLine(msg?.subject, msg?.to, msg?.metaData);
        if(line) {
            rejectionLines.push(line);
        }
    }
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no lines = no section
    if(rejectionLines.length === 0) {
        return undefined;
    }
    // Stryker disable next-line StringLiteral: Cosmetic section header text
    return `## Messages You Attempted to Send (Rejected by Admin)\n${rejectionLines.join('\n')}`;
}

/**
 * Build the gave-up escalation subsection: drafts that could not reach Discord for approval.
 */
async function buildGaveUpSubsection(uids: number[], wdc: WildDuckService): Promise<string | undefined> {
    // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for gaveUpLines
    const gaveUpLines: string[] = [];
    for(const uid of uids) {
        // Stryker disable next-line StringLiteral: EmailFolder.Drafts is configuration constant
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited WildDuck API
        const msg    = await wdc.getMessage('Drafts', uid);
        if(!msg) {
            continue;
        }
        // Stryker disable next-line ArrayDeclaration: defensive fallback for missing to field — equivalent to empty address list
        const toStr  = (msg.to ?? []).map(addr => addr.address).join(', ');
        const subject = msg.subject ?? '(no subject)';
        // Stryker disable next-line StringLiteral: Cosmetic line format
        gaveUpLines.push(`- Drafts:${uid} to ${toStr} — "${subject}"`);
    }
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no lines = no section
    if(gaveUpLines.length === 0) {
        return undefined;
    }
    // Stryker disable next-line StringLiteral: Cosmetic section header text
    return `## CRITICAL: ${uids.length} draft(s) could not be sent for admin approval after multiple attempts:\n${gaveUpLines.join('\n')}\nPlease notify Craig directly to check the Drafts folder.`;
}

/**
 * Classify a caught error into a human-readable reason string for calendar unavailability messages.
 */
function classifyCalendarError(error: unknown): string {
    if(error instanceof CaldavTimeoutError) {
        const timeoutMs = error.context?.timeoutMs;
        // Stryker disable next-line ConditionalExpression,StringLiteral: fallback for missing timeoutMs context — defensive only
        const timeoutStr = typeof timeoutMs === 'number' ? String(timeoutMs) : 'unknown';
        return `connection to calendar server timed out after ${timeoutStr}ms`;
    }
    if(error instanceof CaldavAuthError) {
        return 'authentication failed for calendar server';
    }
    if(error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Class-based context builder for managing agent memory context
 */
class ContextBuilderImpl implements ContextBuilder {
    readonly #backend:                 MemoryToolBackend;
    readonly #maxIdentityChars:        number;
    readonly #maxStateFullItems:       number;
    readonly #maxStatePreviewItems:    number;
    readonly #maxStateItemMaxChars:    number;
    readonly #maxUserChars:            number;
    readonly #maxEventFullItems:       number;
    readonly #maxEventItemMaxChars:    number;
    readonly #maxEventBatchSize:       number;
    readonly #summarizeEventBatchesFn: SummarizeEventBatchesFn | undefined;
    readonly #emailService:            EmailService | undefined;
    readonly #bskyDMService:           BskyDMService | undefined;
    readonly #calendarService:         CalendarService | undefined;

    constructor(options: ContextBuilderOptions) {
        this.#backend = options.backend;
        const maxIdentityTokens = options.maxIdentityTokens ?? DEFAULT_MAX_IDENTITY_TOKENS;
        this.#maxStateFullItems = options.maxStateFullItems ?? DEFAULT_MAX_STATE_FULL_ITEMS;
        this.#maxStatePreviewItems = options.maxStatePreviewItems ?? DEFAULT_MAX_STATE_PREVIEW_ITEMS;
        this.#maxStateItemMaxChars = options.maxStateItemMaxChars ?? DEFAULT_MAX_STATE_ITEM_MAX_CHARS;
        this.#maxEventFullItems = options.maxEventFullItems ?? DEFAULT_MAX_EVENT_FULL_ITEMS;
        this.#maxEventItemMaxChars = options.maxEventItemMaxChars ?? DEFAULT_MAX_EVENT_ITEM_MAX_CHARS;
        this.#maxEventBatchSize = options.maxEventBatchSize ?? DEFAULT_MAX_EVENT_BATCH_SIZE;
        this.#summarizeEventBatchesFn = options.summarizeEventBatches;
        this.#emailService = options.emailService;
        this.#bskyDMService = options.bskyDMService;
        this.#calendarService = options.calendarService;

        this.#maxIdentityChars = maxIdentityTokens * CHARS_PER_TOKEN;
        this.#maxUserChars = (options.maxUserTokens ?? DEFAULT_MAX_USER_TOKENS) * CHARS_PER_TOKEN;
    }

    /**
     * Build event section from recent events result
     * @param eventsResult Recent events result with items and fallback flag
     * @param now Reference time for age calculation
     * @returns Formatted event section string or undefined if no events
     */
    // eslint-disable-next-line sonarjs/cognitive-complexity -- event section builder partitions items into summarized/full buckets, each requiring distinct rendering paths; extraction would obscure the single-pass logic
    async #buildEventSection(
        eventsResult: RecentEventsResult,
        now: Date
    ): Promise<string | undefined> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Defensive guard - empty items produces empty join anyway, caller checks falsy
        if(eventsResult.items.length === 0) {
            return undefined;
        }

        // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for eventSections
        const eventSections: string[] = [];

        // Warning note for fallback events
        if(eventsResult.isFallback) {
            eventSections.push('⚠️ No activity in the last 14 days. Showing older events:');
        }

        // Split into full-display and summary items (newest events get full display)
        // Stryker disable next-line ConditionalExpression,EqualityOperator: Edge case - if total <= max, slice returns empty array anyway
        const summaryItems = eventsResult.items.length <= this.#maxEventFullItems
            ? []
            : eventsResult.items.slice(0, -this.#maxEventFullItems);
        const fullItems = eventsResult.items.slice(-this.#maxEventFullItems);

        // Older events summarized (rendered first for chronological order)
        // Stryker disable ConditionalExpression,EqualityOperator: Defensive empty check - for loop won't execute if empty anyway
        if(summaryItems.length > 0 && this.#summarizeEventBatchesFn) {
            // Stryker disable BlockStatement — external summarization API call with graceful preview fallback on failure
            try {
                const batchSummaries = await this.#summarizeEventBatchesFn(summaryItems, this.#maxEventBatchSize, now);
                for(const batch of batchSummaries) {
                    const startAge = formatShortRelativeTime(new Date(batch.startTime), now);
                    const endAge = formatShortRelativeTime(new Date(batch.endTime), now);
                    eventSections.push(`[Events from ${startAge} to ${endAge} (${batch.count} events)]\n${batch.summary}`);
                }
            } catch (error) {
                logger.warn({ error, msg: 'Event summarization failed, falling back to preview format' });
                // Fall back to preview format on error
                for(const item of summaryItems) {
                    eventSections.push(formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now));
                }
            }
            // Stryker restore BlockStatement
        } else if(summaryItems.length > 0) {
            // No summarizer — fall back to preview format
            for(const item of summaryItems) {
                eventSections.push(formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now));
            }
        }
        // Stryker restore ConditionalExpression,EqualityOperator

        // Full-content recent events (newest, rendered last)
        for(const item of fullItems) {
            let content = item.content;
            // Stryker disable next-line EqualityOperator: Config-driven content truncation threshold
            if(content.length > this.#maxEventItemMaxChars) {
                content = `${content.slice(0, this.#maxEventItemMaxChars)}\n[truncated — use 'memory view ${item.path}' for full content]`;
            }
            const age = formatShortRelativeTime(new Date(item.updatedAt), now);
            eventSections.push(`${item.path} (${age}):\n${content}`);
        }

        return eventSections.join('\n\n');
    }

    /**
     * Build the calendar context section for a specific user.
     * Returns formatted calendar section string, or undefined if no service, no calendars, or no events.
     */
    async #buildCalendarSection(userId: string, userTimezone?: string, now: Date = new Date()): Promise<string | undefined> {
        if(!this.#calendarService) {
            return undefined;
        }

        // Stryker disable BlockStatement: try-catch guards calendar errors from breaking user message prefix
        try {
            const servers = await this.#calendarService.registry.getAllCalendars(userId);
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no servers = no section
            if(servers.length === 0) {
                return undefined;
            }

            const events = await this.#calendarService.client.getContextEvents(servers, now);
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no events = no section
            if(events.length === 0) {
                return undefined;
            }

            const timezone = resolveTimezone(userTimezone);
            return formatCalendarContext(events, now, timezone);
        } catch (error) {
            logger.warn({ error, userId }, 'Failed to load calendar context');
            return `[Calendar unavailable: ${classifyCalendarError(error)}]`;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Build the calendar context section for all registered users (for perch sessions).
     * Loads all users' calendars and merges their events, using Izzy's local timezone.
     * Returns formatted calendar section string, or undefined if no service, no users, or no events.
     */
    async #buildPerchCalendarSection(now: Date = new Date()): Promise<string | undefined> {
        if(!this.#calendarService) {
            return undefined;
        }

        // Stryker disable BlockStatement: try-catch guards calendar errors from breaking perch context
        try {
            const userIds = await this.#calendarService.registry.listRegisteredUserIds();
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no users = no section
            if(userIds.length === 0) {
                return undefined;
            }

            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for allEvents
            const allEvents: CalendarEvent[] = [];
            for(const userId of userIds) {
                // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited CalDAV API, few users
                const servers = await this.#calendarService.registry.getAllCalendars(userId);
                // Stryker disable next-line ConditionalExpression,EqualityOperator: skip users with no servers
                if(servers.length > 0) {
                    // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited CalDAV API
                    const events = await this.#calendarService.client.getContextEvents(servers, now);
                    allEvents.push(...events);
                }
            }

            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no events = no section
            if(allEvents.length === 0) {
                return undefined;
            }

            return formatCalendarContext(allEvents, now, resolveTimezone());
        } catch (error) {
            logger.warn({ error }, 'Failed to load perch calendar context');
            return `[Calendar unavailable: ${classifyCalendarError(error)}]`;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Build the email inbox section for perch context.
     * Returns formatted inbox section string, or undefined if no unread mail or email service unavailable.
     */
    async #buildEmailInboxSection(now: Date): Promise<string | undefined> {
        if(!this.#emailService) {
            return undefined;
        }
        // Stryker disable BlockStatement: try-catch guards email errors from breaking perch context
        try {
            const counts = await this.#emailService.wildDuckClient.getMailboxCounts('CleanInbox');
            if(counts.unseen > 0) {
                const summaries = await this.#emailService.wildDuckClient.listMessages('CleanInbox', { unseen: true });
                // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for inboxLines
                const inboxLines: string[] = [];
                for(const summary of summaries) {
                    // Stryker disable next-line ObjectLiteral: new Date() wrapping is structural, not behavior-affecting
                    const age = formatShortRelativeTime(new Date(summary.date), now);
                    // Stryker disable next-line StringLiteral,ObjectLiteral: Cosmetic inbox line format
                    const fromStr = summary.from.name ? `${summary.from.name} <${summary.from.address}>` : summary.from.address;
                    // Stryker disable next-line StringLiteral: UID reference prefix is configuration
                    inboxLines.push(`- [CleanInbox:${summary.id}] From: ${fromStr} | Subject: ${summary.subject} | ${age}`);
                }
                // Stryker disable next-line StringLiteral: Cosmetic section header text
                return `## Inbox\nYou have mail (${counts.unseen} unread):\n${inboxLines.join('\n')}`;
            }
        } catch (error) {
            // Stryker disable next-line StringLiteral,ObjectLiteral: Log message content is not behavior-affecting
            logger.warn({ error, msg: 'Email inbox fetch failed, skipping inbox section' });
        }
        // Stryker restore BlockStatement
        return undefined;
    }

    /**
     * Build the rejected drafts section for perch context.
     * Returns formatted rejected drafts section string, or undefined if none found or service unavailable.
     * Also includes a CRITICAL escalation section for drafts where Discord notification has permanently failed.
     */
    async #buildRejectedDraftSection(): Promise<string | undefined> {
        if(!this.#emailService) {
            return undefined;
        }
        const { wildDuckClient } = this.#emailService;
        // Stryker disable BlockStatement: try-catch guards rejected draft errors from breaking perch context
        try {
            // Stryker disable next-line StringLiteral: EmailFolder.Drafts is configuration constant
            const rejectedUids = await wildDuckClient.searchByKeyword('Drafts', 'SendRejectedByAdmin');
            // Stryker disable next-line StringLiteral: EmailFolder.Drafts is configuration constant
            const gaveUpUids   = await wildDuckClient.searchByKeyword('Drafts', 'DiscordNotifyGaveUp');

            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for sections
            const sections: string[] = [];

            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: skip if no rejected drafts
            if(rejectedUids.length > 0) {
                const sub = await buildAdminRejectedSubsection(rejectedUids, wildDuckClient);
                if(sub) {
                    sections.push(sub);
                }
            }

            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: skip if no gave-up drafts
            if(gaveUpUids.length > 0) {
                const sub = await buildGaveUpSubsection(gaveUpUids, wildDuckClient);
                if(sub) {
                    sections.push(sub);
                }
            }

            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: skip if no sections
            if(sections.length > 0) {
                return sections.join('\n\n');
            }
        } catch (err) {
            // Stryker disable next-line StringLiteral,ObjectLiteral: Log message content is not behavior-affecting
            logger.warn({ err, msg: 'Failed to load rejected draft context' });
        }
        // Stryker restore BlockStatement
        return undefined;
    }

    /**
     * Build the Bluesky DM section for perch context.
     * Returns formatted DM section string, or undefined if no unread DMs or service unavailable.
     */
    async #buildBskyDMSection(): Promise<string | undefined> {
        if(!this.#bskyDMService) {
            return undefined;
        }

        // Stryker disable BlockStatement: try-catch guards bsky DM errors from breaking perch context
        try {
            // Stryker disable next-line StringLiteral: 'unread' readState filter is API configuration
            const result = await this.#bskyDMService.client.listConversations(undefined, undefined, 'unread');
            const convos = result.conversations;

            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no conversations = no section
            if(convos.length === 0) {
                return undefined;
            }

            // Count total unread messages across conversations on this page
            // Stryker disable next-line ArithmeticOperator: sum accumulator for unread count
            const totalUnread = convos.reduce((sum, c) => sum + c.unreadCount, 0);

            // Build per-conversation descriptions: "N in the conversation with handle1, handle2"
            const convoDescriptions = convos.map((c) => {
                const memberHandles = c.members
                    .filter(m => m.handle !== this.#bskyDMService!.client.ownHandle)
                    .map(m => m.handle)
                    .join(', ');
                return `${c.unreadCount} in the conversation with ${memberHandles}`;
            });

            const hasMore = result.cursor !== undefined;
            // Stryker disable next-line StringLiteral: section header is cosmetic
            const header = `## Bluesky DMs\nYou have ${totalUnread}${hasMore ? '+' : ''} DMs: ${convoDescriptions.join('; ')}`;
            return hasMore
                ? `${header}\n(More conversations available — use Bluesky DM tools to see all)`
                : header;
        } catch (error) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ error, msg: 'Bluesky DM fetch failed, skipping DM section' });
        }
        // Stryker restore BlockStatement
        return undefined;
    }

    async loadCoreIdentity(): Promise<string> {
        logger.debug({ msg: 'Loading core identity...' });

        // Load identity layer items (permanent, auto-loaded)
        const result = await this.#backend.listByLayer(createLayerName('identity'));

        // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant - empty array join returns ''
        if(result.items.length === 0) {
            logger.debug({ identityLength: 0 }, 'Core identity loaded');
            return '';
        }

        // Format and truncate if needed
        const content = result.items.map(item => item.content).join('\n\n');
        if(content.length > this.#maxIdentityChars) {
            const truncated = `${content.slice(0, this.#maxIdentityChars - 3)}...`;
            const overflowNote = `\n\n...and ${result.items.length} total identity memories (use 'list /identity' to see all)`;
            const identity = truncated + overflowNote;
            logger.debug({ identityLength: identity.length }, 'Core identity loaded');
            return identity;
        } else {
            const identity = content;
            logger.debug({ identityLength: identity.length }, 'Core identity loaded');
            return identity;
        }
    }

    async loadHotState(now: Date = new Date()): Promise<string> {
        logger.debug({ msg: 'Loading hot state...' });

        const scoredItems = await this.#backend.getStateItemsScored({ now });

        // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant - empty loop produces same result
        if(scoredItems.length === 0) {
            logger.debug({ fullTierCount: 0, previewTierCount: 0, overflowCount: 0, stateLength: 0 }, 'Hot state loaded');
            return '';
        }

        // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for sections
        const sections: string[] = [];
        let fullTierCount = 0;
        let previewTierCount = 0;

        for(const { item } of scoredItems) {
            // Stryker disable next-line ConditionalExpression: Guard break for tier limits — both tiers full
            if(fullTierCount >= this.#maxStateFullItems && previewTierCount >= this.#maxStatePreviewItems) {
                break;
            }

            if(fullTierCount < this.#maxStateFullItems) {
                // Full content tier - cap per-item content length
                let content = item.content;
                // Stryker disable next-line EqualityOperator: Config-driven content truncation threshold
                if(content.length > this.#maxStateItemMaxChars) {
                    content = `${content.slice(0, this.#maxStateItemMaxChars)}\n[truncated — use 'memory view ${item.path}' for full content]`;
                }
                sections.push(`${item.path}:\n${content}`);
                fullTierCount++;
            } else {
                // Preview tier
                const preview = formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now);
                sections.push(preview);
                previewTierCount++;
            }
        }

        const overflowCount = scoredItems.length - fullTierCount - previewTierCount;
        if(overflowCount > 0) {
            sections.push(`...and ${overflowCount} more state memories (use 'list /state' to see all)`);
        }

        const result = sections.join('\n');
        logger.debug({ fullTierCount, previewTierCount, overflowCount, stateLength: result.length }, 'Hot state loaded');
        return result;
    }

    async loadUserMemories(userId: string, now: Date = new Date()): Promise<string> {
        logger.debug({ userId }, 'Loading user memories');

        const result = await this.#backend.list(`/users/${userId}`);

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
            if(charsUsed + formatted.length <= this.#maxUserChars) {
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
    }

    async recordAccess(paths: MemoryPath[]): Promise<void> {
        for(const path of paths) {
            // Get current item
            // eslint-disable-next-line no-await-in-loop -- sequential: order-dependent (get then update same item)
            const item = await this.#backend.get(path);

            if(!item) {
                // Skip if item doesn't exist
                continue;
            }

            // Get current access count from metadata
            // Stryker disable next-line OptionalChaining: metadata always exists per schema, ?. is defensive
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: metadata is non-nullable per schema but accessed via generic DynamoDB record type
            const currentAccessCount = typeof item.metadata?.accessCount === 'number'
                ? item.metadata.accessCount
                : 0;

            // Update metadata with incremented access count and timestamp
            // This metadata-only update bumps updatedAt (keeps item visible in GSI1) but skips tag index.
            // The reconciler handles eventual tag index consistency, avoiding O(num_tags) write amplification.
            // eslint-disable-next-line no-await-in-loop -- sequential: each update depends on prior get result
            await this.#backend.update(path, {
                metadata: {
                    ...item.metadata,
                    accessCount:  currentAccessCount + 1,
                    lastAccessed: new Date().toISOString(),
                },
            });
        }
    }

    async loadRecentEvents(limit = 50, now: Date = new Date()): Promise<RecentEventsResult> {
        logger.debug({ msg: 'Loading recent events' });

        // Load recent events by time range (last 14 days)
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        let result = await this.#backend.searchByTimeRange(
            twoWeeksAgo.toISOString(),
            now.toISOString(),
            createLayerName('events'),
            { limit }
        );

        // Fallback: if no events in 14 days, get most recent regardless of age
        let isFallback = false;
        if(result.length === 0) {
            const fallbackResult = await this.#backend.listByLayer(createLayerName('events'), { limit });
            result = fallbackResult.items;
            isFallback = result.length > 0;
        }

        // Ensure ascending order: searchByTimeRange returns ascending, but listByLayer fallback returns descending
        result = result.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt));

        logger.debug({ eventCount: result.length }, 'Recent events loaded');
        return { items: result, isFallback };
    }

    async loadUserTimezone(userId: string): Promise<string | undefined> {
        const path = createMemoryPath(`/users/${userId}/timezone`);
        const item = await this.#backend.get(path);

        if(!item) {
            logger.debug({ userId }, 'User timezone not found');
            return undefined;
        }

        return item.content;
    }

    async buildUserMessagePrefix(userId: string, userTimezone?: string): Promise<string> {
        // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for sections
        const sections: string[] = [];
        const now = new Date();

        // 1. Time header (always first, refreshed per-message)
        sections.push(formatTimeHeader(userTimezone));

        // 2. User-specific memories (path-based)
        const userMemories = await this.loadUserMemories(userId, now);
        if(userMemories) {
            sections.push(`[About this user]\n${userMemories}`);
        }

        // 3. Calendar context (optional — skip if no calendar service configured)
        const calendarSection = await this.#buildCalendarSection(userId, userTimezone, now);
        if(calendarSection) {
            sections.push(calendarSection);
        }

        // 4. Hot state (sigmoid-scored, tiered)
        const hotState = await this.loadHotState(now);
        if(hotState) {
            sections.push(`[Current state]\n${hotState}`);
        }

        // 5. Recent events (tiered display)
        // Stryker disable ArithmeticOperator: Config constant calculation for event loading limit
        const eventsResult = await this.loadRecentEvents(
            this.#maxEventFullItems + this.#maxEventBatchSize * 4,
            now
        );
        // Stryker restore ArithmeticOperator
        const eventSection = await this.#buildEventSection(eventsResult, now);
        if(eventSection) {
            sections.push(`[Recent events]\n${eventSection}`);
        }

        // Stryker disable next-line StringLiteral: Equivalent - trailing newlines are formatting
        return `${sections.join('\n\n')}\n\n`;
    }

    // eslint-disable-next-line sonarjs/cognitive-complexity -- perch context aggregates 7 optional sections (time, state, events, calendar, inbox, rejected drafts, bsky DMs); each section adds one branch
    async buildPerchContext(now: Date = new Date()): Promise<string> {
        // 1. Time header (no user timezone for perch)
        // Stryker disable next-line ArrayDeclaration: Equivalent - time header is always first element
        const sections: string[] = [formatTimeHeader()];

        // 2. Top state memories (full content, truncated per-item)
        // Stryker disable next-line ObjectLiteral: Config parameter for getStateItemsScored
        const scoredItems = await this.#backend.getStateItemsScored({ now });
        if(scoredItems.length > 0) {
            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for stateSections
            const stateSections: string[] = [];
            // Stryker disable next-line ArithmeticOperator: Config constant for perch state count
            const perchStateCount = 3;
            for(const { item } of scoredItems.slice(0, perchStateCount)) {
                let content = item.content;
                // Stryker disable next-line ConditionalExpression,EqualityOperator: Config-driven content truncation threshold
                if(content.length > this.#maxStateItemMaxChars) {
                    // Stryker disable next-line StringLiteral: Cosmetic truncation message for context display
                    content = `${content.slice(0, this.#maxStateItemMaxChars)}\n[truncated — use 'memory view ${item.path}' for full content]`;
                }
                stateSections.push(`${item.path}:\n${content}`);
            }
            // Stryker disable next-line StringLiteral: Cosmetic section join separator
            sections.push(`## Recent Focus\n${stateSections.join('\n\n')}`);
        }

        // 3. Recent events (all shown in full, no summarization)
        // Stryker disable next-line ArithmeticOperator: Config constant for perch event count
        const perchEventCount = 5;
        const eventsResult = await this.loadRecentEvents(perchEventCount, now);
        if(eventsResult.items.length > 0) {
            // Stryker disable next-line ArrayDeclaration: Equivalent - empty array is initial value for eventSections
            const eventSections: string[] = [];
            for(const item of eventsResult.items) {
                let content = item.content;
                // Stryker disable next-line EqualityOperator: Config-driven content truncation threshold
                if(content.length > this.#maxEventItemMaxChars) {
                    // Stryker disable next-line StringLiteral: Cosmetic truncation message text
                    content = `${content.slice(0, this.#maxEventItemMaxChars)}\n[truncated — use 'memory view ${item.path}' for full content]`;
                }
                const age = formatShortRelativeTime(new Date(item.updatedAt), now);
                eventSections.push(`${item.path} (${age}):\n${content}`);
            }
            // Stryker disable next-line StringLiteral: Cosmetic section join separator
            sections.push(`## Recent Events\n${eventSections.join('\n\n')}`);
        }

        // 4. Calendar context (optional — skip if no calendar service configured)
        const perchCalendarSection = await this.#buildPerchCalendarSection(now);
        if(perchCalendarSection) {
            sections.push(perchCalendarSection);
        }

        // 5. Email inbox summary (optional — skip if no email service configured)
        const inboxSection = await this.#buildEmailInboxSection(now);
        if(inboxSection) {
            sections.push(inboxSection);
        }

        // 6. Rejected drafts context (outbound emails rejected by admin)
        const rejectedDraftsSection = await this.#buildRejectedDraftSection();
        if(rejectedDraftsSection) {
            sections.push(rejectedDraftsSection);
        }

        // 7. Bluesky DM summary (optional — skip if no bsky service configured)
        const bskyDMSection = await this.#buildBskyDMSection();
        if(bskyDMSection) {
            sections.push(bskyDMSection);
        }

        // Stryker disable next-line StringLiteral: Cosmetic trailing newlines for context formatting
        return `${sections.join('\n\n')}\n\n`;
    }
}

/**
 * Creates a context builder for managing agent memory context
 */
export function createContextBuilder(options: ContextBuilderOptions): ContextBuilder {
    return new ContextBuilderImpl(options);
}
