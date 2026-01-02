/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access -- Test mocks */
import { describe, it, test, expect, mock, beforeEach } from 'bun:test';
import { ActivityType } from 'discord.js';
import _ from 'lodash';
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
    describe('generate', () => {
        // ============================================================
        // CONCURRENT TESTS - Independent tests that only verify return values
        // These tests don't check mock.calls and can run in parallel
        // ============================================================
        describe.concurrent('return value verification', () => {
            describe.concurrent('thinking phase output', () => {
                test('should use generatedStatus when present', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:            'thinking',
                        startedAt:       new Date(),
                        generatedStatus: 'Pondering the meaning of life...',
                    };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Pondering the meaning of life...');
                    expect(result.type).toBe(ActivityType.Custom);
                });

                test('should fall back to "Thinking..." when generatedStatus is undefined', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Thinking...');
                });

                test('should return exactly "Thinking..." with three dots', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Thinking...');
                    expect(result.name).toHaveLength(11); // "Thinking" (8) + "..." (3)
                    expect(_.endsWith(result.name, '...')).toBe(true);
                    expect(_.endsWith(result.name, '..')).toBe(true); // 3 dots ends with 2 dots
                    expect(_.endsWith(result.name, '....')).toBe(false); // Not 4 dots
                });

                test('should propagate activityType correctly', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.type).toBe(ActivityType.Custom);
                });
            });

            describe.concurrent('responding phase output', () => {
                test('should use generatedStatus when present', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:            'responding',
                        startedAt:       new Date(),
                        generatedStatus: 'Composing a thoughtful reply...',
                    };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Composing a thoughtful reply...');
                    expect(result.type).toBe(ActivityType.Custom);
                });

                test('should fall back to "Responding..." when generatedStatus is undefined', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Responding...');
                });

                test('should return exactly "Responding..." with three dots', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Responding...');
                    expect(result.name).toHaveLength(13); // "Responding" (10) + "..." (3)
                    expect(_.endsWith(result.name, '...')).toBe(true);
                });

                test('should propagate activityType correctly', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.type).toBe(ActivityType.Custom);
                });
            });

            describe.concurrent('idle phase output', () => {
                test('should return exactly "Idle" without dots', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Idle');
                    expect(result.name).toHaveLength(4);
                    expect(result.name.includes('.')).toBe(false);
                });

                test('should propagate activityType correctly', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    const result = generator.generate(phase);

                    expect(result.type).toBe(ActivityType.Custom);
                });
            });

            describe.concurrent('using_tool phase output', () => {
                describe.concurrent('generatedStatus override', () => {
                    test('should use generatedStatus when present', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:            'using_tool',
                            toolName:        'mcp__memory__view',
                            startedAt:       new Date(),
                            generatedStatus: 'Recalling conversation history...',
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Recalling conversation history...');
                        expect(result.type).toBe(ActivityType.Custom);
                    });

                    test('should fall back to ToolStatusMap when generatedStatus is undefined', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'mcp__memory__view',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Remembering...');
                    });
                });

                describe.concurrent('known tools from ToolStatusMap', () => {
                    test('should return "Remembering..." for mcp__memory__view', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'mcp__memory__view',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Remembering...');
                        expect(result.type).toBe(ActivityType.Custom);
                    });

                    test('should return "Recording self-knowledge..." for mcp__memory__storeSelf', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'mcp__memory__storeSelf',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Recording self-knowledge...');
                        expect(result.type).toBe(ActivityType.Custom);
                    });

                    test('should return "Recording user memory..." for mcp__memory__storeUserMemory', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'mcp__memory__storeUserMemory',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Recording user memory...');
                        expect(result.type).toBe(ActivityType.Custom);
                    });

                    test('should return "Logging event..." for mcp__memory__logEvent', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'mcp__memory__logEvent',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Logging event...');
                        expect(result.type).toBe(ActivityType.Custom);
                    });

                    test('should return "Searching memories..." for mcp__memory__search', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'mcp__memory__search',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Searching memories...');
                        expect(result.type).toBe(ActivityType.Custom);
                    });
                });

                describe.concurrent('unknown tools - fallback to Working...', () => {
                    test('should return "Working..." for unknown tool name', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'unknown_tool_xyz',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Working...');
                        expect(result.name).toHaveLength(10); // "Working" (7) + "..." (3)
                    });

                    test('should return "Working..." for empty string tool name', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  '',
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Working...');
                    });

                    test('should return "Working..." for tool name with typo', () => {
                        const generator = createActiveStatusGenerator({
                            logger:       createMockLogger(),
                            activityType: ActivityType.Custom,
                        });

                        const phase: PresencePhase = {
                            type:      'using_tool',
                            toolName:  'mcp__memory__views', // typo: 'views' not 'view'
                            startedAt: new Date(),
                        };
                        const result = generator.generate(phase);

                        expect(result.name).toBe('Working...');
                    });
                });
            });

            describe.concurrent('activity type propagation', () => {
                test('should propagate ActivityType.Playing correctly', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Playing,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.type).toBe(ActivityType.Playing);
                });

                test('should propagate ActivityType.Watching correctly', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Watching,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(result.type).toBe(ActivityType.Watching);
                });

                test('should propagate ActivityType.Listening correctly', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Listening,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    const result = generator.generate(phase);

                    expect(result.type).toBe(ActivityType.Listening);
                });

                test('should propagate ActivityType.Competing correctly', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Competing,
                    });

                    const phase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__view',
                        startedAt: new Date(),
                    };
                    const result = generator.generate(phase);

                    expect(result.type).toBe(ActivityType.Competing);
                });
            });

            describe.concurrent('unique outputs per phase', () => {
                test('should produce different outputs for thinking vs responding', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const thinkingPhase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    const respondingPhase: PresencePhase = { type: 'responding', startedAt: new Date() };

                    const thinkingResult = generator.generate(thinkingPhase);
                    const respondingResult = generator.generate(respondingPhase);

                    expect(thinkingResult.name).not.toBe(respondingResult.name);
                });

                test('should produce different outputs for thinking vs idle', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const thinkingPhase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    const idlePhase: PresencePhase = { type: 'idle', since: new Date() };

                    const thinkingResult = generator.generate(thinkingPhase);
                    const idleResult = generator.generate(idlePhase);

                    expect(thinkingResult.name).not.toBe(idleResult.name);
                });

                test('should produce different outputs for responding vs idle', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const respondingPhase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    const idlePhase: PresencePhase = { type: 'idle', since: new Date() };

                    const respondingResult = generator.generate(respondingPhase);
                    const idleResult = generator.generate(idlePhase);

                    expect(respondingResult.name).not.toBe(idleResult.name);
                });

                test('should produce different outputs for using_tool vs thinking', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const toolPhase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__view',
                        startedAt: new Date(),
                    };
                    const thinkingPhase: PresencePhase = { type: 'thinking', startedAt: new Date() };

                    const toolResult = generator.generate(toolPhase);
                    const thinkingResult = generator.generate(thinkingPhase);

                    expect(toolResult.name).not.toBe(thinkingResult.name);
                });

                test('should produce different outputs for using_tool vs responding', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const toolPhase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__view',
                        startedAt: new Date(),
                    };
                    const respondingPhase: PresencePhase = { type: 'responding', startedAt: new Date() };

                    const toolResult = generator.generate(toolPhase);
                    const respondingResult = generator.generate(respondingPhase);

                    expect(toolResult.name).not.toBe(respondingResult.name);
                });

                test('should produce different outputs for using_tool vs idle', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const toolPhase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__view',
                        startedAt: new Date(),
                    };
                    const idlePhase: PresencePhase = { type: 'idle', since: new Date() };

                    const toolResult = generator.generate(toolPhase);
                    const idleResult = generator.generate(idlePhase);

                    expect(toolResult.name).not.toBe(idleResult.name);
                });
            });

            describe.concurrent('default/unknown phase type output', () => {
                test('should return exactly "Processing..." for unknown phase type', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    // Force an unknown phase type to hit the default branch
                    const unknownPhase = { type: 'unknown_type', startedAt: new Date() } as unknown as PresencePhase;
                    const result = generator.generate(unknownPhase);

                    expect(result.name).toBe('Processing...');
                    expect(result.name).toHaveLength(13); // "Processing" (10) + "..." (3)
                    expect(_.endsWith(result.name, '...')).toBe(true);
                });

                test('should propagate activityType correctly for unknown phase', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const unknownPhase = { type: 'invalid_phase' } as unknown as PresencePhase;
                    const result = generator.generate(unknownPhase);

                    expect(result.type).toBe(ActivityType.Custom);
                });

                test('should return object with only name and type properties for unknown phase', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const unknownPhase = { type: 'not_a_real_type' } as unknown as PresencePhase;
                    const result = generator.generate(unknownPhase);

                    expect(_.keys(result).sort()).toEqual(['name', 'type'].sort());
                });

                test('should handle different activity types with unknown phase', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Playing,
                    });

                    const unknownPhase = { type: 'fake' } as unknown as PresencePhase;
                    const result = generator.generate(unknownPhase);

                    expect(result.name).toBe('Processing...');
                    expect(result.type).toBe(ActivityType.Playing);
                });
            });

            describe.concurrent('return value structure', () => {
                test('should return object with only name and type properties for thinking', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(_.keys(result).sort()).toEqual(['name', 'type'].sort());
                });

                test('should return object with only name and type properties for responding', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    const result = generator.generate(phase);

                    expect(_.keys(result).sort()).toEqual(['name', 'type'].sort());
                });

                test('should return object with only name and type properties for idle', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    const result = generator.generate(phase);

                    expect(_.keys(result).sort()).toEqual(['name', 'type'].sort());
                });

                test('should return object with only name and type properties for using_tool', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       createMockLogger(),
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'test_tool',
                        startedAt: new Date(),
                    };
                    const result = generator.generate(phase);

                    expect(_.keys(result).sort()).toEqual(['name', 'type'].sort());
                });
            });
        });

        // ============================================================
        // SEQUENTIAL TESTS - Tests that verify mock calls (need beforeEach)
        // These tests check .mock.calls and must run sequentially
        // ============================================================
        describe('logger behavior verification', () => {
            let mockLogger: any;

            beforeEach(() => {
                mockLogger = {
                    debug: mock(() => undefined),
                    warn:  mock(() => undefined),
                    error: mock(() => undefined),
                    info:  mock(() => undefined),
                    child: mock(() => mockLogger),
                };
            });

            describe('thinking phase', () => {
                it('should call logger.debug with phase object', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
                    expect(mockLogger.debug.mock.calls[0][0]).toEqual({ phase });
                    expect(mockLogger.debug.mock.calls[0][1]).toBe('Generating active status');
                });

                it('should NOT call logger.warn', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.warn).not.toHaveBeenCalled();
                });

                it('should NOT call logger.error', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.error).not.toHaveBeenCalled();
                });
            });

            describe('responding phase', () => {
                it('should call logger.debug with phase object', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
                    expect(mockLogger.debug.mock.calls[0][0]).toEqual({ phase });
                });

                it('should NOT call logger.warn', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.warn).not.toHaveBeenCalled();
                });

                it('should NOT call logger.error', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.error).not.toHaveBeenCalled();
                });
            });

            describe('idle phase', () => {
                it('should call logger.warn with specific message', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
                    expect(mockLogger.warn).toHaveBeenCalledWith('Active status generator called for idle phase');
                });

                it('should call logger.debug with phase object', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
                    expect(mockLogger.debug.mock.calls[0][0]).toEqual({ phase });
                });

                it('should NOT call logger.error', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.error).not.toHaveBeenCalled();
                });
            });

            describe('using_tool phase', () => {
                it('should call logger.debug with phase object', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__view',
                        startedAt: new Date(),
                    };
                    generator.generate(phase);

                    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
                    expect(mockLogger.debug.mock.calls[0][0]).toEqual({ phase });
                });

                it('should NOT call logger.warn', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__view',
                        startedAt: new Date(),
                    };
                    generator.generate(phase);

                    expect(mockLogger.warn).not.toHaveBeenCalled();
                });

                it('should NOT call logger.error', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__view',
                        startedAt: new Date(),
                    };
                    generator.generate(phase);

                    expect(mockLogger.error).not.toHaveBeenCalled();
                });
            });

            describe('logger.debug message format', () => {
                it('should include "Generating active status" message for thinking', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.debug.mock.calls[0][1]).toBe('Generating active status');
                });

                it('should include "Generating active status" message for responding', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.debug.mock.calls[0][1]).toBe('Generating active status');
                });

                it('should include "Generating active status" message for idle', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = { type: 'idle', since: new Date() };
                    generator.generate(phase);

                    expect(mockLogger.debug.mock.calls[0][1]).toBe('Generating active status');
                });

                it('should include "Generating active status" message for using_tool', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'test_tool',
                        startedAt: new Date(),
                    };
                    generator.generate(phase);

                    expect(mockLogger.debug.mock.calls[0][1]).toBe('Generating active status');
                });
            });

            describe('default/unknown phase type', () => {
                it('should call logger.error with phase object and specific message', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const unknownPhase = { type: 'bad_phase', someData: 123 } as unknown as PresencePhase;
                    generator.generate(unknownPhase);

                    expect(mockLogger.error).toHaveBeenCalledTimes(1);
                    expect(mockLogger.error.mock.calls[0][0]).toEqual({ phase: unknownPhase });
                    expect(mockLogger.error.mock.calls[0][1]).toBe('Unknown presence phase');
                });

                it('should call logger.debug before logger.error', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const unknownPhase = { type: 'mystery' } as unknown as PresencePhase;
                    generator.generate(unknownPhase);

                    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
                    expect(mockLogger.debug.mock.calls[0][1]).toBe('Generating active status');
                });

                it('should NOT call logger.warn for unknown phase', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const unknownPhase = { type: 'unexpected' } as unknown as PresencePhase;
                    generator.generate(unknownPhase);

                    expect(mockLogger.warn).not.toHaveBeenCalled();
                });
            });
        });
    });
});
