import type { Client } from 'discord.js';
import { logger } from '@hughescr/logger';
import type { DiscordConfig } from '@/config/schemas';
import type { ClaudeAgent } from '@/agent/agent';
import type { ContextBuilder } from '@/agent/context-builder';
import { createDiscordClient } from './client';
import { createReadyHandler, createErrorHandler } from './handlers';
import {
    createDynamicStatusGenerator,
    type PresenceManager
} from './presence';
import { setupPresence, type PresenceSetupResult } from './setup/presence-setup';
import type { MessageCoordinator } from './message-coordinator';
import { DiscordRateLimiter } from './rate-limiter';
import { QuestionRegistry } from '@/agent/question-registry';
import { AnswerClassifier, classifyWithHaiku } from '@/agent/answer-classifier';
import { createInteractionHandler } from './interactions';
import type { InboxManager } from './inbox';
import {
    type CatchUpSessionRunner,
    type CatchUpCompletionSignal,
    type CatchUpInProgressSignal
} from './catchup';
import {
    BotStateManagerImpl,
    type BotStateManager
} from './state';
import {
    type PerchScheduler,
    type PerchSessionRunner,
    type PerchConfig
} from '@/agent/perch';
import { DMTracker, ResponseRouter, type ChannelRegistryManager } from './channel-registry';
import { setupPerchSessionRunnerAndScheduler } from './setup/perch-setup';
import { setupCatchUpSessionRunner, setupInboxAndCatchUp } from './setup/catchup-setup';
import { setupCoordinatorIntegration } from './setup/coordinator-setup';
import { setupMessageProcessing, initializeChannelRegistry, setupChannelCleanupHandlers } from './setup/event-handler-setup';

/**
 * Global state for Discord client to survive Bun hot reload.
 * During hot reload, the module is re-executed but global state persists.
 * This allows us to reuse the existing client and remove old event handlers
 * before registering new ones, preventing duplicate handler registration.
 */
declare global {

    var __discordClient: Client | undefined;
}

/**
 * Options for configuring the Discord bot.
 */
export interface DiscordBotOptions {
    /**
     * Discord configuration including bot token and monitored channels.
     */
    config: DiscordConfig

    /**
     * Optional identity context for personalizing idle status messages.
     * Used for generating creative idle status messages.
     */
    identityContext?: string

    /**
     * Claude agent instance for status middleware integration.
     */
    agent?: ClaudeAgent

    /**
     * Optional pre-created Discord client.
     * If provided, this client will be used instead of creating a new one.
     * Useful when the client needs to be shared with other components.
     */
    client?: Client

    /**
     * Optional question registry for interactive question/answer flows.
     * If not provided, a new registry will be created internally.
     * Pass this to share the registry with the Discord MCP server.
     */
    questionRegistry?: QuestionRegistry

    /**
     * Optional inbox manager for tracking unread messages and channel activity.
     * If provided, enables inbox functionality for the bot.
     */
    inboxManager?: InboxManager

    /**
     * Optional memory backend for storing catch-up state (completion/inProgress signals).
     * If provided along with agent and inboxManager, enables catch-up mode.
     */
    memoryBackend?: {
        /** Store catch-up completion signal */
        storeCompletionSignal:  (signal: CatchUpCompletionSignal) => Promise<void>
        /** Load catch-up completion signal */
        loadCompletionSignal:   () => Promise<CatchUpCompletionSignal | null>
        /** Store catch-up in-progress signal */
        storeInProgressSignal:  (signal: CatchUpInProgressSignal) => Promise<void>
        /** Load catch-up in-progress signal */
        loadInProgressSignal:   () => Promise<CatchUpInProgressSignal | null>
        /** Delete catch-up in-progress signal */
        deleteInProgressSignal: () => Promise<void>
    }

    /**
     * Optional bot state manager.
     * If provided, this will be used instead of creating a new one.
     * Useful when the state manager needs to be shared with other components.
     */
    botStateManager?: BotStateManager

    /**
     * Channel registry for dynamic channel management.
     * Required for message filtering and channel discovery.
     */
    channelRegistry: ChannelRegistryManager

    /**
     * Optional perch time configuration.
     * If provided along with agent, enables autonomous perch time.
     */
    perchConfig?: PerchConfig

    /**
     * Optional event delta tracker for capturing events during message processing interruptions
     */
    eventDeltaTracker?: import('../../agent/event-delta-tracker').EventDeltaTracker

    /**
     * Optional context builder for loading memory context into perch prompts.
     * If provided, enables perch context feature (time header + recent focus + recent events).
     */
    contextBuilder?: ContextBuilder
}

/**
 * Discord bot interface with lifecycle methods.
 */
export interface DiscordBot {
    /**
     * Starts the bot by logging into Discord.
     * Errors during login propagate to the caller.
     */
    start(): Promise<void>

    /**
     * Stops the bot by destroying the Discord client connection.
     */
    stop(): Promise<void>

    /**
     * For testing - expose internal state manager (Phase 2).
     * @internal
     */
    _botStateManager?: BotStateManager
}

/**
 * Creates a Discord bot with the specified configuration and message handler.
 *
 * The bot orchestrates the Discord client lifecycle and event handling:
 * 1. Creates a Discord client with required intents
 * 2. Registers error handler for Discord client errors
 * 3. Registers ready handler for logging bot startup
 * 4. Registers ready handler for setting up messageCreate handler
 * 5. Provides start/stop methods for lifecycle management
 *
 * The bot follows the factory function pattern used throughout the Discord integration.
 * Event handlers are registered during bot creation, but the client is not logged in
 * until start() is called.
 *
 * Error handling:
 * - Login errors propagate to the caller (let caller handle authentication failures)
 * - Message processing errors are logged but don't crash the bot
 * - Client errors are logged via the error handler
 *
 * @param options - Bot configuration and message callback
 * @returns Discord bot with start/stop methods
 *
 * @example
 * ```typescript
 * const agent = createClaudeAgent({ ... });
 * const channelRegistry = createChannelRegistryManager({ ... });
 *
 * const bot = createDiscordBot({
 *   config: {
 *     botToken: process.env.DISCORD_BOT_TOKEN,
 *     applicationId: process.env.DISCORD_APP_ID,
 *     homeGuildId: '...'
 *   },
 *   identityContext: 'I am a helpful assistant',
 *   agent: agent,
 *   channelRegistry: channelRegistry,
 * });
 *
 * await bot.start();
 * // Bot is now running
 * await bot.stop();
 * ```
 */
export function createDiscordBot(options: DiscordBotOptions): DiscordBot {
    const { config, identityContext, agent, client: providedClient, inboxManager, memoryBackend, botStateManager: providedBotStateManager, channelRegistry, eventDeltaTracker, contextBuilder } = options;

    // Hot reload protection: Reuse existing client if available in global state
    // During Bun hot reload, the module is re-executed but global state persists.
    // This prevents duplicate event handler registration.
    let client: Client;
    if(providedClient) {
        // Use provided client (testing or external management)
        client = providedClient;
    } else if(globalThis.__discordClient) {
        // Reuse existing client from hot reload
        client = globalThis.__discordClient;
        // Remove all existing listeners before re-registering
        // This is critical to prevent duplicate handlers during hot reload
        client.removeAllListeners();
    } else {
        // First initialization - create new client
        client = createDiscordClient(config);
        // Store in global state for hot reload survival
        globalThis.__discordClient = client;
    }

    let presenceManager: PresenceManager | undefined;
    let coordinator: MessageCoordinator | undefined;
    let rateLimiter: DiscordRateLimiter | undefined;
    let catchUpSessionRunner: CatchUpSessionRunner | undefined;
    let perchScheduler: PerchScheduler | undefined;
    let perchSessionRunner: PerchSessionRunner | undefined;
    // Use provided registry or create a new one
    const questionRegistry: QuestionRegistry = options.questionRegistry ?? new QuestionRegistry();

    // Capture unsubscribe functions for cleanup
    let unsubscribeModeTransition: (() => void) | undefined;
    let unsubscribeActivityPhase: (() => void) | undefined;

    // Use provided bot state manager or create a new one
    const botStateManager: BotStateManager = providedBotStateManager ?? new BotStateManagerImpl({
        logger,
        updateThrottleMs: config.presence?.updateThrottleMs,
    });

    // Register error handler for Discord client errors
    // Stryker disable next-line StringLiteral: Discord.js event name
    client.on('error', createErrorHandler());

    // Register rate limit handler for logging (if rest client is available)
    // Stryker disable next-line ConditionalExpression,BlockStatement: client.rest always exists on Discord.js Client; rate limit logging is observational
    if(client.rest) {
        // Stryker disable all: Rate limit logging is observational only
        // Stryker disable next-line StringLiteral: Event name constant
        client.rest.on('rateLimited', (info) => {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Logger warn object for observability
            logger.warn({
                route:      info.route,
                limit:      info.limit,
                retryAfter: info.retryAfter,
                global:     info.global,
                msg:        'Discord rate limit hit, auto-retrying',
            });
        });
        // Stryker restore all
    }

    // Register clientReady handler for messageCreate setup
    // This runs after the client is authenticated and ready
    // Use .once() to ensure this setup only runs once, even on reconnects
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- clientReady handler must be async; needs refactoring to reduce complexity
    client.once('clientReady', async (readyClient: Client): Promise<void> => {
        // Log that the bot is ready (preserving functionality from removed logging handler)
        createReadyHandler()(readyClient);
        // At this point, readyClient.user is guaranteed to be non-null
        // because the 'clientReady' event only fires after successful authentication

        // Track recent messages for context-aware idle status generation
        const MAX_RECENT_MESSAGES = 5;
        const recentMessages: string[] = [];

        const addRecentMessage = (content: string): void => {
            recentMessages.push(content.slice(0, 200)); // Truncate long messages
            if(recentMessages.length > MAX_RECENT_MESSAGES) {
                recentMessages.shift();
            }
        };

        // Track last thinking content for context-aware idle status generation
        let lastThinkingContent: string | undefined;

        const setLastThinkingContent = (content: string): void => {
            lastThinkingContent = content;
        };

        const getLastThinkingContent = (): string | undefined => lastThinkingContent;

        // Create rate limiter for Discord message sending
        rateLimiter = new DiscordRateLimiter({
            globalConcurrency: 5,
            logger,
        });

        // Create answer classifier with Haiku for ambiguous messages
        const answerClassifier = new AnswerClassifier({
            classifyWithLLM: classifyWithHaiku,
        });

        // Create interaction handler for button clicks
        const interactionHandler = createInteractionHandler({
            questionRegistry,
        });

        // Register interaction handler for button clicks
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- interactionCreate handler is async
        client.on('interactionCreate', async (interaction) => {
            if(interaction.isButton()) {
                await interactionHandler.handleButtonInteraction(interaction);
            }
        });

        // Create dynamic status generator if identityContext is provided
        // IMPORTANT: Must create before presence manager, catch-up session runner, and coordinator
        const dynamicStatusGenerator = identityContext
            ? createDynamicStatusGenerator({ identityContext })
            : undefined;

        // Setup presence manager if optional deps provided
        // IMPORTANT: Must create before coordinator.setProcessor so it's available in onStreamEvent
        let presenceSetup: PresenceSetupResult | undefined;
        if(identityContext && config.presence) {
            presenceSetup = setupPresence({
                identityContext,
                presenceConfig:   config.presence,
                readyClient,
                botStateManager,
                dynamicStatusGenerator,
                inboxManager,
                getRecentContext: async () => {
                    if(recentMessages.length === 0) {
                        return undefined;
                    }
                    return recentMessages.join('\n• ');
                },
                contextBuilder,
                getLastThinkingContent,
            });
            presenceManager = presenceSetup.presenceManager;
            unsubscribeModeTransition = presenceSetup.unsubscribeModeTransition;
            unsubscribeActivityPhase = presenceSetup.unsubscribeActivityPhase;
        }

        // Create DMTracker and ResponseRouter (after client is ready, BEFORE session runners)
        const dmTracker = new DMTracker(channelRegistry, readyClient);
        const responseRouter = new ResponseRouter({
            manager: channelRegistry,
        });

        // Create catch-up session runner if all dependencies available (must be created before inbox init)
        if(inboxManager && agent && memoryBackend) {
            catchUpSessionRunner = setupCatchUpSessionRunner({
                inboxManager,
                agent,
                memoryBackend,
                botStateManager,
                presenceManager,
                dynamicStatusGenerator,
                responseRouter,
                rateLimiter,
                client:                  readyClient,
                onThinkingContentUpdate: setLastThinkingContent,
            });
        }

        // Create perch session runner and scheduler if config provided
        if(agent && options.perchConfig?.enabled) {
            const perchSetup = setupPerchSessionRunnerAndScheduler({
                agent,
                perchConfig:             options.perchConfig,
                botStateManager,
                presenceManager,
                dynamicStatusGenerator,
                responseRouter,
                rateLimiter,
                client:                  readyClient,
                contextBuilder,
                onThinkingContentUpdate: setLastThinkingContent,
            });
            perchSessionRunner = perchSetup.runner;
            perchScheduler = perchSetup.scheduler;
        }

        // Initialize channel registry BEFORE setting up message handlers
        // Pass rateLimiter for error notification (may be undefined if not created yet)
        await initializeChannelRegistry(readyClient, channelRegistry, responseRouter, rateLimiter);

        // Create message coordinator if agent is provided (MUST be before setupMessageProcessing)
        if(agent) {
            coordinator = setupCoordinatorIntegration({
                agent,
                presenceManager,
                dynamicStatusGenerator,
                botStateManager,
                catchUpSessionRunner,
                perchSessionRunner,
                responseRouter,
                rateLimiter:             rateLimiter,
                readyClient,
                channelRegistry,
                eventDeltaTracker,
                onThinkingContentUpdate: setLastThinkingContent,
            });

            // Register message handler AFTER channel registry is initialized and coordinator is created
            // Message processing requires coordinator, which requires agent
            setupMessageProcessing({
                client,
                readyClient,
                channelRegistry,
                addRecentMessage,
                coordinator,
                questionRegistry,
                answerClassifier,
                inboxManager,
                catchUpSessionRunner,
                botStateManager,
                perchSessionRunner,
                dmTracker,
            });
        }

        // Register channel cleanup event handlers
        setupChannelCleanupHandlers({
            client,
            coordinator,
            channelRegistry,
        });

        // Initialize inbox on startup and then check for catch-up
        if(inboxManager) {
            setupInboxAndCatchUp({
                inboxManager,
                readyClient,
                botStateManager,
                catchUpSessionRunner,
                presenceManager,
                memoryBackend: memoryBackend!,
                perchConfig:   options.perchConfig,
            });
        }
    });

    return {
        async start(): Promise<void> {
            // Login errors propagate to caller (as per user decision)
            await client.login(config.botToken);
        },

        async stop(): Promise<void> {
            // Stop coordinator if it exists
            if(coordinator) {
                coordinator.stop();
            }
            // Stop question registry (always exists now)
            questionRegistry.stop();
            // Unsubscribe from botStateManager subscriptions
            if(unsubscribeModeTransition) {
                unsubscribeModeTransition();
            }
            if(unsubscribeActivityPhase) {
                unsubscribeActivityPhase();
            }
            // Abort sessions FIRST, before stopping botStateManager
            // Session aborts may trigger callbacks that need botStateManager to be alive
            // Abort any running catch-up session
            if(catchUpSessionRunner) {
                const controller = catchUpSessionRunner.getAbortController();
                if(controller) {
                    controller.abort();
                }
            }
            // Stop perch scheduler if it exists
            if(perchScheduler) {
                perchScheduler.stop();
            }
            // Abort any running perch session
            if(perchSessionRunner) {
                const controller = perchSessionRunner.getAbortController();
                if(controller) {
                    controller.abort();
                }
            }
            // NOW safe to stop botStateManager after all sessions are aborted
            // This ensures abort callbacks complete before state manager is stopped
            botStateManager.stop();
            // Stop presence manager if it exists
            if(presenceManager) {
                presenceManager.stop();
            }
            // Stop rate limiter if it exists
            if(rateLimiter) {
                rateLimiter.stop();
            }
            // Remove all listeners before destroy to prevent memory leaks
            client.removeAllListeners();
            // destroy() is sufficient for cleanup (as per user decision)
            await client.destroy();
            // Clear global state to allow fresh initialization if needed
            // Only clear if this is the global client (not a provided client)
            if(!providedClient && globalThis.__discordClient === client) {
                globalThis.__discordClient = undefined;
            }
        },

        // For testing - expose internal state manager (Phase 2)
        _botStateManager: botStateManager,
    };
}
