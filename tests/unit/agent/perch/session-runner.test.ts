import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import _ from 'lodash';
import type { Logger } from '@hughescr/logger';
import {
    createPerchSessionRunner,
    type PerchSessionRunnerDeps,
    type RunAgentSessionOptions,
    type AgentSessionResult
} from '@/agent/perch/session-runner';
import type { BotStateManager, BotState, PerchingModeContext } from '@/integrations/discord/state';
import type { PerchConfig } from '@/agent/perch/types';
import { type ChannelId } from '@/integrations/discord/types';

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

// Mock state manager
function createMockStateManager(): BotStateManager {
    const state: BotState = {
        mode:          'idle',
        interrupted:   false,
        activityPhase: null,
        modeEnteredAt: new Date(),
        modeContext:   {},
    };

    return {
        getMode:       mock(() => state.mode),
        getState:      mock(() => state),
        isInterrupted: mock(() => state.interrupted),
        startPerching: mock((activity: string) => {
            state.mode = 'perching';
            state.modeContext = { activityType: activity } as PerchingModeContext;
        }),
        interrupt: mock(() => {
            state.interrupted = true;
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
/* eslint-enable @typescript-eslint/unbound-method -- end of test helpers using lodash/mock */

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
            return new Promise((resolve, reject) => {
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
                return new Promise((resolve, reject) => {
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
                return new Promise((resolve, reject) => {
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
                return new Promise((resolve, reject) => {
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
});
