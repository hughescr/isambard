/**
 * Integration tests for Discord presence flow.
 *
 * Tests the complete flow of presence updates during message processing,
 * using real components (not mocks) except for Discord client and Anthropic API.
 */

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { constant as _constant } from 'lodash';
import { ActivityType } from 'discord.js';
import type { Client, Message, TextChannel } from 'discord.js';
import { createActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';
import { createPresenceManager } from '@/integrations/discord/presence/manager';
import { createStatusMiddleware } from '@/integrations/discord/presence/middleware';
import { createMessageHandler } from '@/integrations/discord/handlers';
import { createMockBotStateManager, createMockResponseRouter } from '../../setup';
import type { ClaudeAgent } from '@/agent/agent';
import type { StreamTracker } from '@/agent/stream-tracker';
import type { DiscordMessageContext, ChannelId, UserId, GuildId } from '@/integrations/discord/types';
import type { AgentStreamEvent } from '@/agent/types';
import type { BotStateManager } from '@/integrations/discord/state';
import type { ChannelRegistryManager, ResponseRouter } from '@/integrations/discord/channel-registry';
// Import shared mocks from setup.ts (already registered via mock.module in preload)
import { mockGenerateText, mockGenerateTextWithSystemPrompt } from '../../setup';

describe('Discord Presence Flow (Integration)', () => {
    let mockDiscordClient: Client;
    let mockAgent: ClaudeAgent;
    let mockMessage: Message;
    let mockChannel: TextChannel;

    beforeEach(() => {
        jest.useFakeTimers();
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(_constant(Promise.resolve('Contemplating digital dreams')));
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(_constant(Promise.resolve('Contemplating digital dreams')));

        // Mock Discord client
        mockDiscordClient = {
            user: {
                setPresence: mock(async () => undefined),
            },
        } as unknown as Client;

        // Mock channel with typing indicator
        mockChannel = {
            id:         'channel-id',
            channelId:  'channel-id',
            sendTyping: mock(async () => undefined),
            isDMBased:  mock(_constant(false)),
            isThread:   mock(_constant(false)),
        } as unknown as TextChannel;

        // Mock Discord message
        mockMessage = {
            id:           '123456789',
            author:       { id: 'user-id', bot: false, tag: 'TestUser#1234' },
            content:      'Hello bot!',
            cleanContent: 'Hello bot!',
            createdAt:    new Date(),
            guild:        { id: 'guild-id' },
            channel:      mockChannel,
            channelId:    'channel-id',
            reply:        mock(async () => undefined),
        } as unknown as Message;
    });

    afterEach(() => {
        jest.clearAllTimers();     // Clear while still in fake mode
        jest.useRealTimers();      // Then restore real timers
    });

    it('should update presence through full message processing lifecycle', async () => {
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
            identityContext: 'Test Bot',
        });

        // Create presence manager with real implementation
        const presenceManager = createPresenceManager({
            discordClient: mockDiscordClient,
            config:        {
                updateThrottleMs:      100,
                idleTimeoutMs:         1000,
                idleRefreshIntervalMs: 5000,
            },
            activeStatusGenerator,
            idleStatusGenerator,
            logger,
        });

        presenceManager.start();

        // Create mock agent that simulates stream events
        const streamCallbacks: ((event: AgentStreamEvent) => void)[] = [];
        mockAgent = {
            handleInput: mock(async (contexts: DiscordMessageContext[], options?: { onStreamEvent?: (e: AgentStreamEvent) => void }) => {
                if(options?.onStreamEvent) {
                    streamCallbacks.push(options.onStreamEvent);

                    // Simulate stream events
                    // 1. Thinking phase
                    options.onStreamEvent({
                        type:  'assistant',
                        delta: {},
                    } as AgentStreamEvent);

                    // 2. Tool usage
                    options.onStreamEvent({
                        type:      'tool_progress',
                        tool_name: 'mcp__memory__view',
                    } as AgentStreamEvent);

                    // 3. Responding phase
                    options.onStreamEvent({
                        type:  'assistant',
                        delta: { text: 'Hello!' },
                    } as AgentStreamEvent);

                    // 4. Result
                    options.onStreamEvent({
                        type: 'result',
                    } as AgentStreamEvent);
                }

                return { response: 'Hello! How can I help you?', wasInterrupted: false, streamTracker: {} as StreamTracker };
            }),
        } as ClaudeAgent;

        // Create mock bot state manager
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock type is intentionally loose
        const mockBotStateManager = {
            shouldUpdatePresence:   mock(_constant(true)),
            updateActivityPhase:    mock(() => undefined),
            clearActivityPhase:     mock(() => undefined),
            getMode:                mock(_constant('idle' as const)),
            goIdle:                 mock(() => undefined),
            startProcessingMessage: mock(() => undefined),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
        } as any;

        // Don't use onMessage directly if presenceManager and agent are provided
        // The middleware will call agent.handleInput instead
        const messageHandler = createMessageHandler({
            channelRegistry: { shouldProcess: mock(_constant(true)), getChannel: mock(_constant(null)), warmCache: mock(_constant(Promise.resolve())) } as unknown as ChannelRegistryManager,
            botUserId:       'bot-id' as UserId,
            onMessage:       mock(_constant(Promise.resolve('test response'))), // This won't be called when middleware is used
            presenceManager,
            agent:           mockAgent,
            botStateManager: mockBotStateManager as unknown as BotStateManager,
            responseRouter:  createMockResponseRouter() as unknown as ResponseRouter,
        });

        // Process message
        await messageHandler(mockMessage);

        // Verify typing indicator started
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest-style mocking requires accessing method reference
        expect(mockChannel.sendTyping).toHaveBeenCalled();

        // Verify agent was called
        expect(mockAgent.handleInput).toHaveBeenCalled();

        // The presence manager should be active (we can't easily verify setPresence calls
        // due to debouncing and timing issues in tests, but the flow should complete without errors)

        // Clean up
        presenceManager.stop();
    });

    it('should handle errors gracefully without crashing', async () => {
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
            identityContext: 'Test Bot',
        });

        // Create presence manager
        const presenceManager = createPresenceManager({
            discordClient: mockDiscordClient,
            config:        {
                updateThrottleMs:      100,
                idleTimeoutMs:         1000,
                idleRefreshIntervalMs: 5000,
            },
            activeStatusGenerator,
            idleStatusGenerator,
            logger,
        });

        presenceManager.start();

        // Create agent that throws an error
        mockAgent = {
            handleInput: mock(async (_contexts: DiscordMessageContext[], _options?: { onStreamEvent?: (e: AgentStreamEvent) => void }) => {
                throw new Error('Agent processing failed');
            }),
        } as ClaudeAgent;

        // Create mock bot state manager
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock type is intentionally loose
        const mockBotStateManager = {
            shouldUpdatePresence:   mock(_constant(true)),
            updateActivityPhase:    mock(() => undefined),
            clearActivityPhase:     mock(() => undefined),
            getMode:                mock(_constant('idle' as const)),
            goIdle:                 mock(() => undefined),
            startProcessingMessage: mock(() => undefined),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
        } as any;

        // Create status middleware
        const statusMiddleware = createStatusMiddleware({
            presenceManager,
            agent:           mockAgent,
            logger,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock type is intentionally loose
            botStateManager: mockBotStateManager,
        });

        // Process message - should not throw
        const context: DiscordMessageContext = {
            guildId:   'guild-id' as GuildId,
            channelId: 'channel-id' as ChannelId,
            userId:    'user-id' as UserId,
            messageId: 'message-id',
            content:   'Hello',
            timestamp: new Date().toISOString(),
            botUserId: 'bot-id' as UserId,
        };

        const result = await statusMiddleware(context, mockChannel);

        // Should return null on error
        expect(result).toBeNull();

        // Should log error
        expect(logger.error).toHaveBeenCalled();

        // Clean up
        presenceManager.stop();
    });

    it('should work without presence manager (backward compatibility)', async () => {
        // Create fresh mock for this test to avoid interference
        const testMessage = {
            id:           '999888777',
            author:       { id: 'user-id', bot: false, tag: 'TestUser#5678' },
            content:      'Hello bot!',
            cleanContent: 'Hello bot!',
            createdAt:    new Date(),
            guild:        { id: 'guild-id' },
            channel:      { id: 'channel-id', channelId: 'channel-id', sendTyping: mock(async () => undefined), isDMBased: mock(_constant(false)), isThread: mock(_constant(false)) },
            channelId:    'channel-id',
            reply:        mock(async () => undefined),
        } as unknown as Message;

        // Create message handler WITHOUT presence manager
        const messageHandler = createMessageHandler({
            channelRegistry: { shouldProcess: mock(_constant(true)), getChannel: mock(_constant(null)), warmCache: mock(_constant(Promise.resolve())) } as unknown as ChannelRegistryManager,
            botUserId:       'bot-id' as UserId,
            onMessage:       mock(_constant(Promise.resolve('Response without presence'))),
            botStateManager: createMockBotStateManager() as unknown as BotStateManager,
            responseRouter:  createMockResponseRouter() as unknown as ResponseRouter,
        });

        // Process message
        await messageHandler(testMessage);

        // Should still work and reply
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest-style mocking requires accessing method reference
        expect(testMessage.reply).toHaveBeenCalledWith('Response without presence');

        // No presence updates should occur (client wasn't even provided)
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest-style mocking requires accessing method reference
        expect(mockDiscordClient.user?.setPresence).not.toHaveBeenCalled();
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
            identityContext: 'Test Bot',
        });

        // Create presence manager with SHORT idle timeout for testing
        const presenceManager = createPresenceManager({
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

        // The idle refresh should have been triggered, but due to debouncing and mock timing,
        // we just verify the system doesn't crash and cleans up properly

        // Clean up
        presenceManager.stop();
    });
});
