import { logger } from '@hughescr/logger';
import { MessageFlags, type Client, type Message } from 'discord.js';
import type { AllowlistCommandHandler } from './allowlist-commands';
import type { AllowlistInteractionHandler } from './allowlist-interaction-handler';
import type { DiscordCapability } from './capability';
import {
    type CatchUpSessionRunner,
    type CatchUpCompletionSignal,
    type CatchUpInProgressSignal
} from './catchup';
import { DMTracker, ResponseRouter, type ChannelRegistryManager } from './channel-registry';
import { createDiscordClient } from './client';
import type { ContactCommandHandler, ContactApprovalHandler } from './contact-commands';
import { createReadyHandler, createErrorHandler, dispatchAdmittedMessage, type PerchRoutingDeps } from './handlers';
import type { InboxManager } from './inbox';
import { createIngressGate, type IngressGate } from './ingress-gate';
import { createInteractionHandler } from './interactions';
import type { MessageCoordinator } from './message-coordinator';
import {
    createDynamicStatusGenerator,
    createPresenceThrottle,
    type PresenceManager
} from './presence';
import { DiscordRateLimiter } from './rate-limiter';
import type { BskySetupResult } from './setup/bsky-setup';
import { setupCatchUpSessionRunner, setupInboxAndCatchUp, submitConductorCatchUp } from './setup/catchup-setup';
import type { DiscordEnvelopeProvider } from './setup/conductor-processor';
import { setupCoordinatorIntegration } from './setup/coordinator-setup';
import { channelListProvider, resolveNames as resolveEnvelopeNames, toEnvelopeInput } from './setup/discord-envelope-provider';
import type { EmailSetupResult } from './setup/email-setup';
import { setupMessageProcessing, initializeChannelRegistry, setupChannelCleanupHandlers } from './setup/event-handler-setup';
import { setupPerchDriverAndScheduler, setupPerchSessionRunnerAndScheduler } from './setup/perch-setup';
import { setupConductorPresence, setupPresence, type PresenceSetupResult } from './setup/presence-setup';
import {
    BotStateManagerImpl,
    type BotStateManager
} from './state';
import { installLedgerShim } from './state/ledger-shim';
import { createChannelId, createUserId, type ChannelId } from './types';
import { QuestionRegistry, AnswerClassifier, classifyWithHaiku, createTaskListReader, LiveSignals, systemClock, createShutdown, type IdentityCache, type PerchDriver, type PerchScheduler, type PerchSessionRunner, type PerchConfig, type ClaudeAgent, type ContextBuilder, type EventDeltaTracker, type ActivityLogger, type PersonHistoryCoordinator, type RecentTool, type RecentChannel, type Conductor, type LedgerStore, type ContextPolicy, type DeliveryGuard, type SessionJournal, type Clock, type Shutdown, type ShutdownSession, type NotifyFn  } from '@/agent';
import type { DiscordConfig } from '@/config';
import type { CalendarCommandHandler } from '@/integrations/caldav';
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

/** Rolling window for activity-log signals fed to LiveSignals (2 hours in ms). */
// Stryker disable next-line ArithmeticOperator: window duration constant — mutation would change the window size, not the logic
const ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Bound on how long `conversationConductor.open()` may take in `clientReady` before it is
 * treated as failed. `open()` only rejects on an explicit session-closed error — a wedged CLI
 * child (hung auth prompt, stalled network, never emitting an init frame) leaves it pending
 * forever, and `initialized` is already set to `true` earlier in `clientReady`, so nothing would
 * ever retry the rest of setup (`setupCoordinatorIntegration`, message-handler registration,
 * catch-up/perch) on a plain rejection-only guard. Racing against this timeout turns a hang into
 * the same degrade-to-legacy-processor path a rejection already takes.
 */
const CONDUCTOR_OPEN_TIMEOUT_MS = 30_000;

/** Resolves with `result` from `promise`, or rejects with a timeout error after `ms` — whichever comes first. Does not cancel `promise` itself; a late resolution after the timeout is simply ignored. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(message));
        }, ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
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
     * Claude agent instance for message processing.
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
     * Optional allowlist interaction handler for the saga-based allowlist flow.
     * If provided, handles allowlist-* button and modal interactions (modal submission, yes/next/create buttons).
     */
    allowlistInteractionHandler?: AllowlistInteractionHandler

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

    /**
     * Optional Q3/B4 daily cost ceiling predicate. Forwarded only into the conductor-mode perch
     * setup path (`setupPerchDriverAndScheduler`) — the legacy oneshot session runner+scheduler
     * path is left untouched, unchanged.
     */
    isCostPaused?: () => boolean

    /**
     * Optional Q5/B1 shared notification bridge `notify` function (see
     * `agent/session/notification-bridge.ts`). A safe no-op until the composition root
     * (`src/index.ts`) attaches the real conductor to the bridge. Not yet consumed inside this
     * file — Q6-Q8 land the notification sources that will call it; this field only threads the
     * seam through the composition root.
     */
    notify?: NotifyFn

    /**
     * Optional write-through identity cache.
     * When provided, idle status generation uses the cache instead of the inline
     * TTL-based loader.  Invalidate this cache from the memory-tool write path
     * whenever an identity-layer write commits.
     */
    identityCache?: IdentityCache

    /**
     * P9: the long-lived conversation conductor, BUILT but not yet OPENED (see
     * `src/app/sessions.ts`'s own doc). `clientReady` opens it, after `initializeChannelRegistry`
     * and before `setupCoordinatorIntegration`, under the existing idempotency guard; if `open()`
     * rejects the error is logged and the process degrades to the legacy `agent` processor above
     * without a restart — every one of these five fields is then simply never used.
     */
    conversationConductor?: Conductor
    /** The conductor's own ledger — `installLedgerShim` subscribes to it, and `lastSessionId` is seeded from `ledgerStore.get().sessionId` after a successful `open()`. */
    ledgerStore?:           LedgerStore
    contextPolicy?:         ContextPolicy
    deliveryGuard?:         DeliveryGuard
    journal?:               SessionJournal
    /**
     * P12: the perch conductor, BUILT but not yet OPENED (`src/app/sessions.ts`'s
     * `createPerchConductor`), mirroring `conversationConductor`'s own contract exactly.
     * `clientReady` opens it AFTER the conversation conductor; a rejected (or omitted) `open()`
     * degrades perch to the legacy `PerchSessionRunner`/scheduler without a restart — the
     * mode machine and the (conversation) coordinator are never touched by the perch conductor.
     */
    perchConductor?:        Conductor
    /** The perch conductor's own ledger — folded into the presence composer's `ledgers` array alongside `ledgerStore` (design doc section 8) whenever it is present, whether or not `perchConductor.open()` itself succeeded (an untouched ledger simply composes as idle). */
    perchLedgerStore?:      LedgerStore
    /** The perch conductor's own role-keyed journal — required, alongside `perchLedgerStore`, before `perchConductor.open()` is attempted. */
    perchJournal?:          SessionJournal
    /**
     * P10: forwarded verbatim to `conversationConductor.shutdown` via `createShutdown` — see
     * `config.session.shutdownTurnWaitMs`/`shutdownDeadlineMs`. Defaults match the config
     * schema's own defaults (60s/120s) so a test or caller that omits them still gets a sane
     * bound rather than an unbounded wait.
     */
    shutdownTurnWaitMs?:    number
    shutdownDeadlineMs?:    number
    /** Injected for shutdown's own timer — defaults to the real wall clock. */
    clock?:                 Clock
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
     * P10: the cross-session shutdown orchestrator built for conductor mode (`createShutdown`),
     * exposed so a caller (the signal handlers in `src/app/lifecycle.ts`) can run it directly
     * without going through the full `stop()` teardown when only the conductor's own bounded
     * wait/interrupt/flush/close sequence is wanted. `undefined` in oneshot mode, or before the
     * conductor has opened.
     */
    shutdown?: Shutdown

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
    const { config, identityContext, agent, client: providedClient, inboxManager, memoryBackend, botStateManager: providedBotStateManager, channelRegistry, eventDeltaTracker, contextBuilder, emailSetup, bskySetup, allowlistHandler, allowlistInteractionHandler, calendarHandler, contactHandler, contactApprovalHandler, activityLogger, historyCoordinator, healthRegistry, discordCapability, identityCache, conversationConductor, ledgerStore, contextPolicy, deliveryGuard, journal, perchConductor, perchLedgerStore, perchJournal, shutdownTurnWaitMs, shutdownDeadlineMs, clock: providedClock } = options;
    const clock: Clock = providedClock ?? systemClock;

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
    // P12: true once perchConductor.open() has succeeded this process — gates whether the perch
    // section below wires the conductor-mode driver (setupPerchDriverAndScheduler) or falls back
    // to the legacy PerchSessionRunner/scheduler. Stays false if perchConductor was never
    // provided, or if its open() rejected — the fallback runner then owns perch exactly as today.
    let perchConductorOpened = false;
    let perchDriver: PerchDriver | undefined;
    // Use provided registry or create a new one
    const questionRegistry: QuestionRegistry = options.questionRegistry ?? new QuestionRegistry();

    // Capture unsubscribe functions for cleanup
    let unsubscribeModeTransition: (() => void) | undefined;
    let unsubscribeActivityPhase: (() => void) | undefined;
    // P11: torn down instead of the two above when presence is composed from ledgers.
    let unsubscribeLedgerPresence: (() => void) | undefined;
    // P11: the ONE process-wide throttle shared by presence-setup's conductor branch and the
    // ledger-sink stream handler wired per turn by conductor-processor.ts (design doc section 8:
    // "at most one non-idle presence update per 12s"). Built once, only in conductor mode.
    const presenceThrottle = ledgerStore
        ? createPresenceThrottle(config.presence?.updateThrottleMs, () => Date.now())
        : undefined;

    // P9: true once conversationConductor.open() has succeeded this process — gates whether
    // setupCoordinatorIntegration/setupMessageProcessing take the conductor branch, and whether
    // stop() has a shim/conductor to tear down. Stays false (legacy path) if conductorConductor
    // was never provided, or if open() rejected.
    let conductorOpened = false;
    let unsubscribeLedgerShim: (() => void) | undefined;
    // P10: the ingress gate (buffers live messages during boot), the cross-session shutdown
    // orchestrator, and a captured reference to clientReady's own `responseRouter` (needed by
    // `triggerCatchUp`'s conductor-mode branch, which runs outside clientReady's own scope) —
    // all built once, inside the same conductor-open block as `conductorOpened = true` below,
    // and all `undefined` in oneshot mode or before the conductor has opened.
    let ingressGate: IngressGate<Message> | undefined;
    let shutdownRef: Shutdown | undefined;
    let responseRouterRef: ResponseRouter | undefined;

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

    // Recent-tools ring buffer for LiveSignals aggregator
    const MAX_RECENT_TOOLS = 10;
    const recentTools: RecentTool[] = [];
    // Stryker disable BlockStatement: composition root helper — tested via ring-buffer unit tests
    const addRecentTool = (toolName: string): void => {
        recentTools.push({ toolName, timestamp: Date.now() });
        if(recentTools.length > MAX_RECENT_TOOLS) {
            recentTools.shift();
        }
    };
    // Stryker restore BlockStatement
    const getRecentTools = (): readonly RecentTool[] => recentTools;

    // Recent-channels ring buffer for LiveSignals aggregator
    const MAX_RECENT_CHANNELS = 10;
    const recentChannels: RecentChannel[] = [];
    // Stryker disable BlockStatement: composition root helper — tested via ring-buffer unit tests
    const addRecentChannel = (channelId: RecentChannel['channelId']): void => {
        recentChannels.push({ channelId, timestamp: Date.now() });
        if(recentChannels.length > MAX_RECENT_CHANNELS) {
            recentChannels.shift();
        }
    };
    // Stryker restore BlockStatement
    const getRecentChannels = (): readonly RecentChannel[] => recentChannels;

    // Previous idle status holder — populated by Step 3; read by LiveSignals
    let lastIdleText: string | undefined;
    const getPreviousStatus = (): string | undefined => lastIdleText;
    // Stryker disable next-line BlockStatement: composition root setter — populated in Step 3
    const setPreviousStatus = (text: string): void => {
        lastIdleText = text;
    };

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
                // Route contact-approve:*, contact-reject:*, contact-delete-confirm:*, and contact-delete-cancel:* buttons to contact approval handler
                // Stryker disable next-line BlockStatement: composition root interaction routing — not covered by unit tests
                if(contactApprovalHandler && (interaction.customId.startsWith('contact-approve:') || interaction.customId.startsWith('contact-reject:') || interaction.customId.startsWith('contact-delete-confirm:') || interaction.customId.startsWith('contact-delete-cancel:'))) {
                    await contactApprovalHandler.handleButton(interaction);
                    return;
                }
                // Route allowlist-* buttons (yes/next/create/startmodal) to allowlist interaction handler
                // Stryker disable next-line BlockStatement: composition root interaction routing — not covered by unit tests
                if(allowlistInteractionHandler && interaction.customId.startsWith('allowlist-')) {
                    await allowlistInteractionHandler.handleButton(interaction);
                    return;
                }
                await interactionHandler.handleButtonInteraction(interaction);
            } else if(interaction.isModalSubmit()) {
                // Stryker disable next-line BlockStatement: composition root interaction routing — not covered by unit tests
                if(bskySetup && (interaction.customId.startsWith('bsky-send-reject-reason:') || interaction.customId.startsWith('bsky-dm-reject-reason:'))) {
                    await bskySetup.outboundApprovalHandler.handleModalSubmit(interaction);
                } else if(emailSetup && interaction.customId.startsWith('email-send-reject-reason:')) {
                    await emailSetup.outboundApprovalHandler.handleModalSubmit(interaction);
                } else if(allowlistInteractionHandler && interaction.customId.startsWith('allowlist-name:')) {
                    // Stryker disable next-line BlockStatement: composition root interaction routing — not covered by unit tests
                    await allowlistInteractionHandler.handleModalSubmit(interaction);
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
                // Silent: interaction.reply() throws if the interaction expired (3-second
                // acknowledgement window) or the bot already replied. The outer catch above
                // already logged the original error; failing to send the fallback ephemeral
                // reply is not a new error worth logging separately.
            }
            // Stryker restore BlockStatement
        }
        // Stryker restore BlockStatement
    });

    // P11: in conductor mode, the ring buffers are fed from the session ledger(s) instead of
    // BotStateManager — ledger-shim.ts no longer forwards activity phases at all, so the
    // botStateManager-based subscriptions below would silently starve the moment a Discord turn
    // migrates to the conductor. P12: the perch conductor's own ledger (`perchLedgerStore`) folds
    // in here whenever it is present — replacing the throwaway legacy-perch-ledger adapter this
    // package deletes — regardless of whether `perchConductor.open()` itself later succeeds (an
    // untouched ledger simply never emits, contributing nothing rather than something wrong).
    function buildConductorLedgers(): readonly LedgerStore[] | undefined {
        if(!ledgerStore) {
            return undefined;
        }
        return perchLedgerStore ? [ledgerStore, perchLedgerStore] : [ledgerStore];
    }
    const conductorLedgers: readonly LedgerStore[] | undefined = buildConductorLedgers();
    // Stryker disable BlockStatement: Composition root — ring-buffer subscriptions are integration-wiring, not unit-testable
    let unsubscribeToolTracking: () => void;
    let unsubscribeChannelTracking: () => void;
    if(conductorLedgers) {
        const ledgers = conductorLedgers;
        const lastToolNameByLedger = new Map<LedgerStore, string | undefined>();
        const lastTurnIdByLedger = new Map<LedgerStore, string | undefined>();
        const unsubscribes = ledgers.map(store => store.subscribe((ledger) => {
            const { turn } = ledger;
            if(turn?.phase?.type === 'using_tool' && turn.phase.toolName !== lastToolNameByLedger.get(store)) {
                lastToolNameByLedger.set(store, turn.phase.toolName);
                addRecentTool(turn.phase.toolName);
            } else if(turn?.phase?.type !== 'using_tool') {
                lastToolNameByLedger.set(store, undefined);
            }
            if(turn?.kind === 'discord' && turn.channelId !== undefined && turn.id !== lastTurnIdByLedger.get(store)) {
                lastTurnIdByLedger.set(store, turn.id);
                addRecentChannel(createChannelId(turn.channelId));
            }
        }));
        const unsubscribeAll = (): void => {
            for(const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        };
        unsubscribeToolTracking = unsubscribeAll;
        unsubscribeChannelTracking = unsubscribeAll;
    } else {
        // Subscribe to botStateManager for recent-tools ring buffer
        unsubscribeToolTracking = botStateManager.subscribe((change) => {
            if(change.changeType === 'activity_phase') {
                const phase = change.newState.activityPhase;
                if(phase?.type === 'using_tool') {
                    addRecentTool(phase.toolName);
                }
            }
        });

        // Subscribe to botStateManager for recent-channels ring buffer
        // Records the channel whenever the bot transitions into processing_message mode
        unsubscribeChannelTracking = botStateManager.subscribe((change) => {
            if(change.changeType === 'mode_transition' && change.newState.mode === 'processing_message') {
                const ctx = change.newState.modeContext as { channelId?: RecentChannel['channelId'] };
                if(ctx.channelId) {
                    addRecentChannel(ctx.channelId);
                }
            }
        });
    }
    // Stryker restore BlockStatement

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

            // Construct LiveSignals aggregator (requires readyClient for channel name resolution)
            // Stryker disable BlockStatement: composition root — LiveSignals construction is integration-wiring
            const liveSignals = options.perchConfig
                ? new LiveSignals({
                    timezone:           options.perchConfig.timezone,
                    getRecentTools,
                    getRecentChannels,
                    // Stryker disable next-line ConditionalExpression,BlockStatement: channel name resolution — cache miss path is a valid runtime state
                    resolveChannelName: (id) => {
                        const ch = readyClient.channels.cache.get(id);
                        return ch && 'name' in ch ? (ch as { name: string }).name : undefined;
                    },
                    getPreviousStatus,
                    // Step 4: network-fetched signals
                    bskyClient:            bskySetup?.client,
                    idleSignalsConfig:     config.presence?.idleSignals,
                    // Stryker disable next-line BlockStatement: composition root callback — contextBuilder is optional
                    loadRecentActivityLog: contextBuilder
                        ? (limit: number) => contextBuilder.loadRecentEventsSince(ACTIVITY_WINDOW_MS, limit)
                        : undefined,
                })
                : undefined;
            // Stryker restore BlockStatement

            // P11 fix: presence construction moved below the conductor-open block (still before
            // setupCoordinatorIntegration/setupMessageProcessing, which is all "before
            // coordinator.setProcessor" ever required) so it can gate on `conductorOpened` —
            // whether open() actually SUCCEEDED — rather than on `ledgerStore`'s mere existence,
            // which only means conductor mode was REQUESTED. Gating on `ledgerStore` left presence
            // frozen on the boot-time idle status for the process lifetime whenever open() rejected
            // or timed out (the degrade-to-oneshot path below), since the ledger it was composing
            // from would then never receive another event. See `presenceSetup`/`catchUpSessionRunner`/
            // `perchSessionRunner` construction after the conductor-open block.
            let presenceSetup: PresenceSetupResult | undefined;

            // Create DMTracker and ResponseRouter (after client is ready, BEFORE session runners)
            const dmTracker = new DMTracker(channelRegistry, readyClient);
            const responseRouter = new ResponseRouter({
                manager: channelRegistry,
            });
            // P10: captured for triggerCatchUp's conductor-mode branch, which runs outside
            // clientReady's own scope (see the outer `let responseRouterRef` declaration).
            responseRouterRef = responseRouter;

            // Initialize channel registry BEFORE setting up message handlers.
            // startHydration() fires the reconnection loop asynchronously — do not await.
            // The registry-ready gate in MessageCoordinator drops messages until hydration completes.
            initializeChannelRegistry(readyClient, channelRegistry, responseRouter, rateLimiter, healthRegistry);

            // P12: the perch conductor's own delivery surface for a live perch-channel Discord
            // message — built lazily (read at CALL time, like `onDrain`'s own `coordinator` read
            // below) so it always reflects perchConductorOpened's FINAL value, not whatever it was
            // when the closure was created. `undefined` whenever conversation itself never opened
            // (the ingress-gate/conductor-mode machinery this rides on is anchored to the
            // conversation conductor's own boot flow) or the perch conductor did not.
            function perchRoutingDeps(): PerchRoutingDeps | undefined {
                return conductorOpened && perchConductorOpened && perchConductor
                    ? {
                        conductor: perchConductor, responseRouter, client: readyClient, rateLimiter, discordCapability, contextBuilder,
                    }
                    : undefined;
            }

            // P9: open the long-lived conversation conductor now that the guild cache and
            // channel registry exist, but BEFORE setupCoordinatorIntegration/setupMessageProcessing
            // pick a processor — a rejected open() (or one that never settles at all — see
            // CONDUCTOR_OPEN_TIMEOUT_MS) must degrade to the legacy `agent` processor below
            // without ever having switched either of those over to the conductor branch.
            // Stryker disable all: Composition root — conductor-open wiring is a bot.test.ts behavioural describe block (real timers/promises/callback wiring); a mutant here changes call ORDER or the timeout bound, not a value the unit tests below assert on
            if(conversationConductor && ledgerStore && contextPolicy && deliveryGuard && journal) {
                try {
                    await withTimeout(conversationConductor.open(), CONDUCTOR_OPEN_TIMEOUT_MS, 'conductor.open() timed out');
                    setLastSessionId(ledgerStore.get().sessionId);
                    unsubscribeLedgerShim = installLedgerShim({ ledgerStore, botStateManager, logger });
                    // P10: created here (before setupCoordinatorIntegration/setupMessageProcessing
                    // pick a processor) so both can be handed the SAME gate/shutdown instances.
                    // `onDrain` reads the outer `coordinator` variable at CALL time (gate.open()
                    // only ever runs from the boot sequence, well after setupCoordinatorIntegration
                    // has assigned it below), not at this closure's definition time. P12: routed
                    // through the same `dispatchAdmittedMessage` the live handler uses, so a
                    // perch-channel message buffered during boot is answered by the perch
                    // conductor exactly like a live one, once drained.
                    //
                    // `drainChain` serialises dispatch across a whole drained batch: `gate.open()`
                    // calls `onDrain` synchronously per buffered message in arrival order, but each
                    // call now does async work first (handleModeInterruptions, and — with perch
                    // routing active — a getWellKnownChannel lookup) whose await depth varies per
                    // message (a cache hit resolves sooner than a cache miss). Without this chain,
                    // a later message's dispatch could resolve before an earlier one's, delivering
                    // a boot-buffered burst to the coordinator out of arrival order. Each link
                    // swallows its own error (logged) so one failed dispatch never blocks the rest
                    // of the chain.
                    let drainChain: Promise<void> = Promise.resolve();
                    ingressGate = createIngressGate<Message>({
                        onDrain: (message) => {
                            if(coordinator) {
                                const currentCoordinator = coordinator;
                                drainChain = drainChain
                                    .then(() => dispatchAdmittedMessage(message, createUserId(readyClient.user!.id), currentCoordinator, {
                                        channelRegistry, botStateManager, catchUpSessionRunner, perchSessionRunner, inboxManager, perch: perchRoutingDeps(),
                                    }))
                                    .catch((err: unknown) => {
                                        logger.error({ err, msg: 'dispatchAdmittedMessage failed for a gate-drained message' });
                                    });
                            }
                        },
                    });
                    conductorOpened = true;
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        msg:   'Conductor open() failed — degrading to the legacy oneshot processor without a restart',
                    });
                }
            }

            // P12: open the perch conductor next — independent of whether the conversation
            // conductor above succeeded — mirroring its build-only-then-open contract exactly. A
            // rejected (or omitted) open() degrades perch to the legacy PerchSessionRunner/
            // scheduler below without a restart; the mode machine and the conversation coordinator
            // are never touched by the perch conductor either way.
            if(perchConductor && perchLedgerStore && perchJournal) {
                try {
                    await withTimeout(perchConductor.open(), CONDUCTOR_OPEN_TIMEOUT_MS, 'perch conductor.open() timed out');
                    perchConductorOpened = true;
                } catch (err) {
                    logger.error({
                        error: err instanceof Error ? err.message : String(err),
                        msg:   'Perch conductor open() failed — degrading to the legacy perch scheduler/runner without a restart',
                    });
                }
            }

            // P10/P12: build the cross-session shutdown orchestrator once both open attempts above
            // have settled, covering whichever conductor(s) actually opened under ONE shared
            // turnWaitMs/deadlineMs budget (createShutdown's own `sessions` array already
            // anticipates a second 'perch' entry — see shutdown.ts's own doc).
            if(conductorOpened || perchConductorOpened) {
                const sessions: ShutdownSession[] = [];
                if(conductorOpened && conversationConductor) {
                    sessions.push({ name: 'conversation', shutdown: opts => conversationConductor.shutdown(opts) });
                }
                if(perchConductorOpened && perchConductor) {
                    sessions.push({ name: 'perch', shutdown: opts => perchConductor.shutdown(opts) });
                }
                shutdownRef = createShutdown({
                    sessions,
                    journal: {
                        flush: async () => {
                            await Promise.allSettled([
                                conductorOpened && journal ? journal.flush() : Promise.resolve(),
                                perchConductorOpened && perchJournal ? perchJournal.flush() : Promise.resolve(),
                            ]);
                        },
                    },
                    stopIngress: () => ingressGate?.stop(),
                    clock,
                    turnWaitMs:  shutdownTurnWaitMs ?? 60_000,
                    deadlineMs:  shutdownDeadlineMs ?? 120_000,
                    logger,
                });
            }
            // Stryker restore all

            // Setup presence manager if optional deps provided.
            // IMPORTANT: Must create before coordinator.setProcessor so it's available in onStreamEvent.
            // P11 fix: gated on `conductorOpened` (open() actually succeeded), not on `ledgerStore`'s
            // mere existence (conductor mode merely REQUESTED) — see the comment left at this
            // block's old position, above, for why.
            if(identityContext && config.presence) {
                // Stryker disable next-line BlockStatement: composition root callback
                const getRecentContext = async (): Promise<string | undefined> => {
                    // Stryker disable next-line BlockStatement: optimization guard — empty array short-circuit, not covered by unit tests
                    if(recentMessages.length === 0) {
                        return undefined;
                    }
                    const sortedMessages = recentMessages.toSorted((a, b) => a.timestamp - b.timestamp);
                    return sortedMessages.map(m => (m.author === 'user' ? `User: ${m.content}` : `Izzy: ${m.content}`)).join('\n');
                };
                const sharedPresenceParams = {
                    identityContext,
                    presenceConfig: config.presence,
                    readyClient,
                    dynamicStatusGenerator,
                    getTaskContext: () => taskListReader.buildTaskListSummary(),
                    getRecentContext,
                    contextBuilder,
                    getLastThinkingContent,
                    identityCache,
                    getLiveSignals: liveSignals ? () => liveSignals.snapshot() : undefined,
                    getPreviousStatus,
                    setPreviousStatus,
                };
                // P11/P12: in conductor mode, presence composes from the session ledger(s) —
                // conversation always, perch too whenever its ledger exists — instead of bridging
                // BotStateManager (design doc section 8); see setupConductorPresence's own doc for
                // exactly what it deliberately omits versus the oneshot bridge below.
                if(conductorOpened && presenceThrottle && ledgerStore) {
                    const conductorPresence = setupConductorPresence({
                        ...sharedPresenceParams,
                        // Stryker disable next-line ArrayDeclaration: equivalent — buildConductorLedgers() (above) returns undefined iff `!ledgerStore`, and this `if` already requires `ledgerStore` truthy, so `conductorLedgers` can never be undefined here; the `?? [ledgerStore]` exists only to satisfy TypeScript's narrowing, not to handle a reachable branch.
                        ledgers:      conductorLedgers ?? [ledgerStore],
                        throttle:     presenceThrottle,
                        // Keeps the DEGRADED-FALLBACK legacy perch runner's own presence throttle
                        // clock ticking (see setupConductorPresence's own doc) when perchConductor
                        // was omitted or its own open() rejected — never subscribed to.
                        botStateManager,
                        // Q3/B4: only forward the predicate when perch is actually enabled — the
                        // `⏸ perch` marker asserts a pause that has a subject; with perch off, no
                        // scheduler was ever going to run, so nothing is paused regardless of what
                        // isCostPaused() reports (finding: the marker rendered even with perch off).
                        isCostPaused: options.perchConfig?.enabled ? options.isCostPaused : undefined,
                    });
                    presenceManager = conductorPresence.presenceManager;
                    unsubscribeLedgerPresence = conductorPresence.unsubscribeLedgers;
                } else {
                    presenceSetup = setupPresence({
                        ...sharedPresenceParams,
                        botStateManager,
                        inboxManager,
                    });
                    presenceManager = presenceSetup.presenceManager;
                    unsubscribeModeTransition = presenceSetup.unsubscribeModeTransition;
                    unsubscribeActivityPhase = presenceSetup.unsubscribeActivityPhase;
                }
            }

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

            // Create the perch driver+scheduler (conductor mode, once perchConductor has
            // successfully opened) or fall back to the legacy session runner+scheduler exactly as
            // before — P12's degrade-without-a-restart contract (see the perch conductor-open
            // block's own doc, above).
            // Stryker disable BlockStatement: composition root — optional dep wiring, not unit-testable
            if(agent && options.perchConfig?.enabled) {
                if(perchConductorOpened && perchConductor) {
                    const perchSetup = setupPerchDriverAndScheduler({
                        conductor:    perchConductor,
                        perchConfig:  options.perchConfig,
                        clock,
                        contextBuilder,
                        activityLogger,
                        channelRegistry,
                        responseRouter,
                        client:       readyClient,
                        rateLimiter,
                        discordCapability,
                        isCostPaused: options.isCostPaused,
                    });
                    perchDriver = perchSetup.driver;
                    perchScheduler = perchSetup.scheduler;
                } else {
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
            }
            // Stryker restore BlockStatement

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
                // P9: once the conductor has opened, its Discord-facing dependencies bind to this
                // readyClient/channelRegistry — built here (not earlier) because both only exist
                // from clientReady onward.
                // Stryker disable next-line ConditionalExpression: bot.ts IS in the mutate glob (see stryker.conf.mjs's mutate array) — this disables only the condition itself; the object it builds is asserted by 'wires envelopeProvider ... once the conductor opens' (conductorOpened true) and 'degrades to the legacy processor without a shim when open() rejects' (conductorOpened false), which assert envelopeProvider is present vs undefined respectively
                const envelopeProvider: DiscordEnvelopeProvider | undefined = conductorOpened
                    ? {
                        resolveNames: resolveEnvelopeNames(channelRegistry, readyClient),
                        toEnvelopeInput,
                        channelList:  channelListProvider(channelRegistry, readyClient),
                    }
                    : undefined;

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
                    addRecentChannel,
                    activityLogger,
                    historyCoordinator,
                    discordCapability,
                    ...(conductorOpened
                        ? {
                            conversationConductor: conversationConductor!,
                            contextPolicy:         contextPolicy!,
                            deliveryGuard:         deliveryGuard!,
                            journal:               journal!,
                            envelopeProvider,
                            contextBuilder,
                            inboxManager,
                            // P11: shared with presence-setup's conductor branch so every turn
                            // overlays synopses onto the SAME ledger/throttle presence composes from.
                            ledgerStore,
                            presenceThrottle,
                        }
                        : {}),
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
                    conductorMode: conductorOpened,
                    ingressGate,
                    perch:         perchRoutingDeps(),
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
                // P12: the well-known perch-time channel's replay is owned by the perch conductor,
                // not the conversation one — excluded from replayUnhandled entirely (documented
                // skip: this package does not route perch-channel replay to the perch conductor,
                // only its LIVE messages — see handlers.ts's own dispatchAdmittedMessage) whenever
                // the perch conductor actually opened. If it did not, conversation's own replay
                // keeps trying that channel exactly as before P12 (the safer fallback).
                //
                // Guarded: a rejection here (the backend read inside getWellKnownChannel is not
                // itself try/caught — see channel-registry/manager.ts) must NOT abort the rest of
                // this async clientReady handler, which has no surrounding try/catch of its own —
                // an unguarded throw here would skip setupInboxAndCatchUp entirely, so the ingress
                // gate would never open and every Discord message would buffer forever. Degrading
                // to "no exclusion" (conversation's replay tries that channel too) is the safe
                // fallback, exactly like the omitted-perchConductor case above.
                let perchTimeChannelId: ChannelId | undefined;
                if(perchConductorOpened) {
                    try {
                        const perchTimeChannel = await channelRegistry.getWellKnownChannel('perch-time');
                        perchTimeChannelId = perchTimeChannel?.channelId;
                    } catch (err) {
                        logger.error({ err, msg: 'Failed to resolve the well-known perch-time channel for replay exclusion — continuing without it' });
                    }
                }

                void setupInboxAndCatchUp({
                    inboxManager,
                    readyClient,
                    botStateManager,
                    catchUpSessionRunner,
                    presenceManager,
                    memoryBackend:  memoryBackend!,
                    perchConfig:    options.perchConfig,
                    healthRegistry: options.healthRegistry,
                    ...(conductorOpened
                        ? {
                            conversationConductor: conversationConductor!,
                            journal:               journal!,
                            responseRouter,
                            rateLimiter,
                            ingressGate:           ingressGate!,
                            discordCapability,
                            excludeChannelIds:     perchTimeChannelId ? new Set([perchTimeChannelId]) : undefined,
                        }
                        : {}),
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

        // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- shutdown coordinates coordinator, conductor, shim, question registry, presence, sessions, and the client in a fixed order; branching is inherent
        async stop(): Promise<void> {
            // Stop coordinator if it exists
            if(coordinator) {
                coordinator.stop();
            }
            // P12: stop the conductor-mode perch driver's own timers (wrap-up/interrupt/pending)
            // and the scheduler BEFORE shutdownRef.run() below waits out the shared turn-wait
            // budget — otherwise an interrupt or wrap-up timer can still fire while shutdown is
            // politely waiting for the very turn it is about to interrupt anyway, re-submitting a
            // fresh slot envelope (onSlotSettled's `pending` resolution) into a conductor that is
            // mid-shutdown and logs a spurious "shutting down" rejection. A no-op when the legacy
            // perchSessionRunner path was used instead (perchDriver/perchScheduler stay undefined).
            if(perchScheduler) {
                perchScheduler.stop();
            }
            if(perchDriver) {
                perchDriver.stop();
            }
            // P10/P12: coordinator.stop() -> perch driver/scheduler stop() -> gate.stop() ->
            // shutdown.run() (the cross-session wait/interrupt/flush/close sequence, covering both
            // conductors under ONE shared config.session.shutdownTurnWaitMs/shutdownDeadlineMs
            // budget — see createShutdown) -> shim unsubscribe, ahead of the legacy runner aborts
            // and botStateManager.stop() below.
            // Stryker disable all: bot.ts IS in the mutate glob (stryker.conf.mjs) — this block is
            // disabled because the shutdown() call ORDER (asserted by bot.test.ts's 'stop order'
            // conductor-mode test) is the behaviour that matters; the catch's error-message
            // formatting is not independently asserted and is accepted as untested
            // composition-root wiring.
            if(shutdownRef) {
                ingressGate?.stop();
                try {
                    await shutdownRef.run();
                } catch (err) {
                    logger.warn({
                        error: err instanceof Error ? err.message : String(err),
                        msg:   'Conductor shutdown() failed — continuing with the rest of stop()',
                    });
                }
            }
            if(unsubscribeLedgerShim) {
                unsubscribeLedgerShim();
                unsubscribeLedgerShim = undefined;
            }
            // Stryker restore all
            // Stop question registry (always exists now)
            questionRegistry.stop();
            // Unsubscribe from botStateManager subscriptions
            if(unsubscribeModeTransition) {
                unsubscribeModeTransition();
            }
            if(unsubscribeActivityPhase) {
                unsubscribeActivityPhase();
            }
            if(unsubscribeLedgerPresence) {
                unsubscribeLedgerPresence();
            }
            unsubscribeToolTracking();
            unsubscribeChannelTracking();
            // Abort sessions FIRST, before stopping botStateManager
            // Session aborts may trigger callbacks that need botStateManager to be alive
            // Abort any running catch-up session
            if(catchUpSessionRunner) {
                const controller = catchUpSessionRunner.getAbortController();
                if(controller) {
                    controller.abort();
                }
            }
            // Perch scheduler/driver (conductor mode) are already stopped above, before
            // shutdownRef.run() — see that comment. Only the legacy perchSessionRunner (oneshot
            // fallback) needs an abort here.
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
            // Stop channel registry hydration loop (safe to call if startHydration was never called)
            channelRegistry.stop();
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
            // P10: conductor mode submits a catch-up envelope through the conductor — the same
            // path the boot sequence uses (`submitConductorCatchUp`) — instead of the legacy
            // catch-up-runner branch below.
            if(conductorOpened && conversationConductor && inboxManager && responseRouterRef) {
                try {
                    await inboxManager.loadUnread();
                    // Mirrors the legacy branch's shouldStartCatchUp() gate (and runBootSequence's
                    // own unreadCount() > 0 gate) — without it, a flaky reconnect loop would submit
                    // a full turn on every reconnect even with nothing new to report.
                    if(inboxManager.getUnreadOverview().totalUnread > 0) {
                        await submitConductorCatchUp({
                            inboxManager,
                            conversationConductor,
                            responseRouter: responseRouterRef,
                            client,
                            rateLimiter,
                            discordCapability,
                        });
                    }
                } catch (err) {
                    logger.warn({ error: err instanceof Error ? err.message : String(err), msg: 'Reconnect catch-up trigger failed' });
                }
                return;
            }

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

        get shutdown(): Shutdown | undefined {
            return shutdownRef;
        },

        // For testing - expose internal state manager (Phase 2)
        _botStateManager: botStateManager,
    };
}
