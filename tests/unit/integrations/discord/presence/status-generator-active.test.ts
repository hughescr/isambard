/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ActivityType } from 'discord.js';
import { createActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import type { PresencePhase } from '@/integrations/discord/presence/types';

describe('ActiveStatusGenerator', () => {
  const mockLogger = {
    debug: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    child: mock(() => mockLogger),
  } as any;

  const spies: ReturnType<typeof spyOn>[] = [];

  afterEach(() => {
    for(const spy of spies) {
      spy.mockRestore();
    }
    spies.length = 0;
  });

  describe('generate', () => {
    it('should return "Thinking..." for thinking phase', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
      const result = generator.generate(phase);

      expect(result.name).toBe('Thinking...');
      expect(result.type).toBe(ActivityType.Custom);
    });

    it('should return "Responding..." for responding phase', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const phase: PresencePhase = { type: 'responding', startedAt: new Date() };
      const result = generator.generate(phase);

      expect(result.name).toBe('Responding...');
      expect(result.type).toBe(ActivityType.Custom);
    });

    it('should map known tool to status text', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const phase: PresencePhase = {
        type: 'using_tool',
        toolName: 'mcp__memory__view',
        startedAt: new Date(),
      };
      const result = generator.generate(phase);

      expect(result.name).toBe('Remembering...');
      expect(result.type).toBe(ActivityType.Custom);
    });

    it('should fall back to "Working..." for unknown tool', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const phase: PresencePhase = {
        type: 'using_tool',
        toolName: 'unknown_tool_name',
        startedAt: new Date(),
      };
      const result = generator.generate(phase);

      expect(result.name).toBe('Working...');
      expect(result.type).toBe(ActivityType.Custom);
    });

    it('should log warning when called for idle phase', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const phase: PresencePhase = { type: 'idle', since: new Date() };
      generator.generate(phase);

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should return "Idle" fallback for idle phase', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const phase: PresencePhase = { type: 'idle', since: new Date() };
      const result = generator.generate(phase);

      expect(result.name).toBe('Idle');
      expect(result.type).toBe(ActivityType.Custom);
    });

    it('should log debug message when generating status', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
      generator.generate(phase);

      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should handle all known tools from ToolStatusMap', () => {
      const generator = createActiveStatusGenerator({
        logger: mockLogger,
        activityType: ActivityType.Custom,
      });

      const testCases: Array<{ toolName: string; expectedStatus: string }> = [
        { toolName: 'mcp__memory__view', expectedStatus: 'Remembering...' },
        { toolName: 'mcp__memory__store', expectedStatus: 'Recording memory...' },
        { toolName: 'mcp__memory__search', expectedStatus: 'Searching memories...' },
      ];

      for(const { toolName, expectedStatus } of testCases) {
        const phase: PresencePhase = {
          type: 'using_tool',
          toolName,
          startedAt: new Date(),
        };
        const result = generator.generate(phase);

        expect(result.name).toBe(expectedStatus);
      }
    });
  });
});
