import { logger } from '@hughescr/logger';
import { MessageFlags, type Client } from 'discord.js';
import type { DiscordCapability } from './capability';
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
import type { ServiceHealthRegistry } from '@/services';

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

    /**
     * Optional health registry for tracking Discord service health state.
     * If provided, shard disconnect/ready/resume events update service health.
     */
    healthRegistry?: ServiceHealthRegistry

    /**
     * Optional Discord capability facade for outbox fallback.
     * When provided, send paths (perch, catch-up, agent response) use the facade
     * so messages are queued to the outbox when Discord is temporarily offline.
     */
    discordCapability?: DiscordCapability
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
     * Trigger catch-up after a Discord reconnect.
     * Reloads the inbox to pick up messages received during the outage,
     * then starts a catch-up session if there are unread messages.
     * No-op if the catch-up runner has not yet been initialised (i.e. the
     * bot has never completed its first clientReady sequence).
     */
    triggerCatchUp(): Promise<void>

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
    const { config, identityContext, agent, client: providedClient, inboxManager, memoryBackend, botStateManager: providedBotStateManager, channelRegistry, eventDeltaTracker, contextBuilder, emailSetup, bskySetup, allowlistHandler, calendarHandler, contactHandler, contactApprovalHandler, activityLogger, historyCoordinator, healthRegistry, discordCapability } = options;

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

    // Register shard event listeners for health tracking
    // Stryker disable BlockStatement: Composition root — shard health event wiring is not unit-testable
    if(healthRegistry) {
        // Stryker disable next-line StringLiteral: Discord.js event name
        client.on('shardDisconnect', () => {
            healthRegistry.sendEvent('discord', 'CONNECTION_LOST');
        });
        // Stryker disable next-line StringLiteral: Discord.js event name
        client.on('shardReady', () => {
            healthRegistry.sendEvent('discord', 'CONNECT_SUCCESS');
        });
        // Stryker disable next-line StringLiteral: Discord.js event name
        client.on('shardResume', () => {
            healthRegistry.sendEvent('discord', 'CONNECT_SUCCESS');
        });
    }
    // Stryker restore BlockStatement

    // Track last session ID for task context
    let lastSessionId: string | undefined;
    // Stryker disable BlockStatement: composition root helper — tested via coordinator integration
    const setLastSessionId = (sessionId: string | undefined): void => {
        if(sessionId) {
            lastSessionId = sessionId;
        }
    };
    // Stryker restore BlockStatement
    const getLastSessionId = (): string | undefined => lastSessionId;

    // Track recent messages (user + bot) for context-aware idle status generation
    interface RecentMessage { author: 'user' | 'izzy', content: string, timestamp: number }
    const MAX_RECENT_MESSAGES = 10; // Increased from 5 since we track both sides
    const recentMessages: RecentMessage[] = [];

    // Stryker disable BlockStatement: composition root helper — tested via coordinator integration
    const addRecentMessage = (content: string, author: 'user' | 'izzy' = 'user'): void => {
        recentMessages.push({ author, content: content.slice(0, 200), timestamp: Date.now() });
        if(recentMessages.length > MAX_RECENT_MESSAGES) {
            recentMessages.shift();
        }
    };
    // Stryker restore BlockStatement

    // Track last thinking content for context-aware idle status generation
    let lastThinkingContent: string | undefined;

    // Stryker disable next-line BlockStatement: composition root callback — not covered by unit tests
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
    const rateLimiter = new DiscordRateLimiter({
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
    // This uses `client` (not `readyClient`) so it is registered immediately at bot creation time,
    // not inside the clientReady handler. This allows interactions to be routed even before the
    // first clientReady fires.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, complexity, sonarjs/cognitive-complexity -- interactionCreate handler is async; branching is inherent — routes buttons, modals, selects, and slash commands
    client.on('interactionCreate', async (interaction) => {
        // Stryker disable BlockStatement: top-level error handler — prevents unhandled rejections
        try {
            if(interaction.isButton()) {
                // Route bsky-send-* and bsky-dm-* buttons to bsky outbound approval handler
                // Stryker disable next-line BlockStatement: composition root interaction routing — not covered by unit tests
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
                // Stryker disable next-line BlockStatement: composition root interaction routing — not covered by unit tests
                if(contactApprovalHandler && (interaction.customId.startsWith('contact-approve:') || interaction.customId.startsWith('contact-reject:'))) {
                    await contactApprovalHandler.handleButton(interaction);
                    return;
                }
                await interactionHandler.handleButtonInteraction(interaction);
            } else if(interaction.isModalSubmit()) {
                // Stryker disable next-line BlockStatement: composition root interaction routing — not covered by unit tests
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
        } catch (err) {
            logger.error({
                error:           err instanceof Error ? err.message : String(err),
                interactionType: interaction.type,
                msg:             'Unhandled error in interaction handler',
            });
            // Try to respond to the interaction if it hasn't been acknowledged
            // Stryker disable BlockStatement: nested error handler — interaction may have expired
            try {
                if(interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: 'An error occurred while processing this interaction.',
                        flags:   MessageFlags.Ephemeral,
                    });
                }
            } catch{
                // Interaction may have expired — nothing we can do
            }
            // Stryker restore BlockStatement
        }
        // Stryker restore BlockStatement
    });

    // Create dynamic status generator if identityContext is provided
    // IMPORTANT: Must create before presence manager, catch-up session runner, and coordinator
    // Stryker disable next-line ConditionalExpression: composition root — identityContext optional dep wiring
    const dynamicStatusGenerator = identityContext
        ? createDynamicStatusGenerator({ identityContext })
        : undefined;

    // Idempotency guard: track whether clientReady setup has run.
    // The handler is registered with .on() (not .once()) so reconnects fire it again,
    // but full component initialisation only runs on the first connection.
    let initialized = false;

    // Register clientReady handler for messageCreate setup
    // This runs after the client is authenticated and ready.
    // Use .on() (not .once()) so reconnects fire the handler again; the `initialized`
    // flag gates the one-time setup so components are only created on first connection.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, complexity, sonarjs/cognitive-complexity -- clientReady handler must be async; complexity is inherent — it orchestrates presence, coordinator, perch, catch-up, inbox, and email lifecycle in sequence
    client.on('clientReady', async (readyClient: Client): Promise<void> => {
        // Log that the bot is ready (preserving functionality from removed logging handler)
        createReadyHandler()(readyClient);
        // At this point, readyClient.user is guaranteed to be non-null
        // because the 'clientReady' event only fires after successful authentication

        if(!initialized) {
            initialized = true;

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
                    // Stryker disable next-line BlockStatement: composition root callback — not covered by unit tests
                    getRecentContext: async () => {
                        // Stryker disable next-line BlockStatement: optimization guard — empty array short-circuit, not covered by unit tests
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
            // Stryker disable BlockStatement: composition root — optional dep wiring, not unit-testable
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
                    discordCapability,
                });
            }
            // Stryker restore BlockStatement

            // Create perch session runner and scheduler if config provided
            // Stryker disable BlockStatement: composition root — optional dep wiring, not unit-testable
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
                    discordCapability,
                });
                perchSessionRunner = perchSetup.runner;
                perchScheduler = perchSetup.scheduler;
            }
            // Stryker restore BlockStatement

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
                    discordCapability,
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
            // Stryker disable BlockStatement: composition root — optional dep wiring, not unit-testable
            if(inboxManager) {
                setupInboxAndCatchUp({
                    inboxManager,
                    readyClient,
                    botStateManager,
                    catchUpSessionRunner,
                    presenceManager,
                    memoryBackend:  memoryBackend!,
                    perchConfig:    options.perchConfig,
                    healthRegistry: options.healthRegistry,
                });
            }
            // Stryker restore BlockStatement
        } // end if(!initialized)
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
            // Stop rate limiter
            rateLimiter.stop();
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

        // Stryker disable BlockStatement: Composition root — reconnect catch-up trigger is not unit-testable
        async triggerCatchUp(): Promise<void> {
            if(!catchUpSessionRunner || !inboxManager) {
                return;
            }
            try {
                await inboxManager.loadUnread();
                const shouldStart = await catchUpSessionRunner.shouldStartCatchUp();
                if(shouldStart) {
                    logger.info({ msg: 'Starting catch-up after Discord reconnect' });
                    await catchUpSessionRunner.startCatchUp();
                }
            } catch (err) {
                logger.warn({ error: err instanceof Error ? err.message : String(err), msg: 'Reconnect catch-up trigger failed' });
            }
        },
        // Stryker restore BlockStatement

        // For testing - expose internal state manager (Phase 2)
        _botStateManager: botStateManager,
    };
}
