import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createCatchUpStateManager } from '@/integrations/discord/catchup/state-manager';
import { createChannelId } from '@/integrations/discord/types';
import type { CatchUpState } from '@/integrations/discord/catchup/types';

describe('CatchUpStateManager', () => {
    let manager: ReturnType<typeof createCatchUpStateManager>;
    let mockLogger: { warn: ReturnType<typeof mock> };

    beforeEach(() => {
        mockLogger = { warn: mock() };
        manager = createCatchUpStateManager(mockLogger);
    });

    describe('initial state', () => {
        it('should start in idle state', () => {
            expect(manager.getState()).toBe('idle');
        });

        it('should have empty viewed channels set initially', () => {
            const viewedChannels = manager.getViewedChannels();
            expect(viewedChannels.size).toBe(0);
        });
    });

    describe('state transitions', () => {
        it('should transition from idle to catching_up', () => {
            manager.setState('catching_up');
            expect(manager.getState()).toBe('catching_up');
        });

        it('should transition from catching_up to catching_up_interrupted', () => {
            manager.setState('catching_up');
            manager.setState('catching_up_interrupted');
            expect(manager.getState()).toBe('catching_up_interrupted');
        });

        it('should transition from catching_up_interrupted back to catching_up', () => {
            manager.setState('catching_up');
            manager.setState('catching_up_interrupted');
            manager.setState('catching_up');
            expect(manager.getState()).toBe('catching_up');
        });

        it('should transition to processing_message', () => {
            manager.setState('processing_message');
            expect(manager.getState()).toBe('processing_message');
        });

        it('should transition back to idle', () => {
            manager.setState('catching_up');
            manager.setState('idle');
            expect(manager.getState()).toBe('idle');
        });

        it('should handle all valid state transitions', () => {
            const states: CatchUpState[] = ['idle', 'catching_up', 'catching_up_interrupted', 'processing_message'];

            for(const state of states) {
                manager.setState(state);
                expect(manager.getState()).toBe(state);
            }
        });
    });

    describe('viewed channels tracking', () => {
        it('should mark channel as viewed', () => {
            const channelId = createChannelId('123456789');
            manager.markChannelViewed(channelId);

            const viewedChannels = manager.getViewedChannels();
            expect(viewedChannels.has(channelId)).toBe(true);
            expect(viewedChannels.size).toBe(1);
        });

        it('should track multiple viewed channels', () => {
            const channelId1 = createChannelId('111111111');
            const channelId2 = createChannelId('222222222');
            const channelId3 = createChannelId('333333333');

            manager.markChannelViewed(channelId1);
            manager.markChannelViewed(channelId2);
            manager.markChannelViewed(channelId3);

            const viewedChannels = manager.getViewedChannels();
            expect(viewedChannels.size).toBe(3);
            expect(viewedChannels.has(channelId1)).toBe(true);
            expect(viewedChannels.has(channelId2)).toBe(true);
            expect(viewedChannels.has(channelId3)).toBe(true);
        });

        it('should not duplicate viewed channels', () => {
            const channelId = createChannelId('123456789');

            manager.markChannelViewed(channelId);
            manager.markChannelViewed(channelId);
            manager.markChannelViewed(channelId);

            const viewedChannels = manager.getViewedChannels();
            expect(viewedChannels.size).toBe(1);
        });

        it('should clear all viewed channels', () => {
            const channelId1 = createChannelId('111111111');
            const channelId2 = createChannelId('222222222');

            manager.markChannelViewed(channelId1);
            manager.markChannelViewed(channelId2);

            expect(manager.getViewedChannels().size).toBe(2);

            manager.clearViewedChannels();

            const viewedChannels = manager.getViewedChannels();
            expect(viewedChannels.size).toBe(0);
        });

        it('should allow marking channels as viewed after clearing', () => {
            const channelId1 = createChannelId('111111111');
            const channelId2 = createChannelId('222222222');

            manager.markChannelViewed(channelId1);
            manager.clearViewedChannels();
            manager.markChannelViewed(channelId2);

            const viewedChannels = manager.getViewedChannels();
            expect(viewedChannels.size).toBe(1);
            expect(viewedChannels.has(channelId1)).toBe(false);
            expect(viewedChannels.has(channelId2)).toBe(true);
        });
    });

    describe('integration scenarios', () => {
        it('should handle full catch-up flow with interruption', () => {
            const channelId1 = createChannelId('111111111');
            const channelId2 = createChannelId('222222222');

            // Start catch-up
            manager.setState('catching_up');
            expect(manager.getState()).toBe('catching_up');

            // View some channels
            manager.markChannelViewed(channelId1);
            manager.markChannelViewed(channelId2);
            expect(manager.getViewedChannels().size).toBe(2);

            // Get interrupted
            manager.setState('catching_up_interrupted');
            expect(manager.getState()).toBe('catching_up_interrupted');

            // Resume catch-up
            manager.setState('catching_up');
            expect(manager.getState()).toBe('catching_up');

            // Viewed channels should still be tracked
            expect(manager.getViewedChannels().size).toBe(2);

            // Finish catch-up - go back to idle
            manager.setState('idle');
            expect(manager.getState()).toBe('idle');

            // Clear viewed channels (session end)
            manager.clearViewedChannels();
            expect(manager.getViewedChannels().size).toBe(0);
        });

        it('should handle processing message flow', () => {
            const channelId = createChannelId('123456789');

            // Process a message
            manager.setState('processing_message');
            manager.markChannelViewed(channelId);

            expect(manager.getState()).toBe('processing_message');
            expect(manager.getViewedChannels().size).toBe(1);

            // Back to idle
            manager.setState('idle');
            expect(manager.getState()).toBe('idle');
        });
    });

    describe('state transition validation', () => {
        it('should allow valid transitions without warnings', () => {
            // Create a fresh manager for this test to start from known state
            const testLogger = { warn: mock() };
            const testManager = createCatchUpStateManager(testLogger);

            // Valid: idle → catching_up
            testManager.setState('catching_up');
            expect(testLogger.warn).not.toHaveBeenCalled();

            // Valid: catching_up → catching_up_interrupted
            testManager.setState('catching_up_interrupted');
            expect(testLogger.warn).not.toHaveBeenCalled();

            // Valid: catching_up_interrupted → catching_up
            testManager.setState('catching_up');
            expect(testLogger.warn).not.toHaveBeenCalled();

            // Valid: catching_up → idle
            testManager.setState('idle');
            expect(testLogger.warn).not.toHaveBeenCalled();

            // Valid: idle → processing_message
            testManager.setState('processing_message');
            expect(testLogger.warn).not.toHaveBeenCalled();

            // Valid: processing_message → idle
            testManager.setState('idle');
            expect(testLogger.warn).not.toHaveBeenCalled();
        });

        it('should allow catching_up → catching_up self-transition (resumption)', () => {
            const testLogger = { warn: mock() };
            const testManager = createCatchUpStateManager(testLogger);

            testManager.setState('catching_up');
            testLogger.warn.mockClear();

            // Valid self-transition during resumption
            testManager.setState('catching_up');
            expect(testLogger.warn).not.toHaveBeenCalled();
            expect(testManager.getState()).toBe('catching_up');
        });

        it('should log warning for invalid transitions but still allow them', () => {
            // Create a fresh manager for this test
            const testLogger = { warn: mock() };
            const testManager = createCatchUpStateManager(testLogger);

            // Invalid: idle → catching_up_interrupted
            testManager.setState('catching_up_interrupted');
            expect(testLogger.warn).toHaveBeenCalledWith({
                from: 'idle',
                to:   'catching_up_interrupted',
                msg:  'Invalid catch-up state transition detected',
            });
            expect(testManager.getState()).toBe('catching_up_interrupted'); // Still transitions

            // Reset
            testLogger.warn.mockClear();
            testManager.setState('idle');

            // Invalid: idle → idle (no-op but invalid)
            testManager.setState('idle');
            expect(testLogger.warn).toHaveBeenCalledWith({
                from: 'idle',
                to:   'idle',
                msg:  'Invalid catch-up state transition detected',
            });
            expect(testManager.getState()).toBe('idle'); // Still transitions
        });

        it('should warn when transitioning from processing_message to non-idle states', () => {
            // Create a fresh manager for this test
            const testLogger = { warn: mock() };
            const testManager = createCatchUpStateManager(testLogger);

            testManager.setState('processing_message');
            testLogger.warn.mockClear(); // Clear any warnings from setup

            // Invalid: processing_message → catching_up
            testManager.setState('catching_up');
            expect(testLogger.warn).toHaveBeenCalledWith({
                from: 'processing_message',
                to:   'catching_up',
                msg:  'Invalid catch-up state transition detected',
            });
            expect(testManager.getState()).toBe('catching_up'); // Still transitions for robustness
        });

        it('should warn when transitioning from catching_up to processing_message', () => {
            // Create a fresh manager for this test
            const testLogger = { warn: mock() };
            const testManager = createCatchUpStateManager(testLogger);

            testManager.setState('catching_up');
            testLogger.warn.mockClear(); // Clear any warnings from setup

            // Invalid: catching_up → processing_message
            testManager.setState('processing_message');
            expect(testLogger.warn).toHaveBeenCalledWith({
                from: 'catching_up',
                to:   'processing_message',
                msg:  'Invalid catch-up state transition detected',
            });
            expect(testManager.getState()).toBe('processing_message'); // Still transitions for robustness
        });
    });

    describe('getViewedChannels defensive copy', () => {
        it('should return a copy that cannot mutate internal state', () => {
            const channelId1 = createChannelId('111111111');
            const channelId2 = createChannelId('222222222');

            manager.markChannelViewed(channelId1);

            // Get the set
            const viewedChannels = manager.getViewedChannels();
            expect(viewedChannels.size).toBe(1);

            // Try to mutate the returned set
            viewedChannels.add(channelId2);
            viewedChannels.delete(channelId1);

            // Internal state should be unchanged
            const actualViewedChannels = manager.getViewedChannels();
            expect(actualViewedChannels.size).toBe(1);
            expect(actualViewedChannels.has(channelId1)).toBe(true);
            expect(actualViewedChannels.has(channelId2)).toBe(false);
        });
    });
});
