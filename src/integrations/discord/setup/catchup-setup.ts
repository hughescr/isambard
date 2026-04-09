import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import { chain } from 'lodash-es';
import type { DiscordCapability } from '../capability';
import {
    createCatchUpSessionRunner,
    type CatchUpSessionRunner,
    type CatchUpCompletionSignal,
    type CatchUpInProgressSignal
} from '../catchup';
import type { ResponseRouter } from '../channel-registry';
import type { InboxManager } from '../inbox';
import {
    type createDynamicStatusGenerator,
    type PresenceManager,
    type CatchUpSynopsisContext
} from '../presence';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendResponseToWellKnownChannel } from '../response-sender';
import type { BotStateManager } from '../state';
import { createPresenceStreamHandler } from './presence-stream-handler';
import { type ClaudeAgent, type PerchConfig, type ActivityLogger  } from '@/agent';
import type { ServiceHealthRegistry } from '@/services';
import { formatTimeSince, getTimeOfDay } from '@/utils';

/**
 * Builds catch-up synopsis context from inbox state.
 *
 * @param inboxManager - Inbox manager with unread messages
 * @param memoryBackend - Memory backend for loading completion signal
 * @returns Promise resolving to catch-up synopsis context
 */
// Stryker disable all: Context building with lodash chains and object literals for catch-up status - tested via integration
async function buildCatchUpContext(
    inboxManager: InboxManager,
    memoryBackend: {
        loadCompletionSignal: () => Promise<CatchUpCompletionSignal | null>
    }
): Promise<CatchUpSynopsisContext> {
    const overview = inboxManager.getUnreadOverview();
    const allMessages = overview.channels.flatMap(ch => inboxManager.getChannelMessages(ch.channelId));
    const topAuthors = chain(allMessages).map('author').countBy().toPairs().orderBy([1], ['desc']).take(3).map(([author]) => author).value();

    // Get time since last active from completion signal
    const completionSignal = await memoryBackend.loadCompletionSignal();
    const lastActiveTime = completionSignal?.completedAt
        ? new Date(completionSignal.completedAt)
        : new Date(Date.now() - 24 * 60 * 60 * 1000); // Default to 24h ago

    return {
        totalUnread:         overview.totalUnread,
        channelCount:        overview.channels.length,
        channelNames:        overview.channels.map(ch => ch.channelName),
        topAuthors,
        timeSinceLastActive: formatTimeSince(lastActiveTime),
        timeOfDay:           getTimeOfDay(new Date()),
        dayOfWeek:           new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    };
}
// Stryker restore all

/**
 * Parameters for setting up catch-up session runner.
 */
interface SetupCatchUpRunnerParams {
    inboxManager:  InboxManager
    agent:         ClaudeAgent
    memoryBackend:              {
        storeCompletionSignal:  (signal: CatchUpCompletionSignal) => Promise<void>
        loadCompletionSignal:   () => Promise<CatchUpCompletionSignal | null>
        storeInProgressSignal:  (signal: CatchUpInProgressSignal) => Promise<void>
        loadInProgressSignal:   () => Promise<CatchUpInProgressSignal | null>
        deleteInProgressSignal: () => Promise<void>
    }
    botStateManager:          BotStateManager
    presenceManager:          PresenceManager | undefined
    dynamicStatusGenerator:   ReturnType<typeof createDynamicStatusGenerator> | undefined
    responseRouter:           ResponseRouter
    rateLimiter:              DiscordRateLimiter
    client:                   Client
    onThinkingContentUpdate?: (content: string) => void
    setLastSessionId?:        (sessionId: string | undefined) => void
    addRecentMessage?:        (content: string, author: 'user' | 'izzy') => void
    activityLogger?:          ActivityLogger
    /** Optional capability facade for outbox fallback when Discord is offline. */
    discordCapability?:       DiscordCapability
}

/**
 * Creates and configures the catch-up session runner.
 *
 * @param params - Configuration for catch-up setup
 * @returns Configured catch-up session runner
 */
// Stryker disable all: Integration function with callbacks coordinating multiple components - tested via bot integration tests
export function setupCatchUpSessionRunner(params: SetupCatchUpRunnerParams): CatchUpSessionRunner {
    const {
        inboxManager,
        agent,
        memoryBackend,
        botStateManager,
        presenceManager,
        dynamicStatusGenerator,
        responseRouter,
        rateLimiter,
        client,
    } = params;

    return createCatchUpSessionRunner({
        stateManager:           botStateManager,
        inboxManager,
        storeCompletionSignal:  memoryBackend.storeCompletionSignal,
        loadCompletionSignal:   memoryBackend.loadCompletionSignal,
        storeInProgressSignal:  memoryBackend.storeInProgressSignal,
        loadInProgressSignal:   memoryBackend.loadInProgressSignal,
        deleteInProgressSignal: memoryBackend.deleteInProgressSignal,
        resolveChannelName:     channelId => inboxManager.getChannelName(channelId),
        activityLogger:         params.activityLogger,
        runAgentSession:        async (runOptions) => {
            // Create abort controller from signal
            const abortController = new AbortController();
            runOptions.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Build dynamic user message from status context
            const statusContext = runOptions.statusContext;
            const userMessage = statusContext
                ? `Processing ${statusContext.totalUnread} messages from ${statusContext.topAuthors.join(', ')} in ${statusContext.channelNames.join(', ')}`
                : 'Catching up on messages...';

            // Create stream event handler for presence updates during catch-up
            const streamEventHandler = createPresenceStreamHandler(
                presenceManager,
                dynamicStatusGenerator,
                userMessage,
                botStateManager,
                params.onThinkingContentUpdate
            );

            // Call agent.handleInput with specialMode: 'catchup' and the catch-up prompt
            const result = await agent.handleInput([], {
                specialMode:   'catchup',
                abortController,
                sessionId:     runOptions.sessionId,
                catchUpPrompt: runOptions.prompt,
                onStreamEvent: streamEventHandler?.onStreamEvent,
            });

            // Transition to idle after completion
            if(streamEventHandler) {
                streamEventHandler.complete();
            }

            // Update session ID tracker
            params.setLastSessionId?.(result.sessionId);

            // Log session completion
            logger.info({
                sessionType:    'catching_up',
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
                    sessionType:       'catching_up',
                    responseRouter,
                    rateLimiter,
                    client,
                    discordCapability: params.discordCapability,
                });
            }

            return {
                completed: !result.wasInterrupted,
                sessionId: result.sessionId,
            };
        },
    });
}
// Stryker restore all

/**
 * Parameters for setting up inbox and catch-up functionality.
 */
interface SetupInboxParams {
    inboxManager:         InboxManager
    readyClient:          Client
    botStateManager:      BotStateManager
    catchUpSessionRunner: CatchUpSessionRunner | undefined
    presenceManager:      PresenceManager | undefined
    memoryBackend:        {
        loadCompletionSignal: () => Promise<CatchUpCompletionSignal | null>
    }
    perchConfig:     PerchConfig | undefined
    /** Optional health registry — when provided, catch-up defers until Discord is online. */
    healthRegistry?: ServiceHealthRegistry
}

/**
 * Sets up inbox and catch-up functionality.
 * Initializes inbox, loads unread messages, and starts catch-up if needed.
 *
 * @param params - Configuration for inbox setup
 */
// Stryker disable all: Integration function with async IIFE coordinating multiple components - tested via bot integration tests
export function setupInboxAndCatchUp(params: SetupInboxParams): void {
    const {
        inboxManager,
        readyClient,
        botStateManager,
        catchUpSessionRunner,
        presenceManager,
        memoryBackend,
        perchConfig,
        healthRegistry,
    } = params;

    // Capture runner reference for closure safety
    const runner = catchUpSessionRunner;

    async function runInboxInit(): Promise<void> {
        try {
            logger.info({ msg: 'Starting inbox initialization...' });

            // Start unified state manager
            botStateManager.start();

            // Set bot user ID for filtering bot messages from inbox
            inboxManager.setBotUserId(readyClient.user!.id);

            // Load unread messages (automatically initializes checkpoints for monitored channels)
            await inboxManager.loadUnread();

            // NOW check if catch-up should start (after inbox is loaded)
            // Skip if perch test mode triggerOnStartup is enabled (perch handles everything)
            if(runner && !perchConfig?.testMode?.triggerOnStartup) {
                const shouldStart = await runner.shouldStartCatchUp();
                if(shouldStart) {
                    logger.info({ msg: 'Starting catch-up mode' });

                    // Build catch-up context for rich status generation
                    const catchUpContext = await buildCatchUpContext(inboxManager, memoryBackend);

                    // Update presence to show catching up with rich context
                    presenceManager?.transitionPresenceDisplayMode('catching_up', catchUpContext);
                    await runner.startCatchUp();
                } else {
                    // Not doing catch-up, transition to idle mode
                    // eslint-disable-next-line sonarjs/void-use -- intentionally fire-and-forget; catch handles rejection
                    void presenceManager?.updatePhase({ type: 'idle', since: new Date() }).catch(() => undefined);
                }
            } else if(!perchConfig?.testMode?.triggerOnStartup) {
                // No catch-up system and not in perch test mode, transition to idle after startup
                // eslint-disable-next-line sonarjs/void-use -- intentionally fire-and-forget; catch handles rejection
                void presenceManager?.updatePhase({ type: 'idle', since: new Date() }).catch(() => undefined);
            }
            // If triggerOnStartup is enabled, perch scheduler handles presence - no action needed here
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.warn({
                error: errorMsg,
                msg:   'Failed to load inbox on startup',
            });
        }
    }

    // If Discord is not yet available, defer inbox init until it comes online (one-shot subscriber)
    if(healthRegistry && !healthRegistry.isAvailable('discord')) {
        logger.info({ msg: 'Discord not yet available — deferring inbox initialization until Discord is online' });
        const unsubscribe = healthRegistry.subscribe((change) => {
            if(change.service === 'discord' && change.newState === 'online') {
                unsubscribe();
                runInboxInit().catch((error) => {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.error({
                        error: errorMsg,
                        msg:   'Unhandled error in deferred inbox initialization',
                    });
                });
            }
        });
        return;
    }

    runInboxInit().catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({
            error: errorMsg,
            msg:   'Unhandled error in inbox initialization',
        });
    });
}
// Stryker restore all
