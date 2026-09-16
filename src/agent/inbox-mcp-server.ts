import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { chain } from 'lodash-es';
import { z } from 'zod';
import { mcpJsonResult, withHealthGuard, withToolErrorHandling } from './mcp-helpers';
import { generateTextWithSystemPrompt } from './text-generator';
import { createChannelId, type MCPInboxManager, type MCPChannelRegistry, type MCPChannelSummaryResponse, type MCPMessageMetadata } from './types';
import { InvariantViolationError } from '@/errors';
import type { ServiceHealthRegistry, ReconnectionLoop } from '@/services';

/**
 * System prompt for generating channel summaries.
 * Used by the getChannelSummary tool to create concise summaries of unread messages.
 */
const SUMMARY_SYSTEM_PROMPT = `You are summarizing Discord messages for an AI assistant who missed them while offline.
Create a concise summary (2-4 sentences) that captures:
- Key topics or questions discussed
- Who participated and what they said
- Any action items or requests directed at the assistant

Keep it factual and actionable. The assistant will decide whether to read full messages based on this summary.`;

/**
 * Creates an MCP server for inbox operations.
 *
 * Provides tools for:
 * - Getting high-level overview of unread messages across all channels
 * - Getting AI-generated summaries of unread messages in specific channels
 * - Fetching full content of specific messages by ID
 * - Marking messages as read
 * - Marking entire channels as read
 *
 * This server uses a two-tier approach:
 * 1. Tier 1: Quick overview and AI summaries to understand the gist
 * 2. Tier 2: Full message content on demand
 *
 * The inbox manager maintains an in-memory queue of unread messages,
 * loaded on startup by fetching messages since the last checkpoint.
 *
 * @param inboxManager - Inbox manager for accessing unread messages
 * @param channelRegistry - Channel registry for resolving channel names
 */
export function createInboxMCPServer(
    inboxManager: MCPInboxManager,
    channelRegistry: MCPChannelRegistry,
    healthRegistry?: ServiceHealthRegistry,
    reconnectionLoop?: ReconnectionLoop
) {
    return createSdkMcpServer({
        name:    'inbox',
        version: '1.0.0',
        tools:   [
            tool(
                'getUnreadOverview',
                'Get a high-level overview of unread messages across all channels. Returns counts only, no message content.',
                {},
                withHealthGuard(healthRegistry, 'discord', reconnectionLoop,
                    withToolErrorHandling('getUnreadOverview', async (): Promise<CallToolResult> => {
                        const overview = inboxManager.getUnreadOverview();

                        logger.info({
                            totalUnread:  overview.totalUnread,
                            channelCount: overview.channels.length,
                            msg:          'Unread overview retrieved',
                        });

                        return mcpJsonResult(overview);
                    }))
            ),

            tool(
                'getChannelSummary',
                'Get an AI-generated summary of unread messages in a channel, plus message metadata for selective reading. Accepts channel ID or #channel-name format.',
                {
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                },
                withHealthGuard(healthRegistry, 'discord', reconnectionLoop,
                    withToolErrorHandling('getChannelSummary', async (args): Promise<CallToolResult> => {
                        const channelId = createChannelId(channelRegistry.resolveChannelId(args.channelId));
                        const messages = inboxManager.getChannelMessages(channelId);

                        // Stryker disable next-line llm: getChannelMessages returns an array whose length is nonnegative, so added falsy and `<= 0` checks are equivalent.
                        if(messages.length === 0) {
                            return mcpJsonResult({
                                channelId:    args.channelId,
                                channelName:  args.channelId,
                                messageCount: 0,
                                summary:      'No unread messages in this channel.',
                                authors:      [],
                                timeRange:    { start: '', end: '' },
                                messages:     [],
                            });
                        }

                        // Build message content for summarization
                        const messagesText = messages.map(m =>
                            `[${m.author} at ${m.timestamp}]: ${m.content}`).join('\n');

                        // Generate AI summary
                        const summary = await generateTextWithSystemPrompt(
                            SUMMARY_SYSTEM_PROMPT,
                            `Summarize these ${messages.length} messages:\n\n${messagesText}`
                        );

                        // Build metadata for each message
                        const metadata: MCPMessageMetadata[] = messages.map(m => ({
                            id:        m.id,
                            author:    m.author,
                            timestamp: m.timestamp,
                            sizeChars: m.content.length,
                        }));

                        // Get unique authors
                        const authors = chain(messages).map('author').uniq().value();

                        // Get time range
                        const timestamps = chain(messages).map('timestamp').sortBy().value();
                        const firstTimestamp = timestamps[0];
                        const lastTimestamp  = timestamps[timestamps.length - 1];
                        if(lastTimestamp === undefined) {
                            // note(inbox-mcp): structured refactor to return mcpErrorResult would improve agent UX here
                            throw new InvariantViolationError('channelSummary tool', 'timestamps empty despite messages.length > 0');
                        }
                        const timeRange = {
                            start: firstTimestamp!,
                            end:   lastTimestamp,
                        };

                        const firstMessage = messages[0]!;
                        const response: MCPChannelSummaryResponse = {
                            channelId,
                            channelName:  firstMessage.channelName,
                            messageCount: messages.length,
                            summary:      summary || 'Unable to generate summary.',
                            authors,
                            timeRange,
                            messages:     metadata,
                        };

                        logger.info({
                            channelId,
                            channelName:  firstMessage.channelName,
                            messageCount: messages.length,
                            authorCount:  authors.length,
                            msg:          'Channel summary generated',
                        });

                        return mcpJsonResult(response);
                    }))
            ),

            tool(
                'fetchMessages',
                'Fetch full content of specific messages by ID. Use after reviewing channel summary to get details. Accepts channel ID or #channel-name format.',
                {
                    channelId:  z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    messageIds: z.array(z.string()).describe('Array of message IDs to fetch'),
                },
                withHealthGuard(healthRegistry, 'discord', reconnectionLoop,
                    withToolErrorHandling('fetchMessages', async (args): Promise<CallToolResult> => {
                        // Stryker disable next-line llm: args.channelId is a required z.string() arg; .toString() on a string is the identity function.
                        const channelId = createChannelId(channelRegistry.resolveChannelId(args.channelId));

                        const fetchedMessages = [];

                        for(const messageId of args.messageIds) {
                            // Stryker disable next-line llm: messageId is a required z.array(z.string()) element, never nullish, so `?? ''` is unreachable.
                            const msg = inboxManager.getMessage(channelId, messageId);
                            if(msg) {
                                fetchedMessages.push({
                                    // Stryker disable next-line llm: msg.id: string is non-nullable by type, so the `??` fallback is unreachable.
                                    id:        msg.id,
                                    // Stryker disable next-line llm: msg.author: string is non-nullable by type, so the `??` fallback is unreachable.
                                    author:    msg.author,
                                    timestamp: msg.timestamp,
                                    // Stryker disable next-line llm: msg.content: string is non-nullable by type, so the `??` fallback is unreachable.
                                    content:   msg.content,
                                });
                            }
                        }

                        logger.info({
                            channelId,
                            requestedCount: args.messageIds.length,
                            // Stryker disable next-line llm: a - (a - b) is an algebraic identity equal to b for finite integer array lengths.
                            fetchedCount:   fetchedMessages.length,
                            msg:            'Messages fetched',
                        });

                        return mcpJsonResult({ messages: fetchedMessages });
                    }))
            ),

            tool(
                'markAsRead',
                'Mark specific messages as read. Updates the checkpoint for the channel. Accepts channel ID or #channel-name format.',
                {
                    channelId:  z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    messageIds: z.array(z.string()).describe('Array of message IDs to mark as read'),
                },
                withHealthGuard(healthRegistry, 'discord', reconnectionLoop,
                    withToolErrorHandling('markAsRead', async (args): Promise<CallToolResult> => {
                        const channelId = createChannelId(channelRegistry.resolveChannelId(args.channelId));
                        await inboxManager.markAsRead(channelId, args.messageIds);

                        logger.info({
                            channelId,
                            markedCount: args.messageIds.length,
                            msg:         'Messages marked as read',
                        });

                        return mcpJsonResult({ success: true, markedCount: args.messageIds.length });
                    }))
            ),

            tool(
                'markChannelRead',
                'Mark all messages in a channel as read. Updates the checkpoint to the latest message. Accepts channel ID or #channel-name format.',
                {
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                },
                withHealthGuard(healthRegistry, 'discord', reconnectionLoop,
                    withToolErrorHandling('markChannelRead', async (args): Promise<CallToolResult> => {
                        const channelId = createChannelId(channelRegistry.resolveChannelId(args.channelId));
                        await inboxManager.markChannelRead(channelId);

                        logger.info({
                            channelId,
                            msg: 'Channel marked as read',
                        });

                        return mcpJsonResult({ success: true });
                    }))
            ),
        ],
    });
}
