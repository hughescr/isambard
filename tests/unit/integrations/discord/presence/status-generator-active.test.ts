/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Test mocks */
import { describe, test, expect, mock } from 'bun:test';
import { ActivityType } from 'discord.js';
import { createActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import type { PresencePhase } from '@/integrations/discord/presence/types';

// Helper to create a minimal mock logger for independent tests
const createMockLogger = (): any => {
    const logger: any = {
        debug: mock(() => undefined),
        warn:  mock(() => undefined),
        error: mock(() => undefined),
        info:  mock(() => undefined),
        child: mock(() => logger),
    };
    return logger;
};

describe('ActiveStatusGenerator', () => {
    describe.concurrent('generate', () => {
        // Core phase behavior: fallback vs generatedStatus override
        test.each([
            { phase: { type: 'thinking', startedAt: new Date() }, expected: 'Thinking...', desc: 'thinking fallback' },
            { phase: { type: 'responding', startedAt: new Date() }, expected: 'Responding...', desc: 'responding fallback' },
            { phase: { type: 'thinking', startedAt: new Date(), generatedStatus: 'Deep thought...' }, expected: 'Deep thought...', desc: 'thinking override' },
            { phase: { type: 'responding', startedAt: new Date(), generatedStatus: 'Composing...' }, expected: 'Composing...', desc: 'responding override' },
            { phase: { type: 'idle', since: new Date() }, expected: 'Idle', desc: 'idle' },
        ] as const)('$desc -> "$expected"', ({ phase, expected }) => {
            const generator = createActiveStatusGenerator({
                logger:       createMockLogger(),
                activityType: ActivityType.Custom,
            });
            expect(generator.generate(phase as PresencePhase).name).toBe(expected);
        });

        // Tool usage: generatedStatus, known tools, unknown tools
        test.each([
            { toolName: 'mcp__memory__view', generatedStatus: 'Custom status', expected: 'Custom status', desc: 'generatedStatus override' },
            { toolName: 'mcp__memory__view', generatedStatus: undefined, expected: 'Remembering...', desc: 'memory view' },
            { toolName: 'mcp__memory__storeSelf', generatedStatus: undefined, expected: 'Recording self-knowledge...', desc: 'storeSelf' },
            { toolName: 'mcp__memory__storeUserMemory', generatedStatus: undefined, expected: 'Recording user memory...', desc: 'storeUserMemory' },
            { toolName: 'mcp__memory__logEvent', generatedStatus: undefined, expected: 'Logging event...', desc: 'logEvent' },
            { toolName: 'mcp__memory__search', generatedStatus: undefined, expected: 'Searching memories...', desc: 'search' },
            { toolName: 'unknown_tool', generatedStatus: undefined, expected: 'Working...', desc: 'unknown tool fallback' },
        ])('using_tool: $desc -> "$expected"', ({ toolName, generatedStatus, expected }) => {
            const generator = createActiveStatusGenerator({
                logger:       createMockLogger(),
                activityType: ActivityType.Custom,
            });
            const phase: PresencePhase = {
                type:      'using_tool',
                toolName,
                startedAt: new Date(),
                generatedStatus,
            };
            const result = generator.generate(phase);
            expect(result.name).toBe(expected);
            // Verify it's not an empty string (which would be a mutation)
            expect(result.name).not.toBe('');
            expect(result.name.length).toBeGreaterThan(0);
        });

        // Default case for unknown phase types
        test('unknown phase type -> "Processing..."', () => {
            const generator = createActiveStatusGenerator({
                logger:       createMockLogger(),
                activityType: ActivityType.Custom,
            });
            const unknownPhase = { type: 'unknown_type', startedAt: new Date() } as unknown as PresencePhase;
            expect(generator.generate(unknownPhase).name).toBe('Processing...');
        });
    });

    describe('presenceDisplayMode prefixes', () => {
        test('undefined presenceDisplayMode -> no prefix', () => {
            const generator = createActiveStatusGenerator({
                logger:       createMockLogger(),
                activityType: ActivityType.Custom,
            });
            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            const result = generator.generate(phase, undefined);
            expect(result.name).toBe('Thinking...');
            expect(result.name).not.toContain('📥');
            expect(result.name).not.toContain('💬');
        });

        test('none presenceDisplayMode -> no prefix', () => {
            const generator = createActiveStatusGenerator({
                logger:       createMockLogger(),
                activityType: ActivityType.Custom,
            });
            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            const result = generator.generate(phase, 'none');
            expect(result.name).toBe('Thinking...');
            expect(result.name).not.toContain('📥');
            expect(result.name).not.toContain('💬');
        });

        test('catching_up mode -> 📥 prefix', () => {
            const generator = createActiveStatusGenerator({
                logger:       createMockLogger(),
                activityType: ActivityType.Custom,
            });
            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            const result = generator.generate(phase, 'catching_up');
            expect(result.name).toBe('📥 Thinking...');
            expect(result.name).toStartWith('📥 ');
        });

        test('processing_message mode -> 💬 prefix', () => {
            const generator = createActiveStatusGenerator({
                logger:       createMockLogger(),
                activityType: ActivityType.Custom,
            });
            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            const result = generator.generate(phase, 'processing_message');
            expect(result.name).toBe('💬 Thinking...');
            expect(result.name).toStartWith('💬 ');
        });
    });

    describe('logging behavior', () => {
        test('should log debug with phase object and message string', () => {
            const mockLogger = createMockLogger();
            const generator = createActiveStatusGenerator({
                logger:       mockLogger,
                activityType: ActivityType.Custom,
            });

            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            generator.generate(phase);

            // Kill ObjectLiteral mutant on line 71 col 26 - verify first arg is object with phase property
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock logger methods for test assertions
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ phase }),
                expect.any(String)
            );

            // Kill StringLiteral mutant on line 71 col 37 - verify second arg is the specific string
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock.calls array from test mock
            const debugCalls = mockLogger.debug.mock.calls;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing length property of mock calls array
            expect(debugCalls.length).toBeGreaterThan(0);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing array element of mock calls
            const lastCall = debugCalls[debugCalls.length - 1];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock call arguments array
            expect(lastCall[1]).toBe('Generating active status');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock call arguments array
            expect(lastCall[1]).not.toBe('');
        });

        test('should log warn with specific string when called with idle phase', () => {
            const mockLogger = createMockLogger();
            const generator = createActiveStatusGenerator({
                logger:       mockLogger,
                activityType: ActivityType.Custom,
            });

            const idlePhase: PresencePhase = { type: 'idle', since: new Date() };
            generator.generate(idlePhase);

            // Kill StringLiteral mutant on line 76 col 33 - verify arg is the specific string
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock.calls array from test mock
            const warnCalls = mockLogger.warn.mock.calls;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing length property of mock calls array
            expect(warnCalls.length).toBeGreaterThan(0);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing array element of mock calls
            const lastCall = warnCalls[warnCalls.length - 1];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock call arguments array
            expect(lastCall[0]).toBe('Active status generator called for idle phase');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock call arguments array
            expect(lastCall[0]).not.toBe('');
        });

        test('should log error with phase object and message string for unknown phase', () => {
            const mockLogger = createMockLogger();
            const generator = createActiveStatusGenerator({
                logger:       mockLogger,
                activityType: ActivityType.Custom,
            });

            const unknownPhase = { type: 'unknown_type', startedAt: new Date() } as unknown as PresencePhase;
            generator.generate(unknownPhase);

            // Kill ObjectLiteral mutant on line 93 col 34 - verify first arg is object with phase property
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock logger methods for test assertions
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ phase: expect.anything() }),
                expect.any(String)
            );

            // Kill StringLiteral mutant on line 93 col 58 - verify second arg is the specific string
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock.calls array from test mock
            const errorCalls = mockLogger.error.mock.calls;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing length property of mock calls array
            expect(errorCalls.length).toBeGreaterThan(0);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing array element of mock calls
            const lastCall = errorCalls[errorCalls.length - 1];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock call arguments array
            expect(lastCall[1]).toBe('Unknown presence phase');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Accessing mock call arguments array
            expect(lastCall[1]).not.toBe('');
        });
    });
});
