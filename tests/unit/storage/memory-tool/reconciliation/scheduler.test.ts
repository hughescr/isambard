/**
 * Tests for Tag Index Reconciliation Scheduler
 */

import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DateTime } from 'luxon';
import { mockLogger } from '../../../../setup';
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
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();

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
        jest.restoreAllMocks();
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
            expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Starting scheduled reconciliation' });
            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Reconciliation complete' }));
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Next reconciliation scheduled' }));
            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Reconciliation scheduler started' }));
        });

        test('reports the armed delay and next trigger time', async () => {
            jest.setSystemTime(new Date('2026-09-12T12:34:56.750Z'));
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       1250,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          { baseDelayMs: 100, maxAttempts: 3 },
            };
            scheduler = createReconciliationScheduler({
                config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps,
            });

            scheduler.start();
            expect(mockLogger.debug).toHaveBeenCalledWith({
                delayMs:     1250,
                nextTrigger: DateTime.fromMillis(Date.now() + 1250).toISO({ suppressMilliseconds: true }),
                msg:         'Next reconciliation scheduled',
            });
            jest.advanceTimersByTime(1249);
            expect(mockRunReconciliation).not.toHaveBeenCalled();
            jest.advanceTimersByTime(1);
            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
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
            expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Reconciliation scheduler disabled' });
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
            expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Reconciliation scheduler in test mode - triggering on startup' });
        });

        test('should NOT trigger immediately when testMode is present but triggerOnStartup is false', async () => {
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
                    triggerOnStartup: false,
                },
            };

            const deps: ReconciliationSchedulerDeps = {
                config,
                runReconciliation: mockRunReconciliation,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);
            scheduler.start();

            // Past the test-mode startup delay; a falsy triggerOnStartup must not fire it
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(mockRunReconciliation).not.toHaveBeenCalled();
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
            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            // Should not have called reconciliation
            expect(mockRunReconciliation).not.toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Reconciliation scheduler stopped' });
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

        test('does not re-abort a completed run\'s controller on a later stop()', async () => {
            let capturedSignal: AbortSignal | undefined;

            const mockRunReconciliationCapture = mock(
                async (_deps: ReconcilerDeps, options: ReconcilerOptions) => {
                    capturedSignal = options.signal;
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
                runReconciliation: mockRunReconciliationCapture,
                reconcilerDeps:    mockReconcilerDeps,
            };

            scheduler = createReconciliationScheduler(deps);

            // Run to completion (not aborted) — finishRun must clear the tracked
            // controller back to null so a later, unrelated stop() has nothing to abort.
            const result = await scheduler.triggerNow();
            expect(result?.success).toBe(true);
            expect(capturedSignal?.aborted).toBe(false);

            // No run is active now — stop() must be a no-op with respect to the
            // already-completed run's controller.
            scheduler.stop();

            expect(capturedSignal?.aborted).toBe(false);
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
            expect(mockLogger.debug).toHaveBeenCalledWith({ msg: 'Reconciliation already running - skipping trigger' });

            // Clean up - resolve the pending reconciliation
            if(resolveReconciliation) {
                resolveReconciliation();
                await Promise.resolve();
            }
        });
    });

    describe('onScheduledTrigger', () => {
        test('reschedules when configuration is disabled after startup', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          { baseDelayMs: 100, maxAttempts: 3 },
            };
            scheduler = createReconciliationScheduler({
                config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps,
            });
            scheduler.start();
            config.enabled = false;

            jest.advanceTimersByTime(50);
            await Promise.resolve();
            expect(mockRunReconciliation).not.toHaveBeenCalled();
            expect(mockLogger.debug).toHaveBeenCalledWith({ msg: 'Reconciliation disabled - skipping trigger' });

            config.enabled = true;
            jest.advanceTimersByTime(50);
            await Promise.resolve();
            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        });

        test('starting twice replaces the pending timeout', async () => {
            const config: ReconciliationConfig = {
                enabled:          true,
                intervalMs:       50,
                operationDelayMs: 0,
                scanPageSize:     25,
                backoff:          { baseDelayMs: 100, maxAttempts: 3 },
            };
            scheduler = createReconciliationScheduler({
                config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps,
            });
            scheduler.start();
            scheduler.start();

            expect(jest.getTimerCount()).toBe(1);

            jest.advanceTimersByTime(50);
            await Promise.resolve();
            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        });

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
            expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Tag index drift detected — accelerating next reconciliation cycle' });

            jest.advanceTimersByTime(10_000);
            await Promise.resolve();
            expect(mockRunReconciliation).toHaveBeenCalledTimes(2);
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
            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Reconciliation failed' }));

            // Scheduler should not crash
            const state = scheduler.getState();
            expect(state.isRunning).toBe(false);
            expect(state.lastCompletedAt).toBeUndefined();
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

    test('restart waits for aborted work to settle before starting another reconciliation', async () => {
        const result = await mockRunReconciliation() as ReconciliationResult;
        mockRunReconciliation.mockClear();
        let resolveFirst!: (value: ReconciliationResult) => void;
        let resolveSecond!: (value: ReconciliationResult) => void;
        let markSecondStarted!: () => void;
        const secondStarted = new Promise<void>((resolve) => {
            markSecondStarted = resolve;
        });
        const signals: AbortSignal[] = [];
        mockRunReconciliation.mockImplementationOnce((_deps, options: ReconcilerOptions) => {
            signals.push(options.signal!);
            return new Promise<ReconciliationResult>((resolve) => {
                resolveFirst = resolve;
            });
        });
        mockRunReconciliation.mockImplementationOnce((_deps, options: ReconcilerOptions) => {
            signals.push(options.signal!);
            markSecondStarted();
            return new Promise<ReconciliationResult>((resolve) => {
                resolveSecond = resolve;
            });
        });
        const config: ReconciliationConfig = {
            enabled:          true,
            intervalMs:       50,
            operationDelayMs: 0,
            scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({
            config,
            runReconciliation: mockRunReconciliation,
            reconcilerDeps:    mockReconcilerDeps,
        });

        scheduler.start();
        const first = scheduler.triggerNow();
        scheduler.stop();
        expect(scheduler.getState().isRunning).toBe(false);
        expect(signals[0]?.aborted).toBe(true);

        scheduler.start();
        const second = scheduler.triggerNow();
        expect(scheduler.getState().isRunning).toBe(false);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        resolveFirst(result);
        await first;
        await secondStarted;
        expect(scheduler.getState().isRunning).toBe(true);
        expect(signals[1]?.aborted).toBe(false);
        expect(await scheduler.triggerNow()).toBeUndefined();

        scheduler.stop();
        expect(signals[1]?.aborted).toBe(true);
        resolveSecond(result);
        await second;
        expect(scheduler.getState().isRunning).toBe(false);
    });

    test('stopped scheduled and startup callbacks cannot reschedule after stop', async () => {
        const result = await mockRunReconciliation() as ReconciliationResult;
        mockRunReconciliation.mockClear();
        let resolveRun!: (value: ReconciliationResult) => void;
        mockRunReconciliation.mockImplementationOnce(() => new Promise<ReconciliationResult>((resolve) => {
            resolveRun = resolve;
        }));
        const config: ReconciliationConfig = {
            enabled:          true,
            intervalMs:       50,
            operationDelayMs: 0,
            scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({
            config,
            runReconciliation: mockRunReconciliation,
            reconcilerDeps:    mockReconcilerDeps,
        });
        scheduler.start();
        jest.advanceTimersByTime(50);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        scheduler.stop();
        resolveRun(result);
        await Promise.resolve();
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(0);
        expect(scheduler.getState().lastCompletedAt).toBeUndefined();

        config.testMode = { triggerOnStartup: true };
        scheduler.start();
        scheduler.stop();
        jest.advanceTimersByTime(10);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a stale scheduled callback cannot run after stop and restart', async () => {
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       50, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        const timerSpy = jest.spyOn(globalThis, 'setTimeout');
        try {
            scheduler.start();
            const staleCallback = timerSpy.mock.calls[0]?.[0] as (() => void) | undefined;
            expect(staleCallback).toBeDefined();
            scheduler.stop();
            scheduler.start();
            const pending = jest.getTimerCount();
            staleCallback?.();
            await Promise.resolve();
            expect(mockRunReconciliation).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(pending);
        } finally {
            timerSpy.mockRestore();
        }
    });

    test('a repeated start replaces the prior scheduled generation', async () => {
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       50, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        const timerSpy = jest.spyOn(globalThis, 'setTimeout');
        try {
            scheduler.start();
            const staleCallback = timerSpy.mock.calls[0]?.[0] as (() => void) | undefined;
            expect(staleCallback).toBeDefined();
            scheduler.start();
            const pending = jest.getTimerCount();
            staleCallback?.();
            await Promise.resolve();
            expect(mockRunReconciliation).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(pending);
        } finally {
            timerSpy.mockRestore();
        }
    });

    test('a repeated startup-mode start discards the prior generation\'s pending drift trigger', async () => {
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       10_000, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
            testMode:         { triggerOnStartup: true },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        scheduler.start();
        // Drift replaces the startup timer with an immediate trigger bound to the first generation
        scheduler.notifyDrift();
        // A startup-mode restart arms a fresh startup timer without clearing the drift timer
        scheduler.start();
        expect(jest.getTimerCount()).toBe(2);

        // The stale drift trigger fires but belongs to the old generation, so it must not run
        jest.advanceTimersByTime(0);
        await Promise.resolve();
        expect(mockRunReconciliation).not.toHaveBeenCalled();

        // Only the new generation's startup trigger runs, and it does not reschedule a periodic cycle
        jest.advanceTimersByTime(10);
        await Promise.resolve();
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a stopped run cannot schedule another cycle after restart', async () => {
        const result = await mockRunReconciliation() as ReconciliationResult;
        mockRunReconciliation.mockClear();
        let resolveRun!: (value: ReconciliationResult) => void;
        mockRunReconciliation.mockImplementationOnce(() => new Promise<ReconciliationResult>((resolve) => {
            resolveRun = resolve;
        }));
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       50, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        scheduler.start();
        jest.advanceTimersByTime(50);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        scheduler.stop();
        scheduler.start();
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(25);
        resolveRun(result);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(25);
        await Promise.resolve();
        expect(mockRunReconciliation).toHaveBeenCalledTimes(2);
    });

    test('a waiting trigger is cancelled if stop changes its generation', async () => {
        const result = await mockRunReconciliation() as ReconciliationResult;
        mockRunReconciliation.mockClear();
        let resolveFirst!: (value: ReconciliationResult) => void;
        mockRunReconciliation.mockImplementationOnce(() => new Promise<ReconciliationResult>((resolve) => {
            resolveFirst = resolve;
        }));
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       10_000, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        scheduler.start();
        const first = scheduler.triggerNow();
        scheduler.stop();
        scheduler.start();
        const waiting = scheduler.triggerNow();
        scheduler.stop();
        resolveFirst(result);
        await first;
        expect(await waiting).toBeUndefined();
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
    });

    test('a stale startup callback cannot run after stop and restart', async () => {
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       10_000, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
            testMode:         { triggerOnStartup: true },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        const timerSpy = jest.spyOn(globalThis, 'setTimeout');
        try {
            scheduler.start();
            const staleCallback = timerSpy.mock.calls[0]?.[0] as (() => void) | undefined;
            expect(staleCallback).toBeDefined();
            scheduler.stop();
            scheduler.start();
            staleCallback?.();
            await Promise.resolve();
            expect(mockRunReconciliation).not.toHaveBeenCalled();
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        } finally {
            timerSpy.mockRestore();
        }
    });

    test('stop clears drift and prevents later hints until restart', async () => {
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       10_000, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        scheduler.start();
        scheduler.notifyDrift();
        expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Tag index drift detected — accelerating next reconciliation cycle' });
        scheduler.stop();
        expect(jest.getTimerCount()).toBe(0);
        scheduler.notifyDrift();
        expect(jest.getTimerCount()).toBe(0);
        scheduler.start();
        scheduler.notifyDrift();
        jest.advanceTimersByTime(0);
        await Promise.resolve();
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
    });

    test('coalesces hints before the timer fires and ignores hints during a run', async () => {
        const result = await mockRunReconciliation() as ReconciliationResult;
        mockRunReconciliation.mockClear();
        let finish!: (value: ReconciliationResult) => void;
        mockRunReconciliation.mockImplementationOnce(() => new Promise<ReconciliationResult>((resolve) => {
            finish = resolve;
        }));
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       10_000, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        scheduler.start();
        mockLogger.info.mockClear();
        scheduler.notifyDrift();
        scheduler.notifyDrift();
        expect(mockLogger.info).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(0);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        scheduler.notifyDrift();
        expect(mockLogger.info).toHaveBeenCalledTimes(2); // Starting scheduled reconciliation is the second info log.
        finish(result);
        await Promise.resolve();
    });

    test('uses the documented startup initialization delay', () => {
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       10_000, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
            testMode:         { triggerOnStartup: true },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        const timerSpy = jest.spyOn(globalThis, 'setTimeout');
        try {
            scheduler.start();
            expect(timerSpy).toHaveBeenCalledTimes(1);
            expect(timerSpy.mock.calls[0]?.[1]).toBe(10);
        } finally {
            timerSpy.mockRestore();
        }
    });

    test('queues a drift reconciliation on the next timer turn', () => {
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       10_000, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        scheduler.start();
        const timerSpy = jest.spyOn(globalThis, 'setTimeout');
        try {
            scheduler.notifyDrift();
            expect(timerSpy).toHaveBeenCalledTimes(1);
            expect(timerSpy.mock.calls[0]?.[1]).toBe(0);
        } finally {
            timerSpy.mockRestore();
        }
    });

    test('waits for a running scheduled reconciliation before calculating its next cycle', async () => {
        const result = await mockRunReconciliation() as ReconciliationResult;
        mockRunReconciliation.mockClear();
        let resolveRun!: (value: ReconciliationResult) => void;
        mockRunReconciliation.mockImplementationOnce(() => new Promise<ReconciliationResult>((resolve) => {
            resolveRun = resolve;
        }));
        const config: ReconciliationConfig = {
            enabled:          true, intervalMs:       50, operationDelayMs: 0, scanPageSize:     25,
            backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        };
        scheduler = createReconciliationScheduler({ config, runReconciliation: mockRunReconciliation, reconcilerDeps: mockReconcilerDeps });
        scheduler.start();
        jest.advanceTimersByTime(50);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(75);
        await Promise.resolve();
        resolveRun(result);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        jest.advanceTimersByTime(24);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(24);
        expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(mockRunReconciliation).toHaveBeenCalledTimes(2);
    });
});
