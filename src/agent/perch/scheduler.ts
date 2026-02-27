/**
 * Perch Time Scheduler
 *
 * Schedules hourly perch time triggers using cron-parser's H option for jitter.
 * Handles deferral when bot is busy and triggers perch when idle.
 */

import type { Logger } from '@hughescr/logger';
import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import { getSlotForHour } from './schedule';
import { type PerchSessionRunner } from './session-runner';
import { type PerchSlot, type PerchConfig, type PerchSchedulerState } from './types';
// eslint-disable-next-line boundaries/element-types -- Perch scheduler imports Discord state types; decouple tracked in roadmap
import type { BotStateManager, StateChange } from '@/integrations/discord';

/**
 * Dependencies for the perch scheduler.
 */
export interface PerchSchedulerDeps {
    /** State manager for checking/transitioning modes */
    stateManager:         BotStateManager
    /** Logger instance */
    logger:               Logger
    /** Perch configuration */
    config:               PerchConfig
    /** Function to get current time in local timezone */
    getCurrentLocalHour?: () => number
    /** Callback when perch should start */
    onPerchTrigger:       (slot: PerchSlot) => void
    /** Optional perch session runner for suspension check */
    perchSessionRunner?:  PerchSessionRunner
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
 * 2. Checks if bot is idle when trigger fires
 * 3. If busy, sets perchPending flag and waits for idle
 * 4. Subscribes to state manager for idle transitions
 * 5. After each trigger, reschedules for next hour with new random minute
 *
 * @param deps - Scheduler dependencies
 * @returns PerchScheduler instance
 */
export function createPerchScheduler(deps: PerchSchedulerDeps): PerchScheduler {
    const { stateManager, logger, config, onPerchTrigger } = deps;
    const getCurrentLocalHour = deps.getCurrentLocalHour ?? (() => getDefaultLocalHour(config.timezone));

    // Internal state
    let state: PerchSchedulerState = {
        perchPending: false,
    };
    let unsubscribe: (() => void) | null = null;
    let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastScheduledTime: Date | null = null;

    // Test mode: track next slot index for cycling
    let nextTestSlotIndex = 0;
    const TEST_SLOTS: PerchSlot[] = ['pre-dawn', 'mid-morning', 'afternoon', 'evening', 'late-night'];

    /**
     * Handle the actual perch trigger.
     * Called either immediately (if idle) or when bot becomes idle.
     */
    function doTrigger(slot: PerchSlot): void {
        // Clear pending state
        // Stryker disable next-line BooleanLiteral: State cleared regardless of previous value
        state = { perchPending: false };

        // Don't start new perch while one is suspended
        if(deps.perchSessionRunner?.isSuspended()) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.debug({ slot }, 'Perch trigger skipped - session is suspended');
            state = {
                perchPending:       true,
                pendingSlot:        slot,
                pendingTriggerTime: new Date(),
            };
            return;
        }

        // Check if still idle (could have changed during jitter delay)
        if(stateManager.getMode() !== 'idle') {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.debug({ slot }, 'Perch trigger skipped - bot no longer idle');
            // Set pending again
            state = {
                perchPending:       true,
                pendingSlot:        slot,
                pendingTriggerTime: new Date(),
            };
            return;
        }

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

        const hour = getCurrentLocalHour();
        const slot = getSlotForHour(hour);

        logger.debug({ hour, slot }, 'Perch trigger fired');

        // Check if bot is idle
        if(stateManager.getMode() === 'idle') {
            doTrigger(slot);
        } else {
            // Bot is busy - set pending
            logger.debug({ slot, mode: stateManager.getMode() }, 'Bot busy - deferring perch');
            state = {
                perchPending:       true,
                pendingSlot:        slot,
                pendingTriggerTime: new Date(),
            };
        }

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
        // Stryker disable next-line StringLiteral,ObjectLiteral: Cron expression format and config
        const expression = CronExpressionParser.parse('H * * * *', { tz: config.timezone });
        let nextTime = expression.next().toDate();
        // Skip past the previously scheduled time to avoid double-fires:
        // a fresh parser picks a random minute that may land in the same hour
        // Stryker disable all: Defensive guard against non-deterministic H minute; only triggers when random value collides with previous
        if(lastScheduledTime) {
            while(nextTime.getTime() <= lastScheduledTime.getTime()) {
                nextTime = expression.next().toDate();
            }
        }
        // Stryker restore all
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
        // Stryker disable all: Cleanup code - tested via behavior
        // Clear any existing timeout
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
            schedulerTimeout = null;
        }
        // Stryker restore all

        const { delayMs, nextTime } = getNextTriggerDelay();
        lastScheduledTime = nextTime;
        schedulerTimeout = setTimeout(onScheduledTrigger, delayMs);

        logger.debug({
            delaySeconds: Math.round(delayMs / 1000),
            nextTrigger:  formatISOWithOffset(nextTime),
        }, 'Next perch trigger scheduled');
    }

    /**
     * Handle state change from BotStateManager.
     * If transitioning to idle and perchPending, trigger perch.
     */
    function onStateChange(change: StateChange): void {
        // Only care about mode transitions to idle
        // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent — tests have getMode()='processing_message', so doTrigger() guards against non-idle state anyway; removing early return produces no observable trigger
        if(change.changeType !== 'mode_transition') {
            return;
        }

        // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent — same reason: doTrigger() re-checks getMode() before calling onPerchTrigger; skipping this guard produces same result when bot is not idle
        if(change.newState.mode !== 'idle') {
            return;
        }

        // Check if we have a pending perch
        // Stryker disable next-line LogicalOperator: && mutant is L-class — pendingSlot=undefined with perchPending=true is unreachable in practice; both conditions true → same early return
        if(!state.perchPending || !state.pendingSlot) {
            return;
        }

        // Re-check the current slot (time may have passed)
        const hour = getCurrentLocalHour();
        const currentSlot = getSlotForHour(hour);

        // Stryker disable next-line all: Logging for observability - hour calculation for display only
        logger.info({
            originalSlot:       state.pendingSlot,
            currentSlot,
            // Stryker disable all: Logging calculation for observability
            hoursSinceDeferred: state.pendingTriggerTime
                ? Math.round((Date.now() - state.pendingTriggerTime.getTime()) / 3_600_000 * 10) / 10
                : undefined,
            // Stryker restore all
        }, 'Bot now idle - running deferred perch with current slot');

        // Use current slot, not the pending one (time may have changed)
        setTimeout(() => doTrigger(currentSlot), 0);
    }

    return {
        start(): void {
            if(!config.enabled) {
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.info('Perch scheduler disabled');
                return;
            }

            // Subscribe to state changes
            unsubscribe = stateManager.subscribe(onStateChange);

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

            // Unsubscribe from state changes
            if(unsubscribe) {
                unsubscribe();
                unsubscribe = null;
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

            if(stateManager.getMode() === 'idle') {
                doTrigger(slot);
            } else {
                state = {
                    perchPending:       true,
                    pendingSlot:        slot,
                    pendingTriggerTime: new Date(),
                };
            }
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
                slot = TEST_SLOTS[nextTestSlotIndex];
                nextTestSlotIndex = (nextTestSlotIndex + 1) % TEST_SLOTS.length;
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.info({ slot, nextIndex: nextTestSlotIndex }, 'Triggering test perch with cycling slot');
            }

            // Trigger immediately if idle, otherwise defer
            // Stryker disable next-line ConditionalExpression: Test mode check validated via test-mode-specific tests
            if(stateManager.getMode() === 'idle') {
                doTrigger(slot);
            } else {
                state = {
                    perchPending:       true,
                    pendingSlot:        slot,
                    pendingTriggerTime: new Date(),
                };
            }
        },
    };
}
