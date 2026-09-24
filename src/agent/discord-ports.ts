import type { ChannelId } from './types';

/**
 * Discord channel metadata consumed by the Discord MCP adapters.
 * This mirrors the integration's channel registry without importing it.
 */
export interface DiscordMcpChannelInfo {
    channelId:    ChannelId
    channelName:  string
    guildId:      string
    isMuted:      boolean
    isWellKnown?: string
}

/**
 * Discord channel registry port consumed by MCP adapters.
 * This abstracts the Discord ChannelRegistryManager while keeping agent code
 * independent from src/integrations/discord.
 */
export interface DiscordMcpChannelRegistry {
    /** Resolve a channel name (#general) or numeric ID string to a ChannelId */
    resolveChannelId(nameOrId: string): ChannelId
    /** Mute a channel */
    muteChannel(channelId: ChannelId): Promise<void>
    /** Unmute a channel */
    unmuteChannel(channelId: ChannelId): Promise<void>
    /** Get all tracked Discord channels */
    getAllChannels(): DiscordMcpChannelInfo[]
    /** Get all unmuted Discord channels */
    getUnmutedChannels(): Promise<DiscordMcpChannelInfo[]>
}

/**
 * Discord DM tracker port consumed by the Discord MCP server.
 * This abstracts DMTracker's username-to-channel resolution.
 */
export interface MCPDMTracker {
    /** Get or create a DM channel by username. Returns null if user not found. */
    getOrCreateDMByUsername(username: string): Promise<ChannelId | null>
}

/**
 * Discord message splitter port for messages subject to Discord limits.
 * @internal Only consumed by src/agent/discord-mcp-server.ts.
 */
export interface MCPMessageSplitter {
    /** Split a message string into chunks */
    splitMessage(content: string): string[]
}

/**
 * Retry helper for Discord MCP API calls.
 * @internal Only consumed by src/agent/discord-mcp-server.ts.
 */
export interface MCPRetryHelper {
    /** Execute a function with retry on transient failures */
    withRetry<T>(fn: () => Promise<T>): Promise<T>
}

/** Agent-owned JSON shape for Discord MCP search responses; it avoids integration imports. */
interface MCPMessageSearchResponse {
    messages:  { timestamp: string, localTimestamp?: string }[]
    overflow?:
      | { mode: 'count-only', count: number, hint?: string }
      | { mode: 'summarized', count: number, batchSummaries: unknown[], summarizedCount: number, hint?: string }
    metadata: {
        coverage:         'complete' | 'limitReached'
        fetched:          number
        matchedInFetched: number
        [key: string]:    unknown
    }
    [key: string]: unknown
}

/** Discord message search service port. */
export interface MCPMessageSearchService {
    searchMessages(params: { channelId?: string, query?: string, startTime?: Date, endTime?: Date, limit?: number }): Promise<MCPMessageSearchResponse>
    getRecentMessages(channelId: string, limit?: number): Promise<MCPMessageSearchResponse>
    getMessageById(channelId: string, messageId: string): Promise<{ localTimestamp?: string, timestamp: string, [key: string]: unknown } | null>
    getMessagesById(channelId: string, messageIds: string[]): Promise<{ localTimestamp?: string, timestamp: string, [key: string]: unknown }[]>
}

/**
 * Unread Discord message shape for the Discord inbox MCP server.
 * @internal Only consumed within src/agent/ (MCPInboxManager interface).
 */
interface MCPUnreadMessage {
    id:          string
    channelId:   ChannelId
    channelName: string
    guildId:     string
    author:      string
    content:     string
    timestamp:   string
    isRead:      boolean
}

/**
 * Metadata from a Discord inbox message.
 * @internal Only consumed by src/agent/discord-inbox-mcp-server.ts.
 */
export interface MCPMessageMetadata {
    id:        string
    author:    string
    timestamp: string
    sizeChars: number
}

/**
 * Unread Discord inbox overview.
 * @internal Only consumed within src/agent/ (MCPInboxManager interface).
 */
interface MCPUnreadOverview {
    totalUnread: number
    channels:    { channelId: ChannelId, channelName: string, messageCount: number }[]
}

/**
 * Discord inbox channel summary response.
 * @internal Only consumed by src/agent/discord-inbox-mcp-server.ts.
 */
export interface MCPChannelSummaryResponse {
    channelId:    ChannelId
    channelName:  string
    messageCount: number
    summary:      string
    authors:      string[]
    timeRange:    { start: string, end: string }
    messages:     MCPMessageMetadata[]
}

/**
 * Discord inbox manager port.
 * @internal Only consumed by src/agent/discord-inbox-mcp-server.ts.
 */
export interface MCPInboxManager {
    /** Get a high-level overview of unread messages across all channels */
    getUnreadOverview(): MCPUnreadOverview
    /** Get all unread messages in a specific channel */
    getChannelMessages(channelId: ChannelId): MCPUnreadMessage[]
    /** Get a specific message by channel and message ID */
    getMessage(channelId: ChannelId, messageId: string): MCPUnreadMessage | undefined
    /** Mark specific messages as read */
    markAsRead(channelId: ChannelId, messageIds: string[]): Promise<void>
    /** Mark all messages in a channel as read */
    markChannelRead(channelId: ChannelId): Promise<void>
}
