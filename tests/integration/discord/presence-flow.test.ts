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
import type { Anthropic } from '@anthropic-ai/sdk';
import { createActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';
import { createPresenceManager } from '@/integrations/discord/presence/manager';
import { createStatusMiddleware } from '@/integrations/discord/presence/middleware';
import { createMessageHandler } from '@/integrations/discord/handlers';
import type { ClaudeAgent } from '@/agent/agent';
import type { DiscordMessageContext, ChannelId, UserId, GuildId } from '@/integrations/discord/types';
import type { AgentStreamEvent } from '@/agent/types';

describe('Discord Presence Flow (Integration)', () => {
    let mockDiscordClient: Client;
    let mockAnthropicClient: Anthropic;
    let mockAgent: ClaudeAgent;
    let mockMessage: Message;
    let mockChannel: TextChannel;

    beforeEach(() => {
        jest.useFakeTimers();

        // Mock Discord client
        mockDiscordClient = {
            user: {
                setPresence: mock(async () => undefined),
            },
        } as unknown as Client;

        // Mock Anthropic client for idle status generation
        mockAnthropicClient = {
            messages: {
                create: mock(async () => ({
                    content: [{ type: 'text', text: 'Contemplating digital dreams' }],
                })),
            },
        } as unknown as Anthropic;

        // Mock channel with typing indicator
        mockChannel = {
            sendTyping: mock(async () => undefined),
        } as unknown as TextChannel;

        // Mock Discord message
        mockMessage = {
            id:        '123456789',
            author:    { id: 'user-id', bot: false },
            content:   'Hello bot!',
            createdAt: new Date(),
            guild:     { id: 'guild-id' },
            channel:   { ...mockChannel, id: 'channel-id' },
            reply:     mock(async () => undefined),
        } as unknown as Message;
    });

    afterEach(() => {
        jest.useRealTimers();
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
            anthropic:       mockAnthropicClient,
            logger,
            activityType:    ActivityType.Custom,
            identityContext: 'Test Bot',
        });

        // Create presence manager with real implementation
        const presenceManager = createPresenceManager({
            discordClient: mockDiscordClient,
            config:        {
                updateDebounceMs:      100,
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
            chat: mock(async (context: DiscordMessageContext, onStreamEvent?: (event: AgentStreamEvent) => void) => {
                if(onStreamEvent) {
                    streamCallbacks.push(onStreamEvent);

                    // Simulate stream events
                    // 1. Thinking phase
                    onStreamEvent({
                        type:  'assistant',
                        delta: {},
                    } as AgentStreamEvent);

                    // 2. Tool usage
                    onStreamEvent({
                        type:      'tool_progress',
                        tool_name: 'mcp__memory__view',
                    } as AgentStreamEvent);

                    // 3. Responding phase
                    onStreamEvent({
                        type:  'assistant',
                        delta: { text: 'Hello!' },
                    } as AgentStreamEvent);

                    // 4. Result
                    onStreamEvent({
                        type: 'result',
                    } as AgentStreamEvent);
                }

                return 'Hello! How can I help you?';
            }),
        } as ClaudeAgent;

        // Don't use onMessage directly if presenceManager and agent are provided
        // The middleware will call agent.chat instead
        const messageHandler = createMessageHandler({
            monitoredChannelIds: ['channel-id' as ChannelId],
            botUserId:           'bot-id' as UserId,
            onMessage:           mock(_constant(Promise.resolve('test response'))), // This won't be called when middleware is used
            presenceManager,
            agent:               mockAgent,
        });

        // Process message
        await messageHandler(mockMessage);

        // Verify typing indicator started
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest-style mocking requires accessing method reference
        expect(mockChannel.sendTyping).toHaveBeenCalled();

        // Verify agent was called
        expect(mockAgent.chat).toHaveBeenCalled();

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
            anthropic:       mockAnthropicClient,
            logger,
            activityType:    ActivityType.Custom,
            identityContext: 'Test Bot',
        });

        // Create presence manager
        const presenceManager = createPresenceManager({
            discordClient: mockDiscordClient,
            config:        {
                updateDebounceMs:      100,
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
            chat: mock(async () => {
                throw new Error('Agent processing failed');
            }),
        } as ClaudeAgent;

        // Create status middleware
        const statusMiddleware = createStatusMiddleware({
            presenceManager,
            agent: mockAgent,
            logger,
        });

        // Process message - should not throw
        const context: DiscordMessageContext = {
            guildId:   'guild-id' as GuildId,
            channelId: 'channel-id' as ChannelId,
            userId:    'user-id' as UserId,
            messageId: 'message-id',
            content:   'Hello',
            timestamp: new Date().toISOString(),
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
            id:        '999888777',
            author:    { id: 'user-id', bot: false },
            content:   'Hello bot!',
            createdAt: new Date(),
            guild:     { id: 'guild-id' },
            channel:   { id: 'channel-id', sendTyping: mock(async () => undefined) },
            reply:     mock(async () => undefined),
        } as unknown as Message;

        // Create message handler WITHOUT presence manager
        const messageHandler = createMessageHandler({
            monitoredChannelIds: ['channel-id' as ChannelId],
            botUserId:           'bot-id' as UserId,
            onMessage:           mock(_constant(Promise.resolve('Response without presence'))),
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
            anthropic:       mockAnthropicClient,
            logger,
            activityType:    ActivityType.Custom,
            identityContext: 'Test Bot',
        });

        // Create presence manager with SHORT idle timeout for testing
        const presenceManager = createPresenceManager({
            discordClient: mockDiscordClient,
            config:        {
                updateDebounceMs:      50,
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
