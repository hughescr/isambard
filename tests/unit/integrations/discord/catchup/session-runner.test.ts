import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { createCatchUpSessionRunner,
    type CatchUpSessionRunnerDeps,
    type CatchUpCompletionSignal,
    type CatchUpInProgressSignal,
    type RunAgentSessionOptions,
    type AgentSessionResult,
    type InterruptingMessage
} from '@/integrations/discord/catchup/session-runner';
import type { InboxManager } from '@/integrations/discord/inbox';
import type { BotStateManager, OperationalMode, CatchingUpModeContext } from '@/integrations/discord/state';
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
    let mockModeContext: CatchingUpModeContext;

    beforeEach(() => {
        // Set up fake timers with fixed system time for deterministic tests
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-25T12:00:00.000Z'));

        // Default mode state
        mockMode = 'idle';
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
            getMode:      mock(() => mockMode),
            startCatchUp: mock((context: CatchingUpModeContext) => {
                mockMode        = 'catching_up';
                mockModeContext = context;
            }),
            goIdle: mock(() => {
                mockMode        = 'idle';
                mockModeContext = { viewedChannels: new Set(), sessionId: null, startedAt: new Date(), unreadCount: 0, channelNames: [], topAuthors: [], timeSinceLastActive: null };
            }),
            markChannelViewed: mock((channelId: ChannelId) => { mockModeContext.viewedChannels.add(channelId); }),
            getState:          mock(() => ({ mode: mockMode, activityPhase: null, modeEnteredAt: new Date(), modeContext: mockModeContext })),
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

        it('should NOT call completeCatchUp when session is suspended (suspension path during runSessionAndFinalize)', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Mock session that returns when abort is triggered
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        // Session aborted due to suspension - returns NOT completed
                        resolve({ completed: false, sessionId: 'session-123' });
                    });
                    // Simulate long-running session
                    setTimeout(() => resolve({ completed: true }), 10_000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up
            const startPromise = runner.startCatchUp();

            // Allow session to start
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Suspend mid-run
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Urgent!',
            };
            runner.suspend(message);

            // Complete the session
            jest.advanceTimersByTime(100);
            await startPromise;

            // completeCatchUp should NOT be called (suspension path)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).not.toHaveBeenCalled();

            // Session state should be preserved for resume
            expect(runner.isSuspended()).toBe(true);

            // Now verify that resuming works (session ID was preserved)
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('789'), channelName: 'support', messageCount: 3 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            await runner.resumeAfterSuspension();

            // Now completeCatchUp SHOULD be called
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(runner.isSuspended()).toBe(false);
        });

        it('should call completeCatchUp when session returns completed=true and NOT suspended', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Session returns completed=true, no suspension
            mockRunAgentSession.mockResolvedValue({ completed: true, sessionId: 'session-123' } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // completeCatchUp SHOULD be called when completed and not suspended
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();

            // startCatchUp should have been called
            expect(mockStateManager.startCatchUp).toHaveBeenCalled();

            // runAgentSession should have been called only ONCE
            expect(mockRunAgentSession).toHaveBeenCalledTimes(1);
        });

        it('should fall through when session returns completed=false but NOT suspended (e.g., aborted externally)', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Session returns completed=false, but suspendedState is null (not suspended, just aborted)
            mockRunAgentSession.mockResolvedValue({ completed: false, sessionId: 'session-789' } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);
            await runner.startCatchUp();

            // completeCatchUp should NOT be called (fall-through case)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).not.toHaveBeenCalled();

            // Should NOT be suspended (no suspend() was called)
            expect(runner.isSuspended()).toBe(false);

            // State is still catching_up because no completion or suspension cleanup happened
            expect(mockStateManager.getMode()).toBe('catching_up');
        });

        it('should preserve session state when result.completed === false AND suspendedState !== null', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Track calls to runAgentSession
            let sessionCallCount = 0;
            const capturedSessionIds: (string | undefined)[] = [];
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                sessionCallCount++;
                // Capture the session ID passed to runAgentSession
                capturedSessionIds.push(options.sessionId);

                // First call: aborted during suspension
                if(sessionCallCount === 1) {
                    return new Promise((resolve) => {
                        options.abortSignal.addEventListener('abort', () => {
                            // Return incomplete with session ID
                            resolve({ completed: false, sessionId: 'session-1' });
                        });
                        setTimeout(() => resolve({ completed: true, sessionId: 'session-1' }), 10_000);
                    });
                }

                // Second call: resume - completes successfully
                return Promise.resolve({ completed: true, sessionId: 'resumed-session' });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up
            const startPromise = runner.startCatchUp();

            // Allow session to start
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Suspend mid-run (sets suspendedState)
            runner.suspend({
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Urgent message!',
            });

            // Complete the aborted session
            await startPromise;

            // Verify the suspension condition was hit:
            // 1. completeCatchUp was NOT called
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).not.toHaveBeenCalled();

            // 2. Suspension state is preserved
            expect(runner.isSuspended()).toBe(true);

            // 3. First call had no sessionId (new session)
            expect(capturedSessionIds[0]).toBeUndefined();

            // 4. Session can be resumed (proving sessionId was preserved)
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 2,
                channels:    [{ channelId: createChannelId('789'), channelName: 'support', messageCount: 2 }],
            });

            await runner.resumeAfterSuspension();

            // 5. Resume starts a NEW session because the first one was aborted before completion
            // The session ID from the aborted session is NOT preserved (it was never "completed")
            expect(capturedSessionIds[1]).toBeUndefined();

            // After resume completes, completeCatchUp SHOULD be called
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(runner.isSuspended()).toBe(false);
        });

        it('should require BOTH !result.completed AND suspendedState !== null to enter suspension block', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Session returns incomplete without suspension
            mockRunAgentSession.mockResolvedValue({ completed: false, sessionId: 'session-xyz' } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);

            // Do NOT call suspend - so suspendedState is null
            await runner.startCatchUp();

            // When !result.completed is true but suspendedState is null:
            // - Should NOT be suspended
            expect(runner.isSuspended()).toBe(false);

            // - Should NOT call completeCatchUp (fall-through case)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();

            // If the condition was mutated to OR (||), it would incorrectly treat this as suspended
            // This test ensures the AND (&&) logic is correct
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

        it('should NOT call completeCatchUp when AbortError is thrown and session is suspended', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Mock session that throws AbortError when suspended
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const abortError = new Error('Aborted');
                        abortError.name = 'AbortError';
                        reject(abortError);
                    });
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up
            const startPromise = runner.startCatchUp();

            // Allow session to start
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();

            // Suspend mid-run (this will abort the session)
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Urgent!',
            };
            runner.suspend(message);

            await startPromise;

            // Should NOT call completeCatchUp (suspension abort path)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).not.toHaveBeenCalled();
        });
    });

    describe('suspend', () => {
        it('should transition to idle mode', () => {
            mockMode = 'catching_up'; // Must be in catching_up mode
            const runner = createCatchUpSessionRunner(deps);
            const message: InterruptingMessage = {
                channelId:   createChannelId('123'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Hey bot!',
            };

            runner.suspend(message);

            expect(mockStateManager.goIdle).toHaveBeenCalled();
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
                    setTimeout(() => resolve({ completed: true }), 10_000);
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

            // Suspend it
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'random',
                content:     'Urgent question!',
            };
            runner.suspend(message);

            // Verify abort was called
            expect(capturedSignal).not.toBeNull();
            expect(capturedSignal!.aborted).toBe(true);

            // Verify goIdle was called after abort
            expect(mockStateManager.goIdle).toHaveBeenCalled();

            // Clean up by advancing timers to complete the promise
            jest.advanceTimersByTime(10_000);
            await startPromise;
        });

        it('should leave state as suspended when abort error is caught after suspend (awaiting external resume)', async () => {
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

            // Suspend with a message
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'random',
                content:     'Urgent question!',
            };
            runner.suspend(message);

            // Wait for the first session to abort
            await startPromise;

            // Verify suspension state is set
            expect(runner.isSuspended()).toBe(true);

            // runAgentSession should have been called only ONCE (no auto-resume)
            expect(mockRunAgentSession).toHaveBeenCalledTimes(1);
        });
    });

    describe('suspend - double-suspend guard', () => {
        it('should be a no-op when NOT in catching_up mode', async () => {
            // Set up state as idle (NOT catching_up)
            mockMode = 'idle';

            const runner = createCatchUpSessionRunner(deps);

            // Call suspend with a message
            const message: InterruptingMessage = {
                channelId:   createChannelId('789'),
                author:      'TestUser2',
                channelName: 'announcements',
                content:     'Second suspend attempt',
            };
            runner.suspend(message);

            // Should NOT transition to idle (already idle)
            // Can't check goIdle wasn't called as it might be called by other tests
            // But verify no suspension state is set
            expect(runner.isSuspended()).toBe(false);
        });

        it('should abort and transition to idle when first suspend (NOT already suspended)', async () => {
            // Set up inbox with unread messages
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Mock a long-running agent session
            let capturedSignal: AbortSignal | undefined;
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                capturedSignal = options.abortSignal;
                return new Promise((resolve) => {
                    setTimeout(() => resolve({ completed: true }), 10_000);
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

            // Call suspend with a message
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'random',
                content:     'First suspend',
            };
            runner.suspend(message);

            // Verify goIdle WAS called
            expect(mockStateManager.goIdle).toHaveBeenCalled();

            // Verify abort controller WAS aborted
            expect(capturedSignal).not.toBeUndefined();
            expect(capturedSignal!.aborted).toBe(true);

            // Clean up by advancing timers to complete the promise
            jest.advanceTimersByTime(10_000);
            await startPromise;
        });
    });

    describe('resumeAfterSuspension', () => {
        it('should return early when NOT suspended', async () => {
            const runner = createCatchUpSessionRunner(deps);
            await runner.resumeAfterSuspension();

            // Should not run agent session or change state
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            expect(mockStateManager.startCatchUp).not.toHaveBeenCalled();
            // Should not check inbox
            expect(mockInboxManager.getUnreadOverview).not.toHaveBeenCalled();
        });

        it('should complete when totalUnread === 0', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 0,
                channels:    [],
            });

            const runner = createCatchUpSessionRunner(deps);

            // Suspend first to set state
            mockMode = 'catching_up';
            const message: InterruptingMessage = {
                channelId:   createChannelId('123'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Message',
            };
            runner.suspend(message);

            await runner.resumeAfterSuspension();

            // Should call completeCatchUp without running agent session
            expect(mockRunAgentSession).not.toHaveBeenCalled();
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockDeleteInProgressSignal).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();
        });

        it('should use buildCatchUpResumedPrompt with viewed channels and suspending message', async () => {
            // Set up state as catching_up
            mockMode = 'catching_up';

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

            // First, suspend with a message
            const suspendMessage: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Need help ASAP!',
            };
            runner.suspend(suspendMessage);

            // Now resume
            await runner.resumeAfterSuspension();

            expect(mockRunAgentSession).toHaveBeenCalled();
            const options = mockRunAgentSession.mock.calls[0][0] as RunAgentSessionOptions;

            // Verify prompt contains resumed content
            expect(options.prompt).toContain('CATCH-UP SESSION RESUMED');
            expect(options.prompt).toContain('general, random'); // viewed channels
            expect(options.prompt).toContain('TestUser'); // author
            expect(options.prompt).toContain('#urgent'); // channel name
            expect(options.prompt).toContain('Need help ASAP!'); // message content
            expect(options.prompt).toContain('3 unread'); // remaining messages
        });

        it('should continue catch-up when unread > 0', async () => {
            mockMode = 'catching_up';
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });
            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);

            // Suspend first
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Message',
            };
            runner.suspend(message);

            await runner.resumeAfterSuspension();

            expect(mockStateManager.startCatchUp).toHaveBeenCalled();
            expect(mockRunAgentSession).toHaveBeenCalled();
            // Should call completeCatchUp when completed
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();
        });

        it('should NOT call completeCatchUp when resume session returns incomplete', async () => {
            mockMode = 'catching_up';
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });
            // Session returns NOT completed (suspended again)
            mockRunAgentSession.mockResolvedValue({ completed: false, sessionId: 'session-456' } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);

            // First suspend
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Message',
            };
            runner.suspend(message);

            // Now suspend again (re-suspend during resume)
            const message2: InterruptingMessage = {
                channelId:   createChannelId('789'),
                author:      'TestUser2',
                channelName: 'urgent2',
                content:     'Message2',
            };
            runner.suspend(message2);

            await runner.resumeAfterSuspension();

            // completeCatchUp should NOT be called
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
        });

        it('should pass channel names from overview to stateManager.startCatchUp during resume', async () => {
            mockMode = 'catching_up';

            const channel1 = createChannelId('111');
            const channel2 = createChannelId('222');

            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [
                    { channelId: channel1, channelName: 'support', messageCount: 3 },
                    { channelId: channel2, channelName: 'feedback', messageCount: 2 },
                ],
            });
            mockInboxManager.getChannelMessages = mock(() => [
                {
                    id:          '1',
                    channelId:   channel1,
                    channelName: 'support',
                    guildId:     'DM' as const,
                    author:      'Alice',
                    content:     'Help',
                    timestamp:   '2025-01-25T11:50:00.000Z',
                    isRead:      false,
                },
            ]);

            mockRunAgentSession.mockResolvedValue({ completed: true } as AgentSessionResult);

            const runner = createCatchUpSessionRunner(deps);

            // Suspend first
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Message',
            };
            runner.suspend(message);

            await runner.resumeAfterSuspension();

            // Verify stateManager.startCatchUp was called
            expect(mockStateManager.startCatchUp).toHaveBeenCalled();
            const startCatchUpMock = mockStateManager.startCatchUp as ReturnType<typeof mock>;
            const context = startCatchUpMock.mock.calls[0][0] as CatchingUpModeContext;

            // Verify channel names match the overview
            expect(context.channelNames).toEqual(['support', 'feedback']);
        });
    });

    describe('re-suspend during resume', () => {
        it('should abort the resume session when suspended during active resume', async () => {
            mockMode = 'catching_up';
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 3,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 3 }],
            });

            // Mock a long-running agent session
            let capturedSignal: AbortSignal | undefined;
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                capturedSignal = options.abortSignal;
                return new Promise((resolve) => {
                    setTimeout(() => resolve({ completed: true }), 10_000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // First suspend
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'general',
                content:     'First message',
            };
            runner.suspend(message);

            // Start resume (don't await)
            const resumePromise = runner.resumeAfterSuspension();

            // Advance timers to start the session
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();

            // Re-suspend while resume is in progress
            // This simulates a new message arriving during resume
            const resuspendMessage: InterruptingMessage = {
                channelId:   createChannelId('999'),
                author:      'NewUser',
                channelName: 'urgent',
                content:     'Re-suspend message',
            };
            runner.suspend(resuspendMessage);

            // Verify AbortController was aborted
            expect(capturedSignal?.aborted).toBe(true);

            // Complete the promise
            jest.advanceTimersByTime(10_000);
            await resumePromise;
        });

        it('should NOT call completeCatchUp after re-suspend', async () => {
            mockMode = 'catching_up';
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
                    setTimeout(() => resolve({ completed: true }), 10_000);
                });
            });

            const runner = createCatchUpSessionRunner(deps);

            // First suspend
            const message: InterruptingMessage = {
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'general',
                content:     'First message',
            };
            runner.suspend(message);

            // Start resume
            const resumePromise = runner.resumeAfterSuspension();

            // Advance timers to start the session
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();

            // Re-suspend
            runner.suspend({
                channelId:   createChannelId('999'),
                author:      'NewUser',
                channelName: 'urgent',
                content:     'Re-suspend',
            });

            // Complete the promise
            jest.advanceTimersByTime(10_000);
            await resumePromise;

            // Verify session was aborted during resume
            expect(abortedDuringResume).toBe(true);

            // completeCatchUp should NOT be called (suspended again)
            expect(mockStoreCompletionSignal).not.toHaveBeenCalled();
        });

        it('should handle new resumeAfterSuspension call after re-suspend', async () => {
            mockMode = 'catching_up';
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

            // First suspend
            runner.suspend({
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'general',
                content:     'First message',
            });

            // First resume
            const resume1Promise = runner.resumeAfterSuspension();
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();

            // Re-suspend during first resume
            runner.suspend({
                channelId:   createChannelId('999'),
                author:      'User1',
                channelName: 'channel1',
                content:     'Second message',
            });

            // Complete first resume
            jest.advanceTimersByTime(1000);
            await resume1Promise;

            // Verify first session ran
            expect(sessionCounter).toBe(1);

            // Verify still suspended after first resume (because we re-suspended)
            expect(runner.isSuspended()).toBe(true);

            // Second resume (after re-suspend)
            const resume2Promise = runner.resumeAfterSuspension();

            // Allow second resume to complete
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();
            jest.advanceTimersByTime(1000);
            await resume2Promise;

            // Verify second session started
            expect(sessionCounter).toBe(2);

            // Second resume should complete successfully
            expect(mockStoreCompletionSignal).toHaveBeenCalled();
            expect(mockStateManager.goIdle).toHaveBeenCalled();
        });
    });

    describe('isSuspended', () => {
        it('should return false when no suspension state exists', () => {
            const runner = createCatchUpSessionRunner(deps);
            expect(runner.isSuspended()).toBe(false);
        });

        it('should return true after suspend() is called', () => {
            mockMode = 'catching_up';
            const runner = createCatchUpSessionRunner(deps);

            const message: InterruptingMessage = {
                channelId:   createChannelId('123'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Message',
            };
            runner.suspend(message);

            expect(runner.isSuspended()).toBe(true);
        });

        it('should return false after resumeAfterSuspension() clears state', async () => {
            mockMode = 'catching_up';
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 0,
                channels:    [],
            });

            const runner = createCatchUpSessionRunner(deps);

            const message: InterruptingMessage = {
                channelId:   createChannelId('123'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Message',
            };
            runner.suspend(message);
            expect(runner.isSuspended()).toBe(true);

            await runner.resumeAfterSuspension();
            expect(runner.isSuspended()).toBe(false);
        });
    });

    describe('clearSuspension', () => {
        it('should clear suspension state', () => {
            mockMode = 'catching_up';
            const runner = createCatchUpSessionRunner(deps);

            const message: InterruptingMessage = {
                channelId:   createChannelId('123'),
                author:      'TestUser',
                channelName: 'general',
                content:     'Message',
            };
            runner.suspend(message);
            expect(runner.isSuspended()).toBe(true);

            runner.clearSuspension();
            expect(runner.isSuspended()).toBe(false);
        });

        it('should be idempotent when no suspension state exists', () => {
            const runner = createCatchUpSessionRunner(deps);
            expect(runner.isSuspended()).toBe(false);

            runner.clearSuspension();
            expect(runner.isSuspended()).toBe(false);
        });

        it('should preserve session ID from suspended session for next startCatchUp after clearSuspension', async () => {
            mockInboxManager.getUnreadOverview = mock().mockReturnValue({
                totalUnread: 5,
                channels:    [{ channelId: createChannelId('123'), channelName: 'general', messageCount: 5 }],
            });

            // Track session IDs passed to runAgentSession
            const capturedSessionIds: (string | undefined)[] = [];
            mockRunAgentSession.mockImplementation((options: RunAgentSessionOptions) => {
                capturedSessionIds.push(options.sessionId);

                // First call: abort and return session ID
                if(capturedSessionIds.length === 1) {
                    return new Promise((resolve) => {
                        options.abortSignal.addEventListener('abort', () => {
                            resolve({ completed: false, sessionId: 'preserved-session' });
                        });
                        setTimeout(() => resolve({ completed: true, sessionId: 'preserved-session' }), 10_000);
                    });
                }

                // Second call: complete normally
                return Promise.resolve({ completed: true, sessionId: 'new-session' });
            });

            const runner = createCatchUpSessionRunner(deps);

            // Start catch-up
            const startPromise = runner.startCatchUp();

            // Allow session to start
            jest.advanceTimersByTime(10);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Suspend
            runner.suspend({
                channelId:   createChannelId('456'),
                author:      'TestUser',
                channelName: 'urgent',
                content:     'Message',
            });

            // Wait for aborted session to complete
            await startPromise;

            // Verify suspended
            expect(runner.isSuspended()).toBe(true);

            // Clear suspension WITHOUT resuming
            runner.clearSuspension();

            // Verify no longer suspended
            expect(runner.isSuspended()).toBe(false);

            // Start catch-up again
            await runner.startCatchUp();

            // The second startCatchUp should use the session ID from the first aborted session
            // This is what line 261 accomplishes: it updates currentSessionId so it's available
            // for the next startCatchUp (not just resume)
            expect(capturedSessionIds[0]).toBeUndefined(); // First call: no previous session
            expect(capturedSessionIds[1]).toBe('preserved-session'); // Second call: uses preserved ID
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
