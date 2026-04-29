/**
 * Tests for Tag Index Reconciliation Scheduler
 */

import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { MemoryToolBackendTagIndex } from '@/storage/memory-tool/backend-tag-index';
import type { ReconcilerDeps, ReconcilerOptions } from '@/storage/memory-tool/reconciliation/reconciler';
import {
    createReconciliationScheduler,
    type ReconciliationScheduler,
    type ReconciliationSchedulerDeps
} from '@/storage/memory-tool/reconciliation/scheduler';
import type { ReconciliationConfig, ReconciliationResult } from '@/storage/memory-tool/reconciliation/types';
import type { MemoryToolItemData } from '@/storage/memory-tool/types';

describe('ReconciliationScheduler', () => {
    let mockRunReconciliation: ReturnType<typeof mock>;
    let mockReconcilerDeps: ReconcilerDeps;
    let scheduler: ReconciliationScheduler | null;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();

        // Create mock reconciler function
        mockRunReconciliation = mock(() => Promise.resolve({
            success: true,
            phaseA:  {
                phase:               'phaseA' as const,
                itemsScanned:        10,
                indexItemsCreated:   2,
                indexItemsRefreshed: 1,
                indexItemsDeleted:   0,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date(),
                endTime:             new Date(),
            },
            phaseB: {
                phase:               'phaseB' as const,
                itemsScanned:        5,
                indexItemsCreated:   0,
                indexItemsRefreshed: 0,
                indexItemsDeleted:   1,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date(),
                endTime:             new Date(),
            },
            totalDurationMs: 100,
        } as ReconciliationResult));

        // Create mock reconciler deps
        mockReconcilerDeps = {
            docClient:            {} as DynamoDBDocumentClient,
            tableName:            'TestTable',
            tagIndex:             {} as MemoryToolBackendTagIndex,
            getMemory:            mock(() => Promise.resolve(undefined)),
            updateMemoryMetadata: mock(() => Promise.resolve({} as MemoryToolItemData)),
        };

        scheduler = null;
    });

    afterEach(() => {
        // Clean up scheduler if it exists
        if(scheduler) {
            scheduler.stop();
            scheduler = null;
        }
        jest.useRealTimers();
    });

    describe('start() - enabled', () => {
        test('should schedule reconciliation at intervalMs', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50, // Small interval for testing
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for scheduled trigger to fire
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            // Should have called reconciliation
            expect(mockRunReconciliation).toHaveBeenCalled();
        });
    });

    describe('start() - disabled', () => {
        test('should log and not schedule anything', async () => {
            const config: ReconciliationConfig = {
                enabled:          false,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait to ensure nothing happens
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            // Should not have called reconciliation
            expect(mockRunReconciliation).not.toHaveBeenCalled();
        });
    });

    describe('start() - testMode.triggerOnStartup', () => {
        test('should trigger reconciliation immediately', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       1000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
                testMode: {
                    triggerOnStartup: true,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for immediate trigger (with small init delay)
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Should have called reconciliation
            expect(mockRunReconciliation).toHaveBeenCalled();
        });
    });

    describe('stop()', () => {
        test('should clear scheduled timeout', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       1000, // Long interval
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Stop immediately
            scheduler.stop();

            // Wait longer than would trigger
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Should not have called reconciliation
            expect(mockRunReconciliation).not.toHaveBeenCalled();
        });

        test('should abort running reconciliation via AbortSignal', async () => {
            let capturedSignal: AbortSignal | undefined;
            let resolveReconciliation: (() => void) | undefined;

            const mockRunReconciliationWithDelay = mock(
                async (_deps: ReconcilerDeps, options: ReconcilerOptions) => {
                    capturedSignal = options.signal;
                    // Simulate long-running reconciliation - don't resolve immediately
                    await new Promise<void>((resolve) => {
                        resolveReconciliation = resolve;
                    });
                    return {
                        success: true,
                        phaseA:  {
                            phase:               'phaseA' as const,
                            itemsScanned:        0,
                            indexItemsCreated:   0,
                            indexItemsRefreshed: 0,
                            indexItemsDeleted:   0,
                            metadataCleaned:     0,
                            errors:              0,
                            startTime:           new Date(),
                            endTime:             new Date(),
                        },
                        phaseB: {
                            phase:               'phaseB' as const,
                            itemsScanned:        0,
                            indexItemsCreated:   0,
                            indexItemsRefreshed: 0,
                            indexItemsDeleted:   0,
                            metadataCleaned:     0,
                            errors:              0,
                            startTime:           new Date(),
                            endTime:             new Date(),
                        },
                        totalDurationMs: 100,
                    } as ReconciliationResult;
                }
            );

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithDelay,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for reconciliation to start
            jest.advanceTimersByTime(75);
            await Promise.resolve();

            // Stop while running
            scheduler.stop();

            // Check that signal was aborted
            expect(capturedSignal?.aborted).toBe(true);

            // Clean up - resolve the pending reconciliation
            if(resolveReconciliation) {
                resolveReconciliation();
                await Promise.resolve();
            }
        });

        test('should reset state to not running', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for reconciliation to start
            jest.advanceTimersByTime(75);
            await Promise.resolve();

            // Stop
            scheduler.stop();

            const state = scheduler.getState();
            expect(state.isRunning).toBe(false);
        });
    });

    describe('getState()', () => {
        test('should return current state (not running initially)', () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       1000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);

            const state = scheduler.getState();
            expect(state.isRunning).toBe(false);
            expect(state.currentPhase).toBeNull();
        });

        test('should show running state during reconciliation', async () => {
            let resolveReconciliation: (() => void) | undefined;

            const mockRunReconciliationWithDelay = mock(async () => {
                // Simulate long-running reconciliation - don't resolve immediately
                await new Promise<void>((resolve) => {
                    resolveReconciliation = resolve;
                });
                return {
                    success: true,
                    phaseA:  {
                        phase:               'phaseA' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    phaseB: {
                        phase:               'phaseB' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    totalDurationMs: 100,
                } as ReconciliationResult;
            });

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithDelay,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for reconciliation to start
            jest.advanceTimersByTime(75);
            await Promise.resolve();

            const state = scheduler.getState();
            expect(state.isRunning).toBe(true);
            expect(state.currentPhase).toBe('phaseA');
            expect(state.runStartedAt).toBeDefined();

            // Clean up - resolve the pending reconciliation
            if(resolveReconciliation) {
                resolveReconciliation();
                await Promise.resolve();
            }
        });
    });

    describe('triggerNow()', () => {
        test('should run reconciliation immediately and return result', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       1000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);

            const result = await scheduler.triggerNow();

            expect(result).toBeDefined();
            expect(result?.success).toBe(true);
            expect(mockRunReconciliation).toHaveBeenCalled();
        });

        test('should skip if already running', async () => {
            let resolveReconciliation: (() => void) | undefined;

            const mockRunReconciliationWithDelay = mock(async () => {
                // Simulate long-running reconciliation - don't resolve immediately
                await new Promise<void>((resolve) => {
                    resolveReconciliation = resolve;
                });
                return {
                    success: true,
                    phaseA:  {
                        phase:               'phaseA' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    phaseB: {
                        phase:               'phaseB' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    totalDurationMs: 100,
                } as ReconciliationResult;
            });

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithDelay,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for reconciliation to start
            jest.advanceTimersByTime(75);
            await Promise.resolve();

            // Try to trigger while running
            const result = await scheduler.triggerNow();

            expect(result).toBeUndefined();
            // Should have been called only once (from scheduled trigger)
            expect(mockRunReconciliationWithDelay).toHaveBeenCalledTimes(1);

            // Clean up - resolve the pending reconciliation
            if(resolveReconciliation) {
                resolveReconciliation();
                await Promise.resolve();
            }
        });
    });

    describe('onScheduledTrigger', () => {
        test('should not run if already running (concurrent protection)', async () => {
            let resolveReconciliation: (() => void) | undefined;

            const mockRunReconciliationWithDelay = mock(async () => {
                // Simulate long-running reconciliation - don't resolve immediately
                await new Promise<void>((resolve) => {
                    resolveReconciliation = resolve;
                });
                return {
                    success: true,
                    phaseA:  {
                        phase:               'phaseA' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    phaseB: {
                        phase:               'phaseB' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    totalDurationMs: 200,
                } as ReconciliationResult;
            });

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50, // Very short interval - would trigger twice
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithDelay,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait longer than 2 intervals but reconciliation hasn't completed
            jest.advanceTimersByTime(150);
            await Promise.resolve();

            // Should have been called only once despite multiple triggers
            expect(mockRunReconciliationWithDelay).toHaveBeenCalledTimes(1);

            // Clean up - resolve the pending reconciliation
            if(resolveReconciliation) {
                resolveReconciliation();
                await Promise.resolve();
            }
        });

        test('should reschedule after completion', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for first cycle (at 50ms)
            jest.advanceTimersByTime(55);
            await Promise.resolve();

            // Wait for second cycle (at 100ms) - but don't reach 150ms
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Should have been called twice (initial + rescheduled)
            expect(mockRunReconciliation).toHaveBeenCalledTimes(2);
        });

        test('should NOT reschedule if testMode.runOnce', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
                testMode: {
                    runOnce: true,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for first cycle (at 50ms)
            jest.advanceTimersByTime(55);
            await Promise.resolve();

            // Wait for potential second cycle (at 100ms) - but runOnce should prevent it
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Should have been called only once
            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        });
    });

    describe('notifyDrift()', () => {
        test('should trigger reconciliation sooner than baseline interval', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       10_000, // Long interval — won't fire naturally in this test
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // No reconciliation at 5ms (well before 10000ms interval)
            jest.advanceTimersByTime(5);
            await Promise.resolve();
            expect(mockRunReconciliation).not.toHaveBeenCalled();

            // Notify drift — should accelerate to 0ms delay
            scheduler.notifyDrift();

            // One microtask/tick should fire the accelerated timeout (delay=0)
            jest.advanceTimersByTime(0);
            await Promise.resolve();

            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        });

        test('should not trigger when scheduler has not been started', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       10_000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            // Do NOT call start()

            scheduler.notifyDrift();

            jest.advanceTimersByTime(10);
            await Promise.resolve();

            expect(mockRunReconciliation).not.toHaveBeenCalled();
        });

        test('should not trigger when scheduler is disabled', async () => {
            const config: ReconciliationConfig = {
                enabled:          false,
                intervalMs:       10_000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start(); // start() returns early for disabled

            scheduler.notifyDrift();

            jest.advanceTimersByTime(10);
            await Promise.resolve();

            expect(mockRunReconciliation).not.toHaveBeenCalled();
        });

        test('should coalesce multiple hints into a single cycle', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       10_000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Call notifyDrift three times in a row
            scheduler.notifyDrift();
            scheduler.notifyDrift();
            scheduler.notifyDrift();

            jest.advanceTimersByTime(0);
            await Promise.resolve();

            // Should have fired exactly once
            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        });

        test('should not accelerate when reconciliation is already running', async () => {
            let resolveReconciliation: (() => void) | undefined;

            const mockRunReconciliationWithDelay = mock(async () => {
                await new Promise<void>((resolve) => {
                    resolveReconciliation = resolve;
                });
                return {
                    success: true,
                    phaseA:  {
                        phase:               'phaseA' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    phaseB: {
                        phase:               'phaseB' as const,
                        itemsScanned:        0,
                        indexItemsCreated:   0,
                        indexItemsRefreshed: 0,
                        indexItemsDeleted:   0,
                        metadataCleaned:     0,
                        errors:              0,
                        startTime:           new Date(),
                        endTime:             new Date(),
                    },
                    totalDurationMs: 100,
                } as ReconciliationResult;
            });

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithDelay,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for reconciliation to start
            jest.advanceTimersByTime(75);
            await Promise.resolve();

            expect(mockRunReconciliationWithDelay).toHaveBeenCalledTimes(1);

            // Notify drift while running — should be a no-op
            scheduler.notifyDrift();

            jest.advanceTimersByTime(0);
            await Promise.resolve();

            // Still only 1 call — not a second trigger
            expect(mockRunReconciliationWithDelay).toHaveBeenCalledTimes(1);

            // Clean up
            if(resolveReconciliation) {
                resolveReconciliation();
                await Promise.resolve();
            }
        });

        test('should reset drift flag after cycle runs so a subsequent hint accelerates again', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       10_000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // First drift hint → fires immediately
            scheduler.notifyDrift();
            jest.advanceTimersByTime(0);
            await Promise.resolve();
            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);

            // After the cycle, drift flag should be reset.
            // The next interval is now scheduled at 10000ms.
            // A second drift hint should accelerate again (not be coalesced away).
            scheduler.notifyDrift();
            jest.advanceTimersByTime(0);
            await Promise.resolve();
            expect(mockRunReconciliation).toHaveBeenCalledTimes(2);
        });

        test('should reset drift flag after errored cycle so a subsequent hint accelerates again', async () => {
            const mockRunReconciliationWithError = mock(() =>
                Promise.reject(new Error('Reconciliation failed'))
            );

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       10_000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithError,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // First drift hint → fires immediately (but reconciliation will error)
            scheduler.notifyDrift();
            jest.advanceTimersByTime(0);
            await Promise.resolve();
            expect(mockRunReconciliationWithError).toHaveBeenCalledTimes(1);

            // After the errored cycle, drift flag should be reset.
            // A second drift hint should accelerate again (not be coalesced away).
            scheduler.notifyDrift();
            jest.advanceTimersByTime(0);
            await Promise.resolve();
            expect(mockRunReconciliationWithError).toHaveBeenCalledTimes(2);
        });

        test('should not interfere with regular periodic scheduling (regression)', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Without calling notifyDrift, it should still fire at normal interval
            jest.advanceTimersByTime(55);
            await Promise.resolve();

            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);

            // And reschedule for the next interval
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(mockRunReconciliation).toHaveBeenCalledTimes(2);
        });

        test('should not interfere with testMode.triggerOnStartup behavior', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       10_000,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
                testMode: {
                    triggerOnStartup: true,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // In triggerOnStartup mode, notifyDrift should not cause a second trigger
            // (since the startup trigger handles it already and drift flag is reset on completion)
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        });
    });

    describe('Error handling', () => {
        test('should catch and log errors from reconciliation', async () => {
            const mockRunReconciliationWithError = mock(() =>
                Promise.reject(new Error('Reconciliation failed'))
            );

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithError,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for trigger
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            // Should have called reconciliation
            expect(mockRunReconciliationWithError).toHaveBeenCalled();

            // Scheduler should not crash
            const state = scheduler.getState();
            expect(state.isRunning).toBe(false);
        });

        test('should reschedule even after errors', async () => {
            let callCount = 0;
            const mockRunReconciliationWithError = mock(() => {
                callCount++;
                return Promise.reject(new Error('Reconciliation failed'));
            });

            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliationWithError,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for first cycle (at 50ms)
            jest.advanceTimersByTime(55);
            await Promise.resolve();

            // Wait for second cycle (at 100ms) - but don't reach 150ms
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Should have been called twice despite errors
            expect(callCount).toBeGreaterThanOrEqual(2);
        });
    });

    describe('State tracking', () => {
        test('should update lastCompletedAt after successful run', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          {
                    baseDelayMs: 100,
                    maxAttempts: 3,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Wait for first run to complete
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            const state = scheduler.getState();
            expect(state.lastCompletedAt).toBeDefined();
            expect(state.lastCompletedAt).toBeInstanceOf(Date);
        });
    });
});
