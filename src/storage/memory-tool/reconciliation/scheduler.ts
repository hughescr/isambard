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
export interface TagIndexReconciliationSchedulerDeps {
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
export interface TagIndexReconciliationScheduler {
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
 * @returns TagIndexReconciliationScheduler instance
 */
export function createTagIndexReconciliationScheduler(deps: TagIndexReconciliationSchedulerDeps): TagIndexReconciliationScheduler {
    const { config, runReconciliation, reconcilerDeps } = deps;

    // Internal state
    let state: ReconciliationState = {
        isRunning: false,
    };
    let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    /** Whether a drift hint has been received since the last cycle completed */
    let driftPending = false;
    /** Whether start() has been called (used by notifyDrift to know if scheduler is active) */
    let started = false;
    let generation: object = {};
    // stop() clears public state immediately; this remains held until aborted work actually settles.
    let activeWork: Promise<void> | null = null;

    /**
     * Build reconciler options from config
     */
    function buildReconcilerOptions(controller: AbortController): ReconcilerOptions {
        return {
            operationDelayMs:   config.operationDelayMs,
            scanPageSize:       config.scanPageSize,
            rateLimitRcuPerSec: config.rateLimitRcuPerSec,
            backoff:            config.backoff,
            signal:             controller.signal,
        };
    }

    function finishRun(controller: AbortController, completed: boolean): void {
        if(abortController !== controller) {
            return;
        }
        state = {
            isRunning:       false,
            lastCompletedAt: completed ? new Date() : state.lastCompletedAt,
        };
        driftPending = false;
        abortController = null;
    }

    function releaseActiveWork(release: () => void): void {
        // Waiters cannot replace activeWork until this promise is released.
        activeWork = null;
        release();
    }

    /**
     * Handle the actual reconciliation trigger.
     */
    async function doTrigger(): Promise<ReconciliationResult | undefined> {
        // Check if already running
        if(state.isRunning) {
            logger.debug({ msg: 'Reconciliation already running - skipping trigger' });
            return undefined;
        }

        if(activeWork !== null) {
            const requestedGeneration = generation;
            await activeWork;
            if(requestedGeneration !== generation) {
                return undefined;
            }
            return doTrigger();
        }

        let releaseWork!: () => void;
        const work = new Promise<void>((resolve) => {
            releaseWork = resolve;
        });
        activeWork = work;
        try {
            return await executeTrigger();
        } finally {
            releaseActiveWork(releaseWork);
        }
    }

    async function executeTrigger(): Promise<ReconciliationResult | undefined> {
        // Set state to running
        state = {
            isRunning:    true,
            runStartedAt: new Date(),
        };

        // Create AbortController for this run
        const controller = new AbortController();
        abortController = controller;

        try {
            // Build options
            const options = buildReconcilerOptions(controller);

            // Run reconciliation
            logger.info({ msg: 'Starting scheduled reconciliation' });
            const result = await runReconciliation(reconcilerDeps, options);

            finishRun(controller, true);

            logger.info({
                success:         result.success,
                totalDurationMs: result.totalDurationMs,
                msg:             'Reconciliation complete',
            });

            return result;
        } catch (error) {
            // Handle errors gracefully
            logger.error({ error, msg: 'Reconciliation failed' });

            finishRun(controller, false);

            return undefined;
        }
    }

    /**
     * Handle scheduled trigger (called at intervalMs).
     */
    async function onScheduledTrigger(runGeneration: object): Promise<void> {
        if(!started || runGeneration !== generation) {
            return;
        }
        schedulerTimeout = null;

        // Check if enabled
        if(!config.enabled) {
            logger.debug({ msg: 'Reconciliation disabled - skipping trigger' });
            // Reschedule even if disabled to allow enabling later
            scheduleNextTrigger();
            return;
        }

        // Run reconciliation
        await doTrigger();

        // Reschedule next run (unless runOnce)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() can change started during the awaited run
        if(started && runGeneration === generation && !config.testMode?.runOnce) {
            scheduleNextTrigger();
        }
    }

    /**
     * Schedule the next trigger.
     */
    function scheduleNextTrigger(): void {
        // Clear any existing timeout
        if(schedulerTimeout) {
            clearTimeout(schedulerTimeout);
            schedulerTimeout = null;
        }

        // Schedule next trigger
        const runGeneration = generation;
        schedulerTimeout = setTimeout(() => {
            // Use void to explicitly ignore promise
            void onScheduledTrigger(runGeneration);
        }, config.intervalMs);

        logger.debug({
            delayMs:     config.intervalMs,
            nextTrigger: DateTime.now().plus({ milliseconds: config.intervalMs }).toISO({ suppressMilliseconds: true }),
            msg:         'Next reconciliation scheduled',
        });
    }

    return {
        start(): void {
            // Stryker disable next-line llm: config.enabled is a required boolean (zod schema default), so !config.enabled and config.enabled === false are equivalent for every value
            if(!config.enabled) {
                logger.info({ msg: 'Tag index reconciliation scheduler disabled' });
                return;
            }

            generation = {};
            started = true;

            // Check for test mode
            // Stryker disable next-line llm: testMode.triggerOnStartup is boolean|undefined (zod optional), so this truthy check and === true are equivalent for every value
            if(config.testMode?.triggerOnStartup) {
                logger.info({ msg: 'Tag index reconciliation scheduler in test mode - triggering on startup' });
                // Small delay to ensure initialization
                const runGeneration = generation;
                schedulerTimeout = setTimeout(() => {
                    // Stryker disable next-line llm: started and generation change together, making the started guard redundant; both generation values are objects, so == and === both use reference equality
                    if(started && runGeneration === generation) {
                        schedulerTimeout = null;
                        // Stryker disable next-line llm: void only documents an intentionally-unhandled promise; dropping it leaves the promise unawaited and unconsumed either way
                        void doTrigger();
                    }
                }, 10);
                return;
            }

            // Schedule first trigger
            scheduleNextTrigger();

            logger.info({
                intervalMs: config.intervalMs,
                msg:        'Tag index reconciliation scheduler started',
            });
        },

        stop(): void {
            generation = {};
            started = false;
            // Clear scheduler timeout
            if(schedulerTimeout) {
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }

            // Abort running reconciliation
            if(abortController) {
                // Stryker disable next-line llm: reconciler.ts and scheduler.ts only ever check signal.aborted, never signal.reason, so passing an abort reason here is unobservable
                abortController.abort();
                abortController = null;
            }

            // Reset state
            state = {
                isRunning: false,
            };

            driftPending = false;

            logger.info({ msg: 'Tag index reconciliation scheduler stopped' });
        },

        getState(): Readonly<ReconciliationState> {
            return { ...state };
        },

        async triggerNow(): Promise<ReconciliationResult | undefined> {
            return doTrigger();
        },

        notifyDrift(): void {
            if(!started || !config.enabled) {
                return;
            }

            if(driftPending || state.isRunning) {
                return;
            }

            driftPending = true;

            logger.info({ msg: 'Tag index drift detected — accelerating next reconciliation cycle' });

            // Clear current scheduled timeout and reschedule immediately
            if(schedulerTimeout) {
                // Stryker disable next-line llm: clearInterval and clearTimeout cancel the same timer handle identically in Bun and Node; only a spy on the function name could tell them apart
                clearTimeout(schedulerTimeout);
                schedulerTimeout = null;
            }

            // Trigger as soon as the current call stack unwinds (delay=0)
            const runGeneration = generation;
            schedulerTimeout = setTimeout(() => {
                void onScheduledTrigger(runGeneration);
            }, 0);
        },
    };
}
