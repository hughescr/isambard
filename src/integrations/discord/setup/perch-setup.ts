import type { Client } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { ClaudeAgent } from '@/agent/agent';
import type { BotStateManager } from '../state';
import { createDynamicStatusGenerator, type PresenceManager } from '../presence';
import {
    type PerchConfig,
    type PerchScheduler,
    type PerchSessionRunner,
    createPerchScheduler,
    createPerchSessionRunner
} from '@/agent/perch';
import type { ResponseRouter } from '../channel-registry';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendResponseToWellKnownChannel } from '../response-sender';
import { createPresenceStreamHandler } from './presence-stream-handler';
import type { ContextBuilder } from '@/agent/context-builder';

/**
 * Parameters for setting up perch scheduler and runner.
 */
export interface SetupPerchParams {
    agent:                  ClaudeAgent
    perchConfig:            PerchConfig
    botStateManager:        BotStateManager
    presenceManager:        PresenceManager | undefined
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined
    responseRouter:         ResponseRouter
    rateLimiter:            DiscordRateLimiter
    client:                 Client
    contextBuilder?:        ContextBuilder
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
        runAgentSession: async (runOptions) => {
            // Create abort controller from signal
            const abortController = new AbortController();
            runOptions.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Create stream event handler for presence updates during perch
            const streamEventHandler = createPresenceStreamHandler(
                presenceManager,
                dynamicStatusGenerator,
                `Perch time: ${runOptions.slot}`,
                botStateManager
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
                await sendResponseToWellKnownChannel({
                    response:    result.response,
                    sessionType: 'perching',
                    responseRouter,
                    rateLimiter,
                    client,
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
        stateManager:   botStateManager,
        logger,
        config:         perchConfig,
        onPerchTrigger: (slot) => {
            if(runner) {
                void runner.startPerch(slot).catch((error) => {
                    const errorMsg = _.isError(error) ? error.message : String(error);
                    logger.error({ error: errorMsg, slot, msg: 'Failed to start perch session' });
                });
            }
        },
    });

    // Start the perch scheduler
    scheduler.start();
    logger.info({ msg: 'Perch scheduler initialized and started' });

    return { runner, scheduler };
}
// Stryker restore all
