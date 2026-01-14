import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import _ from 'lodash';
import type { MessageSearchService } from '../integrations/discord/message-history/search';

/**
 * Creates an MCP server for Discord message history operations.
 *
 * Provides tools for:
 * - Searching messages by text, time range, or both
 * - Getting recent messages from a channel
 * - Fetching specific messages by ID
 *
 * This server wraps the MessageSearchService for use with the Claude Agent SDK.
 */
export function createDiscordMCPServer(searchService: MessageSearchService) {
    return createSdkMcpServer({
        name:    'discord',
        version: '1.0.0',
        tools:   [
            tool(
                'searchMessages',
                'Search Discord message history by text, time range, or both. Returns messages with overflow summaries if results exceed limit.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID to search in'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    query:     z.string().optional().describe('Text to search for in message content'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startTime: z.string().optional().describe('Start of time range (ISO 8601 format)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endTime:   z.string().optional().describe('End of time range (ISO 8601 format)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().max(100).optional().describe('Maximum messages to return (default 10, max 100)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await searchService.searchMessages({
                            channelId: args.channelId,
                            query:     args.query,
                            startTime: args.startTime ? new Date(args.startTime) : undefined,
                            endTime:   args.endTime ? new Date(args.endTime) : undefined,
                            // Stryker disable next-line LogicalOperator: ?? operator provides default value
                            limit:     args.limit ?? 10,
                        });
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'getRecentMessages',
                'Get the most recent messages from a Discord channel',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().max(100).optional().describe('Number of messages to return (default 10, max 100)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await searchService.getRecentMessages(
                            args.channelId,
                            // Stryker disable next-line LogicalOperator: ?? operator provides default value, tested via integration
                            args.limit ?? 10
                        );
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'getMessageById',
                'Fetch a specific Discord message by its ID, or multiple messages by an array of IDs',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    messageId: z.union([z.string(), z.array(z.string())]).describe('Discord message ID or array of message IDs'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Handle array input
                        if(_.isArray(args.messageId)) {
                            const results = await searchService.getMessagesById(
                                args.channelId,
                                args.messageId
                            );
                            return {
                                content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
                            };
                        }

                        // Handle single string input (existing logic)
                        const result = await searchService.getMessageById(
                            args.channelId,
                            args.messageId
                        );
                        if(!result) {
                            return {
                                content: [{ type: 'text' as const, text: 'Message not found' }],
                            };
                        }
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),
        ],
    });
}
