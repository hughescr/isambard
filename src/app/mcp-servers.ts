import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import { createMemoryMCPServer, createDiscordMCPServer, createInboxMCPServer, createBskyMCPServer, createBrowserMCPServer, createCaldavMCPServer, createWikipediaMCPServer, createContactsMCPServer, createUserContextMCPServer, createMediaMCPServer, createHealthMCPServer, type BrowserAdapter, type BrowserHostPolicy, type QuestionRegistry, type ContactChangeRequest, type PersonHistoryCoordinator } from '@/agent';
import { BskyCheckpointManager, type BlueskyClient, type BskyRejectionBackend } from '@/integrations/bsky';
import type { CalDAVClient, CalendarRegistryBackend } from '@/integrations/caldav';
import { DMTracker, resolveChannelId, splitMessage, withDiscordRetry, buildQuestionButtons, type MessageSearchService, type ChannelRegistryManager, type InboxManager } from '@/integrations/discord';
import type { ServiceHealthRegistry, ReconnectionLoop, TokenBucketRateLimiter } from '@/services';
import type { MemoryToolBackend, MemoryPath, ContactBackend, PersonAllowlist, EmbedderLike, VectorIndex } from '@/storage';

/**
 * Options for creating MCP servers.
 */
export interface MCPServersOptions {
    /**
     * Memory tool backend for the memory MCP server.
     */
    memoryBackend: MemoryToolBackend

    /**
     * Message search service for Discord message history.
     */
    messageSearchService: MessageSearchService

    /**
     * Discord client for sending messages and fetching channels.
     */
    discordClient: Client

    /**
     * Question registry for interactive questions.
     */
    questionRegistry: QuestionRegistry

    /**
     * Channel registry for channel name resolution and mute management.
     */
    channelRegistry: ChannelRegistryManager

    /**
     * Inbox manager for accessing unread messages.
     */
    inboxManager: InboxManager

    /**
     * Server timezone for localTimestamp enrichment in Discord message history.
     * The MCP server is a shared, session-level resource created at startup.
     * Per-user timezone would require threading user context into each tool call.
     * The agent's prompts and message formatting use per-user timezone where available.
     */
    timezone: string

    /**
     * Optional callback to record memory access for scoring.
     */
    recordAccess?: (paths: MemoryPath[]) => Promise<void>

    /**
     * Optional Bluesky client for AT Protocol integration.
     */
    bskyClient?: BlueskyClient

    /**
     * Optional Bluesky allowlist for gating outbound posts.
     */
    bskyAllowlist?: PersonAllowlist

    /**
     * Optional rate limiter for Bluesky outbound posts.
     */
    bskyRateLimiter?: TokenBucketRateLimiter

    /**
     * Optional callback to request admin approval for an outbound Bluesky reply.
     */
    bskySendApprovalRequest?: (
        text:         string,
        targetHandle: string,
        parentUri:    string,
        parentCid:    string,
        rootUri?:     string,
        rootCid?:     string
    ) => Promise<void>

    /**
     * Optional callback to request admin approval for an outbound Bluesky DM.
     */
    bskySendDMApprovalRequest?: (text: string, targetHandles: string[], convoId: string) => Promise<void>

    /**
     * Optional Bluesky rejection backend for rejected post tracking.
     */
    bskyRejectionBackend?: BskyRejectionBackend

    /**
     * Optional CalDAV client for calendar integration.
     */
    caldavClient?: CalDAVClient

    /**
     * Optional CalDAV calendar registry backend.
     */
    caldavRegistry?: CalendarRegistryBackend

    /**
     * Optional contact backend for the contacts MCP server.
     */
    contactBackend?: ContactBackend

    /**
     * Optional callback to send contact change approval requests to admin.
     */
    contactApprovalRequest?: (action: 'create' | 'update', details: ContactChangeRequest) => Promise<void>

    /**
     * Optional PersonHistoryCoordinator for the user context MCP server.
     */
    historyCoordinator?: PersonHistoryCoordinator

    /**
     * Optional service health registry for fast-fail guards in MCP tool handlers.
     * When provided, MCP servers can check service availability before attempting
     * operations that would otherwise time out when a service is offline.
     */
    healthRegistry?: ServiceHealthRegistry

    /**
     * Optional reconnection loop for Discord. When provided, MCP tool health
     * checks can trigger an immediate reconnection attempt on failure.
     */
    discordReconnectionLoop?: ReconnectionLoop

    /**
     * Optional reconnection loop for Bluesky. When provided, MCP tool health
     * checks can trigger an immediate reconnection attempt on failure.
     */
    bskyReconnectionLoop?: ReconnectionLoop

    /**
     * Optional reconnection loop for Email. When provided, MCP tool health
     * checks can trigger an immediate reconnection attempt on failure.
     */
    emailReconnectionLoop?: ReconnectionLoop

    /**
     * Optional browser adapter for the browser MCP server.
     * When provided, the browser MCP server is included.
     */
    browserAdapter?: BrowserAdapter

    /**
     * Optional browser host policy (URL allowlist) for the browser MCP server.
     */
    browserPolicy?: BrowserHostPolicy

    /**
     * Maximum screenshot size in bytes for the browser MCP server.
     */
    browserMaxScreenshotBytes?: number

    /**
     * Maximum text size in bytes for the browser MCP server.
     */
    browserMaxTextBytes?: number

    /**
     * Optional vector index for semantic memory search.
     * When provided alongside `embedder`, enables the `semantic_search` MCP tool.
     */
    vectorIndex?: VectorIndex

    /**
     * Optional embedder for encoding semantic search queries.
     * When provided alongside `vectorIndex`, enables the `semantic_search` MCP tool.
     */
    embedder?: EmbedderLike

    /**
     * Optional person allowlist for validating the Discord MCP server's
     * askUserQuestion requestingUserId argument.
     */
    discordAllowlist?: PersonAllowlist

}

/**
 * MCP server configurations.
 */
interface MCPServers {
    /**
     * Memory MCP server for deep memory access.
     */
    memoryMcpServer: McpServerConfig

    /**
     * Discord MCP server for message history and sending.
     */
    discordMcpServer: McpServerConfig

    /**
     * Inbox MCP server for unread message management.
     */
    inboxMcpServer: McpServerConfig

    /**
     * Bluesky MCP server for AT Protocol feed reading and interaction.
     */
    bskyMcpServer?: McpServerConfig

    /**
     * CalDAV MCP server for calendar queries.
     */
    caldavMcpServer?: McpServerConfig

    /**
     * Wikipedia MCP server for random article discovery.
     */
    wikipediaMcpServer: McpServerConfig

    /**
     * Contacts MCP server for address book management.
     */
    contactsMcpServer?: McpServerConfig

    /**
     * User context MCP server for cross-platform person history.
     */
    userContextMcpServer?: McpServerConfig

    /**
     * Media MCP server for video and audio processing tools.
     */
    mediaMcpServer: McpServerConfig

    /**
     * Browser MCP server for web browser automation.
     */
    browserMcpServer?: McpServerConfig

    /**
     * Email MCP server for sending and managing email, when the caller passes an
     * `emailServerFactory` to {@link createMcpServerInstances}. Not created by the
     * `createMCPServers` old-path wrapper — the old path wires email separately.
     */
    emailMcpServer?: McpServerConfig

    /**
     * Health MCP server exposing {@link ServiceHealthRegistry} state as a read-only pull
     * tool, built whenever a `healthRegistry` is supplied. Deliberately not wrapped in a
     * health guard — it must answer even during an outage.
     */
    healthMcpServer?: McpServerConfig
}

/**
 * Dependencies shared across every MCP server instance set created for a session.
 * Built once via {@link createMcpSharedDeps} and passed to every
 * {@link createMcpServerInstances} call so singleton state (DMTracker,
 * BskyCheckpointManager) is constructed exactly once regardless of how many
 * per-session server sets are built from it.
 */
export interface McpSharedDeps {
    /** The options this session's MCP servers are built from. */
    options: MCPServersOptions

    /** Username-to-DM-channel resolver, shared across every server set. */
    dmTracker: DMTracker

    /** Bluesky feed/notification checkpoint tracker, shared across every server set. */
    bskyCheckpointManager: BskyCheckpointManager
}

/**
 * Which kind of session an MCP server instance set is being built for.
 * The browser MCP server (a single Bun.WebView) attaches only to 'conversation' —
 * there is exactly one WebView, so a second ('perch') session set must not get one.
 */
export type McpServerRole = 'conversation' | 'perch';

/**
 * Options for {@link createMcpServerInstances}.
 */
export interface CreateMcpServerInstancesOptions {
    /** Which kind of session this server set is for; gates the browser MCP server. */
    role: McpServerRole

    /**
     * Optional factory that builds a fresh email MCP server instance for this
     * session, closing over the email integration's shared dependencies (see
     * `EmailSetupResult.createEmailMcpServerInstance`). Omit when the caller wires
     * email separately (the old one-shot path does this today).
     */
    emailServerFactory?: () => McpServerConfig
}

/**
 * Builds the dependencies shared across every MCP server instance set for a
 * session's lifetime: singleton state (DMTracker, BskyCheckpointManager) that must
 * be constructed exactly once, plus the options every instance set is built from.
 *
 * Call this once per app/session; pass the result to {@link createMcpServerInstances}
 * as many times as needed (once per concurrent MCP server instance set required —
 * e.g. one for the conversation session, one for the perch session).
 *
 * @param options - Options containing all required dependencies
 * @returns Shared dependencies for {@link createMcpServerInstances}
 */
export function createMcpSharedDeps(options: MCPServersOptions): McpSharedDeps {
    return {
        options,
        dmTracker:             new DMTracker(options.channelRegistry, options.discordClient),
        bskyCheckpointManager: new BskyCheckpointManager({ backend: options.memoryBackend }),
    };
}

/**
 * Creates a fresh MCP server instance set from shared dependencies.
 *
 * Every call builds brand-new server instances (one `createSdkMcpServer()` call per
 * server) — an underlying SDK MCP server instance can only be connected to one
 * session at a time, so each session needing its own set (the conversation session,
 * the perch session) must call this separately, passing the same {@link McpSharedDeps}
 * so singleton state (DMTracker, BskyCheckpointManager) is not reconstructed.
 *
 * This factory consolidates the creation of twelve MCP servers:
 * 1. Memory MCP server - for deep memory access (view, store, search)
 * 2. Discord MCP server - for message history and sending messages
 * 3. Inbox MCP server - for unread message management
 * 4. Bluesky MCP server - for AT Protocol feed reading and interaction (optional)
 * 5. CalDAV MCP server - for calendar queries (optional)
 * 6. Wikipedia MCP server - for random article discovery during perch time
 * 7. Contacts MCP server - for address book management (optional)
 * 8. User context MCP server - for cross-platform person history (optional)
 * 9. Media MCP server - for video and audio processing tools
 * 10. Email MCP server - built from `params.emailServerFactory` when given (optional)
 * 11. Browser MCP server - for web browser automation; 'conversation' role only
 * 12. Health MCP server - read-only service-health reporting, built from `options.healthRegistry` when given (optional)
 *
 * @param shared - Dependencies shared across every instance set (see {@link createMcpSharedDeps})
 * @param params - Which role this instance set is for, and an optional email server factory
 * @returns Object containing all MCP server configurations for this instance set
 */
export function createMcpServerInstances(shared: McpSharedDeps, params: CreateMcpServerInstancesOptions): MCPServers {
    const { options, dmTracker, bskyCheckpointManager } = shared;

    const memoryMcpServer = createMemoryMCPServer(options.memoryBackend, {
        recordAccess: options.recordAccess,
        vectorIndex:  options.vectorIndex,
        embedder:     options.embedder,
    });

    const discordMcpServer = createDiscordMCPServer({
        searchService:    options.messageSearchService,
        client:           options.discordClient,
        questionRegistry: options.questionRegistry,
        channelRegistry:  {
            resolveChannelId:   nameOrId => resolveChannelId(nameOrId, options.channelRegistry),
            muteChannel:        channelId => options.channelRegistry.muteChannel(channelId),
            unmuteChannel:      channelId => options.channelRegistry.unmuteChannel(channelId),
            getAllChannels:     () => options.channelRegistry.getAllChannels(),
            getUnmutedChannels: () => options.channelRegistry.getUnmutedChannels(),
        },
        dmTracker: {
            getOrCreateDMByUsername: username => dmTracker.getOrCreateDMByUsername(username),
        },
        messageSplitter: {
            splitMessage: content => splitMessage(content),
        },
        buttonBuilder: {
            buildQuestionButtons: config => buildQuestionButtons(config),
        },
        retryHelper: {
            withRetry: fn => withDiscordRetry(fn),
        },
        timezone:         options.timezone,
        healthRegistry:   options.healthRegistry,
        reconnectionLoop: options.discordReconnectionLoop,
        personAllowlist:  options.discordAllowlist,
    });

    const inboxMcpServer = createInboxMCPServer(
        options.inboxManager,
        {
            resolveChannelId:   nameOrId => resolveChannelId(nameOrId, options.channelRegistry),
            muteChannel:        channelId => options.channelRegistry.muteChannel(channelId),
            unmuteChannel:      channelId => options.channelRegistry.unmuteChannel(channelId),
            getAllChannels:     () => options.channelRegistry.getAllChannels(),
            getUnmutedChannels: () => options.channelRegistry.getUnmutedChannels(),
        },
        options.healthRegistry,
        options.discordReconnectionLoop
    );

    const bskyMcpServer = options.bskyClient
        ? createBskyMCPServer({
            client:                options.bskyClient,
            checkpointManager:     bskyCheckpointManager,
            rateLimiter:           options.bskyRateLimiter,
            allowlist:             options.bskyAllowlist,
            sendApprovalRequest:   options.bskySendApprovalRequest,
            sendDMApprovalRequest: options.bskySendDMApprovalRequest,
            rejectionBackend:      options.bskyRejectionBackend,
            healthRegistry:        options.healthRegistry,
            reconnectionLoop:      options.bskyReconnectionLoop,
        })
        : undefined;

    const caldavMcpServer = options.caldavClient && options.caldavRegistry
        ? createCaldavMCPServer({
            client:         options.caldavClient,
            registry:       options.caldavRegistry,
            resolveUser:    name => dmTracker.resolveUserByName(name),
            healthRegistry: options.healthRegistry,
        })
        : undefined;

    const wikipediaMcpServer = createWikipediaMCPServer();

    const contactsMcpServer = options.contactBackend
        ? createContactsMCPServer({
            backend:                    options.contactBackend,
            sendContactApprovalRequest: options.contactApprovalRequest,
        })
        : undefined;

    const userContextMcpServer = options.historyCoordinator
        ? createUserContextMCPServer({ coordinator: options.historyCoordinator })
        : undefined;

    const mediaMcpServer = createMediaMCPServer();

    const emailMcpServer = params.emailServerFactory?.();

    const healthMcpServer = options.healthRegistry
        ? createHealthMCPServer({ healthRegistry: options.healthRegistry })
        : undefined;

    let browserMcpServer: McpServerConfig | undefined;
    if(params.role === 'conversation' && options.browserAdapter) {
        if(options.browserMaxScreenshotBytes === undefined || options.browserMaxTextBytes === undefined) {
            // Stryker disable next-line StringLiteral: log message is informational only
            logger.error('browserMaxScreenshotBytes and browserMaxTextBytes are required when browserAdapter is provided; skipping browser MCP server');
            // browserMcpServer stays undefined — rest of startup continues without browser tools
        } else {
            if(options.browserPolicy === undefined) {
                // Stryker disable next-line StringLiteral: log message is informational only
                logger.warn('browserPolicy not provided; defaulting to permissive (no allowlist). Consider passing a browserPolicy explicitly.');
            }
            browserMcpServer = createBrowserMCPServer({
                adapter:            options.browserAdapter,
                // Stryker disable next-line ObjectLiteral: fallback policy object — callers always pass browserPolicy when they provide browserAdapter
                policy:             options.browserPolicy ?? { allowlist: undefined },
                maxScreenshotBytes: options.browserMaxScreenshotBytes,
                maxTextBytes:       options.browserMaxTextBytes,
            });
        }
    }

    return {
        memoryMcpServer,
        discordMcpServer,
        inboxMcpServer,
        bskyMcpServer,
        caldavMcpServer,
        wikipediaMcpServer,
        contactsMcpServer,
        userContextMcpServer,
        mediaMcpServer,
        browserMcpServer,
        emailMcpServer,
        healthMcpServer,
    };
}

/**
 * Creates all MCP servers for the Claude agent — the old, pre-per-session-factory path.
 *
 * A thin wrapper over {@link createMcpSharedDeps} + {@link createMcpServerInstances}
 * with `role: 'conversation'`, for callers that only ever need a single instance set
 * and have no need to hold onto the shared deps themselves.
 *
 * @param options - Options containing all required dependencies
 * @returns Object containing all MCP server configurations
 */
export function createMCPServers(options: MCPServersOptions): MCPServers {
    const shared = createMcpSharedDeps(options);
    return createMcpServerInstances(shared, { role: 'conversation' });
}
