/**
 * Tests for BotStateManager.
 * Following TDD: these tests are written first and will fail until the implementation is complete.
 */

import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { BotStateManagerImpl, type BotStateManager, type BotStateManagerDeps } from '@/integrations/discord/state/manager';
import { TransitionError } from '@/integrations/discord/state/transitions';
import { type StateChange, type CatchingUpModeContext } from '@/integrations/discord/state/types';
import { type ChannelId, createChannelId } from '@/integrations/discord/types';

describe('BotStateManager', () => {
    let manager: BotStateManager;
    let mockLogger: BotStateManagerDeps['logger'];
    const testChannelId: ChannelId = createChannelId('123456789');

    beforeEach(() => {
        mockLogger = {
            info:  () => {},
            warn:  () => {},
            error: () => {},
            debug: () => {},
        } as unknown as BotStateManagerDeps['logger'];
        manager = new BotStateManagerImpl({ logger: mockLogger });
        manager.start();
    });

    describe('Initial State', () => {
        it('should start in idle mode', () => {
            const state = manager.getState();
            expect(state.mode).toBe('idle');
            expect(state.activityPhase).toBeNull();
        });

        it('should return correct mode', () => {
            expect(manager.getMode()).toBe('idle');
        });
    });

    describe('Mode Transitions', () => {
        describe('startCatchUp', () => {
            it('should transition from idle to catching_up', () => {
                const context: CatchingUpModeContext = {
                    viewedChannels:      new Set(),
                    sessionId:           'session-123',
                    startedAt:           new Date(),
                    unreadCount:         10,
                    channelNames:        ['general'],
                    topAuthors:          ['Alice'],
                    timeSinceLastActive: '1 hour',
                };

                manager.startCatchUp(context);

                const state = manager.getState();
                expect(state.mode).toBe('catching_up');
                expect(state.modeContext).toMatchObject({
                    sessionId:           'session-123',
                    unreadCount:         10,
                    channelNames:        ['general'],
                    topAuthors:          ['Alice'],
                    timeSinceLastActive: '1 hour',
                });
            });

            it('should throw TransitionError when not in idle mode', () => {
                const context: CatchingUpModeContext = {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                };

                manager.startCatchUp(context);

                expect(() => {
                    manager.startCatchUp(context);
                }).toThrow(TransitionError);
            });
        });

        describe('startProcessingMessage', () => {
            it('should transition from idle to processing_message', () => {
                manager.startProcessingMessage(testChannelId, 'Hello world');

                const state = manager.getState();
                expect(state.mode).toBe('processing_message');
                const context = state.modeContext as { channelId: ChannelId, userMessage: string };
                expect(context.channelId).toBe(testChannelId);
                expect(context.userMessage).toBe('Hello world');
            });

            it('should throw TransitionError when not in idle mode', () => {
                manager.startProcessingMessage(testChannelId, 'First message');

                expect(() => {
                    manager.startProcessingMessage(testChannelId, 'Second message');
                }).toThrow(TransitionError);
            });
        });

        describe('startPerching', () => {
            it('should transition from idle to perching', () => {
                manager.startPerching('Observing');

                const state = manager.getState();
                expect(state.mode).toBe('perching');
                const context = state.modeContext as { activityType: string };
                expect(context.activityType).toBe('Observing');
            });

            it('should throw TransitionError when not in idle mode', () => {
                manager.startPerching('First perch');

                expect(() => {
                    manager.startPerching('Second perch');
                }).toThrow(TransitionError);
            });
        });

        describe('goIdle', () => {
            it('should transition to idle from catching_up', () => {
                const context: CatchingUpModeContext = {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                };
                manager.startCatchUp(context);

                manager.goIdle();

                expect(manager.getMode()).toBe('idle');
            });

            it('should transition to idle from processing_message', () => {
                manager.startProcessingMessage(testChannelId, 'Test');

                manager.goIdle();

                expect(manager.getMode()).toBe('idle');
            });

            it('should transition to idle from perching', () => {
                manager.startPerching('Observing');

                manager.goIdle();

                expect(manager.getMode()).toBe('idle');
            });

            it('should be idempotent when already idle', () => {
                manager.goIdle();

                expect(manager.getMode()).toBe('idle');
            });

            it('should reset state to defaults', () => {
                manager.startProcessingMessage(testChannelId, 'Test');
                manager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });

                manager.goIdle();

                const state = manager.getState();
                expect(state.mode).toBe('idle');
                expect(state.activityPhase).toBeNull();
            });
        });
    });

    describe('Within-Mode Operations', () => {
        describe('updateActivityPhase', () => {
            it('should update activity phase', () => {
                const phase = { type: 'thinking' as const, startedAt: new Date() };

                manager.updateActivityPhase(phase);

                const state = manager.getState();
                expect(state.activityPhase).toEqual(phase);
            });

            it('should NOT update presence timestamp (that is done by recordPresenceUpdate)', () => {
                // Initially, should allow update (no timestamp set yet)
                expect(manager.shouldUpdatePresence()).toBe(true);

                manager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });

                // After updateActivityPhase, should STILL allow update (timestamp not set)
                expect(manager.shouldUpdatePresence()).toBe(true);
            });
        });

        describe('recordPresenceUpdate', () => {
            it('should set presence update timestamp', () => {
                // Initially, should allow update
                expect(manager.shouldUpdatePresence()).toBe(true);

                manager.recordPresenceUpdate();

                // After recording, should not allow immediate update
                expect(manager.shouldUpdatePresence()).toBe(false);
            });
        });

        describe('clearActivityPhase', () => {
            it('should clear activity phase', () => {
                manager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });

                manager.clearActivityPhase();

                expect(manager.getState().activityPhase).toBeNull();
            });
        });

        describe('markChannelViewed', () => {
            it('should add channel to viewedChannels in catching_up mode', () => {
                const context: CatchingUpModeContext = {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                };
                manager.startCatchUp(context);

                manager.markChannelViewed(testChannelId);

                const state = manager.getState();
                const modeContext = state.modeContext as CatchingUpModeContext;
                expect(modeContext.viewedChannels.has(testChannelId)).toBe(true);
            });

            it('should log warning when not in catching_up mode', () => {
                const warnCalls: unknown[][] = [];
                mockLogger.warn = ((...args: unknown[]) => {
                    warnCalls.push(args);
                }) as BotStateManagerDeps['logger']['warn'];

                manager.markChannelViewed(testChannelId);

                expect(warnCalls).toHaveLength(1);
                expect(warnCalls[0][0]).toEqual({ mode: 'idle' });
                expect(warnCalls[0][1]).toBe('Cannot mark channel viewed: not in catching_up mode');
            });

            it('should isolate viewedChannels mutations from callers', () => {
                // Test that the Set is cloned, not shared with callers
                const externalSet = new Set<ChannelId>();
                const context: CatchingUpModeContext = {
                    viewedChannels:      externalSet,
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                };
                manager.startCatchUp(context);

                // Mark a channel as viewed
                manager.markChannelViewed(testChannelId);

                // Verify the external Set was NOT mutated
                expect(externalSet.has(testChannelId)).toBe(false);

                // Verify the manager's internal Set WAS updated
                const state = manager.getState();
                const modeContext = state.modeContext as CatchingUpModeContext;
                expect(modeContext.viewedChannels.has(testChannelId)).toBe(true);
            });

            it('should notify subscribers with correct previous/new state for viewedChannels', () => {
                const context: CatchingUpModeContext = {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                };
                manager.startCatchUp(context);

                const changes: StateChange[] = [];
                manager.subscribe((change: StateChange): void => {
                    changes.push(change);
                });

                manager.markChannelViewed(testChannelId);

                expect(changes).toHaveLength(1);
                const prevContext = changes[0].previousState.modeContext as CatchingUpModeContext;
                const newContext = changes[0].newState.modeContext as CatchingUpModeContext;

                // Core immutability contract: previous and new state are different
                expect(prevContext.viewedChannels.has(testChannelId)).toBe(false);
                expect(newContext.viewedChannels.has(testChannelId)).toBe(true);
            });
        });

        describe('setSessionId', () => {
            it('should set sessionId in catching_up mode', () => {
                const context: CatchingUpModeContext = {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        [],
                    topAuthors:          [],
                    timeSinceLastActive: null,
                };
                manager.startCatchUp(context);

                manager.setSessionId('new-session-123');

                const state = manager.getState();
                const modeContext = state.modeContext as CatchingUpModeContext;
                expect(modeContext.sessionId).toBe('new-session-123');
            });

            it('should set sessionId in processing_message mode', () => {
                manager.startProcessingMessage(testChannelId, 'Test');

                manager.setSessionId('new-session-456');

                const state = manager.getState();
                const modeContext = state.modeContext as { sessionId: string };
                expect(modeContext.sessionId).toBe('new-session-456');
            });

            it('should set sessionId in perching mode', () => {
                manager.startPerching('Observing');

                manager.setSessionId('new-session-789');

                const state = manager.getState();
                const modeContext = state.modeContext as { sessionId: string };
                expect(modeContext.sessionId).toBe('new-session-789');
            });

            it('should do nothing in idle mode', () => {
                manager.setSessionId('should-not-set');

                const state = manager.getState();
                expect(state.modeContext).toEqual({});
            });
        });
    });

    describe('Throttle Logic', () => {
        it('should return true when enough time has passed after recordPresenceUpdate', () => {
            jest.useFakeTimers();
            try {
                manager = new BotStateManagerImpl({ logger: mockLogger, updateThrottleMs: 50 });
                manager.start();

                manager.recordPresenceUpdate();

                // Immediately after recording update, should not need update
                expect(manager.shouldUpdatePresence()).toBe(false);

                // After throttle period, should allow update
                jest.advanceTimersByTime(60);
                expect(manager.shouldUpdatePresence()).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });

        it('should use default throttle of 12000ms', () => {
            manager.recordPresenceUpdate();

            // Immediately after recording, should not allow
            expect(manager.shouldUpdatePresence()).toBe(false);
        });
    });

    describe('Subscriptions', () => {
        it('should notify subscriber on state change', () => {
            const changes: StateChange[] = [];
            manager.subscribe((change: StateChange): void => {
                changes.push(change);
            });

            manager.startProcessingMessage(testChannelId, 'Test');

            expect(changes).toHaveLength(1);
            expect(changes[0].changeType).toBe('mode_transition');
            expect(changes[0].previousState.mode).toBe('idle');
            expect(changes[0].newState.mode).toBe('processing_message');
        });

        it('should notify subscriber on activity phase change', () => {
            const changes: StateChange[] = [];
            manager.subscribe((change: StateChange): void => {
                changes.push(change);
            });

            manager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });

            expect(changes).toHaveLength(1);
            expect(changes[0].changeType).toBe('activity_phase');
        });

        it('should notify subscriber on context update', () => {
            const context: CatchingUpModeContext = {
                viewedChannels:      new Set(),
                sessionId:           null,
                startedAt:           new Date(),
                unreadCount:         5,
                channelNames:        [],
                topAuthors:          [],
                timeSinceLastActive: null,
            };
            manager.startCatchUp(context);

            const changes: StateChange[] = [];
            manager.subscribe((change: StateChange): void => {
                changes.push(change);
            });

            manager.markChannelViewed(testChannelId);

            expect(changes).toHaveLength(1);
            expect(changes[0].changeType).toBe('context_update');
        });

        it('should support multiple subscribers', () => {
            const changes1: StateChange[] = [];
            const changes2: StateChange[] = [];

            manager.subscribe((change: StateChange): void => {
                changes1.push(change);
            });
            manager.subscribe((change: StateChange): void => {
                changes2.push(change);
            });

            manager.startProcessingMessage(testChannelId, 'Test');

            expect(changes1).toHaveLength(1);
            expect(changes2).toHaveLength(1);
        });

        it('should unsubscribe correctly', () => {
            const changes: StateChange[] = [];
            const unsubscribe = manager.subscribe((change: StateChange): void => {
                changes.push(change);
            });

            manager.startProcessingMessage(testChannelId, 'Test');
            expect(changes).toHaveLength(1);

            unsubscribe();

            manager.goIdle();
            expect(changes).toHaveLength(1); // No new change
        });

        it('should provide different object references for previousState and newState', () => {
            let previousState: StateChange['previousState'] | undefined;
            let newState: StateChange['newState'] | undefined;

            manager.subscribe((change: StateChange): void => {
                previousState = change.previousState;
                newState = change.newState;
            });

            manager.startProcessingMessage(testChannelId, 'Test');

            // Core immutability contract: different object references
            expect(previousState).not.toBe(newState);

            // If both have modeContext, they should also be different references
            if(previousState?.modeContext && newState?.modeContext) {
                expect(previousState.modeContext).not.toBe(newState.modeContext);
            }
        });
    });

    describe('Lifecycle', () => {
        it('should start successfully', () => {
            const newManager = new BotStateManagerImpl({ logger: mockLogger });

            expect(() => newManager.start()).not.toThrow();
        });

        it('should stop successfully', () => {
            manager.stop();

            expect(() => manager.stop()).not.toThrow();
        });

        it('should clear subscribers on stop', () => {
            const changes: StateChange[] = [];
            manager.subscribe((change: StateChange): void => {
                changes.push(change);
            });

            // Make a change before stopping to verify subscriber works
            manager.startProcessingMessage(testChannelId, 'Test');
            expect(changes).toHaveLength(1);

            manager.stop();

            // After stop, subscribers should be cleared (no further changes possible)
            expect(() => manager.startProcessingMessage(testChannelId, 'Test2')).toThrow();
        });

        it('should throw on operations after stop', () => {
            manager.stop();

            expect(() => manager.startProcessingMessage(testChannelId, 'Test')).toThrow('BotStateManager has been stopped');
        });
    });

    describe('State Immutability', () => {
        it('should return frozen state from getState', () => {
            const state = manager.getState();

            expect(() => {
                (state as { mode: string }).mode = 'catching_up';
            }).toThrow();
        });

        it('should return deep frozen state', () => {
            const context: CatchingUpModeContext = {
                viewedChannels:      new Set([testChannelId]),
                sessionId:           null,
                startedAt:           new Date(),
                unreadCount:         5,
                channelNames:        ['general'],
                topAuthors:          ['Alice'],
                timeSinceLastActive: null,
            };
            manager.startCatchUp(context);

            const state = manager.getState();
            const modeContext = state.modeContext as CatchingUpModeContext;

            expect(() => {
                (modeContext as { unreadCount: number }).unreadCount = 10;
            }).toThrow();
        });
    });

    describe('getSessionType', () => {
        it('should return "catching_up" when in catching_up mode', () => {
            const context: CatchingUpModeContext = {
                viewedChannels:      new Set(),
                sessionId:           null,
                startedAt:           new Date(),
                unreadCount:         5,
                channelNames:        [],
                topAuthors:          [],
                timeSinceLastActive: null,
            };
            manager.startCatchUp(context);

            expect(manager.getSessionType()).toBe('catching_up');
        });

        it('should return "catching_up" when in catching_up mode even if isDMChannel is true', () => {
            const context: CatchingUpModeContext = {
                viewedChannels:      new Set(),
                sessionId:           null,
                startedAt:           new Date(),
                unreadCount:         5,
                channelNames:        [],
                topAuthors:          [],
                timeSinceLastActive: null,
            };
            manager.startCatchUp(context);

            expect(manager.getSessionType(true)).toBe('catching_up');
        });

        it('should return "perching" when in perching mode', () => {
            manager.startPerching('Observing');

            expect(manager.getSessionType()).toBe('perching');
        });

        it('should return "perching" when in perching mode even if isDMChannel is true', () => {
            manager.startPerching('Observing');

            expect(manager.getSessionType(true)).toBe('perching');
        });

        it('should return "dm" when in processing_message mode and isDMChannel is true', () => {
            manager.startProcessingMessage(testChannelId, 'Test');

            expect(manager.getSessionType(true)).toBe('dm');
        });

        it('should return "processing_message" when in processing_message mode and isDMChannel is false', () => {
            manager.startProcessingMessage(testChannelId, 'Test');

            expect(manager.getSessionType(false)).toBe('processing_message');
        });

        it('should return "processing_message" when in processing_message mode and isDMChannel is not provided', () => {
            manager.startProcessingMessage(testChannelId, 'Test');

            expect(manager.getSessionType()).toBe('processing_message');
        });

        it('should return "dm" when in idle mode and isDMChannel is true', () => {
            expect(manager.getSessionType(true)).toBe('dm');
        });

        it('should return "processing_message" when in idle mode and isDMChannel is false', () => {
            expect(manager.getSessionType(false)).toBe('processing_message');
        });

        it('should return "processing_message" when in idle mode and isDMChannel is not provided', () => {
            expect(manager.getSessionType()).toBe('processing_message');
        });
    });
});
