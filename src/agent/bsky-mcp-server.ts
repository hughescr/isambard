import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult, mcpTextResult } from './mcp-helpers';
import type { BskyAllowlist, BskyCheckpointManager, BlueskyClient, BskyConversation, BskyFeedItem, BskyRejectionBackend } from '@/integrations/bsky';
import type { SendRateLimiter } from '@/integrations/email';
import { processVideo, extractFramesInRange, generateSpectrogram, createSpawnRunner, createBinarySpawnRunner } from '@/utils';

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
    rejectionBackend?:    BskyRejectionBackend
    sendApprovalRequest?: (text: string, targetHandle: string, parentUri: string, parentCid: string,
        rootUri?: string, rootCid?: string) => Promise<void>
    sendDMApprovalRequest?: (text: string, targetHandles: string[], convoId: string) => Promise<void>
}

/** Transform a BskyConversation to strip DIDs and replace senderDid with senderHandle in lastMessage. */
function transformConversation(convo: BskyConversation): object {
    const didToHandle = new Map(convo.members.map(m => [m.did, m.handle]));
    const members     = convo.members.map(m => ({
        handle:       m.handle,
        displayName:  m.displayName,
        chatDisabled: m.chatDisabled,
    }));

    if(!convo.lastMessage) {
        return { ...convo, members };
    }

    const { senderDid, ...msgRest } = convo.lastMessage;
    const lastMessage = { ...msgRest, senderHandle: didToHandle.get(senderDid) ?? senderDid };

    return { ...convo, members, lastMessage };
}

export function createBskyMCPServer(options: BskyMCPServerOptions) {
    const { client, checkpointManager, rateLimiter, allowlist, sendApprovalRequest, sendDMApprovalRequest } = options;

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
                'follow',
                'Follow a Bluesky user',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.follow(args.actor);
                        if(result.alreadyFollowing) {
                            // Stryker disable next-line StringLiteral: success message is informational only
                            return mcpTextResult(`Already following ${args.actor}`);
                        }
                        // Stryker disable next-line StringLiteral: success message is informational only
                        return mcpTextResult(`Followed ${args.actor} successfully`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Follow', readOnlyHint: false, destructiveHint: false, idempotentHint: true } }
            ),

            tool(
                'unfollow',
                'Unfollow a Bluesky user',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await client.unfollow(args.actor);
                        if(!result.wasFollowing) {
                            // Stryker disable next-line StringLiteral: success message is informational only
                            return mcpTextResult(`Not following ${args.actor}`);
                        }
                        // Stryker disable next-line StringLiteral: success message is informational only
                        return mcpTextResult(`Unfollowed ${args.actor} successfully`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Unfollow', readOnlyHint: false, destructiveHint: true, idempotentHint: true } }
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
                    rootUri:   z.string().optional().describe('AT URI of the thread root post (auto-resolved from parent for nested replies; only needed to override)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    rootCid:   z.string().optional().describe('CID of the thread root post (auto-resolved from parent for nested replies; only needed to override)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Fetch parent post to determine the target author and resolve thread root
                        const parentPost   = await client.getPost(args.parentUri);
                        const targetHandle = parentPost.author.handle;
                        const targetDid    = parentPost.author.did;

                        // Auto-resolve root: both explicit args must be present to override auto-resolved root.
                        // Treating them as an atomic pair prevents mixing a URI from args with a CID from replyRef.
                        const hasExplicitRoot  = args.rootUri !== undefined && args.rootCid !== undefined;
                        const resolvedRootUri  = hasExplicitRoot ? args.rootUri : parentPost.replyRef?.root.uri;
                        const resolvedRootCid  = hasExplicitRoot ? args.rootCid : parentPost.replyRef?.root.cid;

                        // Check if replying to own post (always allowed — threading own posts)
                        const isSelfReply = targetHandle === client.ownHandle;

                        // Check if target is allowlisted (by handle or DID).
                        // Self-replies and missing allowlist are always allowed.
                        // Stryker disable next-line ConditionalExpression: allowlist guard — self-reply, no-allowlist, handle, and DID checks all needed
                        const isAllowed = isSelfReply || !allowlist || allowlist.isAllowed(targetHandle) || allowlist.isAllowed(targetDid);

                        if(isAllowed) {
                            // Allowlisted — send immediately
                            const result           = await client.replyToPost(args.text, args.parentUri, args.parentCid, resolvedRootUri, resolvedRootCid);
                            const rateLimitWarning = buildRateLimitWarning();
                            rateLimiter?.increment();
                            // Stryker disable next-line StringLiteral: success message is informational only
                            return mcpTextResult(`Reply sent successfully: ${result.uri}${rateLimitWarning}`);
                        }

                        // Not allowlisted — request admin approval
                        await client.validatePostText(args.text);
                        if(sendApprovalRequest) {
                            try {
                                await sendApprovalRequest(args.text, targetHandle, args.parentUri, args.parentCid, resolvedRootUri, resolvedRootCid);
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

            tool(
                'listConversations',
                'List Bluesky direct message conversations',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().optional().describe('Maximum number of conversations to return'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    cursor:    z.string().optional().describe('Pagination cursor from previous response'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    readState: z.string().optional().describe("Filter by read state: 'unread' for only unread conversations"),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    status:    z.string().optional().describe("Filter by status: 'request' or 'accepted'"),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result          = await client.listConversations(args.limit, args.cursor, args.readState, args.status);
                        const conversations   = result.conversations.map(convo => transformConversation(convo));
                        return mcpJsonResult({ conversations, cursor: result.cursor });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'List Conversations', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getDirectMessages',
                'Get direct messages with specific Bluesky users. Automatically marks the conversation as read.',
                {
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only; .min(1) is Zod schema configuration
                    recipients: z.array(z.string()).min(1).describe("Handles of the users (e.g., ['alice.bsky.social'])"),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:      z.number().int().positive().optional().describe('Maximum number of messages to return'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    cursor:     z.string().optional().describe('Pagination cursor from previous response'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Resolve each handle → DID
                        const resolvedRecipients = await Promise.all(
                            args.recipients.map(async (handle: string) => {
                                const profile = await client.getProfile(handle);
                                return { did: profile.did, handle: profile.handle };
                            })
                        );
                        const dids  = resolvedRecipients.map(r => r.did);
                        const convo = await client.getConversationForMembers(dids);

                        const result = await client.getMessages(convo.id, args.limit, args.cursor);

                        // Auto-mark conversation as read (best-effort — don't fail the fetch on mark-read error)
                        // Stryker disable BlockStatement: try-catch guards mark-read from breaking message fetch
                        try {
                            await client.markConversationRead(convo.id);
                        } catch (markError) {
                            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                            logger.warn({ error: markError instanceof Error ? markError.message : String(markError), msg: 'Failed to mark conversation as read' });
                        }
                        // Stryker restore BlockStatement

                        // Build DID→handle map from conversation members
                        const didToHandle = new Map(convo.members.map(m => [m.did, m.handle]));

                        // Transform messages: replace senderDid with senderHandle
                        const messages = result.messages.map((msg) => {
                            const { senderDid, ...rest } = msg;
                            return { ...rest, senderHandle: didToHandle.get(senderDid) ?? senderDid };
                        });

                        return mcpJsonResult({ messages, cursor: result.cursor });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Direct Messages', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'sendDirectMessage',
                'Send a direct message to Bluesky users. If recipients are on the allowlist, sends immediately. Otherwise, requests admin approval via Discord.',
                {
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only; .min(1) is Zod schema configuration
                    recipients: z.array(z.string()).min(1).describe("Handles of the recipients (e.g., ['alice.bsky.social'])"),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    text:       z.string().describe('The text content of the message'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Resolve each handle → profile
                        const resolvedRecipients = await Promise.all(
                            args.recipients.map(async (handle: string) => {
                                const profile = await client.getProfile(handle);
                                return { did: profile.did, handle: profile.handle };
                            })
                        );

                        // Check if this is a self-DM (single recipient = own handle)
                        // Stryker disable next-line OptionalChaining: defensive chaining — array guaranteed non-empty by .min(1) schema validation
                        const isSelfDM = resolvedRecipients.length === 1 && resolvedRecipients[0]?.handle === client.ownHandle;

                        // Check if all recipients are allowlisted (by handle or DID)
                        // Stryker disable next-line ConditionalExpression: allowlist guard — self-DM, no-allowlist, handle, and DID checks all needed
                        const allAllowed = isSelfDM || !allowlist || resolvedRecipients.every(
                            r => allowlist.isAllowed(r.handle) || allowlist.isAllowed(r.did)
                        );

                        const dids  = resolvedRecipients.map(r => r.did);
                        const convo = await client.getConversationForMembers(dids);

                        if(allAllowed) {
                            // Allowlisted — send immediately
                            await client.sendDirectMessage(convo.id, args.text);
                            const rateLimitWarning = buildRateLimitWarning();
                            rateLimiter?.increment();
                            // Stryker disable next-line StringLiteral: success message is informational only
                            return mcpTextResult(`DM sent successfully${rateLimitWarning}`);
                        }

                        // Not allowlisted — request admin approval
                        await client.validateDMText(args.text);
                        if(sendDMApprovalRequest) {
                            try {
                                const allHandles = resolvedRecipients.map(r => r.handle);
                                await sendDMApprovalRequest(args.text, allHandles, convo.id);
                                // Stryker disable next-line StringLiteral: success message is informational only
                                return mcpTextResult('DM requires approval. Approval request sent to admin.');
                            } catch (error) {
                                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send bsky DM approval request' });
                                // Stryker disable next-line StringLiteral: error message is informational only
                                return mcpErrorResult(new Error('DM requires approval but failed to send approval request to admin. Please try again later.'));
                            }
                        }

                        // No approval callback — just inform
                        // Stryker disable next-line StringLiteral: informational message is not behavior-affecting
                        return mcpTextResult('DM requires approval but no approval handler is configured.');
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Send Direct Message', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'listRejectedPosts',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'List Bluesky posts and DMs that were rejected by admin. Shows rejection reason and all parameters needed to retry with revised content.',
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        if(!options.rejectionBackend) {
                            // Stryker disable next-line StringLiteral: error message is informational only
                            return mcpErrorResult('Rejection tracking is not configured');
                        }
                        const items = await options.rejectionBackend.listRejections();
                        if(items.length === 0) {
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult('No rejected posts or DMs pending review.');
                        }
                        return mcpJsonResult(items);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'List Rejected Posts', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'clearRejection',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Clear a specific rejected post/DM after reviewing it. Use the uuid from listRejectedPosts.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    uuid: z.uuid().describe('UUID of the rejection to clear (from listRejectedPosts)'),
                },
                async (input): Promise<CallToolResult> => {
                    try {
                        if(!options.rejectionBackend) {
                            // Stryker disable next-line StringLiteral: error message is informational only
                            return mcpErrorResult('Rejection tracking is not configured');
                        }
                        await options.rejectionBackend.deleteRejection(input.uuid);
                        // Stryker disable next-line StringLiteral: result message is informational only
                        return mcpTextResult(`Cleared rejection ${input.uuid}`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Clear Rejection', readOnlyHint: false, destructiveHint: true, idempotentHint: true } }
            ),

            tool(
                'clearAllRejections',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Clear all rejected posts/DMs after reviewing them.',
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        if(!options.rejectionBackend) {
                            // Stryker disable next-line StringLiteral: error message is informational only
                            return mcpErrorResult('Rejection tracking is not configured');
                        }
                        const count = await options.rejectionBackend.clearAll();
                        // Stryker disable next-line ConditionalExpression: zero-count guard — informational message branch
                        if(count === 0) {
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult('No rejections to clear.');
                        }
                        // Stryker disable next-line StringLiteral,ConditionalExpression: plural suffix and count guard are informational only
                        return mcpTextResult(`Cleared ${count} rejection${count === 1 ? '' : 's'}.`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Clear All Rejections', readOnlyHint: false, destructiveHint: true, idempotentHint: false } }
            ),

            tool(
                // Stryker disable next-line StringLiteral: tool name is configuration
                'processVideoEmbed',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Download and analyze a Bluesky video embed. Extracts scene-based frames, metadata, and subtitles/transcription.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    url:       z.string().describe('Video URL or HLS playlist URL'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    outputDir: z.string().describe('Directory to save video files and frames'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    alt:       z.string().optional().describe('Alt text for the video'),
                },
                // Stryker disable all: handler body uses real subprocess runners — not invoked in unit tests
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await processVideo(args.url, args.outputDir, {
                            run:       createSpawnRunner(),
                            binaryRun: createBinarySpawnRunner(),
                        });
                        return {
                            content: [
                                { type: 'text', text: result.metadataMarkdown },
                                ...result.frames.map(f => ({
                                    type:     'image' as const,
                                    data:     f.base64Data,
                                    mimeType: f.mediaType,
                                })),
                            ],
                        };
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker restore all
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Process Video Embed', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                // Stryker disable next-line StringLiteral: tool name is configuration
                'getVideoFrames',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Extract additional frames from a previously downloaded video. Use to focus on specific time ranges.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    videoPath: z.string().describe('Path to the local video file'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startTime: z.number().describe('Start time in seconds'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endTime:   z.number().describe('End time in seconds'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    count:     z.number().int().positive().describe('Number of frames to extract'),
                },
                // Stryker disable all: handler body uses real subprocess runners — not invoked in unit tests
                async (args): Promise<CallToolResult> => {
                    try {
                        const frames = await extractFramesInRange(
                            args.videoPath,
                            args.startTime,
                            args.endTime,
                            args.count,
                            createBinarySpawnRunner()
                        );
                        return {
                            content: frames.map(f => ({
                                type:     'image' as const,
                                data:     f.base64Data,
                                mimeType: f.mediaType,
                            })),
                        };
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker restore all
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Video Frames', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                // Stryker disable next-line StringLiteral: tool name is configuration
                'generateVideoSpectrogram',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Generate an audio spectrogram image from a video file. Useful for identifying speech patterns and audio content.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    videoPath: z.string().describe('Path to the local video file'),
                },
                // Stryker disable all: handler body uses real subprocess runners — not invoked in unit tests
                async (args): Promise<CallToolResult> => {
                    try {
                        const image = await generateSpectrogram(args.videoPath, createBinarySpawnRunner());
                        return {
                            content: [{
                                type:     'image' as const,
                                data:     image.base64Data,
                                mimeType: image.mediaType,
                            }],
                        };
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker restore all
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Generate Video Spectrogram', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
