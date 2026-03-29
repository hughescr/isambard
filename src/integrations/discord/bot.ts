import { logger } from '@hughescr/logger';
import { MessageFlags, type Client } from 'discord.js';
import {
    type CatchUpSessionRunner,
    type CatchUpCompletionSignal,
    type CatchUpInProgressSignal
} from './catchup';
import { DMTracker, ResponseRouter, type ChannelRegistryManager } from './channel-registry';
import { createDiscordClient } from './client';
import type { ContactCommandHandler, ContactApprovalHandler } from './contact-commands';
import { createReadyHandler, createErrorHandler } from './handlers';
import type { InboxManager } from './inbox';
import { createInteractionHandler } from './interactions';
import type { MessageCoordinator } from './message-coordinator';
import {
    createDynamicStatusGenerator,
    type PresenceManager
} from './presence';
import { DiscordRateLimiter } from './rate-limiter';
import type { BskySetupResult } from './setup/bsky-setup';
import { setupCatchUpSessionRunner, setupInboxAndCatchUp } from './setup/catchup-setup';
import { setupCoordinatorIntegration } from './setup/coordinator-setup';
import type { EmailSetupResult } from './setup/email-setup';
import { setupMessageProcessing, initializeChannelRegistry, setupChannelCleanupHandlers } from './setup/event-handler-setup';
import { setupPerchSessionRunnerAndScheduler } from './setup/perch-setup';
import { setupPresence, type PresenceSetupResult } from './setup/presence-setup';
import {
    BotStateManagerImpl,
    type BotStateManager
} from './state';
import { QuestionRegistry, AnswerClassifier, classifyWithHaiku, createTaskListReader, type PerchScheduler, type PerchSessionRunner, type PerchConfig, type ClaudeAgent, type ContextBuilder, type EventDeltaTracker, type ActivityLogger, type PersonHistoryCoordinator  } from '@/agent';
import type { DiscordConfig } from '@/config';
import type { CalendarCommandHandler } from '@/integrations/caldav';
import type { AllowlistCommandHandler } from '@/integrations/email';

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
    eventDeltaTracker?: EventDeltaTracker

    /**
     * Optional context builder for loading memory context into perch prompts.
     * If provided, enables perch context feature (time header + recent focus + recent events).
     */
    contextBuilder?: ContextBuilder

    /**
     * Optional email setup result for email integration.
     * If provided, wires in the email listener lifecycle and email button/command routing.
     */
    emailSetup?: EmailSetupResult

    /**
     * Optional Bluesky setup result for approval workflow.
     * If provided, wires in bsky-send-* button and modal routing.
     */
    bskySetup?: BskySetupResult

    /**
     * Optional allowlist command handler for the /allowlist slash command.
     * If provided, handles /allowlist interactions for both email and Bluesky allowlists.
     */
    allowlistHandler?: AllowlistCommandHandler

    /**
     * Optional calendar command handler for the /calendar slash command.
     * If provided, handles /calendar interactions for CalDAV calendar management.
     */
    calendarHandler?: CalendarCommandHandler

    /**
     * Optional contact command handler for the /contact slash command.
     * If provided, handles /contact interactions for contact management.
     */
    contactHandler?: ContactCommandHandler

    /**
     * Optional contact approval handler for Izzy-requested contact changes.
     */
    contactApprovalHandler?: ContactApprovalHandler

    /**
     * Optional activity logger for recording lifecycle events (email, bsky, perch, catch-up, Discord exchanges).
     */
    activityLogger?: ActivityLogger

    /**
     * Optional person history coordinator for cross-platform conversation history injection.
     */
    historyCoordinator?: PersonHistoryCoordinator
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
    const { config, identityContext, agent, client: providedClient, inboxManager, memoryBackend, botStateManager: providedBotStateManager, channelRegistry, eventDeltaTracker, contextBuilder, emailSetup, bskySetup, allowlistHandler, calendarHandler, contactHandler, contactApprovalHandler, activityLogger, historyCoordinator } = options;

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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: client.rest typed as non-nullable but checking defensively
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
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, complexity, sonarjs/cognitive-complexity -- clientReady handler must be async; complexity is inherent — it orchestrates presence, coordinator, perch, catch-up, inbox, and email lifecycle in sequence
    client.once('clientReady', async (readyClient: Client): Promise<void> => {
        // Log that the bot is ready (preserving functionality from removed logging handler)
        createReadyHandler()(readyClient);
        // At this point, readyClient.user is guaranteed to be non-null
        // because the 'clientReady' event only fires after successful authentication

        // Track last session ID for task context
        let lastSessionId: string | undefined;
        const setLastSessionId = (sessionId: string | undefined): void => {
            if(sessionId) {
                lastSessionId = sessionId;
            }
        };
        const getLastSessionId = (): string | undefined => lastSessionId;

        // Track recent messages (user + bot) for context-aware idle status generation
        interface RecentMessage { author: 'user' | 'izzy', content: string, timestamp: number }
        const MAX_RECENT_MESSAGES = 10; // Increased from 5 since we track both sides
        const recentMessages: RecentMessage[] = [];

        const addRecentMessage = (content: string, author: 'user' | 'izzy' = 'user'): void => {
            recentMessages.push({ author, content: content.slice(0, 200), timestamp: Date.now() });
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

        // Create task list reader for idle status context
        const taskListReader = createTaskListReader({
            getCurrentSessionId: getLastSessionId,
            logger,
        });

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

        // Register interaction handler for button clicks and slash commands
        // eslint-disable-next-line @typescript-eslint/no-misused-promises, complexity, sonarjs/cognitive-complexity -- interactionCreate handler is async; branching is inherent — routes buttons, modals, selects, and slash commands
        client.on('interactionCreate', async (interaction) => {
            if(interaction.isButton()) {
                // Route bsky-send-* and bsky-dm-* buttons to bsky outbound approval handler
                if(bskySetup && (interaction.customId.startsWith('bsky-send-') || interaction.customId.startsWith('bsky-dm-'))) {
                    await bskySetup.outboundApprovalHandler.handleButton(interaction);
                    return;
                }
                // Route email-send-* buttons to outbound approval handler (before email-* catch-all)
                if(emailSetup && interaction.customId.startsWith('email-send-')) {
                    await emailSetup.outboundApprovalHandler.handleButton(interaction);
                    return;
                }
                // Route email-* buttons to review handler
                if(emailSetup && interaction.customId.startsWith('email-')) {
                    await emailSetup.reviewHandler.handleButton(interaction);
                    return;
                }
                // Route contact-approve-* and contact-reject-* buttons to contact approval handler
                if(contactApprovalHandler && (interaction.customId.startsWith('contact-approve:') || interaction.customId.startsWith('contact-reject:'))) {
                    await contactApprovalHandler.handleButton(interaction);
                    return;
                }
                await interactionHandler.handleButtonInteraction(interaction);
            } else if(interaction.isModalSubmit()) {
                if(bskySetup && (interaction.customId.startsWith('bsky-send-reject-reason:') || interaction.customId.startsWith('bsky-dm-reject-reason:'))) {
                    await bskySetup.outboundApprovalHandler.handleModalSubmit(interaction);
                } else if(emailSetup && interaction.customId.startsWith('email-send-reject-reason:')) {
                    await emailSetup.outboundApprovalHandler.handleModalSubmit(interaction);
                }
            } else if(interaction.isStringSelectMenu() && interaction.customId.startsWith('email-allowlist-select:')) {
                // Stryker disable next-line StringLiteral: error message is not behavior-affecting
                await (emailSetup ? emailSetup.outboundApprovalHandler.handleSelectMenu(interaction) : interaction.reply({ content: 'Email integration is not currently available.', flags: MessageFlags.Ephemeral }));
            } else if(interaction.isChatInputCommand() && interaction.commandName === 'allowlist') {
                // Stryker disable next-line StringLiteral: error message is not behavior-affecting
                await (allowlistHandler ? allowlistHandler.handle(interaction) : interaction.reply({ content: 'Allowlist management is not currently available.', flags: MessageFlags.Ephemeral }));
            } else if(interaction.isChatInputCommand() && interaction.commandName === 'calendar') {
                // Stryker disable next-line StringLiteral: error message is not behavior-affecting
                await (calendarHandler ? calendarHandler.handle(interaction) : interaction.reply({ content: 'Calendar management is not currently available.', flags: MessageFlags.Ephemeral }));
            } else if(interaction.isChatInputCommand() && interaction.commandName === 'contact') {
                // Stryker disable next-line StringLiteral: error message is not behavior-affecting
                await (contactHandler ? contactHandler.handle(interaction) : interaction.reply({ content: 'Contact management is not currently available.', flags: MessageFlags.Ephemeral }));
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
                getTaskContext:   () => taskListReader.buildTaskListSummary(),
                getRecentContext: async () => {
                    if(recentMessages.length === 0) {
                        return undefined;
                    }
                    const sortedMessages = recentMessages.toSorted((a, b) => a.timestamp - b.timestamp);
                    return sortedMessages.map(m => (m.author === 'user' ? `User: ${m.content}` : `Izzy: ${m.content}`)).join('\n');
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
                setLastSessionId,
                addRecentMessage,
                activityLogger,
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
                setLastSessionId,
                addRecentMessage,
                activityLogger,
            });
            perchSessionRunner = perchSetup.runner;
            perchScheduler = perchSetup.scheduler;
        }

        // Initialize channel registry BEFORE setting up message handlers
        // Pass rateLimiter for error notification (may be undefined if not created yet)
        await initializeChannelRegistry(readyClient, channelRegistry, responseRouter, rateLimiter);

        // Mute admin email channel so Craig's messages there don't reach Izzy
        if(emailSetup?.adminChannelId) {
            // Stryker disable BlockStatement: try-catch wraps admin channel mute - non-fatal startup step
            try {
                await channelRegistry.muteChannel(emailSetup.adminChannelId);
                // Stryker disable next-line ObjectLiteral,StringLiteral: log message is not behavior-affecting
                logger.info({ msg: 'Admin email channel muted in channel registry' });
            } catch (err) {
                logger.warn({
                    error: err instanceof Error ? err.message : String(err),
                    // Stryker disable next-line StringLiteral: log message is not behavior-affecting
                    msg:   'Failed to mute admin email channel — messages there may reach Izzy',
                });
            }
            // Stryker restore BlockStatement
        }

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
                rateLimiter,
                readyClient,
                channelRegistry,
                eventDeltaTracker,
                onThinkingContentUpdate: setLastThinkingContent,
                setLastSessionId,
                addRecentMessage,
                activityLogger,
                historyCoordinator,
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

        // Start email listener if email setup is provided
        if(emailSetup) {
            // Stryker disable BlockStatement: try-catch wraps email listener start - error handling
            try {
                await emailSetup.listener.start();
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.info({ msg: 'Email listener started' });
            } catch (err) {
                logger.error({
                    error: err instanceof Error ? err.message : String(err),
                    msg:   'Failed to start email listener',
                });
                // Continue — email failure is non-fatal
            }
            // Stryker restore BlockStatement
        }
    });

    return {
        async start(): Promise<void> {
            // Login errors propagate to caller (as per user decision)
            await client.login(config.botToken);
        },

        // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- shutdown sequencing has inherent branching for each optional component
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
            // Stop email listener if it exists
            if(emailSetup) {
                // Stryker disable BlockStatement: try-catch isolates email stop from Discord cleanup
                try {
                    await emailSetup.listener.stop();
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        // Stryker disable next-line StringLiteral: log message is not behavior-affecting
                        msg:   'Email listener stop failed during shutdown',
                    });
                }
                // Stryker restore BlockStatement
                // Stryker disable BlockStatement: try-catch isolates WildDuck shutdown from Discord cleanup
                try {
                    await emailSetup.wildDuckClient.shutdown();
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        // Stryker disable next-line StringLiteral: log message is not behavior-affecting
                        msg:   'WildDuck client shutdown failed during email teardown',
                    });
                }
                // Stryker restore BlockStatement
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
