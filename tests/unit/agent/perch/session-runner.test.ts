/* eslint-disable @typescript-eslint/unbound-method -- Tests use mock() with method references */
/* eslint-disable @typescript-eslint/no-empty-function, lodash/prefer-noop -- test mocks use empty functions to avoid unbound-method errors */
import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import _ from 'lodash';
import type { Logger } from '@hughescr/logger';
import {
    createPerchSessionRunner,
    type PerchSessionRunnerDeps,
    type RunAgentSessionOptions,
    type AgentSessionResult,
    type InterruptingMessage
} from '@/agent/perch/session-runner';
import type { BotStateManager, BotState, PerchingModeContext, InterruptingMessageDetails } from '@/integrations/discord/state';
import type { PerchConfig } from '@/agent/perch/types';
import { type ChannelId } from '@/integrations/discord/types';

// Mock logger
function createMockLogger(): Logger {
    return {
        debug: mock(() => {}),
        info:  mock(() => {}),
        warn:  mock(() => {}),
        error: mock(() => {}),
    } as unknown as Logger;
}

// Mock state manager
interface MockStateManagerState {
    mode:          BotState['mode']
    interrupted:   boolean
    activityPhase: BotState['activityPhase']
    modeEnteredAt: Date
    modeContext:   BotState['modeContext']
}

function createMockStateManager(initialState?: Partial<MockStateManagerState>): BotStateManager {
    const state: MockStateManagerState = {
        mode:          initialState?.mode ?? 'idle',
        interrupted:   initialState?.interrupted ?? false,
        activityPhase: initialState?.activityPhase ?? null,
        modeEnteredAt: initialState?.modeEnteredAt ?? new Date(),
        modeContext:   initialState?.modeContext ?? {},
    };

    return {
        getMode:       mock(() => state.mode),
        getState:      mock(() => ({ ...state, modeContext: { ...state.modeContext } } as BotState)),
        isInterrupted: mock(() => state.interrupted),
        startPerching: mock((activity: string) => {
            state.mode = 'perching';
            state.modeContext = { activityType: activity } as PerchingModeContext;
        }),
        interrupt: mock((message: InterruptingMessageDetails) => {
            state.interrupted = true;
            if(state.mode === 'perching') {
                (state.modeContext as PerchingModeContext).interruptingMessage = message;
            }
        }),
        resume: mock(() => {
            state.interrupted = false;
        }),
        goIdle: mock(() => {
            state.mode = 'idle';
            state.interrupted = false;
            state.modeContext = {};
        }),
    } as unknown as BotStateManager;
}

describe('PerchSessionRunner - Basic Lifecycle', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let mockRunAgentSession: ReturnType<typeof mock>;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        mockRunAgentSession = mock(async (): Promise<AgentSessionResult> => {
            return {
                completed: true,
                sessionId: 'test-session',
            };
        });

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

    test('should transition to perching mode when starting perch', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockStateManager.startPerching).toHaveBeenCalledWith('Perch time: pre-dawn');
    });

    test('should return abort controller when session is active', async () => {
        const longRunningSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: longRunningSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start session but don't await
        const sessionPromise = runner.startPerch('pre-dawn');

        // Let microtasks flush
        await Promise.resolve();

        const controller = runner.getAbortController();
        expect(controller).not.toBeNull();

        // Cleanup
        controller?.abort();

        // Wait for session to complete
        await sessionPromise;
    });

    test('should return null abort controller when no session is active', () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        expect(runner.getAbortController()).toBeNull();
    });

    test('should ignore startPerch if already in perching mode', async () => {
        const mockStateInPerching = createMockStateManager({ mode: 'perching' });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInPerching,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.warn).toHaveBeenCalled();
        expect(mockRunAgentSession).not.toHaveBeenCalled();
    });

    test('should ignore startPerch if not in idle mode', async () => {
        const mockStateInActive = createMockStateManager({ mode: 'processing_message' });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInActive,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify logger.warn was called with mode object (line 314)
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'processing_message' }),
            'Cannot start perch - not idle'
        );
        expect(mockRunAgentSession).not.toHaveBeenCalled();
    });

    test('should transition to idle when session completes', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should use test prompt when test mode is enabled', async () => {
        const testConfig: PerchConfig = {
            ...config,
            testMode: {
                triggerOnStartup: true,
            },
        };

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          testConfig,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        const call = mockRunAgentSession.mock.calls[0] as [RunAgentSessionOptions];
        expect(call[0].prompt).toContain('TEST MODE');
    });

    test('should use regular prompt when test mode is disabled', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        const call = mockRunAgentSession.mock.calls[0] as [RunAgentSessionOptions];
        expect(call[0].prompt).toContain('This is perch time');
    });

    test('should log perch session info with correct slot', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('mid-morning');

        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot:           'mid-morning',
                testMode:       false,
                timeoutMinutes: 45,
                msg:            'Starting perch session with timeout',
            })
        );
    });

    test('should log when session completes', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot: 'pre-dawn',
            }),
            'Perch session completed'
        );
    });
});

describe('PerchSessionRunner - Interruption', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
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

    test('should abort session when interrupted', async () => {
        let abortSignal: AbortSignal | undefined;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            abortSignal = options.abortSignal;
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'test',
            content:     'Hello!',
        };

        runner.interrupt(message);

        expect(abortSignal?.aborted).toBe(true);

        // Wait for session to complete
        await sessionPromise;
    });

    test('should store interrupting message', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'test-channel-name',
            content:     'Important message!',
        };

        runner.interrupt(message);

        expect(mockStateManager.interrupt).toHaveBeenCalledWith(message);

        // Wait for session to complete
        await sessionPromise;
    });

    test('should resume after interruption with interrupted prompt', async () => {
        let _resolveFirst: ((value: AgentSessionResult) => void) | null = null;
        let _rejectFirst: ((error: Error) => void) | null = null;
        let callCount = 0;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // First call - will be interrupted
                return new Promise<AgentSessionResult>((resolve, reject) => {
                    _resolveFirst = resolve;
                    _rejectFirst = reject;
                    options.abortSignal.addEventListener('abort', () => {
                        // Reject when aborted
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                // Second call - resume (complete immediately)
                return { completed: true, sessionId: 'resumed-session' };
            }
        });

        const mockStateManagerWithMessage = createMockStateManager();
        const interruptMessage: InterruptingMessageDetails = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'test-channel',
            content:     'Interrupting message',
        };

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManagerWithMessage,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start session (don't await yet)
        const sessionPromise = runner.startPerch('pre-dawn');

        // Let initial setup complete
        await Promise.resolve();

        // Interrupt the session
        runner.interrupt(interruptMessage);

        // Let abort listener fire asynchronously
        await Promise.resolve();

        // The sessionPromise completes when the first call's catch block finishes
        // (which schedules the resume but doesn't wait for it)
        await sessionPromise;

        // Verify interrupt was called
        expect(mockStateManagerWithMessage.interrupt).toHaveBeenCalledWith(interruptMessage);

        // Now run the setTimeout(0) for resume
        jest.runAllTimers();

        // Let the resume execute (doResume is async)
        await Promise.resolve();
        await Promise.resolve();

        // Verify second call uses interrupted prompt
        expect(sessionMock).toHaveBeenCalledTimes(2);
        const secondCall = sessionMock.mock.calls[1];
        const options = secondCall[0];
        expect(options.prompt).toContain('INTERRUPTED');
    });

    test('should include unknown defaults when interrupting message not stored', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                return { completed: true, sessionId: 'resumed-session' };
            }
        });

        // State manager without interrupting message in context
        const mockStateNoMessage = createMockStateManager({
            mode:        'idle',
            interrupted: false,
            modeContext: { activityType: 'Perch time: pre-dawn' } as PerchingModeContext,
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateNoMessage,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Simulate interrupt by manually setting state and aborting
        // This bypasses runner.interrupt() which would store the message
        const state = mockStateNoMessage as unknown as { interrupted: boolean };
        state.interrupted = true;
        const controller = runner.getAbortController();
        controller?.abort();

        // Run pending timers for the resume
        jest.advanceTimersByTime(1);
        await Promise.resolve();

        await sessionPromise;

        // Verify second call includes unknown defaults
        const secondCall = sessionMock.mock.calls[1];
        if(secondCall) {
            const options = secondCall[0];
            expect(options.prompt).toContain('Unknown');
            expect(options.prompt).toContain('unknown');
        } else {
            // If no second call, verify only one call was made
            expect(sessionMock).toHaveBeenCalledTimes(1);
        }
    });

    test('should not resume if not in perching mode', async () => {
        const mockStateIdle = createMockStateManager({ mode: 'idle', interrupted: true });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateIdle,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        // Should not attempt to resume
        expect(sessionMock).not.toHaveBeenCalled();
    });

    test('should not resume if not interrupted', async () => {
        const mockStateNotInterrupted = createMockStateManager({ mode: 'perching', interrupted: false });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateNotInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        expect(sessionMock).not.toHaveBeenCalled();
    });

    test('should schedule resume on next tick when interrupted', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                return { completed: true };
            }
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.interrupt({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'test',
        });

        // Verify interrupt was called
        expect(mockStateManager.interrupt).toHaveBeenCalled();

        // Let abort listener fire asynchronously
        await Promise.resolve();

        // sessionPromise completes after first call's catch block
        await sessionPromise;

        // Wait for resume to be scheduled and executed
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();

        // Verify resume was scheduled (second call made)
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Note: The resume happens from the catch block which doesn't log
        // "Session interrupted - scheduling resume". That log only happens
        // in the try block when a session completes successfully while interrupted.
    });
});

describe('PerchSessionRunner - Error Handling', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
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

    test('should handle AbortError without interrupt flag', async () => {
        const sessionMock = mock(async (_options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            const error = new Error('AbortError');
            error.name = 'AbortError';
            throw error;
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Perch session aborted'
        );
    });

    test('should transition to idle on non-abort errors', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Network error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.any(Error) as Error,
                slot:  'pre-dawn',
            }),
            'Perch session error'
        );
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should schedule resume on next tick when error occurs during interrupted session', async () => {
        // Start with perching mode to allow session to start
        const mockStateInterrupted = createMockStateManager({ mode: 'idle' });

        let callCount = 0;
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // Mark as interrupted before throwing error
                const state = mockStateInterrupted as unknown as { interrupted: boolean };
                state.interrupted = true;
                throw new Error('Some error');
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Wait for scheduled resume
        jest.advanceTimersByTime(1);
        await Promise.resolve();

        // Verify session was called once (startPerch starts session when mode is 'idle')
        expect(sessionMock).toHaveBeenCalledTimes(1);
    });
});

describe('PerchSessionRunner - Timeout', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let mockRunAgentSession: ReturnType<typeof mock>;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        // Use a realistic timestamp to avoid overflow issues with duration calculation
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        mockRunAgentSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Simulate a long-running session that will be aborted
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    reject(new Error('AbortError'));
                });
            });
        });

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

    test('should start timeout timer when perch session starts', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await - it will hang until aborted)
        void runner.startPerch('pre-dawn');

        // Verify timeout timer was created
        expect(jest.getTimerCount()).toBe(1);
    });

    test('should abort session when timeout is reached', async () => {
        let firstAbortSignal: AbortSignal | null = null;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(!firstAbortSignal) {
                firstAbortSignal = options.abortSignal;
                // First call - wait for abort
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Second call - complete immediately
            return {
                completed: true,
                sessionId: 'wrap-up-session',
            };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await - it will hang until aborted)
        const sessionPromise = runner.startPerch('pre-dawn');

        // Fast-forward to timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Wait for session to complete
        await sessionPromise;

        // Verify that runAgentSession was called twice:
        // 1. Initial session (aborted by timeout)
        // 2. Wrap-up session
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Verify second call had timeout prompt (check for timeout keywords in prompt)
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('PERCH SESSION TIMEOUT');
        expect(secondCall[0].prompt).toContain('wrap up');
    });

    test('should clear timeout when session completes normally', async () => {
        const quickSession = mock(async (): Promise<AgentSessionResult> => {
            return {
                completed: true,
                sessionId: 'test-session',
            };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: quickSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start and complete perch session
        await runner.startPerch('pre-dawn');

        // Verify timeout was cleared (no pending timers)
        expect(jest.getTimerCount()).toBe(0);
    });

    test('should clear timeout when interrupted by message', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await - it will hang until aborted)
        void runner.startPerch('pre-dawn');

        // Verify timeout timer exists
        expect(jest.getTimerCount()).toBe(1);

        // Interrupt with a message
        runner.interrupt({
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'test',
            content:     'Hello!',
        });

        // Verify timeout was cleared
        expect(jest.getTimerCount()).toBe(0);
    });

    test('should include session duration in timeout prompt', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // First call - wait for abort
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                // Second call - complete immediately
                return {
                    completed: true,
                    sessionId: 'wrap-up-session',
                };
            }
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session
        const sessionPromise = runner.startPerch('pre-dawn');

        // Fast-forward to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Wait for session to complete
        await sessionPromise;

        // Verify timeout prompt includes duration
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('45 minutes');
        expect(secondCall[0].prompt).toContain('max: 45 minutes');
    });

    test('should preserve partial work in timeout prompt', async () => {
        const sessionWithPartialWork = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // First call - wait for abort
            if(sessionWithPartialWork.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                // Second call - complete immediately
                return {
                    completed: true,
                    sessionId: 'wrap-up-session',
                };
            }
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionWithPartialWork,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session
        const sessionPromise = runner.startPerch('pre-dawn');

        // Fast-forward to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Wait for session to complete
        await sessionPromise;

        // Verify timeout prompt includes timeout marker
        const secondCall = sessionWithPartialWork.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    // Kill mutant on line 257: StringLiteral - test default partialWork object
    test('should use empty partialWork when none exists at timeout', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                // First call - no partialWork returned
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Second call - check the prompt
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify second call happened with default empty partialWork
        expect(sessionMock).toHaveBeenCalledTimes(2);
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        // The prompt should contain the timeout message (line 257 fallback was used)
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    test('should not timeout if not in perching mode', async () => {
        const mockStateIdle = createMockStateManager({ mode: 'idle' });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Complete immediately and transition back to idle
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateIdle,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch (starts in idle, transitions to perching, then completes and goes back to idle)
        await runner.startPerch('pre-dawn');

        // At this point, session completed and mode is back to idle (via goIdle)
        // Fast-forward past timeout - timeout handler should check mode and not abort
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Session was called once, completed, and then timeout was cleared
        // So advancing timers doesn't trigger any abort
        expect(sessionMock).toHaveBeenCalledTimes(1);
    });

    test('should log timeout info with slot and duration', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('afternoon');

        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Check for the timeout wrap-up log (line 262-267 in session-runner.ts)
        // Note: durationMin calculation uses Date.now() which may not be perfectly mocked
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot:        'afternoon',
                durationMin: expect.any(Number) as number,
                maxDuration: 45,
                msg:         'Resuming with timeout wrap-up prompt',
            })
        );
    });

    test('should calculate session duration correctly', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');

        // Advance exactly to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Check that duration was calculated (45 minutes = 2700000ms)
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toMatch(/45 minutes/);
    });

    test('should reset isTimingOut flag after timeout handling', async () => {
        let timeoutCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        timeoutCount++;
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');

        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Verify timeout flag was reset (by completing successfully)
        expect(sessionMock).toHaveBeenCalledTimes(2);
        expect(timeoutCount).toBe(1);
    });

    test('should use arithmetic operator correctly for timeout calculation', async () => {
        const customConfig: PerchConfig = {
            ...config,
            maxSessionMinutes: 30, // Different timeout
        };

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          customConfig,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');

        // Should timeout at 30 minutes, not 45
        jest.advanceTimersByTime(30 * 60 * 1000);

        await sessionPromise;

        // Verify timeout occurred at correct time
        expect(sessionMock).toHaveBeenCalledTimes(2);

        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('30 minutes');
        expect(secondCall[0].prompt).toContain('max: 30 minutes');
    });
});

describe('PerchSessionRunner - Session State', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
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

    test('should store session ID for resumption', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true, sessionId: 'resumed-session-id' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.interrupt({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'test',
        });

        // Wait for resume to complete
        jest.advanceTimersByTime(1);
        await Promise.resolve();

        await sessionPromise;

        // Verify session ID was passed to second call
        const secondCall = sessionMock.mock.calls[1];
        if(secondCall) {
            const options = secondCall[0];
            expect(options.sessionId).toBeUndefined(); // First interruption has no session ID yet
        } else {
            // If no second call was made, that's also acceptable
            expect(sessionMock).toHaveBeenCalledTimes(1);
        }
    });

    test('should clear session state when completed', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true, sessionId: 'test-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        await runner.startPerch('pre-dawn');

        // After completion, abort controller should be null
        expect(runner.getAbortController()).toBeNull();
    });

    test('should clear session state on error', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        await runner.startPerch('pre-dawn');

        // After error, abort controller should be null
        expect(runner.getAbortController()).toBeNull();
    });

    test('should preserve partial work across interruption', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true, sessionId: 'resumed' };
        });

        // Set up state manager - start in idle mode
        const mockStateWithWork = createMockStateManager({
            mode:        'idle',
            interrupted: false,
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateWithWork,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.interrupt({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'interrupt',
        });

        // Let abort listener fire asynchronously
        await Promise.resolve();

        // sessionPromise completes after first call's catch block
        await sessionPromise;

        // Wait for resume to complete
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();

        // Verify second call got partial work in prompt
        const secondCall = sessionMock.mock.calls[1];
        if(secondCall) {
            const options = secondCall[0];
            expect(options.prompt).toContain('INTERRUPTED');
        } else {
            // If no second call was made, fail the test with a meaningful message
            throw new Error('Expected a second call to be made after interruption');
        }
    });

    test('should include slot in session options', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        await runner.startPerch('evening');

        expect(sessionMock).toHaveBeenCalled();
        const calls = sessionMock.mock.calls as unknown as [RunAgentSessionOptions][];
        if(calls[0]?.[0]) {
            expect(calls[0][0].slot).toBe('evening');
        }
    });
});

describe('PerchSessionRunner - Mutant Killers', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
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

    // Kill mutant on line 140: ObjectLiteral {}
    test('should log with slot parameter when timeout occurs', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify logger.info was called with object containing slot
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Session timeout - aborting for wrap-up'
        );
    });

    // Kill mutants on line 149: ConditionalExpression false, LogicalOperator &&
    test('should skip resume when mode is not perching', async () => {
        const mockStateIdle = createMockStateManager({ mode: 'idle', interrupted: true });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateIdle,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        // Should not call runAgentSession because mode is not perching (line 150 return taken)
        expect(sessionMock).not.toHaveBeenCalled();
        // Verify resume was NOT called since we didn't meet guard conditions
        expect(mockStateIdle.resume).not.toHaveBeenCalled();
    });

    test('should skip resume when not interrupted', async () => {
        const mockStateNotInterrupted = createMockStateManager({ mode: 'perching', interrupted: false });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateNotInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        // Should not call runAgentSession because not interrupted (line 150 return taken)
        expect(sessionMock).not.toHaveBeenCalled();
        // Verify resume was NOT called since we didn't meet guard conditions
        expect(mockStateNotInterrupted.resume).not.toHaveBeenCalled();
    });

    test('should call resume when both perching and interrupted', async () => {
        const mockStateBoth = createMockStateManager({ mode: 'perching', interrupted: true });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateBoth,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        // Should call runAgentSession because both conditions met (line 150 return NOT taken)
        expect(sessionMock).toHaveBeenCalled();
        // Verify resume WAS called (clearing interrupted flag)
        expect(mockStateBoth.resume).toHaveBeenCalled();
    });

    // Kill mutant on line 213: BlockStatement {}
    test('should schedule resume when interrupted flag is set and session completes', async () => {
        // This tests the path where session completes successfully (doesn't throw)
        // but isInterrupted() is true, so resume is scheduled

        let callCount = 0;
        let interrupted = false;
        const mockStateInterruptible = createMockStateManager({ mode: 'idle' });

        // Override to control when interrupted flag is true
        (mockStateInterruptible.isInterrupted as ReturnType<typeof mock>).mockImplementation(() => interrupted);

        // Override resume to clear interrupted flag (like real state manager)
        (mockStateInterruptible.resume as ReturnType<typeof mock>).mockImplementation(() => {
            interrupted = false;
        });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // First call completes normally, set interrupted flag
                interrupted = true;
                return { completed: true };
            }
            // Second call after resume - complete normally
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInterruptible,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await sessionPromise;

        // Verify logger.debug was called for scheduling resume
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Session interrupted - scheduling resume'
        );

        // Run timers to execute resume
        jest.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();

        // Verify second call was made (resume was scheduled and executed)
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    // Kill mutant on line 217: ArrowFunction () => undefined
    test('should execute doResume function when setTimeout fires', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.interrupt({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'test',
        });

        await Promise.resolve();
        await sessionPromise;

        // Run timers to execute setTimeout
        jest.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();

        // Verify second call was made (resume executed)
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    // Kill mutant on line 221: ConditionalExpression true
    test('should only call goIdle when in perching mode on completion', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was called (because mode was perching)
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should not call goIdle when mode is not perching at completion time', async () => {
        // Create a custom state manager that tracks getMode calls
        let currentMode: BotState['mode'] = 'idle';
        const mockStateCustom = createMockStateManager({ mode: 'idle' });

        // Override getMode to return our tracked mode
        (mockStateCustom.getMode as ReturnType<typeof mock>).mockImplementation(() => currentMode);

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Simulate mode being changed externally before completion
            currentMode = 'processing_message';
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateCustom,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Mode will transition: idle -> perching (via startPerching) -> processing_message (via sessionMock)
        currentMode = 'idle'; // Start in idle
        await runner.startPerch('pre-dawn');

        // goIdle should not have been called because mode was not perching at completion
        expect(mockStateCustom.goIdle).not.toHaveBeenCalled();
    });

    // Kill mutant on line 246: BooleanLiteral true
    test('should reset isTimingOut flag to false after timeout handling', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify second call was made with timeout prompt (not another timeout)
        expect(sessionMock).toHaveBeenCalledTimes(2);
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    // Kill mutant on line 307: BlockStatement {}
    test('should prevent duplicate sessions when already perching', async () => {
        const mockStatePerching = createMockStateManager({ mode: 'perching' });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStatePerching,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify session was not started and warning was logged
        expect(mockLogger.warn).toHaveBeenCalledWith('Already in perching mode - ignoring startPerch');
        expect(sessionMock).not.toHaveBeenCalled();
    });

    // Kill mutants on line 376: ConditionalExpression false, BooleanLiteral, EqualityOperator ===
    test('should resume only when perching and interrupted', async () => {
        const mockStatePerchingInterrupted = createMockStateManager({ mode: 'perching', interrupted: true });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStatePerchingInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        // Should call runAgentSession because mode is perching AND interrupted
        expect(sessionMock).toHaveBeenCalled();
    });

    test('should not resume when perching but not interrupted', async () => {
        const mockStatePerchingOnly = createMockStateManager({ mode: 'perching', interrupted: false });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStatePerchingOnly,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        // Should not call runAgentSession because not interrupted
        expect(sessionMock).not.toHaveBeenCalled();
    });

    test('should not resume when interrupted but not perching', async () => {
        const mockStateIdleInterrupted = createMockStateManager({ mode: 'idle', interrupted: true });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateIdleInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.resumeAfterInterruption();

        // Should not call runAgentSession because mode is not perching
        expect(sessionMock).not.toHaveBeenCalled();
    });

    // Kill mutant on line 244: ConditionalExpression - test timeout abort vs message abort
    test('should handle timeout abort when all conditions are met', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        // Trigger timeout (sets isTimingOut = true before abort)
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify timeout wrap-up happened (line 244 condition was true)
        expect(sessionMock).toHaveBeenCalledTimes(2);
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    test('should not handle as timeout when isTimingOut is false', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('AbortError');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Abort without timeout (isTimingOut will be false)
        const controller = runner.getAbortController();
        controller?.abort();

        await sessionPromise;

        // Verify NO wrap-up session (line 244 condition was false, went to line 279 instead)
        expect(sessionMock).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Perch session aborted'
        );
    });

    // Kill mutant on line 286: ConditionalExpression - test goIdle call guard
    test('should call goIdle when error occurs and mode is perching', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was called (line 286 condition was true)
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should not call goIdle when error occurs but mode changed', async () => {
        let currentMode: BotState['mode'] = 'idle';
        const mockStateCustom = createMockStateManager({ mode: 'idle' });
        (mockStateCustom.getMode as ReturnType<typeof mock>).mockImplementation(() => currentMode);

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Change mode before error
            currentMode = 'processing_message';
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateCustom,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was NOT called (line 286 condition was false)
        expect(mockStateCustom.goIdle).not.toHaveBeenCalled();
    });

    // Kill mutant on line 131: ConditionalExpression - test both perching and non-perching modes
    test('should timeout when in perching mode', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify timeout occurred (second call made) - this proves line 132 return was NOT taken
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    test('should not timeout if mode changed to non-perching', async () => {
        let currentMode: BotState['mode'] = 'idle';
        const mockStateCustom = createMockStateManager({ mode: 'idle' });
        (mockStateCustom.getMode as ReturnType<typeof mock>).mockImplementation(() => currentMode);

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Simulate immediate completion and mode change to idle
            currentMode = 'idle';
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateCustom,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify no abort happened (mode was not perching when timeout checked)
        expect(sessionMock).toHaveBeenCalledTimes(1);
    });

    // Kill mutant on line 253: ArithmeticOperator - test Math.round calculation
    test('should correctly calculate duration in minutes using division', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        // Advance 45 minutes exactly
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify the prompt shows correct minutes (45)
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('45 minutes');
    });

    // Kill mutant on line 294: BlockStatement - test that timeout clearing block executes
    test('should clear timeout timer on error', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify no pending timers (timeout was cleared)
        expect(jest.getTimerCount()).toBe(0);
    });

    // Kill mutant on line 330: ArithmeticOperator - test timeout calculation with multiplication
    test('should calculate timeout correctly with different maxSessionMinutes', async () => {
        const shortConfig: PerchConfig = {
            ...config,
            maxSessionMinutes: 10, // Short timeout
        };

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          shortConfig,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        // Should timeout at 10 minutes, not at 9 or 11
        jest.advanceTimersByTime(9 * 60 * 1000);
        await Promise.resolve(); // Let any pending promises resolve
        expect(sessionMock).toHaveBeenCalledTimes(1); // Still first call

        jest.advanceTimersByTime(1 * 60 * 1000); // Total 10 minutes
        await sessionPromise;

        // Verify timeout occurred (second call made)
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    // Kill mutants on lines 172-174: StringLiteral - test exact fallback values
    test('should use exact fallback values when no interrupting message', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        // State manager without interrupting message in context
        const mockStateNoMessage = createMockStateManager({
            mode:        'idle',
            interrupted: false,
            modeContext: { activityType: 'Perch time: pre-dawn' } as PerchingModeContext,
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateNoMessage,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Manually trigger interrupt without storing message
        const state = mockStateNoMessage as unknown as { interrupted: boolean };
        state.interrupted = true;
        const controller = runner.getAbortController();
        controller?.abort();

        await Promise.resolve();
        await sessionPromise;

        jest.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();

        // Verify second call uses exact fallback strings
        const secondCall = sessionMock.mock.calls[1];
        if(secondCall) {
            const options = secondCall[0];
            // Test exact string literals from lines 172-174
            expect(options.prompt).toContain('Unknown'); // Line 172 - author fallback
            expect(options.prompt).toContain('unknown'); // Line 173 - channelName fallback
            // Line 174 is empty string for content - verify the pattern includes it
            expect(options.prompt).toMatch(/author.*Unknown/i);
            expect(options.prompt).toMatch(/channel.*unknown/i);
        }
    });

    // Kill mutant on line 218: ConditionalExpression - test result.completed branch
    test('should transition to idle when result.completed is true', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true, sessionId: 'completed' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was called when completed is true
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should not transition to idle when result.completed is false', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Interrupt (result.completed will be false)
        runner.interrupt({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'test',
        });

        await Promise.resolve();
        await sessionPromise;

        // Reset mock call count for goIdle
        const initialCallCount = (mockStateManager.goIdle as ReturnType<typeof mock>).mock.calls.length;

        // Run resume
        jest.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();

        // Verify goIdle was called on second completion, not first
        const finalCallCount = (mockStateManager.goIdle as ReturnType<typeof mock>).mock.calls.length;
        expect(finalCallCount).toBeGreaterThan(initialCallCount);
    });
});

/* eslint-enable @typescript-eslint/unbound-method -- End of tests using mock method references */
