/**
 * Tag Index Reconciliation Scheduler
 *
 * Timer-based scheduler that triggers reconciliation at regular intervals.
 * Simpler than perch scheduler - no cron parsing, just interval timers.
 */

import { logger } from '@hughescr/logger';
import { DateTime } from 'luxon';
import type { ReconcilerDeps, ReconcilerOptions } from './reconciler';
import type { ReconciliationConfig, ReconciliationState, ReconciliationResult } from './types';

// ============================================================================
// Dependencies & Interface
// ============================================================================

/**
 * Dependencies for the reconciliation scheduler.
 */
export interface ReconciliationSchedulerDeps {
    /** Configuration */
    config:            ReconciliationConfig
    /** The reconciler function to call */
    runReconciliation: (deps: ReconcilerDeps, options: ReconcilerOptions) => Promise<ReconciliationResult>
    /** Dependencies for the reconciler */
    reconcilerDeps:    ReconcilerDeps
}

/**
 * Interface for the reconciliation scheduler.
 */
export interface ReconciliationScheduler {
    /** Start the scheduler */
    start(): void
    /** Stop the scheduler (cancels running reconciliation) */
    stop(): void
    /** Get current state */
    getState(): Readonly<ReconciliationState>
    /** Manually trigger reconciliation now (for testing) */
    triggerNow(): Promise<ReconciliationResult | undefined>
    /**
     * Signal that tag index drift was detected (e.g. BatchWriteItem returned UnprocessedItems).
     * If the scheduler is idle and started, accelerates the next reconciliation cycle.
     * Safe to call multiple times; redundant hints are coalesced into a single early trigger.
     */
    notifyDrift(): void
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a reconciliation scheduler.
 *
 * The scheduler:
 * 1. Triggers reconciliation at regular intervals
 * 2. Prevents concurrent runs (only one at a time)
 * 3. Supports graceful cancellation via AbortController
 * 4. Supports test modes (triggerOnStartup, runOnce)
 * 5. Tracks state (isRunning, runStartedAt, lastCompletedAt)
 *
 * @param deps - Scheduler dependencies
 * @returns ReconciliationScheduler instance
 */
export function createReconciliationScheduler(deps: ReconciliationSchedulerDeps): ReconciliationScheduler {
    const { config, runReconciliation, reconcilerDeps } = deps;

    // Internal state
    let state: ReconciliationState = {
        isRunning:    false,
        currentPhase: null,
    };
    let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    /** Whether a drift hint has been received since the last cycle completed */
    let driftPending = false;
    /** Whether start() has been called (used by notifyDrift to know if scheduler is active) */
    let started = false;

    /**
     * Build reconciler options from config
     */
    function buildReconcilerOptions(): ReconcilerOptions {
        return {
            operationDelayMs: config.operationDelayMs,
            scanPageSize:     config.scanPageSize,
            backoff:          config.backoff,
            signal:           abortController?.signal,
        };
    }

    /**
     * Handle the actual reconciliation trigger.
     */
    async function doTrigger(): Promise<ReconciliationResult | undefined> {
        // Check if already running
        if(state.isRunning) {
            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.debug({ msg: 'Reconciliation already running - skipping trigger' });
            return undefined;
        }

        // Set state to running
        state = {
            isRunning:    true,
            currentPhase: 'phaseA',
            runStartedAt: new Date(),
        };

        // Create AbortController for this run
        abortController = new AbortController();

        try {
            // Build options
            const options = buildReconcilerOptions();

            // Run reconciliation
            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({ msg: 'Starting scheduled reconciliation' });
            const result = await runReconciliation(reconcilerDeps, options);

            // Update state
            // eslint-disable-next-line require-atomic-updates -- single-threaded: interval callback with single async writer, no concurrent writers
            state = {
                isRunning:       false,
                currentPhase:    null,
                lastCompletedAt: new Date(),
            };

            // Reset drift flag now that a cycle has completed
            driftPending = false;

            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({
                success:         result.success,
                totalDurationMs: result.totalDurationMs,
                msg:             'Reconciliation complete',
            });
            /* Stryker restore StringLiteral,ObjectLiteral */

            // Clean up AbortController
            abortController = null;

            return result;
        } catch (error) {
            // Handle errors gracefully
            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.error({ error, msg: 'Reconciliation failed' });

            // Reset state
            state = {
                isRunning:       false,
                currentPhase:    null,
                lastCompletedAt: state.lastCompletedAt, // Preserve last success
            };

            // Reset drift flag now that a cycle has completed (even if errored).
            // Resetting allows subsequent notifyDrift() calls to accelerate the next cycle.
            // Stryker disable next-line BooleanLiteral: resetting to false is tested in the error-path drift-reset test; setting true would prevent re-acceleration after errors
            driftPending = false;

            // Clean up AbortController
            abortController = null;

            return undefined;
        }
    }

    /**
     * Handle scheduled trigger (called at intervalMs).
     */
    async function onScheduledTrigger(): Promise<void> {
        schedulerTimeout = null;

        /* Stryker disable next-line ConditionalExpression,BlockStatement: Belt-and-suspenders check; start() already guards */
        // Check if enabled
        if(!config.enabled) {
            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.debug({ msg: 'Reconciliation disabled - skipping trigger' });
            // Reschedule even if disabled to allow enabling later
            scheduleNextTrigger();
            return;
        }

        // Run reconciliation
        await doTrigger();

        // Reschedule next run (unless runOnce)
        if(!config.testMode?.runOnce) {
            scheduleNextTrigger();
        }
    }

    /**
     * Schedule the next trigger.
     */
    function scheduleNextTrigger(): void {
        // Clear any existing timeout
        // Stryker disable next-line BlockStatement: Internal timeout cleanup
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
            schedulerTimeout = null;
        }

        // Schedule next trigger
        schedulerTimeout = setTimeout(() => {
            // Use void to explicitly ignore promise
            void onScheduledTrigger();
        }, config.intervalMs);

        /* Stryker disable StringLiteral,ObjectLiteral,ArithmeticOperator,BooleanLiteral: Logging is observational */
        logger.debug({
            delayMs:     config.intervalMs,
            nextTrigger: DateTime.now().plus({ milliseconds: config.intervalMs }).toISO({ suppressMilliseconds: true }),
            msg:         'Next reconciliation scheduled',
        });
        /* Stryker restore StringLiteral,ObjectLiteral,ArithmeticOperator */
    }

    return {
        start(): void {
            /* Stryker disable next-line ConditionalExpression,BlockStatement: Enabled guard tested via integration */
            if(!config.enabled) {
                /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
                logger.info({ msg: 'Reconciliation scheduler disabled' });
                return;
            }

            started = true;

            // Check for test mode
            if(config.testMode?.triggerOnStartup) {
                /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
                logger.info({ msg: 'Reconciliation scheduler in test mode - triggering on startup' });
                // Small delay to ensure initialization
                setTimeout(() => {
                    void doTrigger();
                }, 10);
                return;
            }

            // Schedule first trigger
            scheduleNextTrigger();

            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({
                intervalMs: config.intervalMs,
                msg:        'Reconciliation scheduler started',
            });
            /* Stryker restore StringLiteral,ObjectLiteral */
        },

        stop(): void {
            /* Stryker disable BlockStatement: Cleanup is observational - verified by test tear-down */
            // Clear scheduler timeout
            if(schedulerTimeout) {
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }
            /* Stryker restore BlockStatement */

            // Abort running reconciliation
            if(abortController) {
                abortController.abort();
                abortController = null;
            }

            // Reset state
            state = {
                isRunning:    false,
                currentPhase: null,
            };

            started = false;
            driftPending = false;

            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({ msg: 'Reconciliation scheduler stopped' });
        },

        getState(): Readonly<ReconciliationState> {
            return { ...state };
        },

        async triggerNow(): Promise<ReconciliationResult | undefined> {
            return doTrigger();
        },

        notifyDrift(): void {
            // Stryker disable next-line ConditionalExpression,BlockStatement: Guard — only accelerate if scheduler is active and enabled
            if(!started || !config.enabled) {
                return;
            }

            // Stryker disable next-line ConditionalExpression,BlockStatement,LogicalOperator: Guard — already drifting or running; coalesce redundant hints. LogicalOperator (|| → &&): isRunning branch is redundant because doTrigger() already guards against double-running; both forms correctly coalesce due to clearTimeout pattern
            if(driftPending || state.isRunning) {
                return;
            }

            driftPending = true;

            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({ msg: 'Tag index drift detected — accelerating next reconciliation cycle' });

            // Clear current scheduled timeout and reschedule immediately
            // Stryker disable next-line BlockStatement: Cleanup before rescheduling
            if(schedulerTimeout) {
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }

            // Trigger as soon as the current call stack unwinds (delay=0)
            schedulerTimeout = setTimeout(() => {
                void onScheduledTrigger();
            }, 0);
        },
    };
}
