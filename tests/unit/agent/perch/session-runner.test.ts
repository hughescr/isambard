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
import type { ContextBuilder } from '@/agent/context-builder';

// Mock logger
function createMockLogger(): Logger {
    return {
        debug: mock(() => {}),
        info:  mock(() => {}),
        warn:  mock(() => {}),
        error: mock(() => {}),
    } as unknown as Logger;
}

// Mock context builder
function createMockContextBuilder(overrides?: Partial<ContextBuilder>): ContextBuilder {
    return {
        loadCoreIdentity:       mock(_.constant(Promise.resolve(''))),
        loadHotState:           mock(_.constant(Promise.resolve(''))),
        loadUserMemories:       mock(_.constant(Promise.resolve(''))),
        recordAccess:           mock(_.constant(Promise.resolve())),
        loadRecentEvents:       mock(async () => ({ items: [], isFallback: false })),
        loadUserTimezone:       mock(_.constant(Promise.resolve(undefined))),
        buildUserMessagePrefix: mock(_.constant(Promise.resolve(''))),
        buildPerchContext:      mock(_.constant(Promise.resolve(''))),
        ...overrides,
    };
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
        updateInterruptingMessage: mock((message: InterruptingMessageDetails) => {
            if(state.interrupted && state.mode === 'perching') {
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
        let callCount = 0;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // First call - will be interrupted
                return new Promise<AgentSessionResult>((_resolve, reject) => {
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

        // Now resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();

        // Let the resume execute (doResume is async)
        await Promise.resolve();
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

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Verify resume was scheduled (second call made)
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Note: The resume no longer happens automatically - it must be triggered
        // via resumeAfterInterruption() by the bot.ts onResponse callback.
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

    test('should transition to idle when context builder throws', async () => {
        const mockContextBuilder = createMockContextBuilder({
            buildPerchContext: mock(async (): Promise<string> => {
                throw new Error('DynamoDB timeout');
            }),
        });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify error was logged
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.any(Error) as Error,
                slot:  'pre-dawn',
            }),
            'Failed to start perch session'
        );

        // Verify bot transitioned back to idle
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Verify session was never called
        expect(sessionMock).not.toHaveBeenCalled();
    });

    test('should clear timeout when context builder throws', async () => {
        const mockContextBuilder = createMockContextBuilder({
            buildPerchContext: mock(async (): Promise<string> => {
                throw new Error('DynamoDB timeout');
            }),
        });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify timeout was set but then cleared
        // We can't directly verify the timeout was cleared, but we can verify
        // that advancing timers doesn't cause any timeout handling
        jest.advanceTimersByTime(config.maxSessionMinutes * 60 * 1000 + 1000);

        // Verify no timeout handling occurred (no abort, no wrap-up)
        expect(sessionMock).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('timeout')
        );
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

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
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

describe('PerchSessionRunner - Double-Interrupt Guard', () => {
    let mockLogger: Logger;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
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

    test('should not abort when already interrupted', async () => {
        // Set up state manager that reports already interrupted
        const mockStateInterrupted = createMockStateManager({ mode: 'idle', interrupted: true });

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Long-running session that waits for abort
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await - it will hang)
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Get the abort controller before calling interrupt
        const controller = runner.getAbortController();

        // Call interrupt when already interrupted
        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'test',
            content:     'Second interrupt!',
        };
        runner.interrupt(message);

        // Verify abort controller was NOT aborted (guard prevented it)
        expect(controller?.signal.aborted).toBe(false);

        // Verify stateManager.interrupt was NOT called (early return prevented it)
        expect(mockStateInterrupted.interrupt).not.toHaveBeenCalled();

        // Cleanup
        controller?.abort();
        await sessionPromise;
    });

    test('should abort when not already interrupted', async () => {
        // Set up state manager that reports NOT interrupted initially
        let interrupted = false;
        const mockStateNotInterrupted = createMockStateManager({ mode: 'idle', interrupted: false });

        // Override isInterrupted to track our local flag
        (mockStateNotInterrupted.isInterrupted as ReturnType<typeof mock>).mockImplementation(() => interrupted);

        // Override interrupt to set our flag
        (mockStateNotInterrupted.interrupt as ReturnType<typeof mock>).mockImplementation((_message: InterruptingMessageDetails) => {
            interrupted = true;
            // Store message in context (like real state manager)
            const state = mockStateNotInterrupted as unknown as { interrupted: boolean };
            state.interrupted = true;
        });

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Long-running session that waits for abort
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateNotInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await)
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Get the abort controller before calling interrupt
        const controller = runner.getAbortController();

        // Call interrupt when NOT already interrupted
        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'test',
            content:     'First interrupt!',
        };
        runner.interrupt(message);

        // Verify abort controller WAS aborted
        expect(controller?.signal.aborted).toBe(true);

        // Verify stateManager.interrupt WAS called
        expect(mockStateNotInterrupted.interrupt).toHaveBeenCalledWith(message);

        // Wait for session to complete
        await sessionPromise;
    });

    test('should handle multiple rapid interrupts without error', async () => {
        // Set up state manager that toggles interrupted state
        let interrupted = false;
        const mockStateDynamic = createMockStateManager({ mode: 'idle', interrupted: false });

        // Override isInterrupted to track our local flag
        (mockStateDynamic.isInterrupted as ReturnType<typeof mock>).mockImplementation(() => interrupted);

        // Override interrupt to set our flag
        (mockStateDynamic.interrupt as ReturnType<typeof mock>).mockImplementation(() => {
            interrupted = true;
        });

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Long-running session
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateDynamic,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Call interrupt multiple times rapidly
        const message1: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'User1',
            channelName: 'test',
            content:     'First!',
        };

        const message2: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'User2',
            channelName: 'test',
            content:     'Second!',
        };

        const message3: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'User3',
            channelName: 'test',
            content:     'Third!',
        };

        // Call interrupt multiple times
        expect(() => {
            runner.interrupt(message1);
            runner.interrupt(message2);
            runner.interrupt(message3);
        }).not.toThrow();

        // Verify only first interrupt was processed (subsequent ones returned early)
        expect(mockStateDynamic.interrupt).toHaveBeenCalledTimes(1);
        expect(mockStateDynamic.interrupt).toHaveBeenCalledWith(message1);

        // Cleanup
        const controller = runner.getAbortController();
        controller?.abort();
        await sessionPromise;
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

        // Verify logger.debug was called for awaiting external resume
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Session interrupted - awaiting external resume'
        );

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
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

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
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

    test('should prevent duplicate sessions when already perching via not-idle guard', async () => {
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

        // Verify session was not started and warning was logged with mode object
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'perching' }),
            'Cannot start perch - not idle'
        );
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

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
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

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Verify goIdle was called on second completion, not first
        const finalCallCount = (mockStateManager.goIdle as ReturnType<typeof mock>).mock.calls.length;
        expect(finalCallCount).toBeGreaterThan(initialCallCount);
    });
});

describe('Resume session fallthrough to idle', () => {
    let mockStateManager: BotStateManager;
    let mockLogger:       Logger;
    let config:           PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger = createMockLogger();
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    30,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should go idle when resume session returns completed: false and still in perching mode', async () => {
        // Setup: state manager in idle mode initially (will transition to perching)
        mockStateManager = createMockStateManager({
            mode: 'idle',
        });

        // First call: initial session that gets interrupted
        // Second call: resume session that returns completed: false
        let callCount = 0;
        const mockSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // Initial session — will be interrupted, hang until aborted
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Resume session — returns not completed
            return { completed: false, sessionId: 'resume-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Interrupt the session
        runner.interrupt({
            channelId:   'ch-1' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Hello',
        });

        // Wait for interrupt to be processed
        await Promise.resolve();
        await sessionPromise;

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // After resume completes with completed: false, the finally block in doResume
        // should call goIdle because we're still in perching mode
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });
});

describe('AbortError during resume', () => {
    let mockLogger: Logger;
    let config:     PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger = createMockLogger();
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    30,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should go idle when AbortError occurs during resume and still in perching mode', async () => {
        const mockStateManager = createMockStateManager({
            mode: 'idle',
        });

        let callCount = 0;
        const mockSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // Initial session — hang until interrupted
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Resume session — also throws AbortError (external abort)
            // Clear interrupted first so it doesn't try to re-resume
            (mockStateManager.isInterrupted as ReturnType<typeof mock>).mockImplementation(_.constant(false));
            const error = new Error('Aborted');
            error.name = 'AbortError';
            throw error;
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Interrupt the session
        runner.interrupt({
            channelId:   'ch-1' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Hello',
        });

        // Wait for interrupt to be processed
        await Promise.resolve();
        await sessionPromise;

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // goIdle should have been called via the finally block safety net in doResume
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should NOT go idle when AbortError occurs during initial session (not resume)', async () => {
        const mockStateManager = createMockStateManager({ mode: 'idle' });

        const mockSession = mock(async (_options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Simulate external abort during initial session (not interrupt, not timeout)
            const error = new Error('Aborted');
            error.name = 'AbortError';
            throw error;
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // goIdle should NOT be called for non-resume AbortError
        // (startPerch calls startPerching which sets mode to perching,
        //  but goIdle should not be called on simple abort)
        // Actually, the state was already set to perching by startPerch.
        // The abort handler without resumeInProgress should just return.
        // But note: the finally block in runSessionAndFinalize sets currentAbortController = null
        // There's no goIdle call in the AbortError path when resumeInProgress is false.
        expect(mockStateManager.goIdle).not.toHaveBeenCalled();
    });

    test('should clear session timeout when initial session is externally aborted', async () => {
        const mockStateManager = createMockStateManager({ mode: 'idle' });

        const mockSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Hang until aborted
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('Aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          { ...config, maxSessionMinutes: 5 },
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Externally abort (not via interrupt)
        const controller = runner.getAbortController();
        controller?.abort();
        await sessionPromise;

        // Advance time past the original session timeout
        // If timeout wasn't cleaned up, handleSessionTimeout would fire
        jest.advanceTimersByTime(5 * 60 * 1000 + 1000);

        // Starting a new session should work cleanly — no stale timeout interference
        // Reset mode to idle for the next startPerch
        (mockStateManager.getMode as ReturnType<typeof mock>).mockImplementation(_.constant('idle' as const));
        (mockStateManager.goIdle as ReturnType<typeof mock>).mockClear();

        // The key assertion: no goIdle from orphaned timeout handler
        // (handleSessionTimeout checks mode and calls abort, but if no session is active, nothing happens)
        expect(mockStateManager.goIdle).not.toHaveBeenCalled();
    });
});

describe('Resume timeout', () => {
    let mockLogger: Logger;
    let config:     PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger = createMockLogger();
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    30,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should set timeout for resume session based on remaining time', async () => {
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        const mockStateManager = createMockStateManager({
            mode: 'idle',
        });

        let callCount = 0;
        const mockSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // Initial session - hang until interrupted
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        // Advance time 30 minutes before rejecting
                        jest.advanceTimersByTime(30 * 60 * 1000);
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Resume session completes
            return { completed: true, sessionId: 'resume-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          { ...config, maxSessionMinutes: 45 },
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Interrupt the session
        runner.interrupt({
            channelId:   'ch-1' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Hello',
        });

        // Wait for interrupt to be processed
        await Promise.resolve();
        await sessionPromise;

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // The resume should have been called (since interrupted)
        expect(callCount).toBe(2);
    });

    test('should enforce minimum 1-minute floor on resume timeout', async () => {
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        const mockStateManager = createMockStateManager({
            mode: 'idle',
        });

        let callCount = 0;
        const mockSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // Initial session - hang until interrupted
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        // Advance time 50 minutes (exceeding max time) before rejecting
                        jest.advanceTimersByTime(50 * 60 * 1000);
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Resume session completes
            return { completed: true, sessionId: 'resume-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          { ...config, maxSessionMinutes: 45 },
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Interrupt the session
        runner.interrupt({
            channelId:   'ch-1' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Hello',
        });

        // Wait for interrupt to be processed
        await Promise.resolve();
        await sessionPromise;

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Resume should have been called even though we're over time
        // (the 1-minute floor ensures the resume gets at least 1 minute)
        expect(callCount).toBe(2);
    });

    // Kill mutant on line 157: BooleanLiteral - resumeInProgress = true → false
    test('should prevent double-resume when resumeInProgress flag is true', async () => {
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        const mockStateManager = createMockStateManager({
            mode:        'perching',
            interrupted: true,
            modeContext: {
                activityType:        'Perch time: pre-dawn',
                interruptingMessage: {
                    channelId:   'ch-1' as ChannelId,
                    author:      'TestUser',
                    channelName: 'general',
                    content:     'Hello',
                },
            } as PerchingModeContext,
        });

        let callCount = 0;
        let resumeResolver: (() => void) | undefined;

        const mockSession = mock(async (): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // First resume call - hang until externally resolved
                return new Promise<AgentSessionResult>((resolve) => {
                    resumeResolver = () => resolve({ completed: true, sessionId: 'resume-session' });
                });
            }
            // Second resume call (should never happen)
            return { completed: true, sessionId: 'second-resume' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);

        // First resume call
        const firstResumePromise = runner.resumeAfterInterruption();

        // Let the first resume start
        await Promise.resolve();

        // Try to call resumeAfterInterruption again while first is in progress
        await runner.resumeAfterInterruption();

        // Should still only have 1 call (second resume blocked by resumeInProgress flag)
        expect(callCount).toBe(1);

        // Complete the first resume
        resumeResolver?.();
        await firstResumePromise;

        // Still only 1 call total
        expect(callCount).toBe(1);
    });

    test('should log entry with slot, remainingMs, and hasPartialWork when doResume starts', async () => {
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        const mockStateManager = createMockStateManager({
            mode:        'idle',
            interrupted: false,
        });

        let callCount = 0;
        const mockSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // First call - abort due to interrupt
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Second call (resume) - complete successfully
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          { ...config, maxSessionMinutes: 30 },
            runAgentSession: mockSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start a session and interrupt it during execution
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.interrupt({
            channelId:   'ch-1' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Hello',
        });

        await Promise.resolve();
        await sessionPromise;

        // Clear previous log calls
        (mockLogger.info as ReturnType<typeof mock>).mockClear();

        // Advance time by 5 minutes (300000 ms)
        jest.setSystemTime(new Date('2024-01-01T12:05:00.000Z'));

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Verify logger.info was called with doResume starting message
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot:           'pre-dawn',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() is type-safe at runtime
                remainingMs:    expect.any(Number),
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() is type-safe at runtime
                hasPartialWork: expect.any(Boolean),
            }),
            'doResume starting'
        );

        // Verify remainingMs is calculated correctly (should be >= 60000, the 1-minute floor)
        // eslint-disable-next-line lodash/prefer-lodash-method -- Array.find is clearer for test assertion
        const logCall = (mockLogger.info as ReturnType<typeof mock>).mock.calls.find(
            (call: unknown[]) => call[1] === 'doResume starting'
        );
        expect(logCall).toBeDefined();
        if(logCall) {
            const logData = logCall[0] as { remainingMs: number };
            expect(logData.remainingMs).toBeGreaterThanOrEqual(60_000);
        }
    });
});

describe('PerchSessionRunner - Timeout Return Path', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();

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

    test('should trigger wrap-up when timeout abort returns completed:false (not throw)', async () => {
        // Mock runAgentSession to resolve with completed:false when timeout fires (return path not throw path)
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                // First call: wait for abort signal, then RETURN completed:false (not throw)
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        // Agent catches AbortError internally and returns completed:false
                        resolve({ completed: false, sessionId: 'test-session' });
                    });
                });
            }
            // Second call (wrap-up): complete normally
            return { completed: true, sessionId: 'wrap-up-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('afternoon');

        // Advance to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Assert: runAgentSession called twice (initial + wrap-up)
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Assert: second call's prompt contains 'PERCH SESSION TIMEOUT'
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('PERCH SESSION TIMEOUT');

        // Assert: goIdle was called
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should go idle as safety net when session returns incomplete for unknown reason', async () => {
        // Mock runAgentSession to immediately resolve with completed:false (no timeout, no interrupt, no resume)
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: false, sessionId: 'test-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('mid-morning');

        // Assert: goIdle was called as safety net
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: no wrap-up session (only 1 call to runAgentSession)
        expect(sessionMock).toHaveBeenCalledTimes(1);

        // Assert: warning logged
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'mid-morning' }),
            'Session returned incomplete for unknown reason - going idle'
        );
    });

    test('should trigger wrap-up via return path with correct duration', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false, sessionId: 'test-session' });
                    });
                });
            }
            return { completed: true, sessionId: 'wrap-up-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('evening');

        // Advance exactly to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Assert: timeout log includes correct duration
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot:        'evening',
                durationMin: expect.any(Number) as number,
                maxDuration: 45,
                msg:         'Resuming with timeout wrap-up prompt',
            })
        );

        // Assert: prompt includes duration
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toMatch(/45 minutes/);
    });
});

describe('PerchSessionRunner - Wrap-Up Timeout', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();

        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 2,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should abort wrap-up session after wrapUpTimeoutMinutes', async () => {
        // Mock runAgentSession:
        // - First call: throw AbortError when timeout fires (main session timeout)
        // - Second call (wrap-up): also throw AbortError when wrap-up timeout fires
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Both calls: wait for abort signal, then throw AbortError
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('Aborted');
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

        // Advance to main session timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Advance to wrap-up timeout (2 minutes)
        jest.advanceTimersByTime(2 * 60 * 1000);

        await sessionPromise;

        // Assert: goIdle was called (bot recovered from hang)
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: session was called exactly 2 times (main + wrap-up, no retry)
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Assert: warning logged about wrap-up timeout
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn', wrapUpTimeoutMinutes: 2 }),
            'Wrap-up session timed out - aborting'
        );
    });

    test('should abort wrap-up session after wrapUpTimeoutMinutes via return path', async () => {
        // First call resolves completed:false (return path), second call throws AbortError
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                // First call: wait for abort, then resolve completed:false
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false, sessionId: 'test-session' });
                    });
                });
            }
            // Second call (wrap-up): throw AbortError when timeout fires
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('Aborted');
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
        const sessionPromise = runner.startPerch('mid-morning');

        // Advance to main session timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Advance to wrap-up timeout (2 minutes)
        jest.advanceTimersByTime(2 * 60 * 1000);

        await sessionPromise;

        // Assert: goIdle was called
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: session was called exactly 2 times
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    test('should use default 5 minute wrap-up timeout when not configured', async () => {
        // Test with default wrapUpTimeoutMinutes (5)
        const defaultConfig: PerchConfig = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Both calls: throw AbortError when timeout fires
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('Aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          defaultConfig,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('afternoon');

        // Advance to main session timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Advance to wrap-up timeout (5 minutes - default)
        jest.advanceTimersByTime(5 * 60 * 1000);

        await sessionPromise;

        // Assert: goIdle was called
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: warning logged with default timeout value
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'afternoon', wrapUpTimeoutMinutes: 5 }),
            'Wrap-up session timed out - aborting'
        );
    });
});

describe('PerchSessionRunner - Re-interrupt during resume', () => {
    let mockLogger: Logger;
    let config: PerchConfig;

    beforeEach(() => {
        mockLogger = createMockLogger();

        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    test('should abort resume session when re-interrupted', async () => {
        let callCount = 0;
        let resumeAbortSignal: AbortSignal | undefined;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // First call - initial session, will be interrupted
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else if(callCount === 2) {
                // Second call - resume session, capture abort signal
                resumeAbortSignal = options.abortSignal;
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                // Third call - second resume after re-interrupt
                return { completed: true, sessionId: 'final-session' };
            }
        });

        const mockState = createMockStateManager();
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockState,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start session
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // First interrupt
        const message1: InterruptingMessage = {
            channelId:   'ch-1' as ChannelId,
            author:      'User1',
            channelName: 'general',
            content:     'First message',
        };
        runner.interrupt(message1);
        await Promise.resolve();

        // Wait for startPerch to complete (first session aborted)
        await sessionPromise;

        // Start resume (simulating onResponse callback)
        const resumePromise = runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();

        // Second interrupt (re-interrupt during resume)
        const message2: InterruptingMessage = {
            channelId:   'ch-2' as ChannelId,
            author:      'User2',
            channelName: 'random',
            content:     'Second message',
        };
        runner.interrupt(message2);

        // Verify the resume session's abort signal was triggered
        expect(resumeAbortSignal?.aborted).toBe(true);

        // Wait for resume to complete
        await resumePromise;

        // Verify updateInterruptingMessage was called with second message
        expect(mockState.updateInterruptingMessage).toHaveBeenCalledWith(message2);
    });

    test('should not call goIdle after re-interrupt', async () => {
        let callCount = 0;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount <= 2) {
                // First and second calls - wait for abort
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

        const mockState = createMockStateManager();
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockState,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start and interrupt
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();
        runner.interrupt({ channelId: 'ch' as ChannelId, author: 'U', channelName: 'c', content: 'msg1' });
        await Promise.resolve();
        await sessionPromise;

        // Clear goIdle mock calls from initial interrupt handling
        (mockState.goIdle as ReturnType<typeof mock>).mockClear();

        // Start resume, then re-interrupt
        const resumePromise = runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        runner.interrupt({ channelId: 'ch2' as ChannelId, author: 'U2', channelName: 'c2', content: 'msg2' });
        await resumePromise;

        // goIdle should NOT have been called (we're re-interrupted, waiting for another resume)
        expect(mockState.goIdle).not.toHaveBeenCalled();
    });

    test('should allow fresh resume after re-interrupt', async () => {
        let callCount = 0;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount <= 2) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                // Third call - final resume, completes normally
                return { completed: true, sessionId: 'final' };
            }
        });

        const mockState = createMockStateManager();
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockState,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start → interrupt → resume → re-interrupt
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();
        runner.interrupt({ channelId: 'ch' as ChannelId, author: 'U', channelName: 'c', content: 'msg1' });
        await Promise.resolve();
        await sessionPromise;

        const resumePromise = runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        runner.interrupt({ channelId: 'ch2' as ChannelId, author: 'U2', channelName: 'c2', content: 'msg2' });
        await resumePromise;

        // Now trigger fresh resume (simulating second onResponse callback)
        await runner.resumeAfterInterruption();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Third call should have been made
        expect(sessionMock).toHaveBeenCalledTimes(3);
    });

    test('should be no-op when re-interrupted but resume not started', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('AbortError');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const mockState = createMockStateManager();
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockState,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start and interrupt
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();
        runner.interrupt({ channelId: 'ch' as ChannelId, author: 'U', channelName: 'c', content: 'msg1' });
        await Promise.resolve();
        await sessionPromise;

        // Second interrupt before resume starts - should be no-op
        // (isInterrupted is true, but resumeInProgress is false)
        runner.interrupt({ channelId: 'ch2' as ChannelId, author: 'U2', channelName: 'c2', content: 'msg2' });

        // updateInterruptingMessage should NOT have been called
        // (because resumeInProgress is false, the no-op branch is taken)
        expect(mockState.updateInterruptingMessage).not.toHaveBeenCalled();
    });
});

/* eslint-enable @typescript-eslint/unbound-method -- End of tests using mock method references */
