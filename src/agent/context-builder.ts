/**
 * Context Builder
 *
 * Builds system context from memory backend for Claude agent auto-loading.
 * Formats identity and state layer memories into a structured context string.
 */

import { logger } from '@hughescr/logger';
import pLimit from 'p-limit';
import type { SummarizeEventBatchesFn } from './event-summarizer';
import { formatTimeHeader } from './time-header';
import type { BlueskyClient, BskyRejectionBackend } from '@/integrations/bsky';
import { formatCalendarContext, type CalDAVClient, type CalendarRegistryBackend, type CalendarEvent, type FailedCalendarEvent, CaldavTimeoutError, CaldavAuthError } from '@/integrations/caldav';
import type { ServiceHealthRegistry } from '@/services';
import { type MemoryToolBackend, type MemoryPath, type MemoryToolItemData, createMemoryPath, createLayerName  } from '@/storage';
import { formatShortRelativeTime, resolveTimezone } from '@/utils';

/** Minimal interface for retrieving message metadata from WildDuck */
interface WildDuckService {
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

interface RecentEventsResult {
    items:      MemoryToolItemData[]
    isFallback: boolean
}

/** One entry of {@link ContextBuilder.loadStateTopSet}: a state item's path and content fingerprint. */
interface StateTopSetItem {
    path:               MemoryPath
    /**
     * A cheap, deterministic fingerprint of `item.content` (`Bun.hash(content).toString()`) —
     * NOT `item.content`'s `updatedAt` field, which is a "last touched" stamp bumped by
     * read-only access (`ContextBuilderImpl.recordAccess`, called on every `memory view` of a
     * state item) as well as by real edits. Using `updatedAt` directly would report a path as
     * "changed" whenever Claude merely reads it, even when its content is byte-identical.
     */
    contentFingerprint: string
}

interface ContextBuilderOptions {
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
    emailService?:          EmailService           // Optional email service for perch inbox section
    bskyDMService?:         BskyDMService          // Optional Bluesky DM service for perch DM section
    bskyRejectionBackend?:  BskyRejectionBackend   // Optional Bluesky rejection backend for perch rejection section
    calendarService?:       CalendarService        // Optional calendar service for context injection
    healthRegistry?:        ServiceHealthRegistry  // Optional service health registry for status section
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
     * Load the state top set: the same top-scored state items {@link loadHotState} renders
     * (full tier + preview tier, `maxStateFullItems + maxStatePreviewItems` items — default
     * 8 + 30 = 38), but as bare `{path, contentFingerprint}` entries instead of formatted text.
     * Used by `ContextPolicy.stateTopSetDelta` to diff the set membership and per-path content
     * fingerprint across turns, so it must use the exact same cap as `loadHotState` or the delta
     * would report churn `loadHotState` never actually rendered. The fingerprint is derived from
     * `item.content` itself (not `updatedAt`, which read-only access also bumps) so a path Claude
     * merely reads is never reported as "changed".
     * @param now Optional reference time for scoring (defaults to current time)
     * @returns Each item's path and content fingerprint, in score order, capped at
     *   `maxStateFullItems + maxStatePreviewItems`
     */
    loadStateTopSet: (now?: Date) => Promise<StateTopSetItem[]>

    /**
     * Load a user's calendar events for the given reference time -- the same per-user fetch
     * {@link ContextBuilder}'s internal `#buildCalendarSection` uses (`registry.getAllCalendars`
     * then `client.getContextEvents`), returning the raw events with no formatting. Used by
     * `ContextPolicy.calendarDelta` (Q12) to build the day's agenda for change detection.
     * @param userId User whose registered calendar servers to fetch
     * @param now Reference time passed through to `client.getContextEvents`
     * @returns The user's calendar events, or `[]` when no calendar service is configured, the
     *   user has no registered servers, or the fetch fails (logged at `warn`)
     */
    loadCalendarAgenda: (userId: string, now: Date) => Promise<CalendarEvent[]>

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
     * Load recent events from a rolling time window using an open-ended >= query.
     * Used by LiveSignals for the activity-log signal (2-hour window).
     * @param windowMs Rolling window size in milliseconds
     * @param limit Maximum number of events to load
     * @param now Optional reference time (defaults to current time)
     * @returns Raw event items array
     */
    loadRecentEventsSince: (windowMs: number, limit: number, now?: Date) => Promise<MemoryToolItemData[]>

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

const DEFAULT_MAX_IDENTITY_TOKENS = 5000;
const DEFAULT_MAX_STATE_FULL_ITEMS = 8;
const DEFAULT_MAX_STATE_PREVIEW_ITEMS = 30;
const DEFAULT_MAX_STATE_ITEM_MAX_CHARS = 2000;
const DEFAULT_MAX_USER_TOKENS = 2500;
const DEFAULT_MAX_EVENT_FULL_ITEMS = 10;
const DEFAULT_MAX_EVENT_ITEM_MAX_CHARS = 2000;
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
        const shouldTruncate = content.length > CONTENT_PREVIEW_MAX_LENGTH;
        const preview = shouldTruncate
            ? `${content.slice(0, CONTENT_PREVIEW_MAX_LENGTH)}...`
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
    const reason    = typeof metaData.reason === 'string' ? metaData.reason : undefined;
    const firstTo   = to?.[0];
    const toAddress = firstTo?.address;
    if(!reason || !toAddress) {
        return undefined;
    }
    return `- To: ${toAddress}, Subject: "${subject ?? ''}" — Reason: ${reason}`;
}

/**
 * Build the admin-rejected subsection: messages sent by Izzy that were rejected by admin.
 */
export async function buildAdminRejectedSubsection(uids: number[], wdc: WildDuckService): Promise<string | undefined> {
    const limit = pLimit(8);
    const messages = await Promise.all(uids.map(uid => limit(() => wdc.getMessage('Drafts', uid))));
    const rejectionLines: string[] = [];
    for(const msg of messages) {
        const line = formatRejectedDraftLine(msg?.subject, msg?.to, msg?.metaData);
        if(line) {
            rejectionLines.push(line);
        }
    }
    if(rejectionLines.length === 0) {
        return undefined;
    }
    return `## Messages You Attempted to Send (Rejected by Admin)\n${rejectionLines.join('\n')}`;
}

/**
 * Build the gave-up escalation subsection: drafts that could not reach Discord for approval.
 */
export async function buildGaveUpSubsection(uids: number[], wdc: WildDuckService): Promise<string | undefined> {
    const limit = pLimit(8);
    const messages = await Promise.all(uids.map(uid => limit(() => wdc.getMessage('Drafts', uid))));
    const gaveUpLines: string[] = [];
    for(const [index, msg] of messages.entries()) {
        if(!msg) {
            continue;
        }
        const toStr  = (msg.to ?? []).map(addr => addr.address).join(', ');
        const subject = msg.subject ?? '(no subject)';
        gaveUpLines.push(`- Drafts:${uids[index]} to ${toStr} — "${subject}"`);
    }
    if(gaveUpLines.length === 0) {
        return undefined;
    }
    return `## CRITICAL: ${uids.length} draft(s) could not be sent for admin approval after multiple attempts:\n${gaveUpLines.join('\n')}\nPlease notify Craig directly to check the Drafts folder.`;
}

/**
 * Append a short human-readable note about failed recurring event expansions to the
 * already-formatted calendar string.  Returns the string unchanged when `failed` is empty.
 */
function appendFailedNote(calendarText: string, failed: FailedCalendarEvent[]): string {
    if(failed.length === 0) {
        return calendarText;
    }
    const plural = failed.length === 1 ? 'event' : 'events';
    return `${calendarText}\n\n⚠️ ${failed.length} recurring ${plural} couldn't be parsed and may be missing from the calendar above.`;
}

/**
 * Classify a caught error into a human-readable reason string for calendar unavailability messages.
 */
function classifyCalendarError(error: unknown): string {
    if(error instanceof CaldavTimeoutError) {
        const timeoutMs = error.context?.timeoutMs;
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
    readonly #bskyRejectionBackend:    BskyRejectionBackend | undefined;
    readonly #calendarService:         CalendarService | undefined;
    readonly #healthRegistry:          ServiceHealthRegistry | undefined;

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
        this.#bskyRejectionBackend = options.bskyRejectionBackend;
        this.#calendarService = options.calendarService;
        this.#healthRegistry = options.healthRegistry;

        this.#maxIdentityChars = maxIdentityTokens * CHARS_PER_TOKEN;
        this.#maxUserChars = (options.maxUserTokens ?? DEFAULT_MAX_USER_TOKENS) * CHARS_PER_TOKEN;
    }

    /**
     * Build event section from recent events result
     * @param eventsResult Recent events result with items and fallback flag
     * @param now Reference time for age calculation
     * @returns Formatted event section string or undefined if no events
     */
    async #buildEventSection(
        eventsResult: RecentEventsResult,
        now: Date
    ): Promise<string | undefined> {
        const eventSections: string[] = [];

        // Warning note for fallback events
        if(eventsResult.isFallback) {
            // Stryker disable next-line ArrayMethodSwap: eventSections is newly allocated, so this first insertion has the same order.
            eventSections.push('⚠️ No activity in the last 14 days. Showing older events:');
        }

        // Split into full-display and summary items (newest events get full display)
        const summaryItems = eventsResult.items.slice(0, -this.#maxEventFullItems);
        const fullItems = eventsResult.items.slice(-this.#maxEventFullItems);

        // Older events are rendered first for chronological order.
        eventSections.push(...await this.#renderOlderEvents(summaryItems, now));

        // Full-content recent events (newest, rendered last)
        for(const item of fullItems) {
            let content = item.content;
            if(content.length > this.#maxEventItemMaxChars) {
                content = `${content.slice(0, this.#maxEventItemMaxChars)}\n[truncated — use 'memory view ${item.path}' for full content]`;
            }
            const age = formatShortRelativeTime(new Date(item.updatedAt), now);
            eventSections.push(`${item.path} (${age}):\n${content}`);
        }

        return eventSections.join('\n\n');
    }

    async #renderOlderEvents(items: RecentEventsResult['items'], now: Date): Promise<string[]> {
        if(items.length === 0) {
            return [];
        }
        if(this.#summarizeEventBatchesFn) {
            try {
                const batches = await this.#summarizeEventBatchesFn(items, this.#maxEventBatchSize, now);
                return batches.map((batch) => {
                    const startAge = formatShortRelativeTime(new Date(batch.startTime), now);
                    const endAge = formatShortRelativeTime(new Date(batch.endTime), now);
                    return `[Events from ${startAge} to ${endAge} (${batch.count} events)]\n${batch.summary}`;
                });
            } catch (error) {
                logger.warn({ error, msg: 'Event summarization failed, falling back to preview format' });
            }
        }
        return items.map(item => formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now));
    }

    /**
     * The per-user calendar fetch shared by {@link loadCalendarAgenda} and
     * `#buildCalendarSection`: registered servers, then their events for `now`. Does not catch --
     * callers each apply their own error handling (the agenda primitive swallows to `[]` and logs
     * a warning; the formatted section reports a classified `[Calendar unavailable: ...]` message).
     * Assumes `this.#calendarService` is set; callers guard that first.
     */
    async #fetchCalendarEvents(userId: string, now: Date): Promise<{ events: CalendarEvent[], failed: FailedCalendarEvent[] }> {
        const servers = await this.#calendarService!.registry.getAllCalendars(userId);
        if(servers.length === 0) {
            return { events: [], failed: [] };
        }

        return this.#calendarService!.client.getContextEvents(servers, now);
    }

    async loadCalendarAgenda(userId: string, now: Date): Promise<CalendarEvent[]> {
        if(!this.#calendarService) {
            return [];
        }

        try {
            const { events } = await this.#fetchCalendarEvents(userId, now);
            return events;
        } catch (error) {
            logger.warn({ error, userId }, 'Failed to load calendar agenda');
            return [];
        }
    }

    /**
     * Build the calendar context section for a specific user.
     * Returns formatted calendar section string, or undefined if no service, no calendars,
     * or neither events nor recurrence failures were returned.
     * Appends a note when some recurring events could not be parsed.
     */
    async #buildCalendarSection(userId: string, userTimezone?: string, now: Date = new Date()): Promise<string | undefined> {
        if(!this.#calendarService) {
            return undefined;
        }

        try {
            const { events, failed } = await this.#fetchCalendarEvents(userId, now);
            if(events.length === 0 && failed.length === 0) {
                return undefined;
            }

            const calendarText = events.length === 0
                ? '## Calendar\nNo calendar events could be displayed.'
                : formatCalendarContext(events, now, resolveTimezone(userTimezone));
            return appendFailedNote(calendarText, failed);
        } catch (error) {
            logger.warn({ error, userId }, 'Failed to load calendar context');
            return `[Calendar unavailable: ${classifyCalendarError(error)}]`;
        }
    }

    /**
     * Build the calendar context section for all registered users (for perch sessions).
     * Loads all users' calendars and merges their events, using Izzy's local timezone.
     * Returns formatted calendar section string, or undefined if no service, no users,
     * or neither events nor recurrence failures were returned.
     * Appends a note when some recurring events could not be parsed.
     */
    async #buildPerchCalendarSection(now: Date = new Date()): Promise<string | undefined> {
        const calendarService = this.#calendarService;
        if(!calendarService) {
            return undefined;
        }

        try {
            const userIds = await calendarService.registry.listRegisteredUserIds();
            // Registry lookups are independent DynamoDB reads. Gather them with
            // bounded concurrency before using the stateful CalDAV client.
            const registryLimit = pLimit(8);
            // Drain every scheduled read even if one fails. Then apply the
            // original per-user failure boundary before that user's CalDAV call.
            const registryResults = await Promise.allSettled(userIds.map(userId => registryLimit(() => calendarService.registry.getAllCalendars(userId))));
            const allEvents: CalendarEvent[]       = [];
            const allFailed: FailedCalendarEvent[] = [];
            for(const registryResult of registryResults) {
                if(registryResult.status === 'rejected') {
                    throw registryResult.reason;
                }
                const servers = registryResult.value;
                if(servers.length > 0) {
                    // eslint-disable-next-line no-await-in-loop -- getContextEvents shares CalDAV client cache and consecutive-failure health state across users
                    const { events, failed } = await calendarService.client.getContextEvents(servers, now);
                    allEvents.push(...events);
                    // Stryker disable next-line ArrayMethodSwap: only allFailed.length is observed, so aggregation order is unobservable.
                    allFailed.push(...failed);
                }
            }

            if(allEvents.length === 0 && allFailed.length === 0) {
                return undefined;
            }

            const calendarText = allEvents.length === 0
                ? '## Calendar\nNo calendar events could be displayed.'
                : formatCalendarContext(allEvents, now, resolveTimezone());
            return appendFailedNote(calendarText, allFailed);
        } catch (error) {
            logger.warn({ error }, 'Failed to load perch calendar context');
            return `[Calendar unavailable: ${classifyCalendarError(error)}]`;
        }
    }

    /**
     * Build the service health section showing any degraded or offline services.
     * Returns formatted section string, or undefined if all services are online or no registry is configured.
     */

    #buildServiceHealthSection(): string | undefined {
        if(!this.#healthRegistry) {
            return undefined;
        }

        const summary = this.#healthRegistry.buildStatusSummary();
        if(summary === undefined) {
            return undefined;
        }

        return `## Service Status\n⚠️ Some services are currently unavailable:\n${summary}\nAll other services are operating normally.`;
    }

    /**
     * Build the email inbox section for perch context.
     * Returns formatted inbox section string, or undefined if no unread mail or email service unavailable.
     */
    async #buildEmailInboxSection(now: Date): Promise<string | undefined> {
        if(!this.#emailService) {
            return undefined;
        }
        try {
            const counts = await this.#emailService.wildDuckClient.getMailboxCounts('CleanInbox');
            if(counts.unseen > 0) {
                const summaries = await this.#emailService.wildDuckClient.listMessages('CleanInbox', { unseen: true });
                const inboxLines: string[] = [];
                for(const summary of summaries) {
                    const age = formatShortRelativeTime(new Date(summary.date), now);
                    const fromStr = summary.from.name ? `${summary.from.name} <${summary.from.address}>` : summary.from.address;
                    inboxLines.push(`- [CleanInbox:${summary.id}] From: ${fromStr} | Subject: ${summary.subject} | ${age}`);
                }
                return `## Inbox\nYou have mail (${counts.unseen} unread):\n${inboxLines.join('\n')}`;
            }
        } catch (error) {
            logger.warn({ error, msg: 'Email inbox fetch failed, skipping inbox section' });
        }
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
        try {
            const rejectedUids = await wildDuckClient.searchByKeyword('Drafts', 'SendRejectedByAdmin');
            const gaveUpUids   = await wildDuckClient.searchByKeyword('Drafts', 'DiscordNotifyGaveUp');

            const sections: string[] = [];

            const rejectedSubsection = await buildAdminRejectedSubsection(rejectedUids, wildDuckClient);
            if(rejectedSubsection) {
                // Stryker disable next-line ArrayMethodSwap: sections is newly allocated, so this first insertion has the same order.
                sections.push(rejectedSubsection);
            }

            const gaveUpSubsection = await buildGaveUpSubsection(gaveUpUids, wildDuckClient);
            if(gaveUpSubsection) {
                sections.push(gaveUpSubsection);
            }

            return sections.join('\n\n');
        } catch (err) {
            logger.warn({ err, msg: 'Failed to load rejected draft context' });
        }
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

        try {
            const result = await this.#bskyDMService.client.listConversations(undefined, undefined, 'unread');
            // Stryker disable next-line llm: convos is only read (length, reduce, map) and never escapes, so a shallow copy is observationally equivalent
            const convos = result.conversations;

            if(convos.length === 0) {
                return undefined;
            }

            // Count total unread messages across conversations on this page
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
            const header = `## Bluesky DMs\nYou have ${totalUnread}${hasMore ? '+' : ''} DMs: ${convoDescriptions.join('; ')}`;
            return hasMore
                ? `${header}\n(More conversations available — use Bluesky DM tools to see all)`
                : header;
        } catch (error) {
            logger.warn({ error, msg: 'Bluesky DM fetch failed, skipping DM section' });
        }
        return undefined;
    }

    /**
     * Build the rejected Bluesky posts/DMs section for perch context.
     * Returns formatted section string, or undefined if no rejections or backend unavailable.
     */
    async #buildBskyRejectedPostsSection(): Promise<string | undefined> {
        if(!this.#bskyRejectionBackend) {
            return undefined;
        }
        try {
            const items = await this.#bskyRejectionBackend.listRejections();
            if(items.length === 0) {
                return undefined;
            }

            const lines = items.map((item) => {
                if(item.type === 'reply') {
                    return [
                        `- **Reply rejected** (${item.rejectedAt}) uuid: ${item.uuid}`,
                        `  Reason: ${item.reason}`,
                        `  To: @${item.targetHandle}`,
                        `  parentUri: ${item.reply.parent.uri}`,
                        `  parentCid: ${item.reply.parent.cid}`,
                        item.reply.root ? `  rootUri: ${item.reply.root.uri}` : undefined,
                        item.reply.root ? `  rootCid: ${item.reply.root.cid}` : undefined,
                        `  Text: ${item.text}`,
                    ].filter(Boolean).join('\n');
                }
                return [
                    `- **DM rejected** (${item.rejectedAt}) uuid: ${item.uuid}`,
                    `  Reason: ${item.reason}`,
                    `  Recipients: ${JSON.stringify(item.recipientHandles)}`,
                    `  convoId: ${item.convoId}`,
                    `  Text: ${item.text}`,
                ].join('\n');
            });

            return `## Rejected Bluesky Posts/DMs\nYour admin rejected the following outbound posts or DMs. Reflect on each rejection reason — it's feedback to help you calibrate. Sometimes the right response is to revise the content and try again; other times, the lesson is that this wasn't the right moment or context to post at all. After reflecting, use \`clearRejection\` or \`clearAllRejections\` to acknowledge.\n\n${lines.join('\n\n')}`;
        } catch (err) {
            logger.warn({ err, msg: 'Failed to load rejected Bluesky posts context' });
        }
        return undefined;
    }

    async loadCoreIdentity(): Promise<string> {
        logger.debug({ msg: 'Loading core identity...' });

        // Load identity layer items (permanent, auto-loaded)
        const result = await this.#backend.listByLayer(createLayerName('identity'));

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

        const sections: string[] = [];
        let fullTierCount = 0;
        let previewTierCount = 0;

        for(const { item } of scoredItems) {
            if(fullTierCount >= this.#maxStateFullItems && previewTierCount >= this.#maxStatePreviewItems) {
                break;
            }

            if(fullTierCount < this.#maxStateFullItems) {
                // Full content tier - cap per-item content length
                let content = item.content;
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

    async loadStateTopSet(now: Date = new Date()): Promise<StateTopSetItem[]> {
        // Shared cap: must match loadHotState's own full+preview tier sizes exactly, so the
        // delta tracker never reports churn outside what loadHotState actually renders.
        const maxItems = this.#maxStateFullItems + this.#maxStatePreviewItems;
        const scoredItems = await this.#backend.getStateItemsScored({ now, maxItems });

        return scoredItems.map(({ item }) => ({ path: item.path, contentFingerprint: Bun.hash(item.content).toString() }));
    }

    async loadUserMemories(userId: string, now: Date = new Date()): Promise<string> {
        logger.debug({ userId }, 'Loading user memories');

        const result = await this.#backend.list(`/users/${userId}`);

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

            // Core reads normalize missing legacy metadata to {}, matching the schema.
            const currentAccessCount = typeof item.metadata.accessCount === 'number'
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

    async loadRecentEventsSince(windowMs: number, limit: number, now: Date = new Date()): Promise<MemoryToolItemData[]> {
        const startTime = new Date(now.getTime() - windowMs).toISOString();
        return this.#backend.searchSince(startTime, createLayerName('events'), { limit });
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
        const sections: string[] = [];
        const now = new Date();

        // 1. Time header (always first, refreshed per-message)
        // Stryker disable next-line ArrayMethodSwap: sections is newly allocated, so this first insertion has the same order.
        sections.push(formatTimeHeader(userTimezone));

        // 2. Service health status (shown early so Izzy knows which services are available)
        const healthSection = this.#buildServiceHealthSection();
        if(healthSection) {
            sections.push(healthSection);
        }

        // 3. User-specific memories (path-based)
        const userMemories = await this.loadUserMemories(userId, now);
        if(userMemories) {
            sections.push(`[About this user]\n${userMemories}`);
        }

        // 4. Calendar context (optional — skip if no calendar service configured)
        const calendarSection = await this.#buildCalendarSection(userId, userTimezone, now);
        if(calendarSection) {
            sections.push(calendarSection);
        }

        // 5. Hot state (sigmoid-scored, tiered)
        const hotState = await this.loadHotState(now);
        if(hotState) {
            sections.push(`[Current state]\n${hotState}`);
        }

        // 6. Recent events (tiered display)
        const eventsResult = await this.loadRecentEvents(
            this.#maxEventFullItems + this.#maxEventBatchSize * 4,
            now
        );
        const eventSection = await this.#buildEventSection(eventsResult, now);
        if(eventSection) {
            sections.push(`[Recent events]\n${eventSection}`);
        }

        return `${sections.join('\n\n')}\n\n`;
    }

    async #buildPerchStateSection(now: Date): Promise<string | undefined> {
        const scoredItems = await this.#backend.getStateItemsScored({ now });
        if(scoredItems.length === 0) {
            return undefined;
        }
        const stateSections: string[] = [];
        const perchStateCount = 3;
        for(const { item } of scoredItems.slice(0, perchStateCount)) {
            let content = item.content;
            if(content.length > this.#maxStateItemMaxChars) {
                content = `${content.slice(0, this.#maxStateItemMaxChars)}\n[truncated — use 'memory view ${item.path}' for full content]`;
            }
            stateSections.push(`${item.path}:\n${content}`);
        }
        return `## Recent Focus\n${stateSections.join('\n\n')}`;
    }

    async #buildPerchEventSection(now: Date): Promise<string | undefined> {
        const perchEventCount = 5;
        const eventsResult = await this.loadRecentEvents(perchEventCount, now);
        if(eventsResult.items.length === 0) {
            return undefined;
        }
        const eventSections: string[] = [];
        for(const item of eventsResult.items) {
            let content = item.content;
            if(content.length > this.#maxEventItemMaxChars) {
                content = `${content.slice(0, this.#maxEventItemMaxChars)}\n[truncated — use 'memory view ${item.path}' for full content]`;
            }
            const age = formatShortRelativeTime(new Date(item.updatedAt), now);
            eventSections.push(`${item.path} (${age}):\n${content}`);
        }
        return `## Recent Events\n${eventSections.join('\n\n')}`;
    }

    async buildPerchContext(now: Date = new Date()): Promise<string> {
        // 1. Time header (no user timezone for perch)
        const sections: string[] = [formatTimeHeader()];

        // 2. Service health status (shown early so Izzy knows which services are available)
        const healthSection = this.#buildServiceHealthSection();
        if(healthSection) {
            sections.push(healthSection);
        }

        // 3. Top state memories (full content, truncated per-item)
        const stateSection = await this.#buildPerchStateSection(now);
        if(stateSection) {
            sections.push(stateSection);
        }

        // 4. Recent events (all shown in full, no summarization)
        const eventSection = await this.#buildPerchEventSection(now);
        if(eventSection) {
            sections.push(eventSection);
        }

        // 5. Calendar context (optional — skip if no calendar service configured)
        const perchCalendarSection = await this.#buildPerchCalendarSection(now);
        if(perchCalendarSection) {
            sections.push(perchCalendarSection);
        }

        // 6. Email inbox summary (optional — skip if no email service configured)
        const inboxSection = await this.#buildEmailInboxSection(now);
        if(inboxSection) {
            sections.push(inboxSection);
        }

        // 7. Rejected drafts context (outbound emails rejected by admin)
        const rejectedDraftsSection = await this.#buildRejectedDraftSection();
        if(rejectedDraftsSection) {
            sections.push(rejectedDraftsSection);
        }

        // 8. Bluesky DM summary (optional — skip if no bsky service configured)
        const bskyDMSection = await this.#buildBskyDMSection();
        if(bskyDMSection) {
            sections.push(bskyDMSection);
        }

        // 9. Rejected Bluesky posts/DMs (admin rejections awaiting agent review)
        const bskyRejectedSection = await this.#buildBskyRejectedPostsSection();
        if(bskyRejectedSection) {
            sections.push(bskyRejectedSection);
        }

        return `${sections.join('\n\n')}\n\n`;
    }
}

/**
 * Creates a context builder for managing agent memory context
 */
export function createContextBuilder(options: ContextBuilderOptions): ContextBuilder {
    return new ContextBuilderImpl(options);
}
