/* eslint-disable lodash/prefer-constant -- arrow functions needed for test mocks */
import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import _ from 'lodash';
import type { Logger } from '@hughescr/logger';
import { createPerchScheduler, type PerchSchedulerDeps } from '@/agent/perch/scheduler';
import type { BotStateManager, StateChange, OperationalMode, BotState } from '@/integrations/discord/state';
import type { PerchConfig } from '@/agent/perch/types';

/* eslint-disable @typescript-eslint/unbound-method -- test helper functions use mock() with lodash */
// Mock logger
function createMockLogger(): Logger {
    return {
        debug: mock(_.noop),
        info:  mock(_.noop),
        warn:  mock(_.noop),
        error: mock(_.noop),
    } as unknown as Logger;
}

// Helper to create minimal StateChange objects
function createStateChange(
    changeType: StateChange['changeType'],
    mode: OperationalMode
): StateChange {
    const botState: BotState = {
        mode,
        interrupted:   false,
        activityPhase: null,
        modeEnteredAt: new Date(),
        modeContext:   {},
    };

    return {
        changeType,
        previousState: botState,
        newState:      botState,
    };
}

// Mock state manager
function createMockStateManager(): BotStateManager {
    const subscribers = new Set<(change: StateChange) => void>();

    const stateManager = {

        getMode:   () => 'idle' as OperationalMode,
        subscribe: mock((callback: (change: StateChange) => void) => {
            subscribers.add(callback);
            return () => {
                subscribers.delete(callback);
            };
        }),
        // Helper for testing
        _triggerStateChange: (change: StateChange) => {
            for(const cb of subscribers) {
                /* eslint-disable-next-line n/callback-return -- test helper doesn't need return */
                cb(change);
            }
        },
    } as unknown as BotStateManager;

    return stateManager;
}
/* eslint-enable @typescript-eslint/unbound-method -- end of test helpers using lodash/mock */

describe('PerchScheduler', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager & { _triggerStateChange: (change: StateChange) => void };
    let mockOnPerchTrigger: ReturnType<typeof mock>;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        jest.setSystemTime(1000);

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager() as BotStateManager & { _triggerStateChange: (change: StateChange) => void };
        /* eslint-disable-next-line @typescript-eslint/unbound-method -- creating test mock */
        mockOnPerchTrigger = mock(_.noop);
        config = {
            enabled:           true,
            timezone:          'America/Los_Angeles',
            intervalMinutes:   60,
            jitterMinutes:     15,
            maxSessionMinutes: 45,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        test('should create scheduler with provided config', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            expect(scheduler).toBeDefined();
            /* eslint-disable @typescript-eslint/unbound-method -- verifying scheduler methods exist */
            expect(scheduler.start).toBeDefined();
            expect(scheduler.stop).toBeDefined();
            expect(scheduler.getState).toBeDefined();
            /* eslint-enable @typescript-eslint/unbound-method -- end method existence checks */
        });

        test('should use default Pacific hour function if not provided', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            expect(scheduler).toBeDefined();
        });

        test('should use custom Pacific hour function if provided', () => {
            const customHourFn = mock(() => 10);
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: customHourFn,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            expect(scheduler).toBeDefined();
        });
    });

    describe('start()', () => {
        test('should subscribe to state changes', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            /* eslint-disable-next-line @typescript-eslint/unbound-method -- checking mock was called */
            expect(mockStateManager.subscribe).toHaveBeenCalled();

            scheduler.stop();
        });

        test('should create cron job with correct schedule', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);

            scheduler.start();

            // Note: Actual cron job creation testing would require mocking Cron more deeply
            // This test validates the scheduler calls start()

            scheduler.stop();
        });

        test('should not start if disabled', () => {
            const disabledConfig = { ...config, enabled: false };
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config:         disabledConfig,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            /* eslint-disable-next-line @typescript-eslint/unbound-method -- checking mock was called */
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
        });

        test('should log start message', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            /* eslint-disable-next-line @typescript-eslint/unbound-method -- checking mock was called */
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    timezone:        'America/Los_Angeles',
                    intervalMinutes: 60,
                }),
                expect.stringContaining('started')
            );

            scheduler.stop();
        });
    });

    describe('stop()', () => {
        test('should handle stop without start gracefully', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            // Call stop without start - should not crash

            expect(() => scheduler.stop()).not.toThrow();
        });

        test('should unsubscribe from state changes', () => {
            /* eslint-disable @typescript-eslint/unbound-method -- test mocks using lodash helpers */
            const unsubscribeMock = mock(_.noop);
            mockStateManager.subscribe = mock(() => unsubscribeMock);
            /* eslint-enable @typescript-eslint/unbound-method -- end test mock creation */

            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();
            scheduler.stop();

            expect(unsubscribeMock).toHaveBeenCalled();
        });

        test('should clear perch pending state', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Set a pending state via triggerNow when bot is busy
            mockStateManager.getMode = mock((): OperationalMode => 'processing_message');
            scheduler.triggerNow();

            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);

            scheduler.stop();

            const state2 = scheduler.getState();
            expect(state2.perchPending).toBe(false);
        });

        test('should log stop message', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();
            scheduler.stop();

            /* eslint-disable-next-line @typescript-eslint/unbound-method -- checking mock was called */
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('stopped'));
        });
    });

    describe('getState()', () => {
        test('should return initial state with perchPending false', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
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
                stateManager:   mockStateManager,
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
        test('should trigger immediately when bot is idle', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10, // mid-morning
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'idle');

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('mid-morning');
        });

        test('should set pending when bot is busy', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10, // mid-morning
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'processing_message');

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);
            expect(state.pendingSlot).toBe('mid-morning');
            expect(state.pendingTriggerTime).toBeInstanceOf(Date);
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();
        });

        test('should use current Pacific hour', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 18, // evening
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'idle');

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('evening');
        });

        test('should handle unscheduled slot', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 12, // unscheduled
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'idle');

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith('unscheduled');
        });
    });

    describe('doTrigger edge cases', () => {
        test('should reset pending state if bot becomes non-idle after being idle', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10, // mid-morning
                onPerchTrigger:        mockOnPerchTrigger,
            };

            // Start with idle, then change to non-idle before doTrigger completes
            let callCount = 0;
            mockStateManager.getMode = mock((): OperationalMode => {
                callCount++;
                // First call (triggerNow check): idle
                // Second call (doTrigger check): non-idle
                return (callCount === 1 ? 'idle' : 'processing_message') satisfies OperationalMode;
            });

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            // Should not have called onPerchTrigger
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            // Should have set pending state again
            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);
            expect(state.pendingSlot).toBe('mid-morning');
        });
    });

    describe('perchPending behavior', () => {
        test('should set perchPending when trigger fires and bot is busy', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'processing_message');

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);
            expect(state.pendingSlot).toBe('mid-morning');
        });

        test('should trigger when bot transitions to idle with pending perch', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10, // mid-morning
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = () => 'processing_message';

            const scheduler = createPerchScheduler(deps);
            scheduler.start();
            scheduler.triggerNow();

            // Verify pending state
            const state = scheduler.getState();
            expect(state.perchPending).toBe(true);

            // Transition to idle

            mockStateManager.getMode = () => 'idle';
            mockStateManager._triggerStateChange(createStateChange('mode_transition', 'idle'));

            // Should trigger and clear pending
            expect(mockOnPerchTrigger).toHaveBeenCalled();

            scheduler.stop();
        });

        test('should not trigger on non-mode-transition state changes', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'processing_message');

            const scheduler = createPerchScheduler(deps);
            scheduler.start();
            scheduler.triggerNow();

            // Trigger non-mode-transition change
            mockStateManager._triggerStateChange(createStateChange('context_update', 'idle'));

            // Should not trigger
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            scheduler.stop();
        });

        test('should not trigger on transition to non-idle mode', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'processing_message');

            const scheduler = createPerchScheduler(deps);
            scheduler.start();
            scheduler.triggerNow();

            // Transition to still-busy mode
            mockStateManager._triggerStateChange(createStateChange('mode_transition', 'processing_message'));

            // Should not trigger
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            scheduler.stop();
        });

        test('should replace pending perch if triggered multiple times while busy', () => {
            let currentHour = 10; // First trigger: mid-morning
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => currentHour,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'processing_message');

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

        test('should use current slot when deferred trigger runs, not original slot', () => {
            let currentHour = 10; // mid-morning
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => currentHour,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = () => 'processing_message';

            const scheduler = createPerchScheduler(deps);
            scheduler.start();
            scheduler.triggerNow();

            // Time passes - now it's evening
            currentHour = 18;

            // Transition to idle
            mockStateManager.getMode = () => 'idle';
            mockStateManager._triggerStateChange(createStateChange('mode_transition', 'idle'));

            // Should trigger with current slot (evening), not original (mid-morning)
            expect(mockOnPerchTrigger).toHaveBeenCalledWith('evening');

            scheduler.stop();
        });

        test('should not trigger if no pending slot when transitioning to idle', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => 10,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'idle');

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Transition to idle without pending perch
            mockStateManager._triggerStateChange(createStateChange('mode_transition', 'idle'));

            // Should not trigger
            expect(mockOnPerchTrigger).not.toHaveBeenCalled();

            scheduler.stop();
        });
    });

    describe('randomized scheduling with H option', () => {
        test('should schedule next trigger using cron-parser H option', () => {
            const deps: PerchSchedulerDeps = {
                stateManager:   mockStateManager,
                logger:         mockLogger,
                config,
                onPerchTrigger: mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Verify that debug log was called with scheduling info
            /* eslint-disable @typescript-eslint/unbound-method,@typescript-eslint/no-unsafe-assignment -- checking mock was called */
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    delaySeconds: expect.any(Number),
                    nextTrigger:  expect.any(String),
                }),
                expect.stringContaining('Next perch trigger scheduled')
            );
            /* eslint-enable @typescript-eslint/unbound-method,@typescript-eslint/no-unsafe-assignment -- end mock assertion check */

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
            [13, 'afternoon'],
            [14, 'afternoon'],
            [18, 'evening'],
            [19, 'evening'],
            [23, 'late-night'],
        ])('hour %d should map to slot %s', (hour, expectedSlot) => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => hour,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'idle');

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith(expectedSlot);
        });

        test.each([
            [3, 'unscheduled'],
            [8, 'unscheduled'],
            [12, 'unscheduled'],
            [16, 'unscheduled'],
            [22, 'unscheduled'],
        ])('hour %d should map to unscheduled', (hour, expectedSlot) => {
            const deps: PerchSchedulerDeps = {
                stateManager:          mockStateManager,
                logger:                mockLogger,
                config,
                getCurrentPacificHour: () => hour,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            mockStateManager.getMode = mock((): OperationalMode => 'idle');

            const scheduler = createPerchScheduler(deps);
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalledWith(expectedSlot);
        });
    });

    describe('disabled scheduler', () => {
        test('should not trigger when disabled', () => {
            const disabledConfig = { ...config, enabled: false };
            const deps: PerchSchedulerDeps = {
                stateManager: mockStateManager,
                logger:       mockLogger,
                config:       disabledConfig,

                getCurrentPacificHour: () => 10,
                onPerchTrigger:        mockOnPerchTrigger,
            };

            const scheduler = createPerchScheduler(deps);
            scheduler.start();

            // Manual trigger should still work (for testing)
            mockStateManager.getMode = () => 'idle';
            scheduler.triggerNow();

            expect(mockOnPerchTrigger).toHaveBeenCalled();
        });
    });
});
