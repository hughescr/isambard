/**
 * Perch Time Scheduler
 *
 * Schedules hourly perch time triggers using cron-parser's H option for jitter. When an
 * `isPerchTurnRunning` predicate is supplied it defers a trigger that fires mid-turn into
 * pending state, re-checking the predicate on the next trigger; otherwise every trigger fires
 * unconditionally, leaving overlap/deferral entirely to the conductor-mode perch driver.
 */

import type { Logger } from '@hughescr/logger';
import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import { getSlotForHour } from './schedule';
import { type PerchSlot, type PerchConfig, type PerchSchedulerState } from './types';

/**
 * Dependencies for the perch scheduler.
 */
export interface PerchSchedulerDeps {
    /**
     * Optional predicate reporting whether a perch turn is currently running, read from the
     * perch ledger. When provided, a trigger (scheduled, `triggerNow`, `triggerTestPerch`) that
     * fires while it returns `true` is deferred — recorded as pending state rather than calling
     * `onPerchTrigger` — and the predicate is re-checked the next time a trigger fires. When
     * omitted, every trigger calls `onPerchTrigger` unconditionally with no check and no pending
     * state — the conductor-mode perch driver owns overlap/deferral itself (see
     * `perch-driver.ts`), so this scheduler-level gate is optional belt-and-braces only.
     */
    isPerchTurnRunning?:  () => boolean
    /** Logger instance */
    logger:               Logger
    /** Perch configuration */
    config:               PerchConfig
    /** Function to get current time in local timezone */
    getCurrentLocalHour?: () => number
    /** Callback when perch should start */
    onPerchTrigger:       (slot: PerchSlot) => void
    /**
     * Optional predicate composed from the daily cost ceiling and quota window: when it returns
     * true, a scheduled trigger skips `onPerchTrigger` without stopping the reschedule loop, so
     * either pause self-clears at its own boundary with no restart. Discord's own turns are never
     * gated by this — only perch's scheduled trigger path checks it.
     */
    isPerchPaused?:       () => boolean
}

/**
 * Interface for the perch scheduler.
 */
export interface PerchScheduler {
    /** Start the scheduler */
    start(): void
    /** Stop the scheduler */
    stop(): void
    /** Get current scheduler state (for testing/debugging) */
    getState(): Readonly<PerchSchedulerState>
    /** Manually trigger a perch check (for testing) */
    triggerNow(): void
    /** Trigger a test perch (cycles through slots or uses forceSlot) */
    triggerTestPerch(): void
}

/**
 * Get current hour in local timezone.
 * Default implementation using Luxon.
 */
function getDefaultLocalHour(timezone: string): number {
    return DateTime.now().setZone(timezone).hour;
}

/**
 * Create a perch scheduler.
 *
 * The scheduler:
 * 1. Uses cron-parser's H option for random minute scheduling
 * 2. Checks `isPerchTurnRunning()` (if supplied) when a trigger fires
 * 3. If it reports a turn already running, sets perchPending and waits for the next trigger
 * 4. After each trigger, reschedules for next hour with new random minute
 *
 * @param deps - Scheduler dependencies
 * @returns PerchScheduler instance
 */
export function createPerchScheduler(deps: PerchSchedulerDeps): PerchScheduler {
    const { isPerchTurnRunning, logger, config, onPerchTrigger } = deps;
    const getCurrentLocalHour = deps.getCurrentLocalHour ?? (() => getDefaultLocalHour(config.timezone));

    // Internal state
    let state: PerchSchedulerState = {
        perchPending: false,
    };
    let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastScheduledTime: Date | null = null;

    // Test mode: track next slot index for cycling
    let nextTestSlotIndex = 0;
    const TEST_SLOTS: PerchSlot[] = ['pre-dawn', 'mid-morning', 'afternoon', 'evening', 'late-night'];

    /**
     * Handle the actual perch trigger: fires `onPerchTrigger` immediately unless
     * `isPerchTurnRunning()` reports a perch turn already running, in which case the trigger is
     * deferred into pending state instead. Called by every trigger path (scheduled, `triggerNow`,
     * `triggerTestPerch`) — each re-checks the predicate fresh rather than caching a prior result.
     */
    function doTrigger(slot: PerchSlot): void {
        if(isPerchTurnRunning?.()) {
            logger.debug({ slot }, 'Perch trigger deferred - a perch turn is already running');
            state = {
                perchPending:       true,
                pendingSlot:        slot,
                pendingTriggerTime: new Date(),
            };
            return;
        }

        state = { perchPending: false };
        logger.info({ slot }, 'Triggering perch time');
        onPerchTrigger(slot);
    }

    /**
     * Handle scheduled trigger (called at random minute each hour).
     */
    function onScheduledTrigger(): void {
        schedulerTimeout = null;

        if(!config.enabled) {
            // Reschedule even if disabled to allow enabling later
            scheduleNextTrigger();
            return;
        }

        // Stryker disable next-line llm: deps.isPerchPaused is an optional function only (never a non-function falsy value), so `?.()` and `&& ...()` are equivalent for every reachable value
        if(deps.isPerchPaused?.()) {
            logger.debug('Perch trigger skipped - perch paused');
            scheduleNextTrigger();
            return;
        }

        const hour = getCurrentLocalHour();
        const slot = getSlotForHour(hour);

        logger.debug({ hour, slot }, 'Perch trigger fired');

        doTrigger(slot);

        // Schedule next trigger with new random minute
        scheduleNextTrigger();
    }

    /**
     * Calculate next trigger time using cron-parser's H option.
     * Skips past lastScheduledTime to prevent double-fires within the same hour
     * (a fresh parser may pick a random minute in the current hour, duplicating
     * the previous trigger).
     */
    function getNextTriggerDelay(): { delayMs: number, nextTime: Date } {
        // hashSeed uses current hour so each hourly call gets a unique deterministic seed.
        // currentDate uses new Date() (respects jest.setSystemTime) so cron-parser starts from
        // the correct time in tests instead of Luxon.DateTime.local() which bypasses fake timers.
        const now = new Date();
        const expression = CronExpressionParser.parse('H * * * *', {
            tz:          config.timezone,
            currentDate: now,
            hashSeed:    Math.floor(now.getTime() / 3_600_000).toString(),
        });
        let nextTime = expression.next().toDate();
        // Skip past the previously scheduled hour to avoid double-fires:
        // a fresh parser picks a random minute that may land in the same hour
        // as the previous trigger (H is re-randomised per parser instance).
        if(lastScheduledTime) {
            const lastHourStart = Math.floor(lastScheduledTime.getTime() / 3_600_000) * 3_600_000;
            // Stryker disable next-line NumberLiteralValue: cron 'H * * * *' candidates are minute-aligned (ms zeroed), so a 1ms shift of the hour bound is unreachable; the whole-hour guard is pinned by the hour-seed and previous-hour tests
            while(nextTime.getTime() < lastHourStart + 3_600_000) {
                nextTime = expression.next().toDate();
            }
        }
        const delayMs = Math.max(0, nextTime.getTime() - Date.now());
        return { delayMs, nextTime };
    }

    /**
     * Format a Date as ISO 8601 with UTC offset for the configured timezone.
     * e.g., "2026-02-08T18:18:00-08:00"
     */
    function formatISOWithOffset(date: Date): string {
        return DateTime.fromJSDate(date).setZone(config.timezone)
            .toISO({ suppressMilliseconds: true })!;
    }

    /**
     * Schedule the next trigger using cron-parser's H option.
     */
    function scheduleNextTrigger(): void {
        // Clear any existing timeout
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
            schedulerTimeout = null;
        }

        const { delayMs, nextTime } = getNextTriggerDelay();
        lastScheduledTime = nextTime;
        schedulerTimeout = setTimeout(onScheduledTrigger, delayMs);

        logger.debug({
            delaySeconds: Math.round(delayMs / 1000),
            nextTrigger:  formatISOWithOffset(nextTime),
        }, 'Next perch trigger scheduled');
    }

    return {
        start(): void {
            if(!config.enabled) {
                logger.info('Perch scheduler disabled');
                return;
            }

            // Skip cron scheduling if test mode is enabled
            // Stryker disable next-line llm: this value is read only inside an `if(...)` condition, where undefined and false are equally falsy, so `?? false` cannot change control flow
            if(config.testMode?.triggerOnStartup) {
                logger.info('Perch scheduler in test mode - cron scheduling disabled');

                logger.info('Test mode: triggering perch on startup');
                // Small delay to ensure bot is fully initialized
                setTimeout(() => this.triggerTestPerch(), 1000);
                return;
            }

            // Schedule first trigger using cron-parser's H option
            scheduleNextTrigger();

            logger.info({
                timezone:        config.timezone,
                intervalMinutes: config.intervalMinutes,
            }, 'Perch scheduler started with randomized hourly triggers');
        },

        stop(): void {
            // Clear scheduler timeout
            if(schedulerTimeout) {
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }

            // Clear state
            state = { perchPending: false };
            lastScheduledTime = null;

            logger.info('Perch scheduler stopped');
        },

        getState(): Readonly<PerchSchedulerState> {
            return { ...state };
        },

        triggerNow(): void {
            // For testing - trigger immediately with current slot
            const hour = getCurrentLocalHour();
            const slot = getSlotForHour(hour);

            doTrigger(slot);
        },

        triggerTestPerch(): void {
            // Determine which slot to use
            let slot: PerchSlot;

            if(config.testMode?.forceSlot) {
                // Use forced slot
                slot = config.testMode.forceSlot;
                logger.info({ slot }, 'Triggering test perch with forced slot');
            } else {
                // Cycle through slots
                // Stryker disable next-line llm: the non-null assertion is erased at compile time, and the index is only ever written as (i + 1) % TEST_SLOTS.length, so both dropping the `!` and adding a second modulo are no-ops
                slot = TEST_SLOTS[nextTestSlotIndex]!;
                nextTestSlotIndex = (nextTestSlotIndex + 1) % TEST_SLOTS.length;
                logger.info({ slot, nextIndex: nextTestSlotIndex }, 'Triggering test perch with cycling slot');
            }

            doTrigger(slot);
        },
    };
}
