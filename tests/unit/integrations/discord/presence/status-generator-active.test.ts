/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access -- Test mocks */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ActivityType } from 'discord.js';
import { createActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import type { PresencePhase } from '@/integrations/discord/presence/types';

describe('ActiveStatusGenerator', () => {
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

    describe('generate', () => {
        describe('thinking phase', () => {
            it('should return exactly "Thinking..." with three dots', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(result.name).toBe('Thinking...');
                expect(result.name).toHaveLength(11); // "Thinking" (8) + "..." (3)
                expect(result.name.endsWith('...')).toBe(true);
                expect(result.name.endsWith('..')).toBe(true); // 3 dots ends with 2 dots
                expect(result.name.endsWith('....')).toBe(false); // Not 4 dots
            });

            it('should propagate activityType correctly', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(result.type).toBe(ActivityType.Custom);
            });

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
            it('should return exactly "Responding..." with three dots', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(result.name).toBe('Responding...');
                expect(result.name).toHaveLength(13); // "Responding" (10) + "..." (3)
                expect(result.name.endsWith('...')).toBe(true);
            });

            it('should propagate activityType correctly', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(result.type).toBe(ActivityType.Custom);
            });

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
            it('should return exactly "Idle" without dots', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'idle', since: new Date() };
                const result = generator.generate(phase);

                expect(result.name).toBe('Idle');
                expect(result.name).toHaveLength(4);
                expect(result.name.includes('.')).toBe(false);
            });

            it('should propagate activityType correctly', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'idle', since: new Date() };
                const result = generator.generate(phase);

                expect(result.type).toBe(ActivityType.Custom);
            });

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
            describe('known tools from ToolStatusMap', () => {
                it('should return "Remembering..." for mcp__memory__view', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
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

                it('should return "Recording memory..." for mcp__memory__store', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
                        activityType: ActivityType.Custom,
                    });

                    const phase: PresencePhase = {
                        type:      'using_tool',
                        toolName:  'mcp__memory__store',
                        startedAt: new Date(),
                    };
                    const result = generator.generate(phase);

                    expect(result.name).toBe('Recording memory...');
                    expect(result.type).toBe(ActivityType.Custom);
                });

                it('should return "Searching memories..." for mcp__memory__search', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
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

            describe('unknown tools - fallback to Working...', () => {
                it('should return "Working..." for unknown tool name', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
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

                it('should return "Working..." for empty string tool name', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
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

                it('should return "Working..." for tool name with typo', () => {
                    const generator = createActiveStatusGenerator({
                        logger:       mockLogger,
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

        describe('activity type propagation', () => {
            it('should propagate ActivityType.Playing correctly', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Playing,
                });

                const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(result.type).toBe(ActivityType.Playing);
            });

            it('should propagate ActivityType.Watching correctly', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Watching,
                });

                const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(result.type).toBe(ActivityType.Watching);
            });

            it('should propagate ActivityType.Listening correctly', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Listening,
                });

                const phase: PresencePhase = { type: 'idle', since: new Date() };
                const result = generator.generate(phase);

                expect(result.type).toBe(ActivityType.Listening);
            });

            it('should propagate ActivityType.Competing correctly', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
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

        describe('unique outputs per phase', () => {
            it('should produce different outputs for thinking vs responding', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const thinkingPhase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                const respondingPhase: PresencePhase = { type: 'responding', startedAt: new Date() };

                const thinkingResult = generator.generate(thinkingPhase);
                const respondingResult = generator.generate(respondingPhase);

                expect(thinkingResult.name).not.toBe(respondingResult.name);
            });

            it('should produce different outputs for thinking vs idle', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const thinkingPhase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                const idlePhase: PresencePhase = { type: 'idle', since: new Date() };

                const thinkingResult = generator.generate(thinkingPhase);
                const idleResult = generator.generate(idlePhase);

                expect(thinkingResult.name).not.toBe(idleResult.name);
            });

            it('should produce different outputs for responding vs idle', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const respondingPhase: PresencePhase = { type: 'responding', startedAt: new Date() };
                const idlePhase: PresencePhase = { type: 'idle', since: new Date() };

                const respondingResult = generator.generate(respondingPhase);
                const idleResult = generator.generate(idlePhase);

                expect(respondingResult.name).not.toBe(idleResult.name);
            });

            it('should produce different outputs for using_tool vs thinking', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
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

            it('should produce different outputs for using_tool vs responding', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
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

            it('should produce different outputs for using_tool vs idle', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
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

        describe('default/unknown phase type (exhaustive check)', () => {
            it('should return exactly "Processing..." for unknown phase type', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                // Force an unknown phase type to hit the default branch
                const unknownPhase = { type: 'unknown_type', startedAt: new Date() } as unknown as PresencePhase;
                const result = generator.generate(unknownPhase);

                expect(result.name).toBe('Processing...');
                expect(result.name).toHaveLength(13); // "Processing" (10) + "..." (3)
                expect(result.name.endsWith('...')).toBe(true);
            });

            it('should propagate activityType correctly for unknown phase', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const unknownPhase = { type: 'invalid_phase' } as unknown as PresencePhase;
                const result = generator.generate(unknownPhase);

                expect(result.type).toBe(ActivityType.Custom);
            });

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

            it('should return object with only name and type properties for unknown phase', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const unknownPhase = { type: 'not_a_real_type' } as unknown as PresencePhase;
                const result = generator.generate(unknownPhase);

                expect(Object.keys(result).sort()).toEqual(['name', 'type'].sort());
            });

            it('should handle different activity types with unknown phase', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Playing,
                });

                const unknownPhase = { type: 'fake' } as unknown as PresencePhase;
                const result = generator.generate(unknownPhase);

                expect(result.name).toBe('Processing...');
                expect(result.type).toBe(ActivityType.Playing);
            });
        });

        describe('return value structure', () => {
            it('should return object with only name and type properties for thinking', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(Object.keys(result).sort()).toEqual(['name', 'type'].sort());
            });

            it('should return object with only name and type properties for responding', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
                const result = generator.generate(phase);

                expect(Object.keys(result).sort()).toEqual(['name', 'type'].sort());
            });

            it('should return object with only name and type properties for idle', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = { type: 'idle', since: new Date() };
                const result = generator.generate(phase);

                expect(Object.keys(result).sort()).toEqual(['name', 'type'].sort());
            });

            it('should return object with only name and type properties for using_tool', () => {
                const generator = createActiveStatusGenerator({
                    logger:       mockLogger,
                    activityType: ActivityType.Custom,
                });

                const phase: PresencePhase = {
                    type:      'using_tool',
                    toolName:  'test_tool',
                    startedAt: new Date(),
                };
                const result = generator.generate(phase);

                expect(Object.keys(result).sort()).toEqual(['name', 'type'].sort());
            });
        });
    });
});
