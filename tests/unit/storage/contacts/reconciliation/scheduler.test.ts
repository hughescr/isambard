/**
 * Tests for contact reconciliation scheduler.
 * Follows the same pattern as memory-tool reconciliation scheduler tests.
 */
import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../../setup';
import type { ContactReconciliationResult } from '@/storage/contacts/reconciliation/reconciler';
import { createContactReconciliationScheduler, type ContactReconciliationSchedulerDeps  } from '@/storage/contacts/reconciliation/scheduler';

/** A minimal successful reconciliation result */
const SUCCESS_RESULT: ContactReconciliationResult = {
    success:         true,
    totalDurationMs: 1,
    phaseA:          {
        errors:               0,
        itemsScanned:         0,
        orphanLookupsDeleted: 0,
    },
    phaseB: {
        errors:                0,
        itemsScanned:          0,
        missingLookupsCreated: 0,
    },
};

describe('createContactReconciliationScheduler', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let runReconciliation: ReturnType<typeof mock>;
    let deps: ContactReconciliationSchedulerDeps;

    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger.debug.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        ddbMock = mockClient(DynamoDBDocumentClient);
        runReconciliation = mock(async (): Promise<ContactReconciliationResult> => SUCCESS_RESULT);
        deps = {
            config: {
                enabled:                   true,
                intervalMs:                60_000,
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 300_000,
            },
            runReconciliation,
            reconcilerDeps: {
                docClient: ddbMock as unknown as DynamoDBDocumentClient,
                tableName: 'TestTable',
                sleep:     async (_ms: number) => undefined,
            },
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        ddbMock.restore();
        runReconciliation.mockReset();
    });

    test('does not run reconciliation on start (only schedules first interval)', () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        // No immediate reconciliation on start
        expect(runReconciliation).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledWith({
            intervalMs: 60_000,
            msg:        'Contact reconciliation scheduler started',
        });

        scheduler.stop();
    });

    test('runs reconciliation after first interval elapses', async () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(runReconciliation).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Starting contact reconciliation' });
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Contact reconciliation complete',
        }));

        scheduler.stop();
    });

    test('does not run reconciliation when disabled', () => {
        const disabledDeps: ContactReconciliationSchedulerDeps = {
            ...deps,
            config: { ...deps.config, enabled: false },
        };
        const scheduler = createContactReconciliationScheduler(disabledDeps);
        scheduler.start();

        jest.advanceTimersByTime(60_000 * 10);

        expect(runReconciliation).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Contact reconciliation scheduler disabled' });

        scheduler.stop();
    });

    test('stops scheduling after stop() is called', async () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        // Let first interval fire
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(runReconciliation).toHaveBeenCalledTimes(1);

        scheduler.stop();
        expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Contact reconciliation scheduler stopped' });

        // No more runs after stop
        jest.advanceTimersByTime(60_000 * 5);
        await Promise.resolve();

        expect(runReconciliation).toHaveBeenCalledTimes(1);
    });

    test('triggerNow() runs reconciliation immediately and returns result', async () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        const result = await scheduler.triggerNow();

        expect(runReconciliation).toHaveBeenCalledTimes(1);
        expect(result?.success).toBe(true);

        scheduler.stop();
    });

    test('getState() returns isRunning=false before any run', () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        const state = scheduler.getState();
        expect(state.isRunning).toBe(false);

        scheduler.stop();
    });

    test('getState() reflects isRunning=true while reconciliation is active', async () => {
        let resolveRun: () => void;
        const pendingRun = new Promise<ContactReconciliationResult>((resolve) => {
            resolveRun = () => resolve(SUCCESS_RESULT);
        });
        runReconciliation.mockImplementation(() => pendingRun);

        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        const runPromise = scheduler.triggerNow();

        // While running, state should show isRunning=true
        expect(scheduler.getState().isRunning).toBe(true);

        // Resolve the pending run
        resolveRun!();
        await runPromise;

        // After completion, isRunning=false
        expect(scheduler.getState().isRunning).toBe(false);

        scheduler.stop();
    });

    test('starting twice replaces the pending interval instead of duplicating it', async () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();
        scheduler.start();
        expect(jest.getTimerCount()).toBe(1);

        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(runReconciliation).toHaveBeenCalledTimes(1);
        scheduler.stop();
    });

    test('stop clears a pending interval before its first trigger', async () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();
        expect(jest.getTimerCount()).toBe(1);
        scheduler.stop();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(120_000);
        await Promise.resolve();
        expect(runReconciliation).not.toHaveBeenCalled();
    });

    test('a stopped scheduled run cannot schedule another interval after it settles', async () => {
        let finish!: (result: ContactReconciliationResult) => void;
        runReconciliation.mockImplementationOnce(() => new Promise<ContactReconciliationResult>((resolve) => {
            finish = resolve;
        }));
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();
        jest.advanceTimersByTime(60_000);
        expect(runReconciliation).toHaveBeenCalledTimes(1);
        scheduler.stop();
        finish(SUCCESS_RESULT);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(120_000);
        await Promise.resolve();
        expect(runReconciliation).toHaveBeenCalledTimes(1);
    });

    test('a stale scheduled completion does not reset the restarted timer deadline', async () => {
        let finish!: (result: ContactReconciliationResult) => void;
        runReconciliation.mockImplementationOnce(() => new Promise<ContactReconciliationResult>((resolve) => {
            finish = resolve;
        }));
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();
        jest.advanceTimersByTime(60_000);
        scheduler.stop();
        scheduler.start();
        jest.advanceTimersByTime(30_000);
        finish(SUCCESS_RESULT);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(30_000);
        await Promise.resolve();
        await Promise.resolve();
        expect(runReconciliation).toHaveBeenCalledTimes(2);
        scheduler.stop();
    });

    test('a queued manual request is discarded if stopped again before prior work settles', async () => {
        let finish!: (result: ContactReconciliationResult) => void;
        runReconciliation.mockImplementationOnce(() => new Promise<ContactReconciliationResult>((resolve) => {
            finish = resolve;
        }));
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();
        const first = scheduler.triggerNow();
        scheduler.stop();
        scheduler.start();
        const queued = scheduler.triggerNow();
        scheduler.stop();
        finish(SUCCESS_RESULT);
        await first;
        expect(await queued).toBeUndefined();
        expect(runReconciliation).toHaveBeenCalledTimes(1);
    });

    test('prevents concurrent runs — second triggerNow() returns undefined when already running', async () => {
        let resolveFirst: () => void;
        const firstRunPromise = new Promise<ContactReconciliationResult>((resolve) => {
            resolveFirst = () => resolve(SUCCESS_RESULT);
        });
        runReconciliation.mockImplementationOnce(() => firstRunPromise);

        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        const firstResult = scheduler.triggerNow();

        // Second trigger while first is running — should return undefined (skipped)
        const secondResult = await scheduler.triggerNow();
        expect(secondResult).toBeUndefined();

        // Only one reconciliation call should have been made
        expect(runReconciliation).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).toHaveBeenCalledWith({ msg: 'Contact reconciliation already running - skipping trigger' });

        resolveFirst!();
        await firstResult;

        scheduler.stop();
    });

    test('scheduler repeats at each interval (rescheduling guard)', async () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        // First interval
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(runReconciliation).toHaveBeenCalledTimes(1);

        // Second interval — verifies rescheduling after first run completes
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(runReconciliation).toHaveBeenCalledTimes(2);

        scheduler.stop();
    });

    test('stop() mid-run: after in-progress run completes, no rescheduling occurs', async () => {
        let resolveRun: () => void;
        const pendingRun = new Promise<ContactReconciliationResult>((resolve) => {
            resolveRun = () => resolve(SUCCESS_RESULT);
        });
        runReconciliation.mockImplementation(() => pendingRun);

        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        // Trigger a run that is now in-progress
        const runPromise = scheduler.triggerNow();

        // stop() while run is still pending
        scheduler.stop();

        // Verify isRunning is false immediately after stop (not waiting for run to complete)
        expect(scheduler.getState().isRunning).toBe(false);

        // Let the in-progress run complete
        resolveRun!();
        await runPromise;

        // After completion, no timer was rescheduled — advance time and verify no extra runs
        jest.advanceTimersByTime(60_000 * 5);
        await Promise.resolve();
        await Promise.resolve();

        // Only the single manual trigger should have run
        expect(runReconciliation).toHaveBeenCalledTimes(1);
    });

    test('triggerNow() returns undefined and resets isRunning when runReconciliation throws', async () => {
        runReconciliation.mockImplementation(async () => {
            throw new Error('Reconciliation failed');
        });

        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        const result = await scheduler.triggerNow();

        expect(result).toBeUndefined();
        // isRunning must be reset to false after the error
        expect(scheduler.getState().isRunning).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Contact reconciliation failed',
        }));

        scheduler.stop();
    });

    test('Fix 4: stop() aborts in-flight run via AbortController', async () => {
        // Capture the signal passed to runReconciliation so we can verify abort was signalled
        let capturedSignal: AbortSignal | undefined;

        // A reconciliation that stays pending until explicitly resolved
        let resolveRun: (result: ContactReconciliationResult) => void;
        const pendingRun = new Promise<ContactReconciliationResult>((resolve) => {
            resolveRun = resolve;
        });

        runReconciliation.mockImplementation((_reconcilerDeps, options) => {
            capturedSignal = options.signal;
            return pendingRun;
        });

        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        // Start a run and verify it is in-flight
        const runPromise = scheduler.triggerNow();
        expect(scheduler.getState().isRunning).toBe(true);

        // Abort via stop() — the abort controller should signal the in-flight run
        scheduler.stop();

        // The AbortSignal should now be aborted
        expect(capturedSignal?.aborted).toBe(true);

        // Resolve the pending run (as if the reconciler noticed the abort and returned)
        resolveRun!(SUCCESS_RESULT);
        await runPromise;

        // After run completes, scheduler should be stopped (no extra runs after time advance)
        jest.advanceTimersByTime(60_000 * 3);
        await Promise.resolve();
        expect(runReconciliation).toHaveBeenCalledTimes(1);
    });

    test('restart waits for aborted work to settle before starting another reconciliation', async () => {
        let resolveFirst!: (result: ContactReconciliationResult) => void;
        let resolveSecond!: (result: ContactReconciliationResult) => void;
        let markSecondStarted!: () => void;
        const secondStarted = new Promise<void>((resolve) => {
            markSecondStarted = resolve;
        });
        const signals: AbortSignal[] = [];
        runReconciliation.mockImplementationOnce((_deps, options) => {
            signals.push(options.signal);
            return new Promise<ContactReconciliationResult>((resolve) => {
                resolveFirst = resolve;
            });
        });
        runReconciliation.mockImplementationOnce((_deps, options) => {
            signals.push(options.signal);
            markSecondStarted();
            return new Promise<ContactReconciliationResult>((resolve) => {
                resolveSecond = resolve;
            });
        });

        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();
        const first = scheduler.triggerNow();
        scheduler.stop();
        expect(scheduler.getState().isRunning).toBe(false);
        expect(signals[0]?.aborted).toBe(true);

        scheduler.start();
        const second = scheduler.triggerNow();
        expect(scheduler.getState().isRunning).toBe(false);
        expect(runReconciliation).toHaveBeenCalledTimes(1);
        resolveFirst(SUCCESS_RESULT);
        await first;
        await secondStarted;
        expect(scheduler.getState().isRunning).toBe(true);
        expect(signals[1]?.aborted).toBe(false);
        expect(await scheduler.triggerNow()).toBeUndefined();

        scheduler.stop();
        expect(signals[1]?.aborted).toBe(true);
        resolveSecond(SUCCESS_RESULT);
        await second;
        expect(scheduler.getState().isRunning).toBe(false);
    });

    test('old scheduled completion cannot replace a restarted scheduler timer', async () => {
        let resolveFirst!: (result: ContactReconciliationResult) => void;
        runReconciliation.mockImplementationOnce(() => new Promise<ContactReconciliationResult>((resolve) => {
            resolveFirst = resolve;
        }));
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();
        jest.advanceTimersByTime(60_000);
        expect(runReconciliation).toHaveBeenCalledTimes(1);

        scheduler.stop();
        scheduler.start();
        expect(jest.getTimerCount()).toBe(1);
        resolveFirst(SUCCESS_RESULT);
        await Promise.resolve();
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(1);

        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
        expect(runReconciliation).toHaveBeenCalledTimes(2);
        scheduler.stop();
    });
});
