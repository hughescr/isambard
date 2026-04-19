import { logger } from '@hughescr/logger';
import {
    buildThinkingSynopsis,
    createStreamEventHandler,
    type StreamEventHandler,
    type PresenceManager,
    type createDynamicStatusGenerator
} from '../presence';
import type { BotStateManager } from '../state';

/**
 * Type alias for the resolved value of createPresenceStreamHandler.
 * Use this when you need to annotate a variable that holds the result
 * of awaiting createPresenceStreamHandler.
 */
export type PresenceStreamHandler = StreamEventHandler;

/**
 * Creates a stream event handler for presence updates during agent processing.
 * Returns undefined if presence manager is not available.
 *
 * Pre-generates a Haiku thinking synopsis before constructing the handler so
 * that even fast replies that complete before the first thinking-content block
 * can display a personalised status line instead of the generic fallback.
 *
 * @param presenceManager - Manager for Discord presence updates
 * @param dynamicStatusGenerator - Optional generator for context-aware status messages
 * @param userMessage - User's message content for synopsis generation
 * @param botStateManager - Bot state manager for tracking activity phases
 * @param onThinkingContentUpdate - Optional callback fired when thinking content is updated
 * @returns Promise resolving to a stream event handler or undefined
 */
export async function createPresenceStreamHandler(
    presenceManager: PresenceManager | undefined,
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined,
    userMessage: string,
    botStateManager: BotStateManager,
    onThinkingContentUpdate?: (content: string) => void
): Promise<ReturnType<typeof createStreamEventHandler> | undefined> {
    if(!presenceManager) {
        return undefined;
    }

    // Pre-generate thinking synopsis before agent starts processing.
    // This ensures a personalised status is available immediately when the
    // handler first enters 'thinking' phase, even on very short replies.
    const thinkingSynopsis = await buildThinkingSynopsis(dynamicStatusGenerator, botStateManager, userMessage);

    return createStreamEventHandler({
        presenceManager,
        dynamicStatusGenerator,
        logger,
        userMessage,
        thinkingSynopsis,
        botStateManager,
        onThinkingContentUpdate,
    });
}
