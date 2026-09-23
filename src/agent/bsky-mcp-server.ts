import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult, mcpTextResult, withHealthGuard, withWriteHealthGuard, withToolErrorHandling } from './mcp-helpers';
import { createAtUri, createCid, type BskyCheckpointManager, type BlueskyClient, type BskyConversation, type BskyFeedItem, type BskyRejectionBackend, type BskyDirectMessage, type BskyReplyInput, type BskyStrongRef } from '@/integrations/bsky';
import type { ServiceHealthRegistry, ReconnectionLoop, TokenBucketRateLimiter } from '@/services';
import type { PersonAllowlist } from '@/storage';
/** Shared pagination schema fields for feed tools that support checkpointing. */
const FEED_PAGINATION_SCHEMA = {
    limit:            z.number().int().positive().optional().describe('Maximum number of items to return'),
    cursor:           z.string().optional().describe('Pagination cursor from previous response'),
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
    client:                 BlueskyClient
    checkpointManager?:     BskyCheckpointManager
    rateLimiter?:           TokenBucketRateLimiter
    allowlist?:             PersonAllowlist
    rejectionBackend?:      BskyRejectionBackend
    sendApprovalRequest?:   (text: string, targetHandle: string, reply: BskyReplyInput) => Promise<void>
    sendDMApprovalRequest?: (text: string, targetHandles: string[], convoId: string) => Promise<void>
    healthRegistry?:        ServiceHealthRegistry
    reconnectionLoop?:      ReconnectionLoop
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

/**
 * Collects video playlist URLs from a DM's embedded record.
 * Note: Only covers videos nested in quoted/forwarded posts, not direct video sends.
 * Direct video embeds in DMs would require extending normalizeMessage to handle non-record embeds.
 */
function collectVideoPlaylistsFromDM(msg: BskyDirectMessage): string[] {
    const playlists: string[] = [];
    for(const nested of msg.embed?.embeds ?? []) {
        // Stryker disable next-line llm: nested.type is a string-literal discriminator, so loose and strict equality against 'video' coincide.
        if(nested.type === 'video') {
            // Stryker disable next-line llm: the 'video' discriminator narrows to the union member whose video field is always built by normalizeVideoEmbed, so optional chaining is a no-op.
            playlists.push(nested.video.playlist);
        }
    }
    return playlists;
}

/**
 * Build a video embed hint text block for MCP tool responses.
 * Returns undefined when no video playlists are found.
 */

function buildVideoEmbedHint(playlists: string[]): string | undefined {
    if(playlists.length === 0) {
        return undefined;
    }
    const label = playlists.length === 1 ? 'This response contains a video embed' : 'This response contains video embeds';
    const lines  = playlists.map(url => `  - ${url}`);
    return `Note: ${label}. Use the analyzeVideoFromUrl tool to analyze:\n${lines.join('\n')}`;
}

export function createBskyMCPServer(options: BskyMCPServerOptions) {
    const { client, checkpointManager, rateLimiter, allowlist, sendApprovalRequest, sendDMApprovalRequest } = options;

    function buildRateLimitWarning(): string {
        if(!rateLimiter?.isAtLimit()) {
            return '';
        }
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
                    feedName: z.string().optional().describe("Feed name: 'for-you' (default), 'following', 'discover', or a raw at:// URI"),
                    ...FEED_PAGINATION_SCHEMA,
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('getFeed', async (args): Promise<CallToolResult> => {
                        const feedName = args.feedName ?? 'for-you';
                        const result   = await client.getFeed(feedName, args.limit, args.cursor);

                        if(!checkpointManager || args.includeProcessed) {
                            return mcpJsonResult(result);
                        }

                        const { newItems, totalFetched } = await checkpointManager.processFeedItems(feedName, result.items);

                        return mcpJsonResult(buildCheckpointedResponse(newItems, result.cursor, totalFetched));
                    })),
                { annotations: { title: 'Get Feed', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'getNotifications',
                'Get recent Bluesky notifications',
                {
                    limit:            z.number().int().positive().optional().describe('Maximum number of notifications to return'),
                    cursor:           z.string().optional().describe('Pagination cursor from previous response'),
                    includeProcessed: z.boolean().optional().default(false).describe('Include already-processed notifications (default: false)'),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('getNotifications', async (args): Promise<CallToolResult> => {
                        const result = await client.getNotifications(args.limit, args.cursor);

                        if(!checkpointManager || args.includeProcessed) {
                            return mcpJsonResult(result);
                        }

                        const { newNotifications, totalFetched, lastSeenAt, hadExistingCheckpoint } = await checkpointManager.processNotifications(result.notifications);

                        // Mark as seen when there are new notifications OR this is the first poll (no prior checkpoint).
                        // On first poll, we always want to mark the current position as seen so subsequent polls
                        // only surface truly new activity.
                        if(newNotifications.length > 0 || !hadExistingCheckpoint) {
                        // Use max of lastSeenAt (if defined) and current time to guard against clock drift.
                        // When lastSeenAt is undefined (empty first poll), fall back to current time directly.
                            // Stryker disable next-line llm,NumberLiteralValue: the undefined-lastSeenAt fallback is dominated by Date.now() in the Math.max below; only a pre-epoch or backwards mocked clock could tell 0 from 1, -1 or Date.now()
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
                    })),
                { annotations: { title: 'Get Notifications', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'searchPosts',
                'Search Bluesky posts',
                {
                    query:  z.string().describe('Search query'),
                    limit:  z.number().int().positive().optional().describe('Maximum number of results to return'),
                    cursor: z.string().optional().describe('Pagination cursor from previous response'),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('searchPosts', async (args): Promise<CallToolResult> => {
                        const result = await client.searchPosts(args.query, args.limit, args.cursor);
                        return mcpJsonResult(result);
                    })),
                { annotations: { title: 'Search Posts', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getPost',
                'Get a Bluesky post by AT URI',
                {
                    uri: z.string().describe('AT URI of the post (e.g., at://did:plc:abc123/app.bsky.feed.post/xyz)'),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('getPost', async (args): Promise<CallToolResult> => {
                        const result = await client.getPost(args.uri);
                        return mcpJsonResult(result);
                    })),
                { annotations: { title: 'Get Post', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getProfile',
                'Get a Bluesky user profile',
                {
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('getProfile', async (args): Promise<CallToolResult> => {
                        const result = await client.getProfile(args.actor);
                        return mcpJsonResult(result);
                    })),
                { annotations: { title: 'Get Profile', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getAuthorFeed',
                "Read a user's recent posts on Bluesky",
                {
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                    ...FEED_PAGINATION_SCHEMA,
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('getAuthorFeed', async (args): Promise<CallToolResult> => {
                        const result = await client.getAuthorFeed(args.actor, args.limit, args.cursor);

                        if(!checkpointManager || args.includeProcessed) {
                            return mcpJsonResult(result);
                        }

                        // Resolve actor to canonical DID for consistent checkpoint keying
                        const profile  = await client.getProfile(args.actor);
                        const actorDid = profile.did;

                        const { newItems, totalFetched } = await checkpointManager.processFeedItems(actorDid, result.items);

                        return mcpJsonResult(buildCheckpointedResponse(newItems, result.cursor, totalFetched));
                    })),
                { annotations: { title: 'Get Author Feed', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'likePost',
                'Like a Bluesky post',
                {
                    uri: z.string().describe('AT URI of the post to like'),
                    cid: z.string().describe('CID of the post to like'),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('likePost', async (args): Promise<CallToolResult> => {
                        const post = await client.getPost(args.uri);
                        if(post.viewer?.like) {
                            return mcpTextResult('Post already liked');
                        }
                        await client.likePost({ uri: createAtUri(args.uri), cid: createCid(args.cid) });
                        return mcpTextResult('Post liked successfully');
                    })),
                { annotations: { title: 'Like Post', readOnlyHint: false, destructiveHint: false, idempotentHint: true } }
            ),

            tool(
                'follow',
                'Follow a Bluesky user',
                {
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('follow', async (args): Promise<CallToolResult> => {
                        const result = await client.follow(args.actor);
                        if(result.alreadyFollowing) {
                            return mcpTextResult(`Already following ${args.actor}`);
                        }
                        return mcpTextResult(`Followed ${args.actor} successfully`);
                    })),
                { annotations: { title: 'Follow', readOnlyHint: false, destructiveHint: false, idempotentHint: true } }
            ),

            tool(
                'unfollow',
                'Unfollow a Bluesky user',
                {
                    actor: z.string().describe("Handle (e.g., 'alice.bsky.social') or DID"),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('unfollow', async (args): Promise<CallToolResult> => {
                        const result = await client.unfollow(args.actor);
                        if(!result.wasFollowing) {
                            return mcpTextResult(`Not following ${args.actor}`);
                        }
                        return mcpTextResult(`Unfollowed ${args.actor} successfully`);
                    })),
                { annotations: { title: 'Unfollow', readOnlyHint: false, destructiveHint: true, idempotentHint: true } }
            ),

            tool(
                'sendPost',
                'Post a new message to Bluesky',
                {
                    text: z.string().describe('The text content of the post'),
                },
                withWriteHealthGuard(options.healthRegistry, 'bsky', 'discord', options.reconnectionLoop,
                    withToolErrorHandling('sendPost', async (args): Promise<CallToolResult> => {
                        const result           = await client.sendPost(args.text);
                        const rateLimitWarning = buildRateLimitWarning();
                        rateLimiter?.increment();
                        return mcpTextResult(`Post sent successfully: ${result.uri}${rateLimitWarning}`);
                    })),
                { annotations: { title: 'Send Post', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'replyToPost',
                'Reply to an existing Bluesky post. If the target author is on the allowlist, sends immediately. Otherwise, requests admin approval via Discord.',
                {
                    text:   z.string().describe('The text content of the reply'),
                    parent: z.object({
                        uri: z.string().describe('AT URI of the post to reply to'),
                        cid: z.string().describe('CID of the post to reply to'),
                    }).describe('The post being replied to'),
                    root: z.object({
                        uri: z.string().describe('AT URI of the thread root post'),
                        cid: z.string().describe('CID of the thread root post'),
                    }).optional().describe('The thread root post (auto-resolved from parent for nested replies; only needed to override)'),
                },
                withWriteHealthGuard(options.healthRegistry, 'bsky', 'discord', options.reconnectionLoop,
                    withToolErrorHandling('replyToPost', async (args): Promise<CallToolResult> => {
                        // Fetch parent post to determine the target author and resolve thread root
                        const parentPost   = await client.getPost(args.parent.uri);
                        const targetHandle = parentPost.author.handle;

                        const parent: BskyStrongRef = { uri: createAtUri(args.parent.uri), cid: createCid(args.parent.cid) };

                        // Auto-resolve root from the parent post's own thread when not explicitly overridden.
                        const root: BskyStrongRef | undefined = args.root
                            ? { uri: createAtUri(args.root.uri), cid: createCid(args.root.cid) }
                            : parentPost.replyRef?.root;

                        const reply: BskyReplyInput = { parent, root };

                        // Check if replying to own post (always allowed — threading own posts)
                        const isSelfReply = targetHandle === client.ownHandle;

                        // Check if target is allowlisted (by handle or DID).
                        // Self-replies and missing allowlist are always allowed.
                        const isAllowed = isSelfReply || !allowlist || allowlist.isAllowed('bsky', targetHandle);

                        if(isAllowed) {
                        // Allowlisted — send immediately
                            const result           = await client.replyToPost(args.text, reply);
                            const rateLimitWarning = buildRateLimitWarning();
                            rateLimiter?.increment();
                            return mcpTextResult(`Reply sent successfully: ${result.uri}${rateLimitWarning}`);
                        }

                        // Not allowlisted — request admin approval
                        await client.validatePostText(args.text);
                        if(sendApprovalRequest) {
                            try {
                                await sendApprovalRequest(args.text, targetHandle, reply);
                                return mcpTextResult(`Reply to ${targetHandle} requires approval. Approval request sent to admin.`);
                            } catch (error) {
                                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send bsky approval request' });
                                return mcpErrorResult(new Error(`Reply to ${targetHandle} requires approval but failed to send approval request to admin. Please try again later.`));
                            }
                        }

                        // No approval callback — just inform
                        return mcpTextResult(`Reply to ${targetHandle} requires approval but no approval handler is configured.`);
                    })),
                { annotations: { title: 'Reply To Post', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'listConversations',
                'List Bluesky direct message conversations',
                {
                    limit:     z.number().int().positive().optional().describe('Maximum number of conversations to return'),
                    cursor:    z.string().optional().describe('Pagination cursor from previous response'),
                    readState: z.string().optional().describe("Filter by read state: 'unread' for only unread conversations"),
                    status:    z.string().optional().describe("Filter by status: 'request' or 'accepted'"),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('listConversations', async (args): Promise<CallToolResult> => {
                        const result          = await client.listConversations(args.limit, args.cursor, args.readState, args.status);
                        const conversations   = result.conversations.map(convo => transformConversation(convo));
                        return mcpJsonResult({ conversations, cursor: result.cursor });
                    })),
                { annotations: { title: 'List Conversations', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getDirectMessages',
                'Get direct messages with specific Bluesky users. Automatically marks the conversation as read.',
                {
                    recipients: z.array(z.string()).min(1).describe("Handles of the users (e.g., ['alice.bsky.social'])"),
                    limit:      z.number().int().positive().optional().describe('Maximum number of messages to return'),
                    cursor:     z.string().optional().describe('Pagination cursor from previous response'),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('getDirectMessages', async (args): Promise<CallToolResult> => {
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
                        try {
                            await client.markConversationRead(convo.id);
                        } catch (markError) {
                            logger.warn({ error: markError instanceof Error ? markError.message : String(markError), msg: 'Failed to mark conversation as read' });
                        }

                        // Build DID→handle map from conversation members
                        const didToHandle = new Map(convo.members.map(m => [m.did, m.handle]));

                        // Transform messages: replace senderDid with senderHandle
                        const messages = result.messages.map((msg) => {
                            const { senderDid, ...rest } = msg;
                            return { ...rest, senderHandle: didToHandle.get(senderDid) ?? senderDid };
                        });

                        const baseResult = mcpJsonResult({ messages, cursor: result.cursor });

                        // Collect video embed playlists from all messages and append hint
                        const playlists = result.messages.flatMap(msg => collectVideoPlaylistsFromDM(msg));
                        const hint      = buildVideoEmbedHint(playlists);
                        if(hint) {
                            // Stryker disable next-line SpreadOperandDrop: mcpJsonResult has only content, which this literal replaces explicitly.
                            return { ...baseResult, content: [...baseResult.content, { type: 'text' as const, text: hint }] };
                        }

                        return baseResult;
                    })),
                { annotations: { title: 'Get Direct Messages', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'sendDirectMessage',
                'Send a direct message to Bluesky users. If recipients are on the allowlist, sends immediately. Otherwise, requests admin approval via Discord.',
                {
                    recipients: z.array(z.string()).min(1).describe("Handles of the recipients (e.g., ['alice.bsky.social'])"),
                    text:       z.string().describe('The text content of the message'),
                },
                withWriteHealthGuard(options.healthRegistry, 'bsky', 'discord', options.reconnectionLoop,
                    withToolErrorHandling('sendDirectMessage', async (args): Promise<CallToolResult> => {
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
                        const allAllowed = isSelfDM || !allowlist || resolvedRecipients.every(
                            r => allowlist.isAllowed('bsky', r.handle)
                        );

                        const dids  = resolvedRecipients.map(r => r.did);
                        const convo = await client.getConversationForMembers(dids);

                        if(allAllowed) {
                        // Allowlisted — send immediately
                            await client.sendDirectMessage(convo.id, args.text);
                            const rateLimitWarning = buildRateLimitWarning();
                            rateLimiter?.increment();
                            return mcpTextResult(`DM sent successfully${rateLimitWarning}`);
                        }

                        // Not allowlisted — request admin approval
                        await client.validateDMText(args.text);
                        if(sendDMApprovalRequest) {
                            try {
                                const allHandles = resolvedRecipients.map(r => r.handle);
                                await sendDMApprovalRequest(args.text, allHandles, convo.id);
                                return mcpTextResult('DM requires approval. Approval request sent to admin.');
                            } catch (error) {
                                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send bsky DM approval request' });
                                return mcpErrorResult(new Error('DM requires approval but failed to send approval request to admin. Please try again later.'));
                            }
                        }

                        // No approval callback — just inform
                        return mcpTextResult('DM requires approval but no approval handler is configured.');
                    })),
                { annotations: { title: 'Send Direct Message', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'listRejectedPosts',
                'List Bluesky posts and DMs that were rejected by admin. Shows rejection reason and all parameters needed to retry with revised content.',
                {},
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('listRejectedPosts', async (): Promise<CallToolResult> => {
                        if(!options.rejectionBackend) {
                            return mcpErrorResult('Rejection tracking is not configured');
                        }
                        const items = await options.rejectionBackend.listRejections();
                        if(items.length === 0) {
                            return mcpTextResult('No rejected posts or DMs pending review.');
                        }
                        return mcpJsonResult(items);
                    })),
                { annotations: { title: 'List Rejected Posts', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'clearRejection',
                'Clear a specific rejected post/DM after reviewing it. Use the uuid from listRejectedPosts.',
                {
                    uuid: z.uuid().describe('UUID of the rejection to clear (from listRejectedPosts)'),
                },
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('clearRejection', async (input): Promise<CallToolResult> => {
                        if(!options.rejectionBackend) {
                            return mcpErrorResult('Rejection tracking is not configured');
                        }
                        await options.rejectionBackend.deleteRejection(input.uuid);
                        return mcpTextResult(`Cleared rejection ${input.uuid}`);
                    })),
                { annotations: { title: 'Clear Rejection', readOnlyHint: false, destructiveHint: true, idempotentHint: true } }
            ),

            tool(
                'clearAllRejections',
                'Clear all rejected posts/DMs after reviewing them.',
                {},
                withHealthGuard(options.healthRegistry, 'bsky', options.reconnectionLoop,
                    withToolErrorHandling('clearAllRejections', async (): Promise<CallToolResult> => {
                        if(!options.rejectionBackend) {
                            return mcpErrorResult('Rejection tracking is not configured');
                        }
                        const count = await options.rejectionBackend.clearAll();
                        if(count === 0) {
                            return mcpTextResult('No rejections to clear.');
                        }
                        return mcpTextResult(`Cleared ${count} rejection${count === 1 ? '' : 's'}.`);
                    })),
                { annotations: { title: 'Clear All Rejections', readOnlyHint: false, destructiveHint: true, idempotentHint: false } }
            ),

        ],
    });
}
