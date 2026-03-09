import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult, mcpTextResult } from './mcp-helpers';
import type { BskyCheckpointManager, BlueskyClient, BskyFeedItem } from '@/integrations/bsky';

/** Shared pagination schema fields for feed tools that support checkpointing. */
const FEED_PAGINATION_SCHEMA = {
    // Stryker disable next-line StringLiteral: describe() is documentation only
    limit:            z.number().int().positive().optional().describe('Maximum number of items to return'),
    // Stryker disable next-line StringLiteral: describe() is documentation only
    cursor:           z.string().optional().describe('Pagination cursor from previous response'),
    // Stryker disable next-line StringLiteral,BooleanLiteral: describe() is documentation only, default is configuration
    includeProcessed: z.boolean().optional().default(false).describe('Include already-processed items (default: false)'),
} as const;

/** Builds the checkpointed feed response shape shared by getFeed and getAuthorFeed. */
function buildCheckpointedResponse(newItems: BskyFeedItem[], cursor: string | undefined, totalFetched: number) {
    return { items: newItems, cursor, newCount: newItems.length, totalFetched };
}

/**
 * Creates an MCP server for Bluesky operations.
 *
 * Provides tools for:
 * - Reading feeds (following, for-you, discover, or custom AT URI)
 * - Getting notifications
 * - Searching posts
 * - Fetching individual posts by AT URI
 * - Fetching user profiles
 * - Reading an author's post feed
 * - Liking posts
 * - Following or unfollowing users
 * - Sending new posts
 * - Replying to existing posts
 *
 * This server wraps the BlueskyClient for use with the Claude Agent SDK.
 * When a checkpoint manager is provided, getFeed, getNotifications, and getAuthorFeed
 * will automatically filter out already-processed items and persist checkpoints.
 */

export function createBskyMCPServer(client: BlueskyClient, checkpointManager?: BskyCheckpointManager) {
    return createSdkMcpServer({
        name:    'bsky',
        version: '1.0.0',
        tools:   [
            tool(
                'getFeed',
                'Read a Bluesky feed',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    feedName: z.string().optional().describe("Feed name: 'for-you' (default), 'following', 'discover', or a raw at:// URI"),
                    ...FEED_PAGINATION_SCHEMA,
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const feedName = args.feedName ?? 'for-you';
                        const result   = await client.getFeed(feedName, args.limit, args.cursor);

                        if(!checkpointManager || args.includeProcessed) {
                            return mcpJsonResult(result);
                        }

                        const { newItems, totalFetched } = await checkpointManager.processFeedItems(feedName, result.items);

                        return mcpJsonResult(buildCheckpointedResponse(newItems, result.cursor, totalFetched));
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Feed', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'getNotifications',
                'Get recent Bluesky notifications',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:            z.number().int().positive().optional().describe('Maximum number of notifications to return'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    cursor:           z.string().optional().describe('Pagination cursor from previous response'),
                    // Stryker disable next-line StringLiteral,BooleanLiteral: describe() is documentation only, default is configuration
                    includeProcessed: z.boolean().optional().default(false).describe('Include already-processed notifications (default: false)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.getNotifications(args.limit, args.cursor);

                        if(!checkpointManager || args.includeProcessed) {
                            return mcpJsonResult(result);
                        }

                        const { newNotifications, totalFetched, lastSeenAt, hadExistingCheckpoint } = await checkpointManager.processNotifications(result.notifications);

                        // Mark as seen when there are new notifications OR this is the first poll (no prior checkpoint).
                        // On first poll, we always want to mark the current position as seen so subsequent polls
                        // only surface truly new activity.
                        // Stryker disable next-line ConditionalExpression: compound guard — mutations collapse to a single branch that causes either spurious or missed updateNotificationsSeen calls
                        if(newNotifications.length > 0 || !hadExistingCheckpoint) {
                            // Use max of lastSeenAt (if defined) and current time to guard against clock drift.
                            // When lastSeenAt is undefined (empty first poll), fall back to current time directly.
                            const latestMs = lastSeenAt === undefined ? 0 : new Date(lastSeenAt).getTime();
                            const seenAt   = new Date(Math.max(latestMs, Date.now())).toISOString();
                            await client.updateNotificationsSeen(seenAt);
                        }

                        return mcpJsonResult({
                            notifications: newNotifications,
                            cursor:        result.cursor,
                            newCount:      newNotifications.length,
                            totalFetched,
                        });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Notifications', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'searchPosts',
                'Search Bluesky posts',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    query:  z.string().describe('Search query'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:  z.number().int().positive().optional().describe('Maximum number of results to return'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    cursor: z.string().optional().describe('Pagination cursor from previous response'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.searchPosts(args.query, args.limit, args.cursor);
                        return mcpJsonResult(result);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Search Posts', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getPost',
                'Get a Bluesky post by AT URI',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    uri: z.string().describe('AT URI of the post (e.g., at://did:plc:abc123/app.bsky.feed.post/xyz)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.getPost(args.uri);
                        return mcpJsonResult(result);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Post', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getProfile',
                'Get a Bluesky user profile',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.getProfile(args.actor);
                        return mcpJsonResult(result);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Profile', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getAuthorFeed',
                "Read a user's recent posts on Bluesky",
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                    ...FEED_PAGINATION_SCHEMA,
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.getAuthorFeed(args.actor, args.limit, args.cursor);

                        if(!checkpointManager || args.includeProcessed) {
                            return mcpJsonResult(result);
                        }

                        // Resolve actor to canonical DID for consistent checkpoint keying
                        const profile  = await client.getProfile(args.actor);
                        const actorDid = profile.did;

                        const { newItems, totalFetched } = await checkpointManager.processFeedItems(actorDid, result.items);

                        return mcpJsonResult(buildCheckpointedResponse(newItems, result.cursor, totalFetched));
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Author Feed', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'likePost',
                'Like a Bluesky post',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    uri: z.string().describe('AT URI of the post to like'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    cid: z.string().describe('CID of the post to like'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const post = await client.getPost(args.uri);
                        if(post.viewer?.like) {
                            return mcpTextResult('Post already liked');
                        }
                        await client.likePost(args.uri, args.cid);
                        return mcpTextResult('Post liked successfully');
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Like Post', readOnlyHint: false, destructiveHint: false, idempotentHint: true } }
            ),

            tool(
                'toggleFollow',
                'Follow or unfollow a Bluesky user (toggles current state)',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID of the user to follow/unfollow"),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.toggleFollow(args.actor);
                        const action = result.followed ? 'Followed' : 'Unfollowed';
                        return mcpTextResult(`${action} ${args.actor} successfully`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Toggle Follow', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'sendPost',
                'Post a new message to Bluesky',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    text: z.string().describe('The text content of the post'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.sendPost(args.text);
                        return {
                            // Stryker disable next-line StringLiteral: success message is informational only
                            content: [{ type: 'text' as const, text: `Post sent successfully: ${result.uri}` }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Send Post', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'replyToPost',
                'Reply to an existing Bluesky post',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    text:      z.string().describe('The text content of the reply'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    parentUri: z.string().describe('AT URI of the post to reply to'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    parentCid: z.string().describe('CID of the post to reply to'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    rootUri:   z.string().optional().describe('AT URI of the root/thread post (defaults to parentUri for top-level replies)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    rootCid:   z.string().optional().describe('CID of the root/thread post (defaults to parentCid for top-level replies)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.replyToPost(args.text, args.parentUri, args.parentCid, args.rootUri, args.rootCid);
                        return {
                            // Stryker disable next-line StringLiteral: success message is informational only
                            content: [{ type: 'text' as const, text: `Reply sent successfully: ${result.uri}` }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Reply To Post', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),
        ],
    });
}
