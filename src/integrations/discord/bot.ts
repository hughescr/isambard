import { logger } from '@hughescr/logger';
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type Interaction, type Message, type ModalSubmitInteraction } from 'discord.js';
import type { AllowlistCommandHandler } from './allowlist-commands';
import type { AllowlistInteractionHandler } from './allowlist-interaction-handler';
import type { CalendarCommandHandler } from './calendar-commands';
import type { DiscordCapability } from './capability';
import { DMTracker, ResponseRouter, type ChannelRegistryManager } from './channel-registry';
import { createDiscordClient } from './client';
import type { ContactCommandHandler, ContactApprovalHandler } from './contact-commands';
import { createReadyHandler, createErrorHandler, dispatchAdmittedMessage, type PerchRoutingDeps } from './handlers';
import type { InboxManager } from './inbox';
import { createIngressGate, type IngressGate } from './ingress-gate';
import { createInteractionHandler } from './interactions';
import type { MessageCoordinator } from './message-coordinator';
import {
    createPresenceThrottle,
    type PresenceManager
} from './presence';
import { DiscordRateLimiter } from './rate-limiter';
import type { BskySetupResult } from './setup/bsky-setup';
import { setupInboxAndCatchUp, submitConductorCatchUp } from './setup/catchup-setup';
import type { DiscordEnvelopeDeps } from './setup/conductor-processor';
import { setupCoordinatorIntegration } from './setup/coordinator-setup';
import { channelListProvider, resolveNames as resolveEnvelopeNames, toEnvelopeInput } from './setup/discord-envelope-provider';
import type { EmailSetupResult } from './setup/email-setup';
import { setupMessageProcessing, initializeChannelRegistry, setupChannelCleanupHandlers } from './setup/event-handler-setup';
import { setupPerchDriverAndScheduler } from './setup/perch-setup';
import { setupConductorPresence } from './setup/presence-setup';
import { createWakeTurnDelivery } from './setup/wake-delivery';
import { setupTaskBoard } from './task-board/setup';
import { createUserId, type ChannelId } from './types';
import { QuestionRegistry, AnswerClassifier, classifyWithHaiku, createTaskListReader, LiveSignals, systemClock, createShutdown, type IdentityCache, type PerchDriver, type PerchScheduler, type PerchConfig, type ContextBuilder, type ActivityLogger, type RecentTool, type RecentChannel, type Conductor, type LedgerStore, type ContextPolicy, type SessionJournal, type Clock, type Shutdown, type ShutdownSession, type NotifyFn, type NotificationBridge, type DeliverableEnvelope, type Envelope, type TimeHeaderProvider, type PerchSlotHooks, type TurnResult  } from '@/agent';
import {
    DEFAULT_TASK_BOARD_CONFIG,
    BSKY_BUTTON_PREFIXES,
    BSKY_MODAL_PREFIXES,
    EMAIL_SEND_BUTTON_PREFIXES,
    EMAIL_SEND_MODAL_PREFIXES,
    EMAIL_REVIEW_PREFIXES,
    EMAIL_ALLOWLIST_SELECT_PREFIX,
    CONTACT_PREFIXES,
    ALLOWLIST_BUTTON_PREFIXES,
    ALLOWLIST_MODAL_PREFIXES,
    type DiscordConfig
} from '@/config';
import type { ServiceHealthRegistry } from '@/services';
import { parseCustomId, resolveTimezone } from '@/utils';

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

async function destroyOwnedDiscordClient(client: Client, providedClient: Client | undefined, reportFailure: (error: unknown, phase: string) => void): Promise<void> {
    // Listener removal and destruction are independent releases. A failure in one
    // must not skip the other, and the caller retains the first teardown error.
    try {
        client.removeAllListeners();
    } catch (error) {
        reportFailure(error, 'Listener removal');
    }
    let destroyed = false;
    try {
        await client.destroy();
        destroyed = true;
    } catch (error) {
        reportFailure(error, 'Discord client destruction');
    }
    if(destroyed && !providedClient && globalThis.__discordClient === client) {
        globalThis.__discordClient = undefined;
    }
}

async function runBotStopStep(phase: string, stop: () => void | Promise<void>, reportFailure: (error: unknown, phase: string) => void): Promise<void> {
    try {
        await stop();
    } catch (error) {
        reportFailure(error, phase);
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
     * Channel registry for dynamic channel management.
     * Required for message filtering and channel discovery.
     */
    channelRegistry: ChannelRegistryManager

    /**
     * Optional perch time configuration.
     * If provided along with an opened perch conductor, enables autonomous perch time.
     */
    perchConfig?: PerchConfig

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
     * The admin review channel (top-level `config.adminDiscordChannelId`). Muted in the channel
     * registry at clientReady so the admin's messages there never reach Izzy, whether or not
     * email is enabled. The composition root always supplies it; optional only for test fixtures.
     */
    adminReviewChannelId?: ChannelId

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
     * Optional composed perch-pause predicate. Forwarded into the perch setup path
     * (`setupPerchDriverAndScheduler`).
     */
    isPerchPaused?: () => boolean

    /**
     * The most recent thinking content either session's turn synopsis producer saw (last writer
     * wins), for the idle status generator's context. The buffer lives in `src/index.ts`, which
     * feeds it from both conductor factories' `onThinkingContentUpdate`.
     */
    getLastThinkingContent?: () => string | undefined

    /**
     * Optional Q5/B1 shared notification bridge `notify` function (see
     * `agent/session/notification-bridge.ts`). A safe no-op until the composition root
     * (`src/index.ts`) attaches the real conductor to the bridge. Not yet consumed inside this
     * file — Q6-Q8 land the notification sources that will call it; this field only threads the
     * seam through the composition root.
     */
    notify?: NotifyFn

    /**
     * R2: the shared notification bridge (see `agent/session/notification-bridge.ts`), threaded in
     * from `src/index.ts` so `clientReady` can call `attachReplyDelivery` once it has built a
     * Discord-backed wake-turn delivery function for the conversation conductor (the same one
     * threaded into `setWakeTurnDelivery` below) — a host-notification reply then routes to the
     * fallback channel instead of being silently discarded. Optional: `bot.test.ts` covers it
     * absent, in which case a wake `notify()`'s reply is simply never delivered (unchanged from
     * before this package).
     */
    notificationBridge?: Pick<NotificationBridge, 'attachReplyDelivery'>

    /**
     * R2: late-binds the conversation conductor's background-work wake-turn delivery function
     * (`createConversationConductor`'s own `setWakeTurnDelivery` — see its doc) once `clientReady`
     * has built the `responseRouter`/`rateLimiter` a delivery function needs. Optional: omitted in
     * conductor-less tests and whenever `conversationConductor` itself is absent.
     */
    setWakeTurnDelivery?: (fn: (envelope: Envelope, result: TurnResult) => Promise<void>) => void

    /**
     * R2: the perch conductor's own equivalent of {@link setWakeTurnDelivery} — a SEPARATE
     * delivery function bound to `perchConductor` (a different `Conductor.deliver` target), only
     * built/attached when `perchConductor` is present.
     */
    setPerchWakeTurnDelivery?: (fn: (envelope: DeliverableEnvelope, result: TurnResult) => Promise<void>) => void

    /**
     * Optional write-through identity cache.
     * When provided, idle status generation uses the cache instead of the inline
     * TTL-based loader.  Invalidate this cache from the memory-tool write path
     * whenever an identity-layer write commits.
     */
    identityCache?: IdentityCache

    /**
     * The long-lived conversation conductor, BUILT but not yet OPENED (see
     * `src/app/sessions.ts`'s own doc). `clientReady` opens it, after `initializeChannelRegistry`
     * and before `setupCoordinatorIntegration`, under the existing idempotency guard; if `open()`
     * rejects the error is logged and message processing simply does not start this process —
     * every one of these four fields is then simply never used.
     */
    conversationConductor?: Conductor
    /** The conductor's own ledger — presence composition and the ring buffers subscribe to it, and `lastSessionId` is seeded from `ledgerStore.get().sessionId` after a successful `open()`. */
    ledgerStore?:           LedgerStore
    contextPolicy?:         ContextPolicy
    journal?:               SessionJournal
    /**
     * The perch conductor, BUILT but not yet OPENED (`src/app/sessions.ts`'s
     * `createPerchConductor`), mirroring `conversationConductor`'s own contract exactly.
     * `clientReady` opens it AFTER the conversation conductor; a rejected (or omitted) `open()`
     * leaves perch disabled without a restart.
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

    /**
     * R1: forwarded verbatim to `setupInboxAndCatchUp`/`runConductorInboxInit` — see
     * `RunConductorInboxInitParams.bootEventsWindowMs`'s own doc. Omitted here, catchup-setup.ts
     * falls back to its own 24h default (matching `config.session.bootEventsWindowMs`'s own
     * schema default), the same "own default, config not required" contract
     * `shutdownTurnWaitMs`/`shutdownDeadlineMs` already follow above.
     */
    bootEventsWindowMs?: number

    /**
     * R1: forwarded verbatim to `setupInboxAndCatchUp`/`runConductorInboxInit` — see
     * `RunConductorInboxInitParams.bootLostTasks`'s own doc. Sourced from
     * `createConversationConductor`'s `ConversationConductorResult.bootLostTasks` — a snapshot
     * read before `conversationConductor.open()` was ever called, so it must be threaded through
     * from the composition root rather than recomputed here (by the time this option is read,
     * `open()` has already run — see this file's own `conversationConductor.open()` call below).
     */
    bootLostTasks?: string[]

    /**
     * Injected process-exit function, called with code `1` when
     * `conversationConductor.open()` rejects or times out. There is no fallback agent to degrade
     * to (P13b removed the one-shot path), so a process that cannot open its conductor would
     * otherwise stay online — logged into Discord, presence painted — while silently answering no
     * messages at all. Exiting lets the deploy's process supervisor restart it. Defaults to the
     * real `process.exit`; tests inject a mock so the failure-path suite never actually terminates
     * the test runner.
     */
    exit?: (code: number) => void

    /**
     * Session-peers block 4: the conversation session's ambient time-header provider
     * (`SessionAmbience.timeHeaderFor('conversation')`, built in `src/app/sessions.ts`). Every
     * conversation-side envelope this file's setups build renders its time header through it, so
     * each turn also carries the other session's one-line summary and the shared quota line.
     * Omitted, each producer falls back to the bare `formatTimeHeader`.
     */
    timeHeader?: TimeHeaderProvider

    /** The perch session's own provider — the perch-channel and slot envelopes' counterpart of {@link CreateDiscordBotOptions.timeHeader}. */
    perchTimeHeader?: TimeHeaderProvider

    /**
     * Slot-boundary callbacks for the perch driver (`createPerchConductor`'s own `slotHooks`),
     * forwarded to `setupPerchDriverAndScheduler` unchanged. Without them a perch identity-change
     * reopen would have no slot boundary to wait for and would never fire.
     */
    perchSlotHooks?: PerchSlotHooks
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
     * then submits a catch-up envelope through the conductor if there are unread messages.
     * No-op if the conductor has not opened (i.e. the bot has never completed its first
     * clientReady sequence, or `open()` rejected).
     */
    triggerCatchUp(): Promise<void>

    /**
     * The cross-session shutdown orchestrator built once the conductor(s) have opened
     * (`createShutdown`), exposed so a caller (the signal handlers in `src/app/lifecycle.ts`) can
     * run it directly without going through the full `stop()` teardown when only the conductor's
     * own bounded wait/interrupt/flush/close sequence is wanted. `undefined` before any conductor
     * has opened.
     */
    shutdown?: Shutdown
}

type ButtonRouteHandler = (interaction: ButtonInteraction) => Promise<void>;
type ModalRouteHandler = (interaction: ModalSubmitInteraction) => Promise<void>;

/** Register the same handler for every prefix in a feature's closed vocabulary. */
function registerRoutes<T>(map: Map<string, T>, prefixes: readonly string[], handler: T): void {
    for(const prefix of prefixes) {
        map.set(prefix, handler);
    }
}

/**
 * Build the button/modal dispatch tables keyed on the EXACT parsed customId prefix (see
 * `@/utils`'s `parseCustomId`) — once per bot instance, not per interaction, so ordering never
 * matters and a prefix that merely starts like an owned one (e.g. 'email-approve:...' vs. the
 * registered 'email-allow') can no longer mis-route. Each feature registers only the prefixes it
 * owns, and only when its setup/handler is present — an owned-looking prefix with no setup falls
 * through to the generic question-button handler (or, for modals, is silently ignored) exactly
 * as it did before, when the equivalent startsWith chain was simply unreached for that feature.
 */
function buildInteractionRoutes(deps: {
    bskySetup?:                   BskySetupResult
    emailSetup?:                  EmailSetupResult
    contactApprovalHandler?:      ContactApprovalHandler
    allowlistInteractionHandler?: AllowlistInteractionHandler
}): { buttonRoutes: Map<string, ButtonRouteHandler>, modalRoutes: Map<string, ModalRouteHandler> } {
    const { bskySetup, emailSetup, contactApprovalHandler, allowlistInteractionHandler } = deps;
    const buttonRoutes = new Map<string, ButtonRouteHandler>();
    const modalRoutes = new Map<string, ModalRouteHandler>();

    if(bskySetup) {
        registerRoutes(buttonRoutes, BSKY_BUTTON_PREFIXES, i => bskySetup.outboundApprovalHandler.handleButton(i));
        registerRoutes(modalRoutes, BSKY_MODAL_PREFIXES, i => bskySetup.outboundApprovalHandler.handleModalSubmit(i));
    }
    if(emailSetup) {
        registerRoutes(buttonRoutes, EMAIL_SEND_BUTTON_PREFIXES, i => emailSetup.outboundApprovalHandler.handleButton(i));
        registerRoutes(buttonRoutes, EMAIL_REVIEW_PREFIXES, i => emailSetup.reviewHandler.handleButton(i));
        registerRoutes(modalRoutes, EMAIL_SEND_MODAL_PREFIXES, i => emailSetup.outboundApprovalHandler.handleModalSubmit(i));
    }
    if(contactApprovalHandler) {
        registerRoutes(buttonRoutes, CONTACT_PREFIXES, i => contactApprovalHandler.handleButton(i));
    }
    if(allowlistInteractionHandler) {
        registerRoutes(buttonRoutes, ALLOWLIST_BUTTON_PREFIXES, i => allowlistInteractionHandler.handleButton(i));
        registerRoutes(modalRoutes, ALLOWLIST_MODAL_PREFIXES, i => allowlistInteractionHandler.handleModalSubmit(i));
    }

    return { buttonRoutes, modalRoutes };
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
 * const conversationConductor = createConductor({ ... });
 * const channelRegistry = createChannelRegistryManager({ ... });
 *
 * const bot = createDiscordBot({
 *   config: {
 *     botToken: process.env.DISCORD_BOT_TOKEN,
 *     applicationId: process.env.DISCORD_APP_ID,
 *     homeGuildId: '...'
 *   },
 *   identityContext: 'I am a helpful assistant',
 *   conversationConductor,
 *   channelRegistry: channelRegistry,
 * });
 *
 * await bot.start();
 * // Bot is now running
 * await bot.stop();
 * ```
 */
export function createDiscordBot(options: DiscordBotOptions): DiscordBot {
    const { config, identityContext, client: providedClient, inboxManager, channelRegistry, contextBuilder, emailSetup, adminReviewChannelId, bskySetup, allowlistHandler, allowlistInteractionHandler, calendarHandler, contactHandler, contactApprovalHandler, activityLogger, healthRegistry, discordCapability, identityCache, conversationConductor, ledgerStore, contextPolicy, journal, perchConductor, perchLedgerStore, perchJournal, shutdownTurnWaitMs, shutdownDeadlineMs, bootEventsWindowMs, bootLostTasks, clock: providedClock, notificationBridge, setWakeTurnDelivery, setPerchWakeTurnDelivery } = options;
    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- the one place this process actually terminates on a failed conductor open; see the option's own doc
    const exit: (code: number) => void = options.exit ?? (code => process.exit(code));
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
    let perchScheduler: PerchScheduler | undefined;
    // True once perchConductor.open() has succeeded this process — gates whether the perch
    // section below wires the driver (setupPerchDriverAndScheduler) at all. Stays false if
    // perchConductor was never provided, or if its open() rejected — perch is simply disabled.
    let perchConductorOpened = false;
    let perchDriver: PerchDriver | undefined;
    // Use provided registry or create a new one
    const questionRegistry: QuestionRegistry = options.questionRegistry ?? new QuestionRegistry();

    // Torn down (if presence was ever set up) on stop().
    let unsubscribeLedgerPresence: (() => void) | undefined;
    // Torn down (if the live task board was ever set up) on stop().
    let stopTaskBoard: (() => void) | undefined;
    // P11: the ONE process-wide presence DISPLAY throttle (design doc section 8: "at most one
    // non-idle presence update per 12s", with the synopsis-arrival bypass as its one documented
    // exception — see presence-setup.ts). It limits display only: turn synopsis generation has
    // its own per-session `SynopsisBudget` in the session core. Built once, only in conductor mode.
    const presenceThrottle = ledgerStore
        ? createPresenceThrottle(config.presence?.updateThrottleMs, () => Date.now())
        : undefined;

    // True once conversationConductor.open() has succeeded this process — gates whether
    // setupCoordinatorIntegration/setupMessageProcessing run at all, and whether stop() has a
    // shim/conductor to tear down. Stays false if conversationConductor was never provided, or if
    // open() rejected — message processing simply does not start this process.
    let conductorOpened = false;
    // The ingress gate (buffers live messages during boot), the cross-session shutdown
    // orchestrator, and a captured reference to clientReady's own `responseRouter` (needed by
    // `triggerCatchUp`'s conductor branch, which runs outside clientReady's own scope) — all
    // built once, inside the same conductor-open block as `conductorOpened = true` below, and
    // all `undefined` before the conductor has opened.
    let ingressGate: IngressGate<Message> | undefined;
    let shutdownRef: Shutdown | undefined;
    let responseRouterRef: ResponseRouter | undefined;

    // Register error handler for Discord client errors
    client.on('error', createErrorHandler());

    // Register rate limit handler for logging.
    client.rest.on('rateLimited', (info) => {
        logger.warn({
            route:      info.route,
            limit:      info.limit,
            retryAfter: info.retryAfter,
            global:     info.global,
            msg:        'Discord rate limit hit, auto-retrying',
        });
    });

    // Register shard event listeners for health tracking
    if(healthRegistry) {
        client.on('shardDisconnect', () => {
            healthRegistry.sendEvent('discord', { type: 'CONNECTION_LOST' });
        });
        client.on('shardReady', () => {
            healthRegistry.sendEvent('discord', { type: 'CONNECT_SUCCESS' });
        });
        client.on('shardResume', () => {
            healthRegistry.sendEvent('discord', { type: 'CONNECT_SUCCESS' });
        });
    }

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
        // Stryker disable next-line llm: timestamp is only ever read by getRecentContext's sort, and a uniform offset preserves that order.
        recentMessages.push({ author, content: content.slice(0, 200), timestamp: Date.now() });
        if(recentMessages.length > MAX_RECENT_MESSAGES) {
            recentMessages.shift();
        }
    };

    // Recent-tools ring buffer for LiveSignals aggregator
    const MAX_RECENT_TOOLS = 10;
    const recentTools: RecentTool[] = [];
    const addRecentTool = (toolName: string): void => {
        recentTools.push({ toolName, timestamp: Date.now() });
        if(recentTools.length > MAX_RECENT_TOOLS) {
            recentTools.shift();
        }
    };
    const getRecentTools = (): readonly RecentTool[] => recentTools;

    // Recent-channels ring buffer for LiveSignals aggregator
    const MAX_RECENT_CHANNELS = 10;
    const recentChannels: RecentChannel[] = [];
    const addRecentChannel = (channelId: RecentChannel['channelId']): void => {
        recentChannels.push({ channelId, timestamp: Date.now() });
        if(recentChannels.length > MAX_RECENT_CHANNELS) {
            recentChannels.shift();
        }
    };
    const getRecentChannels = (): readonly RecentChannel[] => recentChannels;

    // Previous idle status holder — populated by Step 3; read by LiveSignals
    let lastIdleText: string | undefined;
    const getPreviousStatus = (): string | undefined => lastIdleText;
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

    // Route tables keyed on the EXACT parsed customId prefix (see `@/utils`'s parseCustomId) —
    // built once here, not per interaction, so ordering never matters and a prefix that merely
    // starts like an owned one (e.g. 'email-approve:...' vs. the registered 'email-allow') can no
    // longer mis-route. Each feature registers only the prefixes it owns, and only when its
    // setup/handler is present — an owned-looking prefix with no setup falls through to the
    // generic question-button handler (or, for modals, is silently ignored) exactly as it did
    // before, when the equivalent startsWith chain was simply unreached for that feature.
    const { buttonRoutes, modalRoutes } = buildInteractionRoutes({ bskySetup, emailSetup, contactApprovalHandler, allowlistInteractionHandler });

    // Register interaction handler for button clicks and slash commands
    // This uses `client` (not `readyClient`) so it is registered immediately at bot creation time,
    // not inside the clientReady handler. This allows interactions to be routed even before the
    // first clientReady fires.
    async function routeButton(interaction: ButtonInteraction): Promise<void> {
        const parsed = parseCustomId(interaction.customId);
        const handler = parsed && buttonRoutes.get(parsed.prefix);
        if(handler) {
            await handler(interaction);
            return;
        }
        await interactionHandler.handleButtonInteraction(interaction);
    }

    async function routeModal(interaction: ModalSubmitInteraction): Promise<void> {
        const parsed = parseCustomId(interaction.customId);
        const handler = parsed && modalRoutes.get(parsed.prefix);
        if(handler) {
            await handler(interaction);
        }
    }

    async function routeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        switch(interaction.commandName) {
            case 'allowlist': {
                await (allowlistHandler ? allowlistHandler.handle(interaction) : interaction.reply({ content: 'Allowlist management is not currently available.', flags: MessageFlags.Ephemeral }));
                break;
            }
            case 'calendar': {
                await (calendarHandler ? calendarHandler.handle(interaction) : interaction.reply({ content: 'Calendar management is not currently available.', flags: MessageFlags.Ephemeral }));
                break;
            }
            case 'contact': {
                await (contactHandler ? contactHandler.handle(interaction) : interaction.reply({ content: 'Contact management is not currently available.', flags: MessageFlags.Ephemeral }));
                break;
            }
        }
    }

    async function routeInteraction(interaction: Interaction): Promise<void> {
        if(interaction.isButton()) {
            await routeButton(interaction);
        } else if(interaction.isModalSubmit()) {
            await routeModal(interaction);
        } else if(interaction.isStringSelectMenu() && parseCustomId(interaction.customId)?.prefix === EMAIL_ALLOWLIST_SELECT_PREFIX) {
            await (emailSetup ? emailSetup.outboundApprovalHandler.handleSelectMenu(interaction) : interaction.reply({ content: 'Email integration is not currently available.', flags: MessageFlags.Ephemeral }));
        } else if(interaction.isChatInputCommand()) {
            await routeCommand(interaction);
        }
    }

    const onInteractionCreate = async (interaction: Interaction): Promise<void> => {
        try {
            await routeInteraction(interaction);
        } catch (err) {
            logger.error({
                // Stryker disable next-line llm: TypeError is a subclass of Error, so an added `|| err instanceof TypeError` disjunct is implied and cannot flip the result
                error:           err instanceof Error ? err.message : String(err),
                interactionType: interaction.type,
                msg:             'Unhandled error in interaction handler',
            });
            try {
                if(interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: 'An error occurred while processing this interaction.',
                        flags:   MessageFlags.Ephemeral,
                    });
                }
            } catch{
                // The interaction may have expired or already been acknowledged.
            }
        }
    };

    // Discord's client captures rejected listener promises; this listener also catches route errors.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- asynchronous Discord event listener
    client.on('interactionCreate', onInteractionCreate);

    // P11/P14: the ring buffers are fed exclusively from the session ledger(s) — there is no
    // other source of activity-phase/turn data in conductor mode. P12: the perch conductor's own
    // ledger (`perchLedgerStore`) folds in here whenever it is present, regardless of whether
    // `perchConductor.open()` itself later succeeds (an untouched ledger simply never emits,
    // contributing nothing rather than something wrong). When `ledgerStore` itself is absent (no
    // conductor configured at all — e.g. a minimal test setup), both ring buffers simply see no
    // activity; there is no fallback source to subscribe to instead.
    //
    // The same `[conversation, perch]` ledgers are what presence composes from. Presence no
    // longer needs the conductors: the turn synopsis producer is paired with each conductor and
    // ledger structurally, in `src/app/sessions.ts`, which builds all three together.
    function buildConductorLedgers(): readonly LedgerStore[] | undefined {
        if(!ledgerStore) {
            return undefined;
        }
        return perchLedgerStore ? [ledgerStore, perchLedgerStore] : [ledgerStore];
    }
    const conductorLedgers: readonly LedgerStore[] | undefined = buildConductorLedgers();
    let unsubscribeToolTracking: () => void = () => undefined;
    let unsubscribeChannelTracking: () => void = () => undefined;
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
                addRecentChannel(turn.channelId);
            }
        }));
        const unsubscribeAll = (): void => {
            for(const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        };
        unsubscribeToolTracking = unsubscribeAll;
        unsubscribeChannelTracking = unsubscribeAll;
    }

    // Idempotency guard: track whether clientReady setup has run.
    // The handler is registered with .on() (not .once()) so reconnects fire it again,
    // but full component initialisation only runs on the first connection.
    let initialized = false;

    // Register clientReady handler for messageCreate setup
    // This runs after the client is authenticated and ready.
    // Use .on() (not .once()) so reconnects fire the handler again; the `initialized`
    // flag gates the one-time setup so components are only created on first connection.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Discord captures rejected listener promises; startup setup is asynchronous
    client.on('clientReady', async (readyClient: Client): Promise<void> => {
        // Log that the bot is ready (preserving functionality from removed logging handler)
        createReadyHandler()(readyClient);
        // At this point, readyClient.user is guaranteed to be non-null
        // because the 'clientReady' event only fires after successful authentication

        if(!initialized) {
            initialized = true;

            // Construct LiveSignals aggregator (requires readyClient for channel name resolution)
            const liveSignals = options.perchConfig
                ? new LiveSignals({
                    timezone:           options.perchConfig.timezone,
                    getRecentTools,
                    getRecentChannels,
                    resolveChannelName: (id) => {
                        const ch = readyClient.channels.cache.get(id);
                        return ch && 'name' in ch ? (ch as { name: string }).name : undefined;
                    },
                    getPreviousStatus,
                    // Step 4: network-fetched signals
                    bskyClient:            bskySetup?.client,
                    idleSignalsConfig:     config.presence?.idleSignals,
                    loadRecentActivityLog: contextBuilder
                        ? (limit: number) => contextBuilder.loadRecentEventsSince(ACTIVITY_WINDOW_MS, limit)
                        : undefined,
                })
                : undefined;

            // P11 fix: presence construction moved below the conductor-open block (still before
            // setupCoordinatorIntegration/setupMessageProcessing, which is all "before
            // coordinator.setProcessor" ever required) so it can gate on `conductorOpened` —
            // whether open() actually SUCCEEDED — rather than on `ledgerStore`'s mere existence,
            // which only means the conductor was REQUESTED. Gating on `ledgerStore` left presence
            // frozen on the boot-time idle status for the process lifetime whenever open() rejected
            // or timed out, since the ledger it was composing from would then never receive
            // another event.

            // Create DMTracker and ResponseRouter (after client is ready, BEFORE session runners)
            const dmTracker = new DMTracker(channelRegistry, readyClient);
            const responseRouter = new ResponseRouter({
                manager: channelRegistry,
            });
            // Captured for triggerCatchUp's own use, which runs outside clientReady's own scope
            // (see the outer `let responseRouterRef` declaration).
            responseRouterRef = responseRouter;

            // R2: build the Discord-backed wake-turn delivery function(s) now that
            // responseRouter/readyClient/rateLimiter exist, and late-bind them into whichever
            // conductor(s) were actually built — see `DiscordBotOptions.setWakeTurnDelivery`'s own
            // doc for why this cannot happen at conductor-construction time. The conversation
            // conductor's own delivery function doubles as the notification bridge's reply
            // delivery (both a settled `task`-kind wake turn and a settled `notification`-kind
            // bridge reply are delivered identically once each has an origin channel or falls back
            // — see `wake-delivery.ts`'s own module doc).
            if(conversationConductor) {
                const conversationWakeDelivery = createWakeTurnDelivery({
                    conductor: conversationConductor, responseRouter, client: readyClient, rateLimiter, discordCapability, logger,
                });
                setWakeTurnDelivery?.(conversationWakeDelivery);
                notificationBridge?.attachReplyDelivery(conversationWakeDelivery);
            }
            if(perchConductor) {
                const perchWakeDelivery = createWakeTurnDelivery({
                    conductor: perchConductor, responseRouter, client: readyClient, rateLimiter, discordCapability, logger,
                });
                setPerchWakeTurnDelivery?.(perchWakeDelivery);
            }

            // Initialize channel registry BEFORE setting up message handlers.
            // startHydration() fires the reconnection loop asynchronously — do not await.
            // The registry-ready gate in MessageCoordinator drops messages until hydration completes.
            initializeChannelRegistry(readyClient, channelRegistry, responseRouter, rateLimiter, healthRegistry);

            // The perch conductor's own delivery surface for a live perch-channel Discord message
            // — built lazily (read at CALL time, like `onDrain`'s own `coordinator` read below) so
            // it always reflects perchConductorOpened's FINAL value, not whatever it was when the
            // closure was created. `undefined` whenever the conversation conductor itself never
            // opened (the ingress-gate machinery this rides on is anchored to the conversation
            // conductor's own boot flow) or the perch conductor did not.
            function perchRoutingDeps(): PerchRoutingDeps | undefined {
                return conductorOpened && perchConductorOpened && perchConductor
                    ? {
                        conductor:  perchConductor, responseRouter, client:     readyClient, rateLimiter, discordCapability, contextBuilder,
                        timeHeader: options.perchTimeHeader,
                    }
                    : undefined;
            }

            let drainChain: Promise<void> = Promise.resolve();
            const onDrain = (message: Message): void => {
                if(coordinator) {
                    const currentCoordinator = coordinator;
                    drainChain = drainChain
                        .then(() => dispatchAdmittedMessage(message, createUserId(readyClient.user!.id), currentCoordinator, {
                            channelRegistry, inboxManager, perch: perchRoutingDeps(),
                        }))
                        .catch((err: unknown) => {
                            logger.error({ err, msg: 'dispatchAdmittedMessage failed for a gate-drained message' });
                        });
                }
            };

            async function openConversation(): Promise<void> {
                // Open the long-lived conversation conductor now that the guild cache and channel
                // registry exist, but BEFORE setupCoordinatorIntegration/setupMessageProcessing pick a
                // processor — a rejected open() (or one that never settles at all — see
                // CONDUCTOR_OPEN_TIMEOUT_MS) exits the process (see the `exit` option's own doc)
                // rather than switching either of those on and running on silently disabled.
                if(conversationConductor && ledgerStore && contextPolicy && journal) {
                    try {
                        await withTimeout(conversationConductor.open(), CONDUCTOR_OPEN_TIMEOUT_MS, 'conductor.open() timed out');
                        setLastSessionId(ledgerStore.get().sessionId);
                        // Created here (before setupCoordinatorIntegration/setupMessageProcessing pick
                        // a processor) so both can be handed the SAME gate/shutdown instances.
                        // `onDrain` reads the outer `coordinator` variable at CALL time (gate.open()
                        // only ever runs from the boot sequence, well after setupCoordinatorIntegration
                        // has assigned it below), not at this closure's definition time. Routed through
                        // the same `dispatchAdmittedMessage` the live handler uses, so a perch-channel
                        // message buffered during boot is answered by the perch conductor exactly like
                        // a live one, once drained.
                        //
                        // `drainChain` serialises dispatch across a whole drained batch: `gate.open()`
                        // calls `onDrain` synchronously per buffered message in arrival order, but each
                        // call now does async work first (with perch routing active, a
                        // getWellKnownChannel lookup) whose await depth varies per message (a cache hit
                        // resolves sooner than a cache miss). Without this chain, a later message's
                        // dispatch could resolve before an earlier one's, delivering a boot-buffered
                        // burst to the coordinator out of arrival order. Each link swallows its own
                        // error (logged) so one failed dispatch never blocks the rest of the chain.
                        ingressGate = createIngressGate<Message>({ onDrain });
                        conductorOpened = true;
                    } catch (err) {
                        logger.error({
                            error: err instanceof Error ? err.message : String(err),
                            msg:   'Conductor open() failed — exiting so the deploy supervisor restarts this process',
                        });
                        exit(1);
                    }
                }
            }
            await openConversation();

            async function openPerch(): Promise<void> {
                // Open the perch conductor next — independent of whether the conversation conductor
                // above succeeded — mirroring its build-only-then-open contract exactly. A rejected
                // (or omitted) open() leaves perch disabled without a restart; the conversation
                // coordinator is never touched by the perch conductor either way.
                if(perchConductor && perchLedgerStore && perchJournal) {
                    try {
                        await withTimeout(perchConductor.open(), CONDUCTOR_OPEN_TIMEOUT_MS, 'perch conductor.open() timed out');
                        perchConductorOpened = true;
                    } catch (err) {
                        logger.error({
                            error: err instanceof Error ? err.message : String(err),
                            msg:   'Perch conductor open() failed — perch disabled for this process, no restart',
                        });
                    }
                }
            }
            await openPerch();

            function configureShutdown(): void {
                // P10/P12: build the cross-session shutdown orchestrator once both open attempts above
                // have settled, covering whichever conductor(s) actually opened under ONE shared
                // turnWaitMs/deadlineMs budget (createShutdown's own `sessions` array already
                // anticipates a second 'perch' entry — see shutdown.ts's own doc).
                if(conductorOpened || perchConductorOpened) {
                    const sessions: ShutdownSession[] = [];
                    if(conductorOpened && conversationConductor) {
                        // Stryker disable next-line ArrayMethodSwap: sessions is newly allocated and empty, so either insertion makes conversation its sole first entry.
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
            }
            configureShutdown();

            const getRecentContext = async (): Promise<string | undefined> => {
                if(recentMessages.length === 0) {
                    return undefined;
                }
                const sortedMessages = recentMessages.toSorted((a, b) => a.timestamp - b.timestamp);
                return sortedMessages.map(m => (m.author === 'user' ? `User: ${m.content}` : `Izzy: ${m.content}`)).join('\n');
            };

            function configurePresence(): void {
                // Setup presence manager once the conductor has actually opened (open() SUCCEEDED, not
                // merely requested). Presence only renders: the turn synopsis it shows is produced
                // by the session core (`src/agent/session/turn-synopsis.ts`, wired per session in
                // `src/app/sessions.ts`), whether or not presence is ever set up. There is no
                // fallback presence path (P13b removed the one-shot agent; P14 removed the legacy
                // state-machine bridged `setupPresence`): a conductor that never opens simply runs
                // with no presence at all.
                // Hoisted so the equivalent "drop && ledgerStore" mutant has its own line while the
                // conductorOpened gate below stays mutation-measured (the P11 regression).
                // Stryker disable next-line llm,LogicalOperator: presenceThrottle is derived from ledgerStore at its construction site (`ledgerStore ? createPresenceThrottle(...) : undefined`), so it is never truthy without it and the ledgerStore conjunct cannot decide the branch
                const presenceInfra = presenceThrottle && ledgerStore;
                if(identityContext && config.presence && conductorOpened && presenceInfra) {
                    // P11/P12: presence composes from the session ledger(s) — conversation always,
                    // perch too whenever its ledger exists — see setupConductorPresence's own doc for
                    // exactly what that composition does.
                    const conductorPresence = setupConductorPresence({
                        identityContext,
                        presenceConfig:         config.presence,
                        readyClient,
                        getTaskContext:         () => taskListReader.buildTaskListSummary(),
                        getRecentContext,
                        contextBuilder,
                        getLastThinkingContent: options.getLastThinkingContent,
                        identityCache,
                        getLiveSignals:         liveSignals ? () => liveSignals.snapshot() : undefined,
                        getPreviousStatus,
                        setPreviousStatus,
                        ledgers:                conductorLedgers!,
                        throttle:               presenceThrottle,
                        // Q3/B4: only forward the predicate when perch is actually enabled — the
                        // `⏸ perch` marker asserts a pause that has a subject; with perch off, no
                        // scheduler was ever going to run, so nothing is paused regardless of what
                        // isPerchPaused() reports (finding: the marker rendered even with perch off).
                        isPerchPaused:          options.perchConfig?.enabled ? options.isPerchPaused : undefined,
                    });
                    presenceManager = conductorPresence.presenceManager;
                    unsubscribeLedgerPresence = conductorPresence.unsubscribeLedgers;
                }
            }
            configurePresence();

            function configureTaskBoard(): void {
                // Live task board: one system-posted embed per (channel, turn) mirroring the
                // sub-agents, workflows and background shell commands that turn launched. Gated on the
                // same conductor-opened condition as presence (it composes from the same ledgers) and
                // on the config flag, which only an explicit `enabled: false` turns off.
                if(conductorOpened && ledgerStore && config.taskBoard?.enabled !== false) {
                    const taskBoard = setupTaskBoard({
                        readyClient,
                        rateLimiter,
                        ledgers:                  conductorLedgers!,
                        config:                   config.taskBoard ?? DEFAULT_TASK_BOARD_CONFIG,
                        // The bot receives no zone of its own; perch's configured zone is the only one
                        // reachable here, and it is the same IANA zone the rest of Izzy schedules in.
                        // With perch disabled there is no configured zone at all, so fall back to the
                        // host zone the config loader itself defaults every other `timezone` to.
                        timeZone:                 options.perchConfig?.timezone ?? resolveTimezone(),
                        logger,
                        // A conversation-session task launched from a turn with no channel (a bare
                        // notification turn, or a wake whose launch record was lost) boards in the
                        // `fallback` well-known channel — the same place wake delivery sends such a
                        // turn's reply. A perch-session task always launches with no channel, so it
                        // always takes this fallback: it boards in the `perch-time` well-known
                        // channel, the same place the perch reply already goes.
                        resolveFallbackChannelId: async (role: string): Promise<string | undefined> => {
                            if(role === 'conversation') {
                                const fallback = await channelRegistry.getWellKnownChannel('fallback');
                                return fallback?.channelId;
                            }
                            if(role === 'perch') {
                                const perch = await channelRegistry.getWellKnownChannel('perch-time');
                                return perch?.channelId;
                            }
                            return undefined;
                        },
                    });
                    stopTaskBoard = taskBoard.stop;
                }
            }
            configureTaskBoard();

            function configurePerch(): void {
                // Create the perch driver+scheduler once the perch conductor has successfully opened.
                if(perchConductorOpened && perchConductor && options.perchConfig?.enabled) {
                    const perchSetup = setupPerchDriverAndScheduler({
                        conductor:     perchConductor,
                        perchConfig:   options.perchConfig,
                        clock,
                        contextBuilder,
                        activityLogger,
                        channelRegistry,
                        responseRouter,
                        client:        readyClient,
                        rateLimiter,
                        discordCapability,
                        isPerchPaused: options.isPerchPaused,
                        timeHeader:    options.perchTimeHeader,
                        slotHooks:     options.perchSlotHooks,
                    });
                    perchDriver = perchSetup.driver;
                    perchScheduler = perchSetup.scheduler;
                }
            }
            configurePerch();

            async function muteAdminReviewChannel(): Promise<void> {
                // Mute the admin review channel so Craig's messages there don't reach Izzy
                if(adminReviewChannelId) {
                    try {
                        await channelRegistry.muteChannel(adminReviewChannelId);
                        logger.info({ msg: 'Admin review channel muted in channel registry' });
                    } catch (err) {
                        logger.warn({
                            error: err instanceof Error ? err.message : String(err),
                            msg:   'Failed to mute admin review channel — messages there may reach Izzy',
                        });
                    }
                }
            }
            await muteAdminReviewChannel();

            function configureMessageProcessing(): void {
                // Create message coordinator once the conductor has opened (MUST be before setupMessageProcessing)
                if(conductorOpened) {
                    // The conductor's Discord-facing dependencies bind to this readyClient/
                    // channelRegistry — built here (not earlier) because both only exist from
                    // clientReady onward.
                    const envelopeProvider: DiscordEnvelopeDeps = {
                        resolveNames: resolveEnvelopeNames(channelRegistry, readyClient),
                        toEnvelopeInput,
                        channelList:  channelListProvider(channelRegistry, readyClient),
                    };

                    coordinator = setupCoordinatorIntegration({
                        responseRouter,
                        rateLimiter,
                        readyClient,
                        channelRegistry,
                        setLastSessionId,
                        addRecentMessage,
                        addRecentChannel,
                        activityLogger,
                        discordCapability,
                        conversationConductor: conversationConductor!,
                        contextPolicy:         contextPolicy!,
                        envelopeProvider,
                        contextBuilder,
                        inboxManager,
                        timeHeader:            options.timeHeader,
                    });

                    // Register message handler AFTER channel registry is initialized and coordinator is created
                    setupMessageProcessing({
                        client,
                        readyClient,
                        channelRegistry,
                        addRecentMessage,
                        coordinator,
                        questionRegistry,
                        answerClassifier,
                        inboxManager,
                        dmTracker,
                        ingressGate: ingressGate!,
                        perch:       perchRoutingDeps(),
                    });
                }
            }
            configureMessageProcessing();

            // Register channel cleanup event handlers
            setupChannelCleanupHandlers({
                client,
                coordinator,
                channelRegistry,
            });

            async function initializeInbox(): Promise<void> {
                // Initialize inbox on startup and then check for catch-up, once the conductor opened.
                if(inboxManager && conductorOpened) {
                    // The well-known perch-time channel's replay is owned by the perch conductor, not
                    // the conversation one — excluded from replayUnhandled entirely (documented skip:
                    // this package does not route perch-channel replay to the perch conductor, only
                    // its LIVE messages — see handlers.ts's own dispatchAdmittedMessage) whenever the
                    // perch conductor actually opened. If it did not, conversation's own replay keeps
                    // trying that channel too (the safer fallback).
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
                        perchConfig:           options.perchConfig,
                        healthRegistry:        options.healthRegistry,
                        conversationConductor: conversationConductor!,
                        journal:               journal!,
                        responseRouter,
                        rateLimiter,
                        ingressGate:           ingressGate!,
                        discordCapability,
                        // Stryker disable next-line llm: Set membership deduplicates, so listing perchTimeChannelId twice builds the identical exclusion set.
                        excludeChannelIds:     perchTimeChannelId ? new Set([perchTimeChannelId]) : undefined,
                        contextPolicy,
                        bootEventsWindowMs,
                        bootLostTasks,
                        timeHeader:            options.timeHeader,
                    });
                }
            }
            await initializeInbox();
        } // end if(!initialized)
    });

    return {
        async start(): Promise<void> {
            // Login errors propagate to caller (as per user decision)
            await client.login(config.botToken);
        },

        async stop(): Promise<void> {
            let primaryError: Error | undefined;
            const recordFailure = (error: unknown, phase: string): void => {
                const failure = error instanceof Error ? error : new Error(String(error));
                if(primaryError === undefined) {
                    primaryError = failure;
                    try {
                        logger.warn({ error: failure.message, msg: `${phase} failed during bot shutdown` });
                    } catch{ /* Preserve the original shutdown failure even if logging fails. */ }
                    return;
                }
                try {
                    logger.warn({ error: failure.message, msg: `${phase} failed after an earlier bot shutdown error` });
                } catch{ /* Preserve the first shutdown failure. */ }
            };
            // Stop coordinator if it exists
            await runBotStopStep('Coordinator stop', () => coordinator?.stop(), recordFailure);
            // Stop the perch driver's own timers (wrap-up/interrupt/pending) and the scheduler
            // BEFORE shutdownRef.run() below waits out the shared turn-wait budget — otherwise an
            // interrupt or wrap-up timer can still fire while shutdown is politely waiting for the
            // very turn it is about to interrupt anyway, re-submitting a fresh slot envelope
            // (onSlotSettled's `pending` resolution) into a conductor that is mid-shutdown and
            // logs a spurious "shutting down" rejection. A no-op when perch was never enabled or
            // its conductor never opened (perchDriver/perchScheduler stay undefined).
            await runBotStopStep('Perch scheduler stop', () => perchScheduler?.stop(), recordFailure);
            await runBotStopStep('Perch driver stop', () => perchDriver?.stop(), recordFailure);
            // coordinator.stop() -> perch driver/scheduler stop() -> gate.stop() ->
            // shutdown.run() (the cross-session wait/interrupt/flush/close sequence, covering both
            // conductors under ONE shared config.session.shutdownTurnWaitMs/shutdownDeadlineMs
            // budget — see createShutdown) -> ledger/ring-buffer unsubscribes below.
            // The shutdown() call ORDER and warning formatting are covered by bot.test.ts's
            // conductor-mode lifecycle assertions.
            if(shutdownRef) {
                // Stryker disable next-line AwaitDrop: IngressGate.stop() is synchronous, so runBotStopStep runs it (and any recordFailure) before returning; the await only skips a microtask.
                await runBotStopStep('Ingress gate stop', () => ingressGate?.stop(), recordFailure);
                try {
                    await shutdownRef.run();
                } catch (err) {
                    try {
                        logger.warn({
                            error: err instanceof Error ? err.message : String(err),
                            msg:   'Conductor shutdown() failed — continuing with the rest of stop()',
                        });
                    } catch (warningError) {
                        recordFailure(warningError, 'Conductor shutdown warning');
                    }
                }
            }
            // Stop question registry (always exists now)
            await runBotStopStep('Question registry stop', () => questionRegistry.stop(), recordFailure);
            await runBotStopStep('Ledger presence unsubscribe', () => unsubscribeLedgerPresence?.(), recordFailure);
            await runBotStopStep('Task board stop', () => stopTaskBoard?.(), recordFailure);
            // Stryker disable next-line AwaitDrop: unsubscribeToolTracking is a synchronous `() => void`, so runBotStopStep runs it (and any recordFailure) before returning; the await only skips a microtask.
            await runBotStopStep('Tool tracking unsubscribe', () => unsubscribeToolTracking(), recordFailure);
            // Stryker disable next-line AwaitDrop: unsubscribeChannelTracking is a synchronous `() => void`, so runBotStopStep runs it (and any recordFailure) before returning; the await only skips a microtask.
            await runBotStopStep('Channel tracking unsubscribe', () => unsubscribeChannelTracking(), recordFailure);
            // Perch scheduler/driver are already stopped above, before shutdownRef.run() — see
            // that comment.
            // Stop presence manager if it exists
            await runBotStopStep('Presence manager stop', () => presenceManager?.stop(), recordFailure);
            // Stop rate limiter
            await runBotStopStep('Rate limiter stop', () => rateLimiter.stop(), recordFailure);
            // Stop channel registry hydration loop (safe to call if startHydration was never called)
            await runBotStopStep('Channel registry stop', () => channelRegistry.stop(), recordFailure);
            await destroyOwnedDiscordClient(client, providedClient, recordFailure);
            if(primaryError) {
                throw primaryError;
            }
        },

        async triggerCatchUp(): Promise<void> {
            // Submits a catch-up envelope through the conductor — the same path the boot sequence
            // uses (`submitConductorCatchUp`).
            if(!conductorOpened || !conversationConductor || !inboxManager || !responseRouterRef) {
                return;
            }
            try {
                await inboxManager.loadUnread();
                // Mirrors runBootSequence's own unreadCount() > 0 gate — without it, a flaky
                // reconnect loop would submit a full turn on every reconnect even with nothing new
                // to report.
                // Stryker disable next-line llm: totalUnread is a sum of filtered array lengths, so it is never negative and `> 0` and `!== 0` agree.
                if(inboxManager.getUnreadOverview().totalUnread > 0) {
                    await submitConductorCatchUp({
                        inboxManager,
                        conversationConductor,
                        responseRouter: responseRouterRef,
                        client,
                        rateLimiter,
                        discordCapability,
                        timeHeader:     options.timeHeader,
                    });
                }
            } catch (err) {
                logger.warn({ error: err instanceof Error ? err.message : String(err), msg: 'Reconnect catch-up trigger failed' });
            }
        },

        get shutdown(): Shutdown | undefined {
            return shutdownRef;
        },
    };
}
