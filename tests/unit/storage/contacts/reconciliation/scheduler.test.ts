/**
 * Tests for contact reconciliation scheduler.
 * Follows the same pattern as memory-tool reconciliation scheduler tests.
 */
import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
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

        scheduler.stop();
    });

    test('runs reconciliation after first interval elapses', async () => {
        const scheduler = createContactReconciliationScheduler(deps);
        scheduler.start();

        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(runReconciliation).toHaveBeenCalledTimes(1);

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
});
