import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import type { DiscordCapability } from '../capability';
import type { ResponseRouter } from '../channel-registry';
import { type createDynamicStatusGenerator, type PresenceManager } from '../presence';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendResponseToWellKnownChannel } from '../response-sender';
import type { BotStateManager } from '../state';
import { createPresenceStreamHandler } from './presence-stream-handler';
import { type ClaudeAgent, type ContextBuilder, type PerchConfig, type PerchScheduler, type PerchSessionRunner, type ActivityLogger, createPerchScheduler, createPerchSessionRunner  } from '@/agent';

/**
 * Parameters for setting up perch scheduler and runner.
 */
interface SetupPerchParams {
    agent:                    ClaudeAgent
    perchConfig:              PerchConfig
    botStateManager:          BotStateManager
    presenceManager:          PresenceManager | undefined
    dynamicStatusGenerator:   ReturnType<typeof createDynamicStatusGenerator> | undefined
    responseRouter:           ResponseRouter
    rateLimiter:              DiscordRateLimiter
    client:                   Client
    contextBuilder?:          ContextBuilder
    onThinkingContentUpdate?: (content: string) => void
    setLastSessionId?:        (sessionId: string | undefined) => void
    addRecentMessage?:        (content: string, author: 'user' | 'izzy') => void
    activityLogger?:          ActivityLogger
    /** Optional capability facade for outbox fallback when Discord is offline. */
    discordCapability?:       DiscordCapability
}

/**
 * Creates and configures the perch session runner and scheduler.
 *
 * @param params - Configuration for perch setup
 * @returns Object containing configured perch session runner and scheduler
 */
// Stryker disable all: Integration function with callbacks coordinating multiple components - tested via bot integration tests
export function setupPerchSessionRunnerAndScheduler(params: SetupPerchParams): {
    runner:    PerchSessionRunner
    scheduler: PerchScheduler
} {
    const {
        agent,
        perchConfig,
        botStateManager,
        presenceManager,
        dynamicStatusGenerator,
        responseRouter,
        rateLimiter,
        client,
        contextBuilder,
    } = params;

    const runner = createPerchSessionRunner({
        stateManager:    botStateManager,
        logger,
        config:          perchConfig,
        contextBuilder,
        activityLogger:  params.activityLogger,
        runAgentSession: async (runOptions) => {
            // Create abort controller from signal
            const abortController = new AbortController();
            runOptions.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Create stream event handler for presence updates during perch
            const streamEventHandler = createPresenceStreamHandler(
                presenceManager,
                dynamicStatusGenerator,
                `Perch time: ${runOptions.slot}`,
                botStateManager,
                params.onThinkingContentUpdate
            );

            // Call agent.handleInput with specialMode: 'perching' and the perch prompt
            const result = await agent.handleInput([], {
                specialMode:   'perching',
                abortController,
                perchPrompt:   runOptions.prompt,
                onStreamEvent: streamEventHandler?.onStreamEvent,
            });

            // Complete presence updates
            if(streamEventHandler) {
                streamEventHandler.complete();
            }

            // Update session ID tracker
            params.setLastSessionId?.(result.sessionId);

            // Log session completion
            logger.info({
                sessionType:    'perching',
                hasResponse:    Boolean(result.response),
                responseLength: result.response?.length ?? 0,
                wasInterrupted: result.wasInterrupted,
                sessionId:      result.sessionId,
                msg:            'Session completed',
            });

            // Route response to well-known channel if present
            if(result.response && !result.wasInterrupted) {
                params.addRecentMessage?.(result.response, 'izzy');
                await sendResponseToWellKnownChannel({
                    response:          result.response,
                    sessionType:       'perching',
                    responseRouter,
                    rateLimiter,
                    client,
                    discordCapability: params.discordCapability,
                });
            }

            return {
                completed:   !result.wasInterrupted,
                sessionId:   result.sessionId,
                partialWork: result.streamTracker.getProgress(),
            };
        },
    });

    const scheduler = createPerchScheduler({
        stateManager:       botStateManager,
        logger,
        config:             perchConfig,
        perchSessionRunner: runner,
        onPerchTrigger:     (slot) => {
            void runner.startPerch(slot).catch((error) => {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error({ error: errorMsg, slot, msg: 'Failed to start perch session' });
            });
        },
    });

    // Start the perch scheduler
    scheduler.start();
    logger.info({ msg: 'Perch scheduler initialized and started' });

    return { runner, scheduler };
}
// Stryker restore all
