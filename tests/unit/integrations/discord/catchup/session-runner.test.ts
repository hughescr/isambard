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
import type { BotStateManager, OperationalMode, CatchingUpModeContext, InterruptingMessageDetails } from '@/integrations/discord/state';
import type { InboxManager } from '@/integrations/discord/inbox';
import { createChannelId, type ChannelId } from '@/integrations/discord/types';

describe('CatchUpSessionRunner', () => {
    let mockStateManager: BotStateManager;
    let mockInboxManager: InboxManager;
    let mockStoreCompletionSignal: ReturnType<typeof mock>;
    let mockLoadCompletionSignal: ReturnType<typeof mock>;
    let mockStoreInProgressSignal: ReturnType<typeof mock>;
    let mockLoadInProgressSignal: ReturnType<typeof mock>;
    let mockDeleteInProgressSignal: ReturnType<typeof mock>;
    let mockRunAgentSession: ReturnType<typeof mock>;
    let deps: CatchUpSessionRunnerDeps;
    let mockTotalUnread: number;
    let mockMode: OperationalMode;
    let mockInterrupted: boolean;
    let mockModeContext: CatchingUpModeContext;

    beforeEach(() => {
        // Set up fake timers with fixed system time for deterministic tests
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-25T12:00:00.000Z'));

        // Default mode state
        mockMode = 'idle';
        mockInterrupted = false;
        mockModeContext = {
            viewedChannels:      new Set<ChannelId>(),
            sessionId:           null,
            startedAt:           new Date(),
            unreadCount:         0,
            channelNames:        [],
            topAuthors:          [],
            timeSinceLastActive: null,
        };

        mockStateManager = {
            getMode:       mock(() => mockMode),
            isInterrupted: mock(() => mockInterrupted),
            startCatchUp:  mock((context: CatchingUpModeContext) => {
                mockMode        = 'catching_up';
                mockModeContext = context;
            }),
            interrupt: mock((message?: InterruptingMessageDetails) => {
                mockInterrupted = true;
                if(message) {
                    mockModeContext.interruptingMessage = message;
                }
            }),
            updateInterruptingMessage: mock((message: InterruptingMessageDetails) => {
                mockModeContext.interruptingMessage = message;
            }),
            resume: mock(() => { mockInterrupted = false; }),
            goIdle: mock(() => {
                mockMode        = 'idle';
                mockModeContext = { viewedChannels: new Set(), sessionId: null, startedAt: new Date(), unreadCount: 0, channelNames: [], topAuthors: [], timeSinceLastActive: null };
            }),
            markChannelViewed: mock((channelId: ChannelId) => { mockModeContext.viewedChannels.add(channelId); }),
            getState:          mock(() => ({ mode: mockMode, interrupted: mockInterrupted, activityPhase: null, modeEnteredAt: new Date(), modeContext: mockModeContext })),
        } as unknown as BotStateManager;

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

        // Set default mock return values for async signal functions
        mockStoreCompletionSignal.mockResolvedValue(undefined);
        mockLoadCompletionSignal.mockResolvedValue(null);
        mockStoreInProgressSignal.mockResolvedValue(undefined);
        mockLoadInProgressSignal.mockResolvedValue(null);
        mockDeleteInProgressSignal.mockResolvedValue(undefined);
        mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

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

        it('should return true when completed > 10 seconds ago', async () => {
            mockTotalUnread = 5;
            mockLoadInProgressSignal.mockResolvedValue(null);

            // 30 seconds ago from fixed time (12:00:00 - 30 seconds = 11:59:30)
            const thirtySecondsAgo = new Date('2025-01-25T11:59:30.000Z');
            mockLoadCompletionSignal.mockResolvedValue({
                completedAt:       thirtySecondsAgo.toISOString(),
                channelsProcessed: 2,
                messagesProcessed: 5,
            } as CatchUpCompletionSignal);

            const runner = createCatchUpSessionRunner(deps);
            const result = await runner.shouldStartCatchUp();

            expect(result).toBe(true);
        });

        it('should return false when completed < 10 seconds ago', async () => {
            mockTotalUnread = 5;
            mockLoadInProgressSignal.mockResolvedValue(null);

            // 5 seconds ago from fixed time (12:00:00 - 5 seconds = 11:59:55)
            const fiveSecondsAgo = new Date('2025-01-25T11:59:55.000Z');
            mockLoadCompletionSignal.mockResolvedValue({
                completedAt:       fiveSecondsAgo.toISOString(),
                channelsProcessed: 2,
                messagesProcessed: 5,
            } as CatchUpCompletionSignal);

            const runner = createCatchUpSessionRunner(deps);
            const result = await runner.shouldStartCatchUp();

            expect(result).toBe(false);
        });
    });

    describe('startCatchUp', () => {
        it('should prevent duplicate catch-up sessions when already in catching_up state', async () => {
            // Set mode to catching_up to test guard clause
            mockMode = 'catching_up';

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // Behavior: No side effects should occur when guard prevents duplicate session
            // The guard protects against TransitionError from BotStateManager.startCatchUp()
            expect(mockStoreInProgressSignal).not.toHaveBeenCalled();
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            expect(mockStateManager.startCatchUp).not.toHaveBeenCalled();
        });

        it('should transition to catching_up mode with correct context', async () => {
            const testChannelId = createChannelId('123');
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: testChannelId, channelName: 'general', messageCount: 5 }],
            });

            // Mock getChannelMessages with proper UnreadMessage structure
            const mockMessages = [
                {
                    id:          '1',
                    channelId:   testChannelId,
                    channelName: 'general',
                    guildId:     'DM' as const,
                    author:      'Alice',
                    content:     'Hello',
                    timestamp:   '2025-01-25T11:50:00.000Z',
                    isRead:      false,
                },
                {
                    id:          '2',
                    channelId:   testChannelId,
                    channelName: 'general',
                    guildId:     'DM' as const,
                    author:      'Bob',
                    content:     'Hi',
                    timestamp:   '2025-01-25T11:51:00.000Z',
                    isRead:      false,
                },
                {
                    id:          '3',
                    channelId:   testChannelId,
                    channelName: 'general',
                    guildId:     'DM' as const,
                    author:      'Alice',
                    content:     'How are you?',
                    timestamp:   '2025-01-25T11:52:00.000Z',
                    isRead:      false,
                },
            ];
            mockInboxManager.getChannelMessages = mock(() => mockMessages);

            mockLoadCompletionSignal.mockResolvedValue({
                completedAt:       new Date('2025-01-25T11:00:00.000Z').toISOString(),
                channelsProcessed: 1,
                messagesProcessed: 3,
            } as CatchUpCompletionSignal);
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            expect(mockStateManager.startCatchUp).toHaveBeenCalled();
            // Access the mock property via type assertion to avoid TS error
            const startCatchUpMock = mockStateManager.startCatchUp as ReturnType<typeof mock>;
            const context = startCatchUpMock.mock.calls[0][0] as CatchingUpModeContext;

            // Verify context has correct structure and values
            expect(context.viewedChannels).toEqual(new Set());
            expect(context.sessionId).toBeNull();
            expect(context.startedAt).toBeInstanceOf(Date);
            expect(context.unreadCount).toBe(5);
            expect(context.channelNames).toEqual(['general']);
            expect(context.topAuthors).toEqual(['Alice', 'Bob']); // Alice appears twice, Bob once
            expect(context.timeSinceLastActive).toBe('an hour'); // From fixed time 12:00:00 - 11:00:00
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
            expect(mockStateManager.goIdle).toHaveBeenCalled();
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
            expect(mockStateManager.startCatchUp).toHaveBeenCalled();
            expect(mockStateManager.goIdle).not.toHaveBeenCalled();
        });

        it('should NOT call completeCatchUp when session returns completed=true but isInterrupted is true', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Session returns completed=true, but stateManager says interrupted
            mockRunAgentSession.mockResolvedValue({ completed: true, sessionId: 'session-123' } as AgentSessionResult);

            // Set interrupted flag BEFORE starting catch-up
            mockInterrupted = true;

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // completeCatchUp should NOT be called even though result.completed is true
            // because stateManager.isInterrupted() returns true
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).not.toHaveBeenCalled();
            expect(mockStateManager.goIdle).not.toHaveBeenCalled();

            // startCatchUp should have been called
            expect(mockStateManager.startCatchUp).toHaveBeenCalled();

            // runAgentSession should have been called only ONCE (no auto-resume)
            // Resume is now handled externally via resumeAfterInterruption()
            expect(mockRunAgentSession).toHaveBeenCalledTimes(1);
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
            expect(mockStateManager.goIdle).toHaveBeenCalled();

            // Verify completion signal has 0 channels and messages
            const signal = mockStoreCompletionSignal.mock.calls[0][0] as CatchUpCompletionSignal;
            expect(signal.channelsProcessed).toBe(0);
            expect(signal.messagesProcessed).toBe(0);
        });

        it('should NOT call completeCatchUp when non-AbortError is thrown but state is interrupted', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });
            // Simulate the agent session throwing a non-AbortError (like "Claude Code process aborted by user")
            const abortLikeError = new Error('Claude Code process aborted by user');
            mockRunAgentSession.mockRejectedValue(abortLikeError);

            // Set the state to interrupted (simulating interrupt() was called)
            mockInterrupted = true;

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // Should NOT call completeCatchUp (storeCompletionSignal is part of completeCatchUp)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).not.toHaveBeenCalled();
            expect(mockStateManager.goIdle).not.toHaveBeenCalled();
        });
    });

    describe('interrupt', () => {
        it('should mark state as interrupted', () => {
            const runner = createCatchUpSessionRunner(deps);
            const message: InterruptingMessage = {
                channelId:   createChannelId('123'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Hey bot!',
            };

            runner.interrupt(message);

            expect(mockStateManager.interrupt).toHaveBeenCalled();
        });

        it('should abort current session', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Mock a long-running agent session
            let capturedSignal: AbortSignal | undefined;
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
            // Allow promise microtasks to settle - need multiple cycles for async chain
            await Promise.resolve();
            await Promise.resolve();
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

        it('should leave state as interrupted when abort error is caught after interrupt (awaiting external resume)', async () => {
            // Set up inbox with unread messages
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // First call waits for abort signal, then throws AbortError
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                return new Promise((_resolve, reject) => {
                    if(options.abortSignal.aborted) {
                        const abortError = new Error('Aborted');
                        abortError.name = 'AbortError';
                        reject(abortError);
                    } else {
                        options.abortSignal.addEventListener('abort', () => {
                            const abortError = new Error('Aborted');
                            abortError.name = 'AbortError';
                            reject(abortError);
                        });
                    }
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up
            const startPromise = runner.startCatchUp();

            // Allow async chain to start
            await Promise.resolve();
            await Promise.resolve();

            // Interrupt with a message
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'random',
                content:     'Urgent question!',
            };
            runner.interrupt(message);

            // Wait for the first session to abort
            await startPromise;

            // State should remain interrupted — no auto-resume
            // The onResponse callback in bot.ts will call resumeAfterInterruption() externally
            expect(mockStateManager.goIdle).not.toHaveBeenCalled();

            // runAgentSession should have been called only ONCE (no auto-resume)
            expect(mockRunAgentSession).toHaveBeenCalledTimes(1);
        });
    });

    describe('interrupt - double-interrupt guard', () => {
        it('should not abort when already interrupted', async () => {
            // Set up state as already interrupted
            mockInterrupted = true;

            const runner = createCatchUpSessionRunner(deps);

            // Call interrupt with a message
            const message: InterruptingMessage = {
                channelId:   createChannelId('789'),
                author:      'TestUser2',
                channelName: 'announcements',
                content:     'Second interrupt attempt',
            };
            runner.interrupt(message);

            // Verify stateManager.interrupt was NOT called (due to early return)
            expect(mockStateManager.interrupt).not.toHaveBeenCalled();
        });

        it('should abort when not already interrupted', async () => {
            // Set up inbox with unread messages
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Set initial state as NOT interrupted
            mockInterrupted = false;

            // Mock a long-running agent session
            let capturedSignal: AbortSignal | undefined;
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                capturedSignal = options.abortSignal;
                return new Promise((resolve) => {
                    setTimeout(() => resolve({ completed: true }), 10000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up session to create abort controller
            const startPromise = runner.startCatchUp();

            // Advance time to allow session to start (uses fake timers)
            jest.advanceTimersByTime(10);
            // Allow promise microtasks to settle - need multiple cycles for async chain
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Call interrupt with a message
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'random',
                content:     'First interrupt',
            };
            runner.interrupt(message);

            // Verify stateManager.interrupt WAS called
            expect(mockStateManager.interrupt).toHaveBeenCalled();

            // Verify abort controller WAS aborted
            expect(capturedSignal).not.toBeNull();
            expect(capturedSignal!.aborted).toBe(true);

            // Clean up by advancing timers to complete the promise
            jest.advanceTimersByTime(10000);
            await startPromise;
        });
    });

    describe('resumeAfterInterruption', () => {
        it('should return early when NOT in catching_up_interrupted state', async () => {
            // Set mode to idle (not catching_up + interrupted)
            mockMode = 'idle';
            mockInterrupted = false;

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            // Should not run agent session or change state
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            expect(mockStateManager.resume).not.toHaveBeenCalled();
            // Should not create abort controller or check inbox
            expect(mockInboxManager.getUnreadOverview).not.toHaveBeenCalled();
        });

        it('should return early when in catching_up mode but NOT interrupted', async () => {
            // Set mode to catching_up but NOT interrupted
            mockMode = 'catching_up';
            mockInterrupted = false;

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            // Should not run agent session or change state
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            expect(mockStateManager.resume).not.toHaveBeenCalled();
            // Should not check inbox
            expect(mockInboxManager.getUnreadOverview).not.toHaveBeenCalled();
        });

        it('should complete when totalUnread === 0', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
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
            // goIdle called exactly once (by completeCatchUp), not again by finally block safety net
            expect(mockStateManager.goIdle).toHaveBeenCalledTimes(1);
        });

        it('should use fallback values when no interrupting message', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockModeContext.viewedChannels = new Set<ChannelId>();
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
            // Set up state as catching_up (but not interrupted yet)
            mockMode = 'catching_up';
            mockInterrupted = false;

            // Mock viewed channels
            const viewedChannel1 = createChannelId('111');
            const viewedChannel2 = createChannelId('222');
            mockModeContext.viewedChannels = new Set([viewedChannel1, viewedChannel2]);

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
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            expect(mockStateManager.resume).toHaveBeenCalled();
            expect(mockRunAgentSession).toHaveBeenCalled();
            // Should call completeCatchUp when completed
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();
        });

        it('should complete when unread == 0', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 0,
                channels:    [],
            });

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();
        });

        it('should clean up via safety net when resume session returns incomplete', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });
            // Session returns NOT completed (incomplete exit, not re-interrupted)
            mockRunAgentSession.mockResolvedValue({ completed: false, sessionId: 'session-456' } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterInterruption();

            // completeCatchUp should NOT be called
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            // resume and goIdle should have been called from finally block safety net
            expect(mockStateManager.resume).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();
        });

        it('should prevent concurrent doResume execution (resumeInProgress guard)', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });

            let resolveSession: ((value: AgentSessionResult) => void) | undefined;
            mockRunAgentSession.mockImplementation(() => new Promise<AgentSessionResult>((resolve) => {
                resolveSession = resolve;
            }));

            const runner = createCatchUpSessionRunner(deps);

            // Call resumeAfterInterruption twice concurrently
            const promise1 = runner.resumeAfterInterruption();
            const promise2 = runner.resumeAfterInterruption();

            // Only one should actually execute
            expect(mockRunAgentSession).toHaveBeenCalledTimes(1);

            // Resolve the session
            resolveSession!({ completed: true, sessionId: 'session-guard-test' } as AgentSessionResult);
            await promise1;
            await promise2;

            // Verify cleanup
            expect(mockStoreCompletionSignal).toHaveBeenCalledTimes(1);
        });
    });

    describe('re-interrupt during resume', () => {
        it('should abort the resume session when interrupted during active resume', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });

            // Mock a long-running agent session
            let capturedSignal: AbortSignal | undefined;
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                capturedSignal = options.abortSignal;
                return new Promise((resolve) => {
                    setTimeout(() => resolve({ completed: true }), 10000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start resume (don't await)
            const resumePromise = runner.resumeAfterInterruption();

            // Advance timers to start the session
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();

            // Re-interrupt while resume is in progress
            // This simulates a new message arriving during resume
            mockInterrupted = true; // Simulate isInterrupted() returning true
            const reinterruptMessage: InterruptingMessage = {
                channelId:   createChannelId('999'),
                author:      'NewUser',
                channelName: 'urgent',
                content:     'Re-interrupt message',
            };
            runner.interrupt(reinterruptMessage);

            // Verify AbortController was aborted
            expect(capturedSignal?.aborted).toBe(true);

            // Verify updateInterruptingMessage was called with new message (NOT stateManager.interrupt)
            expect(mockStateManager.updateInterruptingMessage).toHaveBeenCalledWith(reinterruptMessage);
            expect(mockStateManager.interrupt).not.toHaveBeenCalled();

            // Complete the promise
            jest.advanceTimersByTime(10000);
            await resumePromise;
        });

        it('should stay in catching_up+interrupted after re-interrupt (not call completeCatchUp)', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });

            // Mock session that completes after abort (simulating graceful shutdown)
            let abortedDuringResume = false;
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        abortedDuringResume = true;
                        resolve({ completed: false, sessionId: 'aborted-session' });
                    });
                    setTimeout(() => resolve({ completed: true }), 10000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start resume
            const resumePromise = runner.resumeAfterInterruption();

            // Advance timers to start the session
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();

            // Re-interrupt
            mockInterrupted = true;
            runner.interrupt({
                channelId:   createChannelId('999'),
                author:      'NewUser',
                channelName: 'urgent',
                content:     'Re-interrupt',
            });

            // Complete the promise
            jest.advanceTimersByTime(10000);
            await resumePromise;

            // Verify session was aborted during resume
            expect(abortedDuringResume).toBe(true);

            // completeCatchUp should NOT be called (stay interrupted)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();

            // resume() should NOT be called (stay interrupted)
            expect(mockStateManager.resume).not.toHaveBeenCalled();

            // goIdle should NOT be called (stay in catching_up)
            expect(mockStateManager.goIdle).not.toHaveBeenCalled();
        });

        it('should handle new resumeAfterInterruption call after re-interrupt', async () => {
            // Set up state as catching_up + interrupted
            mockMode = 'catching_up';
            mockInterrupted = true;
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });

            // Mock session that aborts gracefully
            let sessionCounter = 0;
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                const currentSession = ++sessionCounter;
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false, sessionId: `session-${currentSession}` });
                    });
                    setTimeout(() => resolve({ completed: true, sessionId: `session-${currentSession}` }), 1000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // First resume
            const resume1Promise = runner.resumeAfterInterruption();
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();

            // Re-interrupt
            mockInterrupted = true;
            runner.interrupt({
                channelId:   createChannelId('999'),
                author:      'User1',
                channelName: 'channel1',
                content:     'First interrupt',
            });

            // Complete first resume
            jest.advanceTimersByTime(1000);
            await resume1Promise;

            // Verify first session ran
            expect(sessionCounter).toBe(1);

            // Second resume (after re-interrupt)
            const resume2Promise = runner.resumeAfterInterruption();
            jest.advanceTimersByTime(1000);

            // Verify second session started
            expect(sessionCounter).toBe(2);

            await resume2Promise;

            // Second resume should complete successfully
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();
        });

        it('should treat re-interrupt when NOT in resume as no-op', async () => {
            // Set up as already interrupted but resume NOT in progress
            mockMode = 'catching_up';
            mockInterrupted = true;

            const runner = createCatchUpSessionRunner(deps);

            // Interrupt again (but no resume session is running)
            const message: InterruptingMessage = {
                channelId:   createChannelId('789'),
                author:      'TestUser',
                channelName: 'channel',
                content:     'Another message',
            };
            runner.interrupt(message);

            // Should not call stateManager.interrupt (early return)
            expect(mockStateManager.interrupt).not.toHaveBeenCalled();

            // updateInterruptingMessage should also NOT be called (no active resume)
            expect(mockStateManager.updateInterruptingMessage).not.toHaveBeenCalled();
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

        it('should transition to idle', async () => {
            const runner = createCatchUpSessionRunner(deps);
            await runner.completeCatchUp(2, 5);

            expect(mockStateManager.goIdle).toHaveBeenCalled();
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
            // Allow promise microtasks to settle - need multiple cycles for async chain
            await Promise.resolve();
            await Promise.resolve();
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
