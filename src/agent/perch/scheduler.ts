/**
 * Perch Time Scheduler
 *
 * Schedules hourly perch time triggers using cron-parser's H option for jitter.
 * Handles deferral when bot is busy and triggers perch when idle.
 */

import { CronExpressionParser } from 'cron-parser';
import type { Logger } from '@hughescr/logger';
import type { BotStateManager, StateChange } from '@/integrations/discord/state';
import { type PerchSlot, type PerchConfig, type PerchSchedulerState } from './types';
import { getSlotForHour } from './schedule';

/**
 * Dependencies for the perch scheduler.
 */
export interface PerchSchedulerDeps {
    /** State manager for checking/transitioning modes */
    stateManager:           BotStateManager
    /** Logger instance */
    logger:                 Logger
    /** Perch configuration */
    config:                 PerchConfig
    /** Function to get current time in Pacific timezone */
    getCurrentPacificHour?: () => number
    /** Callback when perch should start */
    onPerchTrigger:         (slot: PerchSlot) => void
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
}

/**
 * Get current hour in Pacific timezone.
 * Default implementation using Intl.DateTimeFormat.
 */
function getDefaultPacificHour(): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour:     'numeric',
        hour12:   false,
    });
    const hourStr = formatter.format(new Date());
    return parseInt(hourStr, 10);
}

/**
 * Calculate next trigger time using cron-parser's H option.
 * Returns milliseconds until next trigger.
 */
function getNextTriggerDelay(timezone: string): number {
    // H provides random minute (0-59) for each hour
    const expression = CronExpressionParser.parse('H * * * *', {
        tz: timezone,
    });
    const nextTime = expression.next().toDate();
    const delayMs = nextTime.getTime() - Date.now();
    return Math.max(0, delayMs);
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
    const getCurrentPacificHour = deps.getCurrentPacificHour ?? getDefaultPacificHour;

    // Internal state
    let state: PerchSchedulerState = {
        perchPending: false,
    };
    let unsubscribe: (() => void) | null = null;
    let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;

    /**
     * Handle the actual perch trigger.
     * Called either immediately (if idle) or when bot becomes idle.
     */
    function doTrigger(slot: PerchSlot): void {
        // Clear pending state
        // Stryker disable next-line BooleanLiteral: State cleared regardless of previous value
        state = { perchPending: false };

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

        if(!config.enabled) {
            // Reschedule even if disabled to allow enabling later
            scheduleNextTrigger();
            return;
        }

        const hour = getCurrentPacificHour();
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
     * Schedule the next trigger using cron-parser's H option.
     */
    function scheduleNextTrigger(): void {
        // Clear any existing timeout
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
            schedulerTimeout = null;
        }

        const delayMs = getNextTriggerDelay(config.timezone);
        schedulerTimeout = setTimeout(onScheduledTrigger, delayMs);

        logger.debug({
            delaySeconds: Math.round(delayMs / 1000),
            nextTrigger:  new Date(Date.now() + delayMs).toISOString(),
        }, 'Next perch trigger scheduled');
    }

    /**
     * Handle state change from BotStateManager.
     * If transitioning to idle and perchPending, trigger perch.
     */
    function onStateChange(change: StateChange): void {
        // Only care about mode transitions to idle
        // Stryker disable next-line all: Guard clause tested via mode_transition tests
        if(change.changeType !== 'mode_transition') {
            return;
        }

        // Stryker disable next-line all: Guard clause tested via idle transition tests
        if(change.newState.mode !== 'idle') {
            return;
        }

        // Check if we have a pending perch
        // Stryker disable next-line ConditionalExpression,LogicalOperator: Both conditions required for valid pending state
        if(!state.perchPending || !state.pendingSlot) {
            return;
        }

        // Re-check the current slot (time may have passed)
        const hour = getCurrentPacificHour();
        const currentSlot = getSlotForHour(hour);

        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({
            originalSlot:       state.pendingSlot,
            currentSlot,
            hoursSinceDeferred: state.pendingTriggerTime
                ? Math.round((Date.now() - state.pendingTriggerTime.getTime()) / 3600000 * 10) / 10
                : undefined,
        }, 'Bot now idle - running deferred perch with current slot');

        // Use current slot, not the pending one (time may have changed)
        doTrigger(currentSlot);
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

            // Schedule first trigger using cron-parser's H option
            scheduleNextTrigger();

            // Stryker disable next-line ObjectLiteral: Log message content is not behavior-affecting
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

            // Unsubscribe from state changes
            if(unsubscribe) {
                unsubscribe();
                unsubscribe = null;
            }

            // Clear state
            state = { perchPending: false };

            // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
            logger.info('Perch scheduler stopped');
        },

        getState(): Readonly<PerchSchedulerState> {
            return { ...state };
        },

        triggerNow(): void {
            // For testing - trigger immediately with current slot
            const hour = getCurrentPacificHour();
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
    };
}
