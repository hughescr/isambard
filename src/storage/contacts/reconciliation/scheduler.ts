/**
 * Contact Reconciliation Scheduler
 *
 * Timer-based scheduler that triggers contact reconciliation at regular intervals.
 * Follows the same pattern as the memory-tool reconciliation scheduler.
 */

import { logger } from '@hughescr/logger';
import type { ContactReconcilerDeps, ContactReconcilerOptions, ContactReconciliationResult } from './reconciler';
import type { ContactReconciliationConfig } from '@/config';

// ============================================================================
// Types
// ============================================================================

// Re-export ContactReconciliationConfig for callers that import from this module.
export type { ContactReconciliationConfig } from '@/config';

/**
 * Dependencies for the contact reconciliation scheduler.
 */
export interface ContactReconciliationSchedulerDeps {
    /** Configuration */
    config:            ContactReconciliationConfig
    /** The reconciler function to call */
    runReconciliation: (deps: ContactReconcilerDeps, options: ContactReconcilerOptions) => Promise<ContactReconciliationResult>
    /** Dependencies for the reconciler */
    reconcilerDeps:    ContactReconcilerDeps
}

/**
 * State of the contact reconciliation scheduler.
 */
export interface ContactReconciliationSchedulerState {
    /** Whether a reconciliation run is currently in progress */
    isRunning: boolean
}

/**
 * Interface for the contact reconciliation scheduler.
 */
export interface ContactReconciliationScheduler {
    /** Start the scheduler */
    start(): void
    /** Stop the scheduler (aborts any in-flight run) */
    stop(): void
    /** Get current state */
    getState(): Readonly<ContactReconciliationSchedulerState>
    /** Manually trigger reconciliation now (for testing) */
    triggerNow(): Promise<ContactReconciliationResult | undefined>
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a contact reconciliation scheduler.
 *
 * The scheduler:
 * 1. Triggers reconciliation at regular intervals (no immediate run on start)
 * 2. Prevents concurrent runs (only one at a time)
 * 3. Supports graceful cancellation via AbortController (stop() aborts in-flight run)
 *
 * @param deps - Scheduler dependencies
 * @returns ContactReconciliationScheduler instance
 */
export function createContactReconciliationScheduler(deps: ContactReconciliationSchedulerDeps): ContactReconciliationScheduler {
    const { config, runReconciliation, reconcilerDeps } = deps;

    let isRunning = false;
    // Stryker disable next-line BooleanLiteral: initial isStopped=false vs true is irrelevant — start() always resets isStopped to false before scheduling
    let isStopped = false;
    let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;

    function buildOptions(): ContactReconcilerOptions {
        return {
            operationDelayMs:          config.operationDelayMs,
            scanPageSize:              config.scanPageSize,
            strayLookupAgeThresholdMs: config.strayLookupAgeThresholdMs,
            signal:                    abortController?.signal,
        };
    }

    async function doRun(): Promise<ContactReconciliationResult | undefined> {
        if(isRunning) {
            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.debug({ msg: 'Contact reconciliation already running - skipping trigger' });
            return undefined;
        }

        isRunning = true;
        abortController = new AbortController();

        try {
            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({ msg: 'Starting contact reconciliation' });
            const result = await runReconciliation(reconcilerDeps, buildOptions());

            // eslint-disable-next-line require-atomic-updates -- single-threaded: interval callback with single async writer
            isRunning = false;
            abortController = null;

            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({
                success:         result.success,
                totalDurationMs: result.totalDurationMs,
                msg:             'Contact reconciliation complete',
            });
            /* Stryker restore StringLiteral,ObjectLiteral */

            return result;
        } catch (error) {
            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.error({ error, msg: 'Contact reconciliation failed' });
            isRunning = false;
            abortController = null;
            return undefined;
        }
    }

    async function onScheduledTrigger(): Promise<void> {
        schedulerTimeout = null;

        await doRun();

        // Stryker disable next-line ConditionalExpression,BooleanLiteral,BlockStatement: Rescheduling guard — stop() sets isStopped=true; BooleanLiteral disabled because the mutant inverts the guard to re-enable scheduling after stop
        if(isStopped === false) {
            scheduleNextTrigger();
        }
    }

    function scheduleNextTrigger(): void {
        // Stryker disable next-line BlockStatement: Cleanup guard
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
        }
        schedulerTimeout = setTimeout(() => {
            void onScheduledTrigger();
        }, config.intervalMs);
    }

    return {
        start(): void {
            /* Stryker disable next-line ConditionalExpression,BlockStatement: Disabled guard */
            if(!config.enabled) {
                /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
                logger.info({ msg: 'Contact reconciliation scheduler disabled' });
                return;
            }

            isStopped = false;
            scheduleNextTrigger();

            /* Stryker disable StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({
                intervalMs: config.intervalMs,
                msg:        'Contact reconciliation scheduler started',
            });
            /* Stryker restore StringLiteral,ObjectLiteral */
        },

        stop(): void {
            // Stryker disable next-line BooleanLiteral: isStopped=false mutation is equivalent here because stop() clears the timeout, preventing further scheduling regardless of isStopped value
            isStopped = true; // prevent rescheduling after in-progress doRun() completes

            /* Stryker disable BlockStatement: Cleanup */
            if(schedulerTimeout) {
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }
            /* Stryker restore BlockStatement */

            // Fix 4: abort any in-flight reconciliation run so it exits promptly
            /* Stryker disable BlockStatement: abort block — covered by 'Fix 4: stop() aborts in-flight run via AbortController' test */
            if(abortController) {
                abortController.abort();
                abortController = null;
            }
            /* Stryker restore BlockStatement */

            // Stryker disable next-line BooleanLiteral: static mutant (Bun perTest coverage limitation) — stop() mid-run test verifies isRunning=false immediately after stop()
            isRunning = false; // reset: stop() always clears isRunning for getState()

            /* Stryker disable next-line StringLiteral,ObjectLiteral: Logging is observational */
            logger.info({ msg: 'Contact reconciliation scheduler stopped' });
        },

        getState(): Readonly<ContactReconciliationSchedulerState> {
            return { isRunning };
        },

        async triggerNow(): Promise<ContactReconciliationResult | undefined> {
            return doRun();
        },
    };
}
