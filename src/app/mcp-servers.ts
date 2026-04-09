import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Client } from 'discord.js';
import { createMemoryMCPServer, createDiscordMCPServer, createInboxMCPServer, createBskyMCPServer, createCaldavMCPServer, createWikipediaMCPServer, createContactsMCPServer, createUserContextMCPServer, createMediaMCPServer, type QuestionRegistry, type ContactChangeRequest, type PersonHistoryCoordinator } from '@/agent';
import { BskyCheckpointManager, type BlueskyClient, type BskyRejectionBackend } from '@/integrations/bsky';
import type { CalDAVClient, CalendarRegistryBackend } from '@/integrations/caldav';
import { DMTracker, resolveChannelId, splitMessage, withDiscordRetry, buildQuestionButtons, type MessageSearchService, type ChannelRegistryManager, type InboxManager, type BotStateManager } from '@/integrations/discord';
import type { SendRateLimiter } from '@/integrations/email';
import type { ServiceHealthRegistry, ReconnectionLoop } from '@/services';
import type { MemoryToolBackend, MemoryPath, ContactBackend, PersonAllowlist } from '@/storage';

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
     * Bot state manager for tracking viewed channels during catch-up.
     */
    botStateManager: BotStateManager

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
    bskyRateLimiter?: SendRateLimiter

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
}

/**
 * Creates all MCP servers for the Claude agent.
 *
 * This factory consolidates the creation of ten MCP servers:
 * 1. Memory MCP server - for deep memory access (view, store, search)
 * 2. Discord MCP server - for message history and sending messages
 * 3. Inbox MCP server - for unread message management
 * 4. Bluesky MCP server - for AT Protocol feed reading and interaction (optional)
 * 5. CalDAV MCP server - for calendar queries (optional)
 * 6. Wikipedia MCP server - for random article discovery during perch time
 * 7. Contacts MCP server - for address book management (optional)
 * 8. User context MCP server - for cross-platform person history (optional)
 * 9. Media MCP server - for video and audio processing tools
 * 10. Email MCP server - created separately in email-setup.ts
 *
 * @param options - Options containing all required dependencies
 * @returns Object containing all MCP server configurations
 */
export function createMCPServers(options: MCPServersOptions): MCPServers {
    const memoryMcpServer = createMemoryMCPServer(options.memoryBackend, {
        recordAccess: options.recordAccess,
    });

    // Create DMTracker for username-to-DM-channel resolution
    const dmTracker = new DMTracker(options.channelRegistry, options.discordClient);

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
        options.botStateManager,
        options.healthRegistry,
        options.discordReconnectionLoop
    );

    const bskyMcpServer = options.bskyClient
        ? createBskyMCPServer({
            client:                options.bskyClient,
            checkpointManager:     new BskyCheckpointManager({ backend: options.memoryBackend }),
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
    };
}
