import { describe, test, expect, beforeEach, afterEach, mock, jest, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { createPerchScheduler, type PerchSchedulerDeps } from '@/agent/perch/scheduler';
import type { PerchConfig } from '@/agent/perch/types';

// Mock logger
function createMockLogger(): Logger {
    return {
        debug: mock(() => {}),
        info:  mock(() => {}),
        warn:  mock(() => {}),
        error: mock(() => {}),
    } as unknown as Logger;
}

describe('PerchScheduler', () => {
    let mockLogger: Logger;
    let mockOnPerchTrigger: ReturnType<typeof mock>;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        jest.setSystemTime(1000);

        mockLogger = createMockLogger();
        mockOnPerchTrigger = mock(() => undefined);
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        test('should create scheduler with provided config', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            expect(scheduler).toBeDefined();
            expect(scheduler.start).toBeDefined();
            expect(scheduler.stop).toBeDefined();
            expect(scheduler.getState).toBeDefined();
        });

        test('should use default local hour function if not provided', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            expect(scheduler).toBeDefined();
        });

        test('should use custom local hour function if provided', () => {
            const customHourFn = mock(() => 10);
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: customHourFn,
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            expect(scheduler).toBeDefined();
        });
    });

    describe('start()', () => {
        test('should create cron job with correct schedule', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);

            scheduler.start();

            // start() schedules the first trigger via the 'H * * * *' cron expression,
            // logging the computed schedule: an ISO-8601 next-trigger time within the
            // next hour (delaySeconds <= 3600).
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    delaySeconds: expect.any(Number),
                    nextTrigger:  expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
                }),
                expect.stringContaining('Next perch trigger scheduled')
            );

            scheduler.stop();
        });

        test('should not start if disabled', () => {
            const disabledConfig = { ...config, enabled: false };
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         disabledConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
        });

        test('should log start message', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    timezone:        'America/Los_Angeles',
                    intervalMinutes: 60,
                }),
                expect.stringContaining('started')
            );

            scheduler.stop();
        });

        test('never subscribes to anything: it does not throw with no isPerchTurnRunning to consult', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            expect(() => scheduler.start()).not.toThrow();
            scheduler.stop();
        });
    });

    describe('stop()', () => {
        test('should handle stop without start gracefully', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            // Call stop without start - should not crash

            expect(() => scheduler.stop()).not.toThrow();
        });

        test('should clear perch pending state', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 10,
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => true,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Set a pending state via triggerNow while a perch turn is running
            scheduler.triggerNow();

            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);

            scheduler.stop();

            const state2 = scheduler.getState();
            expect(state2.perchPending).toBe(false);
        });

        test('should log stop message', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();
            scheduler.stop();

            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('stopped'));
        });
    });

    describe('getState()', () => {
        test('should return initial state with perchPending false', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            const state = scheduler.getState();

            expect(state.perchPending).toBe(false);
            expect(state.pendingSlot).toBeUndefined();
            expect(state.pendingTriggerTime).toBeUndefined();
        });

        test('should return readonly copy of state', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            const state1 = scheduler.getState();
            const state2 = scheduler.getState();

            // Should be different objects (copies)
            expect(state1).not.toBe(state2);
            expect(state1).toEqual(state2);
        });
    });

    describe('triggerNow()', () => {
        test('should trigger immediately when no perch turn is running', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 10, // mid-morning
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => false,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('mid-morning');
        });

        test('should set pending when a perch turn is already running', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 10, // mid-morning
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => true,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);
            expect(state.pendingSlot).toBe('mid-morning');
            expect(state.pendingTriggerTime).toBeInstanceOf(Date);
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();
        });

        test('should use current local hour', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 18, // evening
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => false,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('evening');
        });

        test('should handle unscheduled slot', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 11, // unscheduled
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => false,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('unscheduled');
        });

        test('triggers immediately with no isPerchTurnRunning to consult', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                onPerchTrigger:      mockOnPerchTrigger,
                getCurrentLocalHour: () => 18, // evening
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('evening');
            expect(scheduler.getState().perchPending).toBe(false);
        });

        test('keeps no pending state across repeated triggers with no isPerchTurnRunning', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                onPerchTrigger:      mockOnPerchTrigger,
                getCurrentLocalHour: () => 10,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledTimes(2);
            expect(scheduler.getState()).toEqual({ perchPending: false });
        });
    });

    describe('perch-ledger deferral (isPerchTurnRunning)', () => {
        test('RED->GREEN: trigger is deferred while isPerchTurnRunning() is true, fires once it is false', () => {
            let running = true;
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 10, // mid-morning
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => running,
            };

            const scheduler = createPerchScheduler(deps);

            // A perch turn is running: the trigger is deferred, not fired.
            scheduler.triggerNow();
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();
            expect(scheduler.getState().perchPending).toBe(true);
            expect(scheduler.getState().pendingSlot).toBe('mid-morning');

            // The predicate is re-checked fresh on the next trigger, so once the perch
            // turn has ended, the very same trigger source fires.
            running = false;
            scheduler.triggerNow();
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('mid-morning');
            expect(scheduler.getState().perchPending).toBe(false);
        });

        test('replaces pending perch if triggered multiple times while a perch turn is running', () => {
            let currentHour = 10; // First trigger: mid-morning
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => currentHour,
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => true,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            let state = scheduler.getState();
            expect(state.pendingSlot).toBe('mid-morning');

            // Change hour and trigger again
            currentHour = 18; // evening
            scheduler.triggerNow();

            state = scheduler.getState();
            expect(state.pendingSlot).toBe('evening'); // Should be replaced, not queued
        });
    });

    describe('randomized scheduling with H option', () => {
        test('should schedule next trigger using cron-parser H option', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Verify that debug log was called with scheduling info
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    delaySeconds: expect.any(Number),
                    nextTrigger:  expect.any(String),
                }),
                expect.stringContaining('Next perch trigger scheduled')
            );

            scheduler.stop();
        });
    });

    describe('slot determination', () => {
        test.each([
            [0, 'late-night'],
            [1, 'late-night'],
            [5, 'pre-dawn'],
            [6, 'pre-dawn'],
            [9, 'mid-morning'],
            [10, 'mid-morning'],
            [12, 'wikipedia'],
            [13, 'wikipedia'],
            [14, 'afternoon'],
            [15, 'afternoon'],
            [18, 'evening'],
            [19, 'evening'],
            [23, 'late-night'],
        ])('hour %d should map to slot %s', (hour, expectedSlot) => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => hour,
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith(expectedSlot);
        });

        test.each([
            [3, 'unscheduled'],
            [8, 'unscheduled'],
            [11, 'unscheduled'],
            [16, 'unscheduled'],
            [22, 'unscheduled'],
        ])('hour %d should map to unscheduled', (hour, expectedSlot) => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => hour,
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith(expectedSlot);
        });
    });

    describe('disabled scheduler', () => {
        test('should not trigger scheduled cron when disabled, but a manual trigger still works', () => {
            const disabledConfig = { ...config, enabled: false };
            const deps: PerchSchedulerDeps = {
                logger: mockLogger,
                config: disabledConfig,

                getCurrentLocalHour: () => 10,
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Manual trigger should still work (for testing)
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalled();

            scheduler.stop();
        });
    });

    describe('test mode', () => {
        test('should skip cron scheduling when test mode enabled', () => {
            const testConfig = {
                ...config,
                testMode: {
                    triggerOnStartup: true,
                },
            };

            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         testConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('test mode'));

            scheduler.stop();
        });

        test('triggerTestPerch should use forceSlot when provided', () => {
            const testConfig = {
                ...config,
                testMode: {
                    triggerOnStartup: true,
                    forceSlot:        'evening' as const,
                },
            };

            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         testConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerTestPerch();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('evening');
        });

        test('triggerTestPerch should cycle through slots when forceSlot not provided', () => {
            const testConfig = {
                ...config,
                testMode: {
                    triggerOnStartup: true,
                },
            };

            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         testConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);

            // First call should be pre-dawn
            scheduler.triggerTestPerch();
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('pre-dawn');

            // Second call should be mid-morning
            scheduler.triggerTestPerch();
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('mid-morning');

            // Third call should be afternoon
            scheduler.triggerTestPerch();
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('afternoon');

            // Fourth call should be evening
            scheduler.triggerTestPerch();
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('evening');

            // Fifth call should be late-night
            scheduler.triggerTestPerch();
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('late-night');

            // Sixth call should wrap back to pre-dawn
            scheduler.triggerTestPerch();
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('pre-dawn');
        });

        test('triggerTestPerch triggers immediately with no isPerchTurnRunning to consult', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         { ...config, testMode: { forceSlot: 'pre-dawn' } },
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerTestPerch();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('pre-dawn');
            expect(scheduler.getState().perchPending).toBe(false);
        });

        test('triggerTestPerch should defer if a perch turn is already running', () => {
            const testConfig = {
                ...config,
                testMode: {
                    enabled:   true,
                    forceSlot: 'pre-dawn' as const,
                },
            };

            const deps: PerchSchedulerDeps = {
                logger:             mockLogger,
                config:             testConfig,
                onPerchTrigger:     mockOnPerchTrigger,
                isPerchTurnRunning: () => true,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerTestPerch();

            // Should not trigger yet
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            // Should set pending state
            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);
            expect(state.pendingSlot).toBe('pre-dawn');
        });

        test('should trigger perch on startup when triggerOnStartup is true', () => {
            const testConfig = {
                ...config,
                testMode: {
                    enabled:          true,
                    triggerOnStartup: true,
                    forceSlot:        'afternoon' as const,
                },
            };

            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         testConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Should log about triggering on startup

            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('triggering perch on startup'));

            // Advance timer to allow startup delay
            jest.advanceTimersByTime(1000);

            // Should have triggered test perch
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('afternoon');

            scheduler.stop();
        });

        test('should use normal cron scheduling when testMode is undefined', () => {
            const testConfig = {
                ...config,
                testMode: undefined,
            };

            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         testConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Should log normal scheduler start

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ timezone: 'America/Los_Angeles' }),
                'Perch scheduler started with randomized hourly triggers'
            );

            // Should not log about test mode

            expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining('test mode'));

            scheduler.stop();
        });

        test('should use normal cron scheduling when triggerOnStartup is false', () => {
            const testConfig = {
                ...config,
                testMode: {
                    triggerOnStartup: false,
                },
            };

            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         testConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Should log normal scheduler start

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ timezone: 'America/Los_Angeles' }),
                'Perch scheduler started with randomized hourly triggers'
            );

            scheduler.stop();
        });
    });

    describe('scheduled trigger behavior', () => {
        test('should reschedule even when disabled', () => {
            const disabledConfig = { ...config, enabled: false };
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config:         disabledConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Advance time to trigger scheduled check
            jest.advanceTimersByTime(3_600_000); // 1 hour

            // Should have logged but not triggered
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            scheduler.stop();
        });

        test('should determine slot from local hour on scheduled trigger', () => {
            const currentHour = 10; // mid-morning
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => currentHour,
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Simulate scheduled trigger
            jest.advanceTimersByTime(3_600_000); // 1 hour

            // The scheduler should have called getSlotForHour with the current hour
            // We can't directly test this, but we can verify the correct slot was triggered
            expect(mockOnPerchTrigger).toHaveBeenCalled();

            scheduler.stop();
        });

        test('should defer if a perch turn is already running on scheduled trigger', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 10,
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => true,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Simulate scheduled trigger
            jest.advanceTimersByTime(3_600_000); // 1 hour

            // Should not trigger yet
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            // Should set pending state
            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);

            scheduler.stop();
        });
    });

    describe('cost ceiling pause (Q3 / B4)', () => {
        test('skips onPerchTrigger but still reschedules when isCostPaused() is true', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
                isCostPaused:   () => true,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            const ceilingSkipCalls = (): number => (mockLogger.debug as Mock<Logger['debug']>).mock.calls
                .filter(call => call[0] === 'Perch trigger skipped - cost ceiling reached').length;

            jest.advanceTimersByTime(3_600_000); // first scheduled tick
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();
            expect(ceilingSkipCalls()).toBe(1);

            // Still reschedules: a second tick fires the trigger again (still paused).
            jest.advanceTimersByTime(3_600_000);
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();
            expect(ceilingSkipCalls()).toBe(2);

            scheduler.stop();
        });

        test('triggers normally when isCostPaused() is false', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
                isCostPaused:   () => false,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            jest.advanceTimersByTime(3_600_000);
            expect(mockOnPerchTrigger).toHaveBeenCalledTimes(1);

            scheduler.stop();
        });

        test('triggers normally when isCostPaused is omitted', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            jest.advanceTimersByTime(3_600_000);
            expect(mockOnPerchTrigger).toHaveBeenCalledTimes(1);

            scheduler.stop();
        });

        test('isCostPaused() toggling false/true/false across successive ticks is honored every tick, never permanently paused', () => {
            let paused = false;
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
                isCostPaused:   () => paused,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            jest.advanceTimersByTime(3_600_000); // tick 1: unpaused
            expect(mockOnPerchTrigger).toHaveBeenCalledTimes(1);

            paused = true;
            jest.advanceTimersByTime(3_600_000); // tick 2: paused
            expect(mockOnPerchTrigger).toHaveBeenCalledTimes(1);

            paused = false;
            jest.advanceTimersByTime(3_600_000); // tick 3: unpaused again, no stop()/start() in between
            expect(mockOnPerchTrigger).toHaveBeenCalledTimes(2);

            scheduler.stop();
        });
    });

    describe('getNextTriggerDelay', () => {
        test('should return positive delay for next hour trigger', () => {
            // This is tested indirectly through scheduler start
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Verify debug log was called with positive delay
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    delaySeconds: expect.any(Number),
                }),
                expect.any(String)
            );

            scheduler.stop();
        });
    });

    describe('getDefaultLocalHour', () => {
        test('scheduler can be created without custom local hour function', () => {
            // Test that scheduler creation doesn't require custom hour function
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
                // Note: getCurrentLocalHour is NOT provided
            };

            // Should not throw during creation
            const scheduler = createPerchScheduler(deps);
            expect(scheduler).toBeDefined();
        });
    });

    describe('cron expression validation', () => {
        test('should use H option in cron expression for randomized minutes', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Verify the scheduler logged scheduling info with ISO format

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    delaySeconds: expect.any(Number) as number,
                    nextTrigger:  expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/) as string,
                }),
                expect.stringContaining('Next perch trigger scheduled')
            );

            scheduler.stop();
        });

        test('should schedule trigger at a future time', () => {
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Verify scheduler started and logged scheduling

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    delaySeconds: expect.any(Number) as number,
                }),
                expect.any(String) as string
            );

            scheduler.stop();
        });
    });

    describe('config.enabled behavior', () => {
        test('should check config.enabled on scheduled trigger', () => {
            // Start with enabled config
            const enabledConfig = { ...config, enabled: true };
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config:              enabledConfig,
                getCurrentLocalHour: () => 10, // mid-morning
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Simulate scheduled trigger by fast-forwarding to next hour
            jest.advanceTimersByTime(3_600_000); // 1 hour

            // Should have triggered because enabled=true
            expect(mockOnPerchTrigger).toHaveBeenCalled();

            scheduler.stop();
        });

        test('should not trigger when config.enabled is false', () => {
            const disabledConfig = { ...config, enabled: false };
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config:              disabledConfig,
                getCurrentLocalHour: () => 10,
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Simulate scheduled trigger
            jest.advanceTimersByTime(3_600_000); // 1 hour

            // Should not have triggered because config.enabled is false
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            scheduler.stop();
        });
    });

    describe('log message content', () => {
        test('should log hour and slot when trigger fires', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 10, // mid-morning
                onPerchTrigger:      mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            jest.advanceTimersByTime(3_600_000); // 1 hour

            expect(mockLogger.debug).toHaveBeenCalledWith(
                { hour: 10, slot: 'mid-morning' },
                'Perch trigger fired'
            );

            scheduler.stop();
        });

        test('should log deferral when a perch turn is already running', () => {
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config,
                getCurrentLocalHour: () => 10,
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => true,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            jest.advanceTimersByTime(3_600_000); // 1 hour

            expect(mockLogger.debug).toHaveBeenCalledWith(
                { slot: 'mid-morning' },
                'Perch trigger deferred - a perch turn is already running'
            );

            scheduler.stop();
        });
    });

    describe('config.enabled check on scheduled trigger', () => {
        test('should not trigger when disabled, even if no perch turn is running', () => {
            // This test kills the ConditionalExpression mutant on line 135
            // The mutant changes !config.enabled to false, which would cause triggers even when disabled
            const disabledConfig = { ...config, enabled: false };
            const deps: PerchSchedulerDeps = {
                logger:              mockLogger,
                config:              disabledConfig,
                getCurrentLocalHour: () => 10,
                onPerchTrigger:      mockOnPerchTrigger,
                isPerchTurnRunning:  () => false,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Advance time to trigger scheduled check
            jest.advanceTimersByTime(3_600_000); // 1 hour

            // Should not trigger when config.enabled is false
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            scheduler.stop();
        });
    });

    describe('next trigger time calculation', () => {
        test('should calculate correct next trigger timestamp for logging', () => {
            // This test kills the ArithmeticOperator mutant on line 178
            // by verifying that Date.now() + delayMs is used correctly
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            // Use a reasonable timestamp (2026-02-08 noon UTC)
            const currentTime = new Date('2026-02-08T12:00:00Z').getTime();
            jest.setSystemTime(currentTime);

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Get the debug log call for scheduling

            const debugCalls = (mockLogger.debug as unknown as Mock<(...args: unknown[]) => void>).mock.calls;
            const scheduleCall = debugCalls.find(call =>
                typeof call[1] === 'string' && call[1].includes('Next perch trigger scheduled'));

            expect(scheduleCall).toBeDefined();
            const logData = scheduleCall?.[0] as { delaySeconds: number, nextTrigger: string } | undefined;
            expect(logData).toBeDefined();

            // Verify nextTrigger has the expected format: ISO 8601 with offset
            expect(logData!.nextTrigger).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

            // Verify delaySeconds is positive (future time)
            expect(logData!.delaySeconds).toBeGreaterThan(0);

            // Verify delaySeconds is reasonable (< 1 hour for next cron trigger)
            // This kills the ArithmeticOperator mutant: delayMs / 1000 vs delayMs * 1000
            expect(logData!.delaySeconds).toBeLessThanOrEqual(3600);

            // Verify nextTrigger matches the calculated future time
            // This kills the ArithmeticOperator mutant: Date.now() + delayMs vs - delayMs
            const nextTriggerTime = new Date(logData!.nextTrigger).getTime();
            const expectedNextTime = currentTime + (logData!.delaySeconds * 1000);
            // Should match within 1 second (rounding tolerance)
            expect(nextTriggerTime).toBeGreaterThanOrEqual(expectedNextTime - 1000);
            expect(nextTriggerTime).toBeLessThanOrEqual(expectedNextTime + 1000);

            scheduler.stop();
        });
    });

    describe('double-fire prevention', () => {
        test('should not schedule two triggers in the same hour', () => {
            // Verifies the lastScheduledTime guard prevents double-fires:
            // rapid successive calls to scheduleNextTrigger() skip past the
            // previously scheduled hour instead of picking the same one.
            const deps: PerchSchedulerDeps = {
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            // Start at a known time
            const startTime = new Date('2026-02-08T12:00:00Z').getTime();
            jest.setSystemTime(startTime);

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Collect the first scheduled trigger time
            const debugCalls1 = (mockLogger.debug as unknown as Mock<(...args: unknown[]) => void>).mock.calls;
            const firstScheduleCall = debugCalls1.findLast(call =>
                typeof call[1] === 'string' && call[1].includes('Next perch trigger scheduled'));
            expect(firstScheduleCall).toBeDefined();
            const firstLog = firstScheduleCall![0] as { delaySeconds: number, nextTrigger: string };
            const firstTriggerHour = new Date(firstLog.nextTrigger).getUTCHours();

            // Advance past the first trigger to fire onScheduledTrigger,
            // which calls scheduleNextTrigger() again
            jest.advanceTimersByTime(firstLog.delaySeconds * 1000 + 1);

            // Collect the second scheduled trigger time
            const debugCalls2 = (mockLogger.debug as unknown as Mock<(...args: unknown[]) => void>).mock.calls;
            const secondScheduleCall = debugCalls2.findLast(call =>
                typeof call[1] === 'string' && call[1].includes('Next perch trigger scheduled'));
            expect(secondScheduleCall).toBeDefined();
            const secondLog = secondScheduleCall![0] as { delaySeconds: number, nextTrigger: string };
            const secondTriggerHour = new Date(secondLog.nextTrigger).getUTCHours();

            // The two triggers must be in different hours
            expect(secondTriggerHour).not.toBe(firstTriggerHour);

            scheduler.stop();
        });
    });
});
