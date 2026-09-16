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
    let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    // Opaque identity changes on every start/stop transition; its numeric value is irrelevant.
    let generation: object = {};
    // stop() clears public state immediately; this remains held until aborted work actually settles.
    let activeWork: Promise<void> | null = null;

    function buildOptions(controller: AbortController): ContactReconcilerOptions {
        return {
            operationDelayMs:          config.operationDelayMs,
            scanPageSize:              config.scanPageSize,
            strayLookupAgeThresholdMs: config.strayLookupAgeThresholdMs,
            signal:                    controller.signal,
        };
    }

    function finishRun(): void {
        // activeWork serializes runs, so no newer controller can exist until this one settles.
        isRunning = false;
        abortController = null;
    }

    function releaseActiveWork(release: () => void): void {
        // The next run waits for this work to settle before replacing activeWork.
        activeWork = null;
        release();
    }

    async function doRun(): Promise<ContactReconciliationResult | undefined> {
        if(isRunning) {
            logger.debug({ msg: 'Contact reconciliation already running - skipping trigger' });
            return undefined;
        }

        if(activeWork !== null) {
            const requestedGeneration = generation;
            await activeWork;
            if(requestedGeneration !== generation) {
                return undefined;
            }
            return doRun();
        }

        let releaseWork!: () => void;
        const work = new Promise<void>((resolve) => {
            releaseWork = resolve;
        });
        activeWork = work;
        try {
            return await executeRun();
        } finally {
            releaseActiveWork(releaseWork);
        }
    }

    async function executeRun(): Promise<ContactReconciliationResult | undefined> {
        isRunning = true;
        const controller = new AbortController();
        abortController = controller;

        try {
            logger.info({ msg: 'Starting contact reconciliation' });
            const result = await runReconciliation(reconcilerDeps, buildOptions(controller));

            finishRun();

            logger.info({
                success:         result.success,
                totalDurationMs: result.totalDurationMs,
                msg:             'Contact reconciliation complete',
            });
            /* Stryker restore StringLiteral,ObjectLiteral */

            return result;
        } catch (error) {
            logger.error({ error, msg: 'Contact reconciliation failed' });
            finishRun();
            return undefined;
        }
    }

    async function onScheduledTrigger(runGeneration: object): Promise<void> {
        // A stopped pending timeout is cancelled; this callback has no await before
        // clearing its own timer, so stop cannot interleave before this point.
        schedulerTimeout = null;

        await doRun();

        if(runGeneration === generation) {
            scheduleNextTrigger();
        }
    }

    function scheduleNextTrigger(): void {
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
        }
        const runGeneration = generation;
        schedulerTimeout = setTimeout(() => {
            void onScheduledTrigger(runGeneration);
        }, config.intervalMs);
    }

    return {
        start(): void {
            if(!config.enabled) {
                logger.info({ msg: 'Contact reconciliation scheduler disabled' });
                return;
            }

            generation = {};
            scheduleNextTrigger();

            logger.info({
                intervalMs: config.intervalMs,
                msg:        'Contact reconciliation scheduler started',
            });
            /* Stryker restore StringLiteral,ObjectLiteral */
        },

        stop(): void {
            generation = {}; // prevent a stopped run from scheduling after it completes

            if(schedulerTimeout) {
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }
            // Fix 4: abort any in-flight reconciliation run so it exits promptly
            if(abortController) {
                abortController.abort();
                abortController = null;
            }
            isRunning = false; // reset: stop() always clears isRunning for getState()

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
