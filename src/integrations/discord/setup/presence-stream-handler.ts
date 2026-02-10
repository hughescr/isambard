import { logger } from '@hughescr/logger';
import type { BotStateManager } from '../state';
import {
    createStreamEventHandler,
    type PresenceManager,
    createDynamicStatusGenerator
} from '../presence';

/**
 * Creates a stream event handler for presence updates during agent processing.
 * Returns undefined if presence manager is not available.
 *
 * @param presenceManager - Manager for Discord presence updates
 * @param dynamicStatusGenerator - Optional generator for context-aware status messages
 * @param userMessage - User's message content for synopsis generation
 * @param botStateManager - Bot state manager for tracking activity phases
 * @returns Stream event handler or undefined
 */
export function createPresenceStreamHandler(
    presenceManager: PresenceManager | undefined,
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined,
    userMessage: string,
    botStateManager: BotStateManager
): ReturnType<typeof createStreamEventHandler> | undefined {
    if(!presenceManager) {
        return undefined;
    }

    return createStreamEventHandler({
        presenceManager,
        dynamicStatusGenerator,
        logger,
        userMessage,
        botStateManager,
    });
}
