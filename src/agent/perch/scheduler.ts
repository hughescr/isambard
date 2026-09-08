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
import { InvariantViolationError } from '@/errors';

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
     * Optional Q3/B4 daily cost ceiling predicate: when it returns true, a scheduled trigger
     * skips `onPerchTrigger` without stopping the reschedule loop, so the pause self-clears at
     * local midnight with no restart. Discord's own turns are never gated by this — only perch's
     * scheduled trigger path checks it.
     */
    isCostPaused?:        () => boolean
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
// Stryker disable next-line BlockStatement: Config values for timezone API - not testable with fake timers
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
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.debug({ slot }, 'Perch trigger deferred - a perch turn is already running');
            state = {
                perchPending:       true,
                pendingSlot:        slot,
                pendingTriggerTime: new Date(),
            };
            return;
        }

        state = { perchPending: false };
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ slot }, 'Triggering perch time');
        onPerchTrigger(slot);
    }

    /**
     * Handle scheduled trigger (called at random minute each hour).
     */
    function onScheduledTrigger(): void {
        schedulerTimeout = null;

        // Stryker disable next-line ConditionalExpression,BlockStatement: Tested via behavior - scheduler reschedules when disabled
        if(!config.enabled) {
            // Reschedule even if disabled to allow enabling later
            scheduleNextTrigger();
            return;
        }

        if(deps.isCostPaused?.()) {
            logger.debug('Perch trigger skipped - cost ceiling reached');
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
        // Stryker disable next-line StringLiteral,ObjectLiteral: Cron expression format and config
        const expression = CronExpressionParser.parse('H * * * *', {
            tz:          config.timezone,
            currentDate: now,
            // Stryker disable next-line ArithmeticOperator: hour-bucketed seed — division is intentional to group by hour; any numeric seed is valid (static NoCoverage)
            hashSeed:    Math.floor(now.getTime() / 3_600_000).toString(),
        });
        let nextTime = expression.next().toDate();
        // Skip past the previously scheduled hour to avoid double-fires:
        // a fresh parser picks a random minute that may land in the same hour
        // as the previous trigger (H is re-randomised per parser instance).
        // Stryker disable all: Defensive guard against non-deterministic H minute; only triggers when random value collides with previous hour
        if(lastScheduledTime) {
            const lastHourStart = Math.floor(lastScheduledTime.getTime() / 3_600_000) * 3_600_000;
            while(nextTime.getTime() < lastHourStart + 3_600_000) {
                nextTime = expression.next().toDate();
            }
        }
        // Stryker restore all
        // Stryker disable next-line ArithmeticOperator: subtraction computes ms until next fire; + mutation yields enormous delay (untestable via timer assertions without real scheduling)
        const delayMs = Math.max(0, nextTime.getTime() - Date.now());
        return { delayMs, nextTime };
    }

    /**
     * Format a Date as ISO 8601 with UTC offset for the configured timezone.
     * e.g., "2026-02-08T18:18:00-08:00"
     */
    // Stryker disable next-line BlockStatement: Date formatting helper for log output
    function formatISOWithOffset(date: Date): string {
        return DateTime.fromJSDate(date).setZone(config.timezone)
            .toISO({ suppressMilliseconds: true })!;
    }

    /**
     * Schedule the next trigger using cron-parser's H option.
     */
    // Stryker disable next-line BlockStatement: Internal scheduling function - tested via behavior
    function scheduleNextTrigger(): void {
        // Stryker disable ConditionalExpression,BlockStatement: Cleanup guard — timer null check; behavior identical if no timer pending
        // Clear any existing timeout
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
            schedulerTimeout = null;
        }
        // Stryker restore ConditionalExpression,BlockStatement

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
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Perch scheduler disabled');
                return;
            }

            // Skip cron scheduling if test mode is enabled
            if(config.testMode?.triggerOnStartup) {
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Perch scheduler in test mode - cron scheduling disabled');

                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Test mode: triggering perch on startup');
                // Small delay to ensure bot is fully initialized
                setTimeout(() => this.triggerTestPerch(), 1000);
                return;
            }

            // Schedule first trigger using cron-parser's H option
            scheduleNextTrigger();

            // Stryker disable next-line ObjectLiteral: Log message content is not behavior-affecting
            logger.info({
                timezone:        config.timezone,
                intervalMinutes: config.intervalMinutes,
            }, 'Perch scheduler started with randomized hourly triggers');
        },

        // Stryker disable next-line BlockStatement: Cleanup function tested via behavior
        stop(): void {
            // Clear scheduler timeout
            if(schedulerTimeout) {
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }

            // Clear state
            state = { perchPending: false };
            lastScheduledTime = null;

            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
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
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.info({ slot }, 'Triggering test perch with forced slot');
            } else {
                // Cycle through slots
                const nextSlot = TEST_SLOTS[nextTestSlotIndex];
                // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — nextTestSlotIndex is always modulo-bounded to TEST_SLOTS.length; unreachable in practice
                if(nextSlot === undefined) {
                    // Stryker disable next-line StringLiteral: invariant violation message — debug context only
                    throw new InvariantViolationError('triggerTestPerch', 'TEST_SLOTS[nextTestSlotIndex] undefined despite modulo bound');
                }
                slot = nextSlot;
                nextTestSlotIndex = (nextTestSlotIndex + 1) % TEST_SLOTS.length;
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.info({ slot, nextIndex: nextTestSlotIndex }, 'Triggering test perch with cycling slot');
            }

            doTrigger(slot);
        },
    };
}
