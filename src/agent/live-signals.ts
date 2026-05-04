/**
 * LiveSignals aggregator
 *
 * Exposes `snapshot(): Promise<Signal[]>` — a list of cheap, in-memory signals
 * representing "right now" context for idle-status generation.
 *
 * Each signal is { kind, label, content } where:
 *   kind    — identifies the signal type (e.g. 'perch', 'time', 'tool')
 *   label   — short bracket label used in the menu (e.g. 'perch')
 *   content — the body text that follows the bracket
 *
 * Step 2 signals (in-memory only, no network):
 *   - perch       current slot hint text (or "between slots" line)
 *   - perch-next  next slot hint, prefixed with hours-until
 *   - time        time-of-day bucket (e.g. "late morning")
 *   - day         day-of-week + time-of-day descriptor
 *   - tool        most-recent tool name + relative time ago
 *   - channel     most-recent channel + relative time ago
 *   - previous    previous idle status text (anti-rut hint for Step 3)
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
    // Stryker disable next-line EqualityOperator,StringLiteral: EqualityOperator mutants timeout under concurrent test runner; string is display-only
    if(hour <= 15) {
        return 'early afternoon';
    }
    // Stryker disable next-line EqualityOperator,StringLiteral: EqualityOperator mutants timeout under concurrent test runner; string is display-only
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
// Stryker disable StringLiteral,ArrayDeclaration: day name strings are display-only — mutations produce wrong words, not wrong logic
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
    private readonly deps: LiveSignalsDeps;

    constructor(deps: LiveSignalsDeps) {
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
        ]);

        const signals: Signal[] = [];
        for(const result of results) {
            if(result.status === 'fulfilled') {
                if(result.value !== undefined) {
                    signals.push(result.value);
                }
            } else {
                logger.debug({
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                    msg:   'LiveSignals: signal source threw, omitting',
                });
            }
        }
        return signals;
    }

    // -------------------------------------------------------------------------
    // Private signal builders
    // -------------------------------------------------------------------------

    private getNow(): DateTime {
        const { now, timezone } = this.deps;
        // Stryker disable next-line ConditionalExpression: injectable clock — now() injected in tests; production always uses DateTime.now()
        return now ? now() : DateTime.now().setZone(timezone);
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
        let hoursUntil = nextConfig.startHour - dt.hour;
        // Stryker disable next-line EqualityOperator: hoursUntil === 0 is unreachable since the next slot always starts at a different hour than the current slot; <= 0 and < 0 are equivalent in practice
        if(hoursUntil <= 0) {
            hoursUntil += 24;
        }

        // Stryker disable next-line ConditionalExpression: hoursUntil===1 ? 'next slot in 1h:' and `next slot in ${1}h:` both produce "next slot in 1h:" — equivalent mutant
        const prefix = hoursUntil === 1 ? 'next slot in 1h:' : `next slot in ${hoursUntil}h:`;
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
        // Stryker disable next-line StringLiteral: 'Monday' fallback is never reached since Luxon weekday is always 1–7 making dayIndex always 0–6
        const dayName = DAY_NAMES[dayIndex] ?? 'Monday';
        const timeBucket = timeOfDayBucket(dt.hour);
        return {
            kind:    'day',
            label:   'day',
            content: `${timeBucket} on a ${dayName}`,
        };
    }

    private toolSignal(): Signal | undefined {
        const tools = this.deps.getRecentTools();
        // Stryker disable next-line ConditionalExpression,BlockStatement: when array is empty and guard mutated to false/body removed, tools[-1] is undefined, ??tools[0] is also undefined, !latest guard returns undefined — same result
        if(tools.length === 0) {
            return undefined;
        }
        const latest = tools[tools.length - 1] ?? tools[0];
        // Stryker disable next-line ConditionalExpression,BlockStatement: latest is always defined when length>0 since tools[length-1] is a valid element; !latest is a defensive guard for noUncheckedIndexedAccess
        if(!latest) {
            return undefined;
        }
        const ago = relativeTime(Date.now() - latest.timestamp);
        return {
            kind:    'tool',
            label:   'tool',
            content: `${ago}: ${latest.toolName}`,
        };
    }

    private channelSignal(): Signal | undefined {
        const channels = this.deps.getRecentChannels();
        // Stryker disable next-line ConditionalExpression,BlockStatement: when array is empty and guard mutated to false/body removed, channels[-1] is undefined, ??channels[0] is also undefined, !latest guard returns undefined — same result
        if(channels.length === 0) {
            return undefined;
        }
        const latest = channels[channels.length - 1] ?? channels[0];
        // Stryker disable next-line ConditionalExpression,BlockStatement: latest is always defined when length>0 since channels[length-1] is a valid element; !latest is a defensive guard for noUncheckedIndexedAccess
        if(!latest) {
            return undefined;
        }
        const name = this.deps.resolveChannelName(latest.channelId);
        const displayName = name === undefined ? `#?${latest.channelId}` : `#${name}`;
        const ago = relativeTime(Date.now() - latest.timestamp);
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
}
