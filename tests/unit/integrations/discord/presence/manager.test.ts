/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Client } from 'discord.js';
import { ActivityType } from 'discord.js';
import { createPresenceManager } from '@/integrations/discord/presence/manager';
import type { PresencePhase, PresenceConfig } from '@/integrations/discord/presence/types';

describe('PresenceManager', () => {
  let mockClient: any;
  let mockActiveGenerator: any;
  let mockIdleGenerator: any;
  let mockLogger: any;
  let config: PresenceConfig;

  beforeEach(() => {
    mockClient = {
      user: {
        setActivity: mock(() => undefined),
      },
    };

    mockActiveGenerator = {
      generate: mock((phase: PresencePhase) => ({
        name: `Status for ${phase.type}`,
        type: ActivityType.Custom,
      })),
    };

    mockIdleGenerator = {
      generate: mock(async () => ({
        name: 'Dozing peacefully',
        type: ActivityType.Custom,
      })),
    };

    mockLogger = {
      debug: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
      info: mock(() => undefined),
    };

    config = {
      updateDebounceMs: 10,
      idleTimeoutMs: 100,
      idleRefreshIntervalMs: 200,
    };
  });

  describe('updatePhase', () => {
    it('should update presence for thinking phase', async () => {
      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
      await manager.updatePhase(phase);

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(mockActiveGenerator.generate).toHaveBeenCalledWith(phase);
      expect(mockClient.user.setActivity).toHaveBeenCalled();
    });

    it('should debounce rapid updates', async () => {
      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
      await manager.updatePhase({ type: 'responding', startedAt: new Date() });

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 20));

      // Should only update once (last update wins)
      expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
    });

    it('should start idle refresh when transitioning to idle', async () => {
      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      // updatePhase now awaits the first idle refresh
      await manager.updatePhase({ type: 'idle', since: new Date() });

      // Should have called idle generator
      expect(mockIdleGenerator.generate).toHaveBeenCalled();
    });

    it('should stop idle refresh when transitioning from idle', async () => {
      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      // Go idle first
      await manager.updatePhase({ type: 'idle', since: new Date() });
      const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

      // Transition to active
      await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

      // Wait and verify idle generator not called again
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCount);
    });

    it('should handle Discord API errors gracefully', async () => {
      const errorClient = {
        user: {
          setActivity: mock(() => {
            throw new Error('Discord API error');
          }),
        },
      } as unknown as Client;

      const manager = createPresenceManager({
        discordClient: errorClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      // Should not throw (errors are caught internally)
      await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should skip update if within debounce window', async () => {
      // Set very short debounce for testing
      const shortConfig = { ...config, updateDebounceMs: 50 };

      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config: shortConfig,
        logger: mockLogger,
      });

      await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
      await new Promise(resolve => setTimeout(resolve, 60));

      // First update should have gone through
      const firstCallCount = mockClient.user.setActivity.mock.calls.length;

      await manager.updatePhase({ type: 'responding', startedAt: new Date() });
      await new Promise(resolve => setTimeout(resolve, 30)); // Before debounce expires

      // Second update should be skipped (too soon)
      expect(mockClient.user.setActivity.mock.calls.length).toBe(firstCallCount);
    });
  });

  describe('start', () => {
    it('should start idle refresh if currently idle', async () => {
      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      // Set to idle first
      await manager.updatePhase({ type: 'idle', since: new Date() });

      manager.start();

      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should clear all timers', async () => {
      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      // Start idle refresh
      await manager.updatePhase({ type: 'idle', since: new Date() });

      manager.stop();

      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should clear pending debounced update', async () => {
      const manager = createPresenceManager({
        discordClient: mockClient,
        activeStatusGenerator: mockActiveGenerator,
        idleStatusGenerator: mockIdleGenerator,
        config,
        logger: mockLogger,
      });

      await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

      manager.stop();

      // Wait past debounce time
      await new Promise(resolve => setTimeout(resolve, 20));

      // Update should not have happened (cleared by stop)
      expect(mockClient.user.setActivity).not.toHaveBeenCalled();
    });
  });
});
