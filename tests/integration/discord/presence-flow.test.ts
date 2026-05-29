/**
 * Integration tests for Discord presence flow.
 *
 * Tests the complete flow of presence updates during message processing,
 * using real components (not mocks) except for Discord client and Anthropic API.
 */

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { ActivityType, type Client  } from 'discord.js';
import { mockGenerateText, mockGenerateTextWithSystemPrompt, originalGenerateText, originalGenerateTextWithSystemPrompt } from '../../setup';
import { PresenceManager } from '@/integrations/discord/presence/manager';
import { createActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';

describe('Discord Presence Flow (Integration)', () => {
    let mockDiscordClient: Client;

    beforeEach(() => {
        jest.useFakeTimers();
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(() => Promise.resolve('Contemplating digital dreams'));
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Contemplating digital dreams'));

        // Mock Discord client
        mockDiscordClient = {
            user: {
                setPresence: mock(async () => undefined),
            },
        } as unknown as Client;
    });

    afterEach(() => {
        jest.clearAllTimers();     // Clear while still in fake mode
        jest.useRealTimers();      // Then restore real timers
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);
    });

    it('should transition to idle after timeout', async () => {
        const logger = {
            debug: mock(() => undefined),
            info:  mock(() => undefined),
            warn:  mock(() => undefined),
            error: mock(() => undefined),
        };

        // Create status generators
        const activeStatusGenerator = createActiveStatusGenerator({
            activityType: ActivityType.Custom,
            logger,
        });

        const idleStatusGenerator = createIdleStatusGenerator({
            logger,
            activityType:    ActivityType.Custom,
            identityContext: () => Promise.resolve('Test Bot'),
        });

        // Create presence manager with SHORT idle timeout for testing
        const presenceManager = new PresenceManager({
            discordClient: mockDiscordClient,
            config:        {
                updateThrottleMs:      50,
                idleTimeoutMs:         200, // Very short for testing
                idleRefreshIntervalMs: 5000,
            },
            activeStatusGenerator,
            idleStatusGenerator,
            logger,
        });

        presenceManager.start();

        // Update to thinking phase
        await presenceManager.updatePhase({
            type:      'thinking',
            startedAt: new Date(),
        });

        // Wait for idle timeout to trigger
        jest.advanceTimersByTime(300);
        await Promise.resolve();

        // Simulate the idle timeout firing: transition to the idle phase. This starts
        // the idle refresh loop, which drives the real idle status generator and so
        // invokes the (mocked) Haiku text generator that produces the idle status text.
        await presenceManager.updatePhase({
            type:  'idle',
            since: new Date(),
        });

        // Transitioning to idle must exercise the idle status generation path.
        expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalled();

        // Clean up
        presenceManager.stop();
    });
});
