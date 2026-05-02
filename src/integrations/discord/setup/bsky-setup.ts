import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import type { ActivityLogger } from '@/agent';
import {
    BskyOutboundApprovalHandler,
    BskyRejectionBackend,
    buildBskyApprovalEmbed,
    type BlueskyClient
} from '@/integrations/bsky';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import type { DiscordCapability } from '@/integrations/discord/capability';
import { TokenBucketRateLimiter, type ApprovalSagaBackend } from '@/services';
import type { DynamoDBClientHolder, PersonAllowlist } from '@/storage';
import { retryAsync } from '@/utils';

/** Type guard: check if a Discord channel supports sending messages (has send method). */
function isSendableChannel(channel: unknown): channel is { send: (options: unknown) => Promise<unknown> } {
    return typeof channel === 'object' && channel !== null && 'send' in channel;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BskySetupOptions {
    bskyClient:                  BlueskyClient
    docClient:                   DynamoDBDocumentClient | DynamoDBClientHolder
    tableName:                   string
    /** Discord client instance */
    client:                      Client
    /** Discord channel ID for admin approval embeds */
    adminDiscordChannelId:       string
    /** Approval saga backend for durable approval workflows */
    approvalSagaBackend:         ApprovalSagaBackend
    /** Optional activity logger for recording approval events */
    activityLogger?:             ActivityLogger
    /**
     * Optional Discord capability facade.
     * When provided, approval embeds are sent via the facade (with outbox fallback
     * when Discord is offline) instead of calling channel.send() directly.
     */
    discordCapability?:          DiscordCapability
    /** @internal Dependency injection for testing (e.g. fast sleep) */
    _deps?:                      { sleep?: (ms: number) => Promise<void> }
    /** Pre-loaded PersonAllowlist for gating outbound Bluesky posts and DMs */
    personAllowlist:             PersonAllowlist
    /** Allowlist interaction handler for the saga-based allowlist flow */
    allowlistInteractionHandler: AllowlistInteractionHandler
}

export interface BskySetupResult {
    allowlist:               PersonAllowlist
    rateLimiter:             TokenBucketRateLimiter
    rejectionBackend:        BskyRejectionBackend
    outboundApprovalHandler: BskyOutboundApprovalHandler
    /** sendApprovalRequest callback for MCP server integration */
    sendApprovalRequest: (
        text:         string,
        targetHandle: string,
        parentUri:    string,
        parentCid:    string,
        rootUri?:     string,
        rootCid?:     string
    ) => Promise<void>
    /** sendDMApprovalRequest callback for DM MCP server integration */
    sendDMApprovalRequest: (
        text:            string,
        targetHandles:   string[],
        convoId:         string
    ) => Promise<void>
}

// ---------------------------------------------------------------------------
// Bsky setup
// ---------------------------------------------------------------------------

/**
 * Initialize all Bluesky integration components for Discord wiring.
 *
 * Creates:
 * - PersonAllowlist (loaded from DynamoDB, passed in via options)
 * - TokenBucketRateLimiter (capacity=24, refill=1/hr)
 * - sendApprovalRequest callback (posts approval embed to admin channel, retries 3x)
 * - sendDMApprovalRequest callback (posts DM approval embed to admin channel, retries 3x)
 * - BskyOutboundApprovalHandler for Discord button interactions
 *
 * @param options - Bsky setup options
 * @returns Bsky components for lifecycle management and MCP server wiring
 */
export async function setupBsky(options: BskySetupOptions): Promise<BskySetupResult> {
    const { bskyClient, docClient, tableName, client, adminDiscordChannelId } = options;
    // Stryker disable next-line ObjectLiteral: Dependency injection for testability — sleep override is a no-op in production
    const retryDeps = options._deps?.sleep ? { deps: { sleep: options._deps.sleep } } : {};

    // Use the pre-loaded PersonAllowlist passed in by the caller
    const allowlist = options.personAllowlist;

    // Create rejection backend for persisting admin-rejected posts/DMs
    const rejectionBackend = new BskyRejectionBackend(docClient, tableName);

    // Create rate limiter for outbound Bluesky posts
    // Stryker disable next-line ObjectLiteral: TokenBucketRateLimiter config object is integration wiring
    const rateLimiter = new TokenBucketRateLimiter({ capacity: 24, refillRatePerHour: 1 });

    // Build sendApprovalRequest callback (posts approval embed to #admin channel)
    // Retries up to 3 times on transient failures. Propagates error to caller after exhaustion.
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression: sendApprovalRequest callback is integration wiring
    const sendApprovalRequest = async (
        text:         string,
        targetHandle: string,
        parentUri:    string,
        parentCid:    string,
        rootUri?:     string,
        rootCid?:     string
    ): Promise<void> => {
        // Fetch parent post preview text (best-effort)
        let parentText: string | undefined;
        try {
            const parentPost = await bskyClient.getPost(parentUri);
            parentText = parentPost.text;
        } catch{
            // Silent: fetching the parent post preview is purely cosmetic enrichment for
            // the approval embed. If the post is deleted, rate-limited, or otherwise
            // unavailable, the embed renders without a preview — still fully functional.
        }

        const { embed, actionRow } = buildBskyApprovalEmbed({
            type: 'reply',
            text,
            targetHandle,
            parentUri,
            parentCid,
            rootUri,
            rootCid,
            parentText,
        });

        // When capability is available, use it for outbox fallback; otherwise retry channel.send() up to 3 times
        await (options.discordCapability
            ? options.discordCapability.sendToChannel(
                adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                { priority: 'high', type: 'bsky_approval' }
            )
            : retryAsync(async () => {
                const channel = await client.channels.fetch(adminDiscordChannelId);
                if(isSendableChannel(channel)) {
                    await channel.send({ embeds: [embed], components: [actionRow] });
                } else {
                    throw new Error(`Admin channel ${adminDiscordChannelId} is not a sendable text channel`);
                }
            }, { policy: { maxAttempts: 3 }, ...retryDeps }));
    };
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression

    // Build sendDMApprovalRequest callback (posts DM approval embed to #admin channel)
    // Retries up to 3 times on transient failures. Propagates error to caller after exhaustion.
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression,LogicalOperator: sendDMApprovalRequest callback is integration wiring
    const sendDMApprovalRequest = async (
        text:          string,
        targetHandles: string[],
        convoId:       string
    ): Promise<void> => {
        const { embed, actionRow } = buildBskyApprovalEmbed({
            type:             'dm',
            text,
            targetHandle:     targetHandles[0] ?? '',
            recipientHandles: targetHandles,
            convoId,
        });

        // When capability is available, use it for outbox fallback; otherwise retry channel.send() up to 3 times
        await (options.discordCapability
            ? options.discordCapability.sendToChannel(
                adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                { priority: 'high', type: 'bsky_approval' }
            )
            : retryAsync(async () => {
                const channel = await client.channels.fetch(adminDiscordChannelId);
                if(isSendableChannel(channel)) {
                    await channel.send({ embeds: [embed], components: [actionRow] });
                } else {
                    throw new Error(`Admin channel ${adminDiscordChannelId} is not a sendable text channel`);
                }
            }, { policy: { maxAttempts: 3 }, ...retryDeps }));
    };
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression,LogicalOperator

    // Create outbound approval handler (handles bsky-send-* and bsky-dm-* button/modal interactions)
    // Stryker disable next-line ObjectLiteral: outbound approval handler wiring is integration-only
    const outboundApprovalHandler = new BskyOutboundApprovalHandler({
        client:                      bskyClient,
        rejectionBackend,
        sagaBackend:                 options.approvalSagaBackend,
        activityLogger:              options.activityLogger,
        allowlistInteractionHandler: options.allowlistInteractionHandler,
    });

    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
    logger.info({ msg: 'Bluesky integration initialized' });

    // Stryker disable next-line ObjectLiteral: return object is integration wiring
    return {
        allowlist,
        rateLimiter,
        rejectionBackend,
        outboundApprovalHandler,
        sendApprovalRequest,
        sendDMApprovalRequest,
    };
}
