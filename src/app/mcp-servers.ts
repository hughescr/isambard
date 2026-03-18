import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Client } from 'discord.js';
import { createMemoryMCPServer, createDiscordMCPServer, createInboxMCPServer, createBskyMCPServer, type QuestionRegistry  } from '@/agent';
import { BskyCheckpointManager, type BskyAllowlist, type BlueskyClient } from '@/integrations/bsky';
import { DMTracker, resolveChannelId, splitMessage, withDiscordRetry, buildQuestionButtons, type MessageSearchService, type ChannelRegistryManager, type InboxManager, type BotStateManager } from '@/integrations/discord';
import type { SendRateLimiter } from '@/integrations/email';
import type { MemoryToolBackend, MemoryPath } from '@/storage';

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
    bskyAllowlist?: BskyAllowlist

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
}

/**
 * MCP server configurations.
 */
export interface MCPServers {
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
}

/**
 * Creates all MCP servers for the Claude agent.
 *
 * This factory consolidates the creation of four MCP servers:
 * 1. Memory MCP server - for deep memory access (view, store, search)
 * 2. Discord MCP server - for message history and sending messages
 * 3. Inbox MCP server - for unread message management
 * 4. Bluesky MCP server - for AT Protocol feed reading and interaction (optional)
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
            withRetry: (fn, operationName) => withDiscordRetry(fn, operationName),
        },
        timezone: options.timezone,
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
        options.botStateManager
    );

    const bskyMcpServer = options.bskyClient
        ? createBskyMCPServer({
            client:                options.bskyClient,
            checkpointManager:     new BskyCheckpointManager({ backend: options.memoryBackend }),
            rateLimiter:           options.bskyRateLimiter,
            allowlist:             options.bskyAllowlist,
            sendApprovalRequest:   options.bskySendApprovalRequest,
            sendDMApprovalRequest: options.bskySendDMApprovalRequest,
        })
        : undefined;

    return {
        memoryMcpServer,
        discordMcpServer,
        inboxMcpServer,
        bskyMcpServer,
    };
}
