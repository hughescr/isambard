/**
 * LiveSignals aggregator
 *
 * Exposes `snapshot(): Promise<Signal[]>` — a list of cheap, in-memory signals
 * representing "right now" context for idle-status generation.
 *
 * Each signal is { kind, label, content } where:
 *   kind    — identifies the signal type (e.g. 'perch', 'time', 'tool')
 *   label   — short bracket label used in the menu (e.g. 'perch')
 *   content — the body text that follows the bracket label
 *
 * Step 2 signals (in-memory only, no network):
 *   - perch            current slot hint text (or "between slots" line)
 *   - perch-next       next slot hint, prefixed with hours-until
 *   - time             time-of-day bucket (e.g. "late morning")
 *   - day              day-of-week + time-of-day descriptor
 *   - tool             most-recent tool name + relative time ago
 *   - channel          most-recent channel + relative time ago
 *   - previous         previous idle status text (anti-rut hint for Step 3)
 *
 * Step 4 signals (network-fetched, TTL-cached, feature-flag gated):
 *   - bsky-discover    top posts from Bluesky discover feed
 *   - bsky-foryou      top posts from Bluesky for-you feed
 *   - bsky-notifications  recent unread Bluesky notifications (single summary)
 *   - activity         recent activity events (auto-logged and manual logEvent)
 *
 * Time-of-day bucket mapping (24-hour local time):
 *   0–4    deep night
 *   5–6    pre-dawn
 *   7–8    early morning
 *   9–11   late morning
 *   12–13  midday
 *   14–15  early afternoon
 *   16–17  late afternoon
 *   18–20  evening
 *   21–22  late evening
 *   23     late night
 */

import { logger } from '@hughescr/logger';
import { DateTime } from 'luxon';
import { getSlotConfig, getSlotForHour, getNextSlot } from './perch/schedule';
import type { ChannelId } from './types';
import type { IdleSignalsConfig } from '@/config';
import type { BlueskyClient, BskyFeedItem, BskyNotification } from '@/integrations/bsky';
import type { MemoryToolItemData } from '@/storage';

// ============================================================================
// Public interfaces
// ============================================================================

/**
 * A single "right now" signal for idle status generation.
 */
export interface Signal {
    /** Signal type identifier (e.g. 'perch', 'tool', 'channel', 'time') */
    kind:    string
    /** Short bracket label used in the numbered menu (e.g. 'perch') */
    label:   string
    /** Body text that goes after the bracket label */
    content: string
}

/** A recent tool invocation entry. */
export interface RecentTool {
    toolName:  string
    timestamp: number
}

/** A recent channel post entry. */
export interface RecentChannel {
    channelId: ChannelId
    timestamp: number
}

/** Initial bootstrap fetch timeout (ms): wait at most this long on the very first call. */
const BOOTSTRAP_TIMEOUT_MS = 2000;

/** Give a cold signal fetch one short chance to finish without delaying idle status indefinitely. */
async function waitForBootstrap(refresh: Promise<void>): Promise<void> {
    await Promise.race([
        refresh,
        new Promise<void>((resolve) => { setTimeout(resolve, BOOTSTRAP_TIMEOUT_MS); }),
    ]);
}

/**
 * Dependencies injected into the LiveSignals aggregator.
 * All deps are synchronous or callback-based to keep snapshot() fast.
 */
export interface LiveSignalsDeps {
    /** IANA timezone name for local-time computations (e.g. 'America/Los_Angeles') */
    timezone:           string
    /** Injectable clock for tests; defaults to () => DateTime.now().setZone(timezone) */
    now?:               () => DateTime
    /** Ring-buffer reader for recent tool invocations */
    getRecentTools:     () => readonly RecentTool[]
    /** Ring-buffer reader for recent channel posts */
    getRecentChannels:  () => readonly RecentChannel[]
    /** Resolve a channel ID to a human name (e.g. '#general'); may return undefined */
    resolveChannelName: (id: ChannelId) => string | undefined
    /** Read the previous idle status text; undefined on cold start */
    getPreviousStatus:  () => string | undefined

    // ---- Step 4: network-fetched signal deps (all optional) ----

    /** Bluesky client for fetching feed and notification signals */
    bskyClient?:            BlueskyClient
    /** Feature flags and TTL overrides for network-fetched signals */
    idleSignalsConfig?:     IdleSignalsConfig
    /**
     * Callback for loading recent activity log events.
     * Receives a limit; returns MemoryToolItemData[] sorted ascending by updatedAt.
     */
    loadRecentActivityLog?: (limit: number) => Promise<MemoryToolItemData[]>
}

/**
 * Internal extension of LiveSignalsDeps for test injection.
 * Adds the injectable clock for TTL math — NOT exported from the barrel
 * so the `nowMs` field is not part of the public API surface.
 */
export interface LiveSignalsDepsInternal extends LiveSignalsDeps {
    /** Injectable "current wall-clock ms" for TTL math in tests */
    nowMs?: () => number
}

// ============================================================================
// Time-of-day bucket mapping
// ============================================================================

/**
 * Map a local hour (0–23) to a short time-of-day descriptor string.
 *
 * Bucket boundaries:
 *   0–4    deep night
 *   5–6    pre-dawn
 *   7–8    early morning
 *   9–11   late morning
 *   12–13  midday
 *   14–15  early afternoon
 *   16–17  late afternoon
 *   18–20  evening
 *   21–22  late evening
 *   23     late night
 */
function timeOfDayBucket(hour: number): string {
    if(hour <= 4) {
        return 'deep night';
    }
    if(hour <= 6) {
        return 'pre-dawn';
    }
    if(hour <= 8) {
        return 'early morning';
    }
    if(hour <= 11) {
        return 'late morning';
    }
    if(hour <= 13) {
        return 'midday';
    }
    if(hour <= 15) {
        return 'early afternoon';
    }
    if(hour <= 17) {
        return 'late afternoon';
    }
    if(hour <= 20) {
        return 'evening';
    }
    if(hour <= 22) {
        return 'late evening';
    }
    return 'late night';
}

/**
 * Day-of-week names (Luxon uses 1=Monday … 7=Sunday).
 */
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
// Stryker restore StringLiteral,ArrayDeclaration

/**
 * Format a relative duration in milliseconds as a short human string.
 * Returns strings like "3m ago", "1h ago", "just now".
 */
function relativeTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if(seconds < 60) {
        return 'just now';
    }
    const minutes = Math.floor(seconds / 60);
    if(minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

// ============================================================================
// Step 4 helpers
// ============================================================================

/** Maximum character length for a bsky post snippet in a signal. */
const BSKY_SNIPPET_MAX_CHARS = 120;

/**
 * Format a BskyFeedItem as a short signal content string.
 * Strips newlines, truncates to BSKY_SNIPPET_MAX_CHARS, appends author handle.
 */
function formatFeedItemContent(item: BskyFeedItem): string {
    const text = item.post.text.replaceAll('\n', ' ').trim();
    const snippet = text.length > BSKY_SNIPPET_MAX_CHARS
        ? `${text.slice(0, BSKY_SNIPPET_MAX_CHARS)}…`
        : text;
    const handle = item.post.author.handle;
    return `"${snippet}" — @${handle}`;
    // Stryker restore all
}

/**
 * Summarise a list of BskyNotification objects into a single short string.
 * Returns undefined when there are no notifications.
 */
function summariseNotifications(notifications: BskyNotification[]): string | undefined {
    // Count by reason; mention/reply/quote are grouped as "mentions" in the summary
    const mentionCount = notifications.filter(n => n.reason === 'mention' || n.reason === 'reply' || n.reason === 'quote').length;
    const likeCount    = notifications.filter(n => n.reason === 'like').length;
    const repostCount  = notifications.filter(n => n.reason === 'repost').length;
    const followCount  = notifications.filter(n => n.reason === 'follow').length;

    const parts: string[] = [];
    if(mentionCount > 0) {
        // Stryker disable next-line ArrayMethodSwap: mention is the first possible part, so push and unshift both insert at index 0.
        parts.push(`${mentionCount} mention${mentionCount === 1 ? '' : 's'}`);
    }
    if(likeCount > 0) {
        parts.push(`${likeCount} like${likeCount === 1 ? '' : 's'}`);
    }
    if(repostCount > 0) {
        parts.push(`${repostCount} repost${repostCount === 1 ? '' : 's'}`);
    }
    if(followCount > 0) {
        parts.push(`${followCount} new follower${followCount === 1 ? '' : 's'}`);
    }

    if(parts.length === 0) {
        return undefined;
    }

    // Most recent notification author, if any
    const sorted = notifications.toSorted((a, b) => b.indexedAt.localeCompare(a.indexedAt));
    const latest = sorted[0]!;
    return `${parts.join(', ')} — latest from @${latest.author.handle}`;
    // Stryker restore all
}

/**
 * Generic TTL cache for a list of items.
 */
interface TtlCache<T> {
    items:     T[]
    fetchedAt: number
}

// ============================================================================
// LiveSignals class
// ============================================================================

/**
 * Aggregates cheap in-memory signals for idle status generation.
 *
 * Construct via `new LiveSignals(deps)` and call `snapshot()` to get the
 * current signal list.  Each call to `snapshot()` re-reads all sources;
 * there is no internal caching.
 *
 * `snapshot()` is fail-soft: if any individual signal source throws, that
 * signal is omitted and a debug log is emitted, but the remaining signals
 * are still returned.
 */
export class LiveSignals {
    private readonly deps: LiveSignalsDepsInternal;

    // Step 4 TTL caches
    private discoverCache:      TtlCache<BskyFeedItem> | undefined;
    private forYouCache:        TtlCache<BskyFeedItem> | undefined;
    private notificationsCache: TtlCache<BskyNotification> | undefined;
    private activityCache:      TtlCache<MemoryToolItemData> | undefined;

    // In-flight refresh promises (prevents duplicate concurrent fetches)
    private discoverInFlight:      Promise<void> | undefined;
    private forYouInFlight:        Promise<void> | undefined;
    private notificationsInFlight: Promise<void> | undefined;
    private activityInFlight:      Promise<void> | undefined;

    constructor(deps: LiveSignalsDeps | LiveSignalsDepsInternal) {
        this.deps = deps;
    }

    /**
     * Returns the current signal list.
     *
     * Uses Promise.allSettled internally so one failing signal source does
     * not prevent the others from being returned.
     */
    async snapshot(): Promise<Signal[]> {
        // Wrap each synchronous builder in a try-catch before passing to
        // allSettled so that synchronous throws are captured as rejections.
        const wrap = (fn: () => Signal | undefined): Promise<Signal | undefined> => {
            try {
                return Promise.resolve(fn());
            } catch (err) {
                // err is unknown here; wrap in Error if needed for the reject chain
                // The allSettled catch branch logs result.reason as a string anyway
                return Promise.reject(err instanceof Error ? err : new Error(String(err)));
            }
        };

        const results = await Promise.allSettled([
            wrap(() => this.perchSignal()),
            wrap(() => this.perchNextSignal()),
            wrap(() => this.timeSignal()),
            wrap(() => this.daySignal()),
            wrap(() => this.toolSignal()),
            wrap(() => this.channelSignal()),
            wrap(() => this.previousSignal()),
            // Step 4: network-fetched signals (async, TTL-cached)
            this.bskyDiscoverSignals(),
            this.bskyForYouSignals(),
            this.bskyNotificationsSignal(),
            this.activitySignals(),
        ]);

        return this.collectResults(results);
    }

    /**
     * Collect fulfilled results from allSettled, flattening arrays, and log failures.
     */
    private collectResults(
        results: PromiseSettledResult<Signal | Signal[] | undefined>[]
    ): Signal[] {
        const signals: Signal[] = [];
        for(const result of results) {
            if(result.status === 'fulfilled') {
                this.appendSignalValue(signals, result.value);
            } else {
                logger.debug({
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                    msg:   'LiveSignals: signal source threw, omitting',
                });
            }
        }
        return signals;
    }

    /**
     * Append a single signal, an array of signals, or nothing (undefined) to the accumulator.
     */
    private appendSignalValue(signals: Signal[], value: Signal | Signal[] | undefined): void {
        if(value === undefined) {
            return;
        }
        if(Array.isArray(value)) {
            for(const s of value) {
                signals.push(s);
            }
        } else {
            signals.push(value);
        }
    }

    // -------------------------------------------------------------------------
    // Private signal builders
    // -------------------------------------------------------------------------

    private getNow(): DateTime {
        const { now, timezone } = this.deps;
        return now ? now() : DateTime.now().setZone(timezone);
    }

    private getNowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    private perchSignal(): Signal {
        const dt = this.getNow();
        const slot = getSlotForHour(dt.hour);
        const config = getSlotConfig(slot);
        const content = config ? config.hint : 'between scheduled slots';
        return {
            kind:  'perch',
            label: 'perch',
            content,
        };
    }

    private perchNextSignal(): Signal | undefined {
        const dt = this.getNow();
        const nextSlot = getNextSlot(dt.hour);
        const nextConfig = getSlotConfig(nextSlot);
        if(!nextConfig) {
            return undefined;
        }

        // Compute hours until next slot starts
        const hoursUntil = ((nextConfig.startHour - dt.hour + 23) % 24) + 1;
        const prefix = `next slot in ${hoursUntil}h:`;
        return {
            kind:    'perch-next',
            label:   'perch-next',
            content: `${prefix} ${nextConfig.hint}`,
        };
    }

    private timeSignal(): Signal {
        const dt = this.getNow();
        return {
            kind:    'time',
            label:   'time',
            content: timeOfDayBucket(dt.hour),
        };
    }

    private daySignal(): Signal {
        const dt = this.getNow();
        // Luxon weekday: 1=Monday … 7=Sunday
        const dayIndex = dt.weekday - 1;
        const dayName = DAY_NAMES[dayIndex] ?? 'Monday';
        const timeBucket = timeOfDayBucket(dt.hour);
        return {
            kind:    'day',
            label:   'day',
            content: `${timeBucket} on a ${dayName}`,
        };
    }

    private toolSignal(): Signal | undefined {
        // Stryker disable next-line llm: the dependency contract requires an array, and the runtime producer always returns its array buffer, so `|| []` is inert.
        const tools = this.deps.getRecentTools();
        const latest = tools[tools.length - 1] ?? tools[0];
        if(!latest) {
            return undefined;
        }
        const ago = relativeTime(this.getNowMs() - latest.timestamp);
        return {
            kind:    'tool',
            label:   'tool',
            content: `${ago}: ${latest.toolName}`,
        };
    }

    private channelSignal(): Signal | undefined {
        const channels = this.deps.getRecentChannels();
        const latest = channels[channels.length - 1] ?? channels[0];
        if(!latest) {
            return undefined;
        }
        const name = this.deps.resolveChannelName(latest.channelId);
        const displayName = name === undefined ? `#?${latest.channelId}` : `#${name}`;
        const ago = relativeTime(this.getNowMs() - latest.timestamp);
        return {
            kind:    'channel',
            label:   'channel',
            content: `${ago}: ${displayName}`,
        };
    }

    private previousSignal(): Signal | undefined {
        const prev = this.deps.getPreviousStatus();
        if(prev === undefined) {
            return undefined;
        }
        return {
            kind:    'previous',
            label:   'previous',
            content: prev,
        };
    }

    // -------------------------------------------------------------------------
    // Step 4: TTL-cached network signal helpers
    // -------------------------------------------------------------------------

    /**
     * Read from a TTL cache.
     *
     * @param cache   - Current cache state (undefined = never fetched)
     * @param ttlMs   - Cache TTL in milliseconds
     * @param nowMs   - Current wall-clock time
     * @returns The cached items if still fresh; undefined if stale or cold
     */
    private readCache<T>(
        cache: TtlCache<T> | undefined,
        ttlMs: number,
        nowMs: number
    ): T[] | undefined {
        if(cache === undefined) {
            return undefined;
        }
        if(nowMs - cache.fetchedAt > ttlMs) {
            return undefined;   // stale
        }
        return cache.items;
    }

    /**
     * Returns cached bsky-discover feed items as Signals.
     *
     * If no cache exists yet, awaits the first fetch with a short timeout
     * (BOOTSTRAP_TIMEOUT_MS) so the very first idle snapshot can include data.
     * If the cache is stale, returns the stale items immediately and kicks
     * a background refresh.  If the cache is fresh, returns it directly.
     */
    private async bskyDiscoverSignals(): Promise<Signal[] | undefined> {
        const { bskyClient, idleSignalsConfig } = this.deps;
        if(!bskyClient || !idleSignalsConfig?.bskyDiscoverEnabled) {
            return undefined;
        }

        const ttlMs = idleSignalsConfig.bskyDiscoverCacheMs;
        const nowMs = this.getNowMs();
        const cached = this.readCache(this.discoverCache, ttlMs, nowMs);

        if(cached !== undefined) {
            // Fresh cache hit — no refresh needed
            return cached.map(item => ({
                kind:    'bsky-discover',
                label:   'bsky-discover',
                content: formatFeedItemContent(item),
            }));
        }

        if(this.discoverCache !== undefined) {
            // Stale: kick background refresh and return the stale data immediately
            void (this.discoverInFlight ?? this.startDiscoverRefresh(bskyClient));
            return this.discoverCache.items.map(item => ({
                kind:    'bsky-discover',
                label:   'bsky-discover',
                content: formatFeedItemContent(item),
            }));
        }

        // Cold start: await first fetch with timeout
        await waitForBootstrap(this.discoverInFlight ?? this.startDiscoverRefresh(bskyClient));

        const afterWait = this.readCache<BskyFeedItem>(this.discoverCache, ttlMs, this.getNowMs());
        if(afterWait === undefined) {
            return [];
        }
        return afterWait.map(item => ({
            kind:    'bsky-discover',
            label:   'bsky-discover',
            content: formatFeedItemContent(item),
        }));
    }

    private startDiscoverRefresh(bskyClient: BlueskyClient): Promise<void> {
        const promise = (async () => {
            try {
                const result = await bskyClient.getFeed('discover', 5);
                this.discoverCache = { items: result.items, fetchedAt: this.getNowMs() };
            } catch (err: unknown) {
                logger.debug({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'LiveSignals: bsky-discover fetch failed',
                });
            } finally {
                this.discoverInFlight = undefined;
            }
        })();
        this.discoverInFlight = promise;
        return promise;
    }

    /**
     * Returns cached bsky-foryou feed items as Signals.
     * Same TTL + first-call-await semantics as bskyDiscoverSignals.
     */
    private async bskyForYouSignals(): Promise<Signal[] | undefined> {
        const { bskyClient, idleSignalsConfig } = this.deps;
        if(!bskyClient || !idleSignalsConfig?.bskyForYouEnabled) {
            return undefined;
        }

        const ttlMs = idleSignalsConfig.bskyForYouCacheMs;
        const nowMs = this.getNowMs();
        const cached = this.readCache(this.forYouCache, ttlMs, nowMs);

        if(cached !== undefined) {
            return cached.map(item => ({
                kind:    'bsky-foryou',
                label:   'bsky-foryou',
                content: formatFeedItemContent(item),
            }));
        }

        if(this.forYouCache !== undefined) {
            void (this.forYouInFlight ?? this.startForYouRefresh(bskyClient));
            return this.forYouCache.items.map(item => ({
                kind:    'bsky-foryou',
                label:   'bsky-foryou',
                content: formatFeedItemContent(item),
            }));
        }

        await waitForBootstrap(this.forYouInFlight ?? this.startForYouRefresh(bskyClient));

        const afterWait = this.readCache<BskyFeedItem>(this.forYouCache, ttlMs, this.getNowMs());
        if(afterWait === undefined) {
            return [];
        }
        return afterWait.map(item => ({
            kind:    'bsky-foryou',
            label:   'bsky-foryou',
            content: formatFeedItemContent(item),
        }));
    }

    private startForYouRefresh(bskyClient: BlueskyClient): Promise<void> {
        const promise = (async () => {
            try {
                const result = await bskyClient.getFeed('for-you', 10);
                this.forYouCache = { items: result.items, fetchedAt: this.getNowMs() };
            } catch (err: unknown) {
                logger.debug({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'LiveSignals: bsky-foryou fetch failed',
                });
            } finally {
                this.forYouInFlight = undefined;
            }
        })();
        this.forYouInFlight = promise;
        return promise;
    }

    /**
     * Returns a single bsky-notifications signal summarising recent notifications.
     * Same TTL + first-call-await semantics as feed signals.
     */
    private async bskyNotificationsSignal(): Promise<Signal | undefined> {
        const { bskyClient, idleSignalsConfig } = this.deps;
        if(!bskyClient || !idleSignalsConfig?.bskyNotificationsEnabled) {
            return undefined;
        }

        const ttlMs = idleSignalsConfig.bskyNotificationsCacheMs;
        const nowMs = this.getNowMs();
        const cached = this.readCache(this.notificationsCache, ttlMs, nowMs);

        if(cached !== undefined) {
            const summary = summariseNotifications(cached);
            if(summary === undefined) {
                return undefined;
            }
            return { kind: 'bsky-notifications', label: 'bsky-notifications', content: summary };
        }

        if(this.notificationsCache !== undefined) {
            void (this.notificationsInFlight ?? this.startNotificationsRefresh(bskyClient));
            const summary = summariseNotifications(this.notificationsCache.items);
            if(summary === undefined) {
                return undefined;
            }
            return { kind: 'bsky-notifications', label: 'bsky-notifications', content: summary };
        }

        await waitForBootstrap(this.notificationsInFlight ?? this.startNotificationsRefresh(bskyClient));

        const afterWait = this.readCache<BskyNotification>(this.notificationsCache, ttlMs, this.getNowMs());
        if(afterWait === undefined) {
            return undefined;
        }
        const summary = summariseNotifications(afterWait);
        if(summary === undefined) {
            return undefined;
        }
        return { kind: 'bsky-notifications', label: 'bsky-notifications', content: summary };
    }

    private startNotificationsRefresh(bskyClient: BlueskyClient): Promise<void> {
        const promise = (async () => {
            try {
                const result = await bskyClient.getNotifications(20);
                this.notificationsCache = { items: result.notifications, fetchedAt: this.getNowMs() };
            } catch (err: unknown) {
                logger.debug({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'LiveSignals: bsky-notifications fetch failed',
                });
            } finally {
                this.notificationsInFlight = undefined;
            }
        })();
        this.notificationsInFlight = promise;
        return promise;
    }

    /**
     * Returns up to 3 activity signals from the recent activity log.
     * Includes both auto-logged (/events/activity/{type}/{ts}) and manual
     * logEvent (/events/{type}/{ts}) entries. Renders each as "type relative-time ago".
     */
    private async activitySignals(): Promise<Signal[] | undefined> {
        const { loadRecentActivityLog, idleSignalsConfig } = this.deps;
        if(!loadRecentActivityLog || !idleSignalsConfig?.activityLogEnabled) {
            return undefined;
        }

        const ttlMs = idleSignalsConfig.activityLogCacheMs;
        const nowMs = this.getNowMs();
        const cached = this.readCache(this.activityCache, ttlMs, nowMs);

        if(cached !== undefined) {
            return this.buildActivitySignals(cached);
        }

        if(this.activityCache !== undefined) {
            void (this.activityInFlight ?? this.startActivityRefresh(loadRecentActivityLog));
            return this.buildActivitySignals(this.activityCache.items);
        }

        await waitForBootstrap(this.activityInFlight ?? this.startActivityRefresh(loadRecentActivityLog));

        const afterWait = this.readCache<MemoryToolItemData>(this.activityCache, ttlMs, this.getNowMs());
        if(afterWait === undefined) {
            return [];
        }
        return this.buildActivitySignals(afterWait);
    }

    private buildActivitySignals(items: MemoryToolItemData[]): Signal[] {
        const nowMs = this.getNowMs();
        // Take the last 3 items (most recent in ascending sort). No tag filter —
        // the 2-hour window query already scopes to the events layer and includes
        // both auto-logged (/events/activity/{type}/{ts}) and manual (/events/{type}/{ts}) entries.
        const recent = items.slice(-3);
        const signals: Signal[] = [];
        for(const item of recent) {
            const pathParts = item.path.split('/');
            // Auto-logged activity uses the established exact five-part namespace.
            // A five-part manual eventType beginning "activity/" is inherently
            // ambiguous and retains that pre-existing auto interpretation.
            const isAutoLoggedActivity = pathParts.length === 5 && pathParts[2] === 'activity';
            const isManualEvent = pathParts.length >= 4 && pathParts[1] === 'events';
            let activityType = pathParts[2] ?? 'event';
            if(isAutoLoggedActivity) {
                activityType = pathParts[3]!;
            } else if(isManualEvent) {
                activityType = pathParts.slice(2, -1).join('/') || 'event';
            }
            const updatedMs = new Date(item.updatedAt).getTime();
            const ago = relativeTime(nowMs - updatedMs);
            signals.push({
                kind:    'activity',
                label:   'activity',
                content: `${activityType} ${ago}`,
            });
        }
        return signals;
    }

    private startActivityRefresh(loadFn: (limit: number) => Promise<MemoryToolItemData[]>): Promise<void> {
        const promise = (async () => {
            try {
                const items = await loadFn(10);
                this.activityCache = { items, fetchedAt: this.getNowMs() };
            } catch (err: unknown) {
                logger.debug({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'LiveSignals: activity-log fetch failed',
                });
            } finally {
                this.activityInFlight = undefined;
            }
        })();
        this.activityInFlight = promise;
        return promise;
    }
}
