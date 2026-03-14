import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult, mcpTextResult } from './mcp-helpers';
import type { BskyAllowlist, BskyCheckpointManager, BlueskyClient, BskyFeedItem } from '@/integrations/bsky';
import type { SendRateLimiter } from '@/integrations/email';

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
 *
 * ## Bluesky Etiquette
 *
 * When posting or replying on Bluesky, be mindful of social norms:
 * - Consider whether you're replying to a friend or a stranger — uninvited replies
 *   to strangers should add genuine value, not just be "nice bot" engagement
 * - Avoid dunking, ratio-seeking, or pile-ons — even if you disagree
 * - Don't post just to be visible — post when you have something worth saying
 * - Keep a healthy ratio: read and like far more than you post or reply
 * - Be authentic and conversational, not performative or promotional
 * - Respect the 300-character limit — brevity is a feature, not a constraint
 * - If unsure whether to reply, observe instead
 */

export interface BskyMCPServerOptions {
    client:               BlueskyClient
    checkpointManager?:   BskyCheckpointManager
    rateLimiter?:         SendRateLimiter
    allowlist?:           BskyAllowlist
    sendApprovalRequest?: (text: string, targetHandle: string, parentUri: string, parentCid: string,
        rootUri?: string, rootCid?: string) => Promise<void>
}

export function createBskyMCPServer(options: BskyMCPServerOptions) {
    const { client, checkpointManager, rateLimiter, allowlist, sendApprovalRequest } = options;

    function buildRateLimitWarning(): string {
        if(!rateLimiter?.isAtLimit()) {
            // Stryker disable next-line StringLiteral: initial empty string for rateLimitWarning
            return '';
        }
        // Stryker disable next-line StringLiteral: Warning message is configuration
        return ` Warning: send rate limit reached (${rateLimiter.tokensRemaining()} tokens remaining).`;
    }

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
                        const result           = await client.sendPost(args.text);
                        const rateLimitWarning = buildRateLimitWarning();
                        rateLimiter?.increment();
                        // Stryker disable next-line StringLiteral: success message is informational only
                        return mcpTextResult(`Post sent successfully: ${result.uri}${rateLimitWarning}`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Send Post', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'replyToPost',
                'Reply to an existing Bluesky post. If the target author is on the allowlist, sends immediately. Otherwise, requests admin approval via Discord.',
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
                        // Fetch parent post to determine the target author
                        const parentPost   = await client.getPost(args.parentUri);
                        const targetHandle = parentPost.author.handle;
                        const targetDid    = parentPost.author.did;

                        // Check if replying to own post (always allowed — threading own posts)
                        const isSelfReply = targetHandle === client.ownHandle;

                        // Check if target is allowlisted (by handle or DID).
                        // Self-replies and missing allowlist are always allowed.
                        // Stryker disable next-line ConditionalExpression: allowlist guard — self-reply, no-allowlist, handle, and DID checks all needed
                        const isAllowed = isSelfReply || !allowlist || allowlist.isAllowed(targetHandle) || allowlist.isAllowed(targetDid);

                        if(isAllowed) {
                            // Allowlisted — send immediately
                            const result           = await client.replyToPost(args.text, args.parentUri, args.parentCid, args.rootUri, args.rootCid);
                            const rateLimitWarning = buildRateLimitWarning();
                            rateLimiter?.increment();
                            // Stryker disable next-line StringLiteral: success message is informational only
                            return mcpTextResult(`Reply sent successfully: ${result.uri}${rateLimitWarning}`);
                        }

                        // Not allowlisted — request admin approval
                        if(sendApprovalRequest) {
                            try {
                                await sendApprovalRequest(args.text, targetHandle, args.parentUri, args.parentCid, args.rootUri, args.rootCid);
                                // Stryker disable next-line StringLiteral: success message is informational only
                                return mcpTextResult(`Reply to ${targetHandle} requires approval. Approval request sent to admin.`);
                            } catch (error) {
                                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send bsky approval request' });
                                // Stryker disable next-line StringLiteral: error message is informational only
                                return mcpErrorResult(new Error(`Reply to ${targetHandle} requires approval but failed to send approval request to admin. Please try again later.`));
                            }
                        }

                        // No approval callback — just inform
                        // Stryker disable next-line StringLiteral: informational message is not behavior-affecting
                        return mcpTextResult(`Reply to ${targetHandle} requires approval but no approval handler is configured.`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Reply To Post', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),
        ],
    });
}
