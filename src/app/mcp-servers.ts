import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Client } from 'discord.js';
import { createMemoryMCPServer } from '../agent/memory-mcp-server';
import { createDiscordMCPServer } from '../agent/discord-mcp-server';
import { createInboxMCPServer } from '../agent/inbox-mcp-server';
import type { MemoryToolBackend } from '../storage/memory-tool';
import type { MemoryPath } from '../storage/memory-tool/types';
import type { MessageSearchService } from '../integrations/discord/message-history/search';
import type { QuestionRegistry } from '../agent/question-registry';
import type { ChannelRegistryManager } from '../integrations/discord/channel-registry';
import type { InboxManager } from '../integrations/discord/inbox';
import type { BotStateManager } from '../integrations/discord/state';

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
}

/**
 * Creates all MCP servers for the Claude agent.
 *
 * This factory consolidates the creation of three MCP servers:
 * 1. Memory MCP server - for deep memory access (view, store, search)
 * 2. Discord MCP server - for message history and sending messages
 * 3. Inbox MCP server - for unread message management
 *
 * @param options - Options containing all required dependencies
 * @returns Object containing all three MCP server configurations
 */
export function createMCPServers(options: MCPServersOptions): MCPServers {
    const memoryMcpServer = createMemoryMCPServer(options.memoryBackend, {
        recordAccess: options.recordAccess,
    });

    const discordMcpServer = createDiscordMCPServer(
        options.messageSearchService,
        options.discordClient,
        options.questionRegistry,
        options.channelRegistry,
        options.timezone
    );

    const inboxMcpServer = createInboxMCPServer(
        options.inboxManager,
        options.channelRegistry,
        options.botStateManager
    );

    return {
        memoryMcpServer,
        discordMcpServer,
        inboxMcpServer,
    };
}
