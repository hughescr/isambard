/* eslint-disable @typescript-eslint/unbound-method -- Tests require direct method references */
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { createCatchUpSessionRunner } from '@/integrations/discord/catchup/session-runner';
import type {
    CatchUpSessionRunnerDeps,
    CatchUpCompletionSignal,
    CatchUpInProgressSignal,
    RunAgentSessionOptions,
    AgentSessionResult,
    InterruptingMessage
} from '@/integrations/discord/catchup/session-runner';
import type { CatchUpStateManager } from '@/integrations/discord/catchup/state-manager';
import type { InboxManager } from '@/integrations/discord/inbox';
import { createChannelId, type ChannelId } from '@/integrations/discord/types';
import type { CatchUpState } from '@/integrations/discord/catchup/types';

describe('CatchUpSessionRunner', () => {
    let mockStateManager: CatchUpStateManager;
    let mockInboxManager: InboxManager;
    let mockStoreCompletionSignal: ReturnType<typeof mock>;
    let mockLoadCompletionSignal: ReturnType<typeof mock>;
    let mockStoreInProgressSignal: ReturnType<typeof mock>;
    let mockLoadInProgressSignal: ReturnType<typeof mock>;
    let mockDeleteInProgressSignal: ReturnType<typeof mock>;
    let mockRunAgentSession: ReturnType<typeof mock>;
    let deps: CatchUpSessionRunnerDeps;
    let mockTotalUnread: number;

    beforeEach(() => {
        // Set up fake timers with fixed system time for deterministic tests
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-25T12:00:00.000Z'));

        mockStateManager = {
            getState:            mock(() => 'idle' as CatchUpState),
            setState:            mock(),
            getViewedChannels:   mock(() => new Set<ChannelId>()),
            markChannelViewed:   mock(),
            clearViewedChannels: mock(),
        };

        // Use a mutable variable for totalUnread that tests can modify
        mockTotalUnread = 0;
        mockInboxManager = {
            loadUnread:         mock(() => Promise.resolve(0)),
            getUnreadOverview:  mock(() => ({ totalUnread: mockTotalUnread, channels: [] })),
            getChannelMessages: mock(() => []),
            get totalUnread() { return mockTotalUnread; },
        } as unknown as InboxManager;

        mockStoreCompletionSignal = mock();
        mockLoadCompletionSignal = mock();
        mockStoreInProgressSignal = mock();
        mockLoadInProgressSignal = mock();
        mockDeleteInProgressSignal = mock();
        mockRunAgentSession = mock();

        deps = {
            stateManager:           mockStateManager,
            inboxManager:           mockInboxManager,
            storeCompletionSignal:  mockStoreCompletionSignal,
            loadCompletionSignal:   mockLoadCompletionSignal,
            storeInProgressSignal:  mockStoreInProgressSignal,
            loadInProgressSignal:   mockLoadInProgressSignal,
            deleteInProgressSignal: mockDeleteInProgressSignal,
            runAgentSession:        mockRunAgentSession,
        };
    });

    afterEach(() => {
        // Restore real timers after each test
        jest.useRealTimers();
    });

    describe('shouldStartCatchUp', () => {
        it('should return false when no unread messages', async () => {
            mockTotalUnread = 0;

            const runner = createCatchUpSessionRunner(deps);
            const result = await runner.shouldStartCatchUp();

            expect(result).toBe(false);
        });

        it('should return true when inProgress marker exists (crash recovery)', async () => {
            mockTotalUnread = 5;
            mockLoadInProgressSignal.mockResolvedValue({
                startedAt: new Date('2025-01-25T11:50:00.000Z').toISOString(),
            } as CatchUpInProgressSignal);

            const runner = createCatchUpSessionRunner(deps);
            const result = await runner.shouldStartCatchUp();

            expect(result).toBe(true);
            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
        });

        it('should delete inProgress marker when found', async () => {
            mockTotalUnread = 5;
            mockLoadInProgressSignal.mockResolvedValue({
                startedAt: new Date('2025-01-25T11:50:00.000Z').toISOString(),
            } as CatchUpInProgressSignal);

            const runner = createCatchUpSessionRunner(deps);
            await runner.shouldStartCatchUp();

            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
        });

        it('should return true when no completion signal exists', async () => {
            mockTotalUnread = 5;
            mockLoadInProgressSignal.mockResolvedValue(null);
            mockLoadCompletionSignal.mockResolvedValue(null);

            const runner = createCatchUpSessionRunner(deps);
            const result = await runner.shouldStartCatchUp();

            expect(result).toBe(true);
        });

        it('should return true when completed > 5 minutes ago', async () => {
            mockTotalUnread = 5;
            mockLoadInProgressSignal.mockResolvedValue(null);

            // 10 minutes ago from fixed time (12:00:00 - 10 minutes = 11:50:00)
            const tenMinutesAgo = new Date('2025-01-25T11:50:00.000Z');
            mockLoadCompletionSignal.mockResolvedValue({
                completedAt:       tenMinutesAgo.toISOString(),
                channelsProcessed: 2,
                messagesProcessed: 5,
            } as CatchUpCompletionSignal);

            const runner = createCatchUpSessionRunner(deps);
            const result = await runner.shouldStartCatchUp();

            expect(result).toBe(true);
        });

        it('should return false when completed < 5 minutes ago', async () => {
            mockTotalUnread = 5;
            mockLoadInProgressSignal.mockResolvedValue(null);

            // 2 minutes ago from fixed time (12:00:00 - 2 minutes = 11:58:00)
            const twoMinutesAgo = new Date('2025-01-25T11:58:00.000Z');
            mockLoadCompletionSignal.mockResolvedValue({
                completedAt:       twoMinutesAgo.toISOString(),
                channelsProcessed: 2,
                messagesProcessed: 5,
            } as CatchUpCompletionSignal);

            const runner = createCatchUpSessionRunner(deps);
            const result = await runner.shouldStartCatchUp();

            expect(result).toBe(false);
        });
    });

    describe('startCatchUp', () => {
        it('should return early when already in catching_up state', async () => {
            // Set state to catching_up
            mockStateManager.getState = mock(() => 'catching_up' as CatchUpState);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // Should not store inProgress marker or run agent session
            expect(mockStoreInProgressSignal).not.toHaveBeenCalled();
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            // Should not attempt to set state (guard returns early)
            expect(mockStateManager.setState).not.toHaveBeenCalled();
        });

        it('should set state to catching_up', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            expect(mockStateManager.setState).toHaveBeenCalledWith('catching_up');
        });

        it('should store inProgress marker', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            expect(mockStoreInProgressSignal).toHaveBeenCalled();
            const call = mockStoreInProgressSignal.mock.calls[0][0] as CatchUpInProgressSignal;
            expect(call.startedAt).toBeDefined();
        });

        it('should run agent session with catch-up prompt', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            expect(mockRunAgentSession).toHaveBeenCalled();
            const options = mockRunAgentSession.mock.calls[0][0] as RunAgentSessionOptions;
            expect(options.prompt).toContain('5 unread messages');
            expect(options.prompt).toContain('1 channel');
            expect(options.abortSignal).toBeInstanceOf(AbortSignal);
        });

        it('should call completeCatchUp on successful completion', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // completeCatchUp should be called with stats
            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.setState).toHaveBeenCalledWith('idle');
        });

        it('should NOT call completeCatchUp when session is interrupted', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            // Session returns NOT completed (was interrupted)
            mockRunAgentSession.mockResolvedValue({ completed: false, sessionId: 'session-123' } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // completeCatchUp should NOT be called (storeCompletionSignal is part of completeCatchUp)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            // But state should still be catching_up (not idle)
            expect(mockStateManager.setState).toHaveBeenCalledWith('catching_up');
            expect(mockStateManager.setState).not.toHaveBeenCalledWith('idle');
        });

        it('should return without completing when AbortError is thrown', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            // Simulate AbortError being thrown
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockRunAgentSession.mockRejectedValue(abortError);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // Should not call completeCatchUp
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).not.toHaveBeenCalled();
        });

        it('should call completeCatchUp with 0,0 when regular Error is thrown', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            // Simulate a regular error (not AbortError)
            const regularError = new Error('Network error');
            mockRunAgentSession.mockRejectedValue(regularError);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // Should call completeCatchUp with 0, 0
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
            expect(mockStateManager.setState).toHaveBeenCalledWith('idle');

            // Verify completion signal has 0 channels and messages
            const signal = mockStoreCompletionSignal.mock.calls[0][0] as CatchUpCompletionSignal;
            expect(signal.channelsProcessed).toBe(0);
            expect(signal.messagesProcessed).toBe(0);
        });
    });

    describe('interrupt', () => {
        it('should set state to catching_up_interrupted', () => {
            const runner = createCatchUpSessionRunner(deps);
            const message: InterruptingMessage = {
                channelId:   createChannelId('123'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Hey bot!',
            };

            runner.interrupt(message);

            expect(mockStateManager.setState).toHaveBeenCalledWith('catching_up_interrupted');
        });

        it('should abort current session', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Mock a long-running agent session
            let capturedSignal: AbortSignal | null = null;
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                capturedSignal = options.abortSignal;
                return new Promise((resolve) => {
                    setTimeout(() => resolve({ completed: true }), 10000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up in background
            const startPromise = runner.startCatchUp();

            // Advance time to allow session to start (uses fake timers)
            jest.advanceTimersByTime(10);
            // Allow promise microtasks to settle
            await Promise.resolve();

            // Interrupt it
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'random',
                content:     'Urgent question!',
            };
            runner.interrupt(message);

            // Verify abort was called
            expect(capturedSignal).not.toBeNull();
            expect(capturedSignal!.aborted).toBe(true);

            // Clean up by advancing timers to complete the promise
            jest.advanceTimersByTime(10000);
            await startPromise;
        });
    });

    describe('resumeAfterInterruption', () => {
        it('should return early when NOT in catching_up_interrupted state', async () => {
            // Set state to idle (not catching_up_interrupted)
            mockStateManager.getState = mock(() => 'idle' as CatchUpState);

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            // Should not run agent session or change state
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            expect(mockStateManager.setState).not.toHaveBeenCalled();
            // Should not create abort controller or check inbox
            expect(mockInboxManager.getUnreadOverview).not.toHaveBeenCalled();
        });

        it('should complete when totalUnread === 0', async () => {
            // Set up state as catching_up_interrupted
            mockStateManager.getState = mock(() => 'catching_up_interrupted' as CatchUpState);
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 0,
                channels:    [],
            });

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            // Should call completeCatchUp without running agent session
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
            expect(mockStateManager.setState).toHaveBeenCalledWith('idle');
        });

        it('should use fallback values when no interrupting message', async () => {
            // Set up state as catching_up_interrupted
            mockStateManager.getState = mock(() => 'catching_up_interrupted' as CatchUpState);
            mockStateManager.getViewedChannels = mock((): Set<ChannelId> => new Set<ChannelId>());
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'support', messageCount: 3 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            // Do NOT call interrupt before resuming - so no interrupting message
            await runner.resumeAfterInterruption();

            expect(mockRunAgentSession).toHaveBeenCalled();
            const options = mockRunAgentSession.mock.calls[0][0] as RunAgentSessionOptions;

            // Verify prompt contains fallback values
            expect(options.prompt).toContain('Unknown'); // author fallback
            expect(options.prompt).toContain('#unknown'); // channel name fallback
            // Content should be empty string (no content in fallback)
        });

        it('should use buildCatchUpInterruptedPrompt with viewed channels and interrupting message', async () => {
            // Set up state as catching_up_interrupted
            mockStateManager.getState = mock(() => 'catching_up_interrupted' as CatchUpState);

            // Mock viewed channels
            const viewedChannel1 = createChannelId('111');
            const viewedChannel2 = createChannelId('222');
            mockStateManager.getViewedChannels = mock(() => new Set([viewedChannel1, viewedChannel2]));

            // Mock channel name resolution
            const mockResolveChannelName = mock((channelId: ChannelId) => {
                if(channelId === viewedChannel1) {
                    return 'general';
                }
                if(channelId === viewedChannel2) {
                    return 'random';
                }
                return undefined;
            });

            deps.resolveChannelName = mockResolveChannelName;

            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'support', messageCount: 3 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);

            // First, interrupt with a message
            const interruptMessage: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Need help ASAP!',
            };
            runner.interrupt(interruptMessage);

            // Set state back to interrupted for resumeAfterInterruption
            mockStateManager.getState = mock(() => 'catching_up_interrupted' as CatchUpState);

            // Now resume
            await runner.resumeAfterInterruption();

            expect(mockRunAgentSession).toHaveBeenCalled();
            const options = mockRunAgentSession.mock.calls[0][0] as RunAgentSessionOptions;

            // Verify prompt contains interrupted content
            expect(options.prompt).toContain('CATCH-UP SESSION INTERRUPTED');
            expect(options.prompt).toContain('general, random'); // viewed channels
            expect(options.prompt).toContain('TestUser'); // author
            expect(options.prompt).toContain('#urgent'); // channel name
            expect(options.prompt).toContain('Need help ASAP!'); // message content
            expect(options.prompt).toContain('3 unread'); // remaining messages
        });

        it('should continue catch-up when unread > 0', async () => {
            // Set up state as catching_up_interrupted
            mockStateManager.getState = mock(() => 'catching_up_interrupted' as CatchUpState);
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            expect(mockStateManager.setState).toHaveBeenCalledWith('catching_up');
            expect(mockRunAgentSession).toHaveBeenCalled();
            // Should call completeCatchUp when completed
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.setState).toHaveBeenCalledWith('idle');
        });

        it('should complete when unread == 0', async () => {
            // Set up state as catching_up_interrupted
            mockStateManager.getState = mock(() => 'catching_up_interrupted' as CatchUpState);
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 0,
                channels:    [],
            });

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.setState).toHaveBeenCalledWith('idle');
        });

        it('should NOT call completeCatchUp when session is interrupted during resume', async () => {
            // Set up state as catching_up_interrupted
            mockStateManager.getState = mock(() => 'catching_up_interrupted' as CatchUpState);
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });
            // Session returns NOT completed (was interrupted again)
            mockRunAgentSession.mockResolvedValue({ completed: false, sessionId: 'session-456' } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            // completeCatchUp should NOT be called
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            // setState should have been called with 'catching_up' but NOT 'idle'
            expect(mockStateManager.setState).toHaveBeenCalledWith('catching_up');
            expect(mockStateManager.setState).not.toHaveBeenCalledWith('idle');
        });
    });

    describe('completeCatchUp', () => {
        it('should delete inProgress marker', async () => {
            const runner = createCatchUpSessionRunner(deps);
            await runner.completeCatchUp(2, 5);

            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
        });

        it('should store completion signal with stats', async () => {
            const runner = createCatchUpSessionRunner(deps);
            await runner.completeCatchUp(2, 5);

            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            const signal = mockStoreCompletionSignal.mock.calls[0][0] as CatchUpCompletionSignal;
            expect(signal.channelsProcessed).toBe(2);
            expect(signal.messagesProcessed).toBe(5);
            expect(signal.completedAt).toBeDefined();
        });

        it('should clear viewed channels', async () => {
            const runner = createCatchUpSessionRunner(deps);
            await runner.completeCatchUp(2, 5);

            expect(mockStateManager.clearViewedChannels).toHaveBeenCalled();
        });

        it('should set state to idle', async () => {
            const runner = createCatchUpSessionRunner(deps);
            await runner.completeCatchUp(2, 5);

            expect(mockStateManager.setState).toHaveBeenCalledWith('idle');
        });
    });

    describe('getAbortController', () => {
        it('should return null when no session is running', () => {
            const runner = createCatchUpSessionRunner(deps);
            const controller = runner.getAbortController();

            expect(controller).toBeNull();
        });

        it('should return abort controller during active session', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            mockRunAgentSession.mockImplementation(() => {
                return new Promise((resolve) => {
                    setTimeout(() => resolve({ completed: true }), 1000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up in background
            const startPromise = runner.startCatchUp();

            // Advance time to allow session to start (uses fake timers)
            jest.advanceTimersByTime(10);
            // Allow promise microtasks to settle
            await Promise.resolve();

            const controller = runner.getAbortController();
            expect(controller).not.toBeNull();
            expect(controller).toBeInstanceOf(AbortController);

            // Clean up by advancing timers to complete the promise
            jest.advanceTimersByTime(1000);
            await startPromise;
        });
    });
});
