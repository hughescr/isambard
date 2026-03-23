import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import {
    BskyAllowlist,
    BskyOutboundApprovalHandler,
    BskyRejectionBackend,
    buildBskyApprovalEmbed,
    type BlueskyClient
} from '@/integrations/bsky';
import { SendRateLimiter } from '@/integrations/email';
import { retryAsync } from '@/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BskySetupOptions {
    bskyClient:            BlueskyClient
    docClient:             DynamoDBDocumentClient
    tableName:             string
    /** Discord client instance */
    client:                Client
    /** Discord channel ID for admin approval embeds */
    adminDiscordChannelId: string
}

export interface BskySetupResult {
    allowlist:               BskyAllowlist
    rateLimiter:             SendRateLimiter
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
 * - BskyAllowlist (loaded from DynamoDB)
 * - SendRateLimiter (capacity=24, refill=1/hr)
 * - sendApprovalRequest callback (posts approval embed to admin channel, retries 3x)
 * - sendDMApprovalRequest callback (posts DM approval embed to admin channel, retries 3x)
 * - BskyOutboundApprovalHandler for Discord button interactions
 *
 * @param options - Bsky setup options
 * @returns Bsky components for lifecycle management and MCP server wiring
 */
export async function setupBsky(options: BskySetupOptions): Promise<BskySetupResult> {
    const { bskyClient, docClient, tableName, client, adminDiscordChannelId } = options;

    // Create and load allowlist from DynamoDB into memory cache
    const allowlist = new BskyAllowlist(docClient, tableName);
    await allowlist.load();

    // Create rejection backend for persisting admin-rejected posts/DMs
    const rejectionBackend = new BskyRejectionBackend(docClient, tableName);

    // Create rate limiter for outbound Bluesky posts
    // Stryker disable next-line ObjectLiteral: SendRateLimiter config object is integration wiring
    const rateLimiter = new SendRateLimiter({ capacity: 24, refillRatePerHour: 1 });

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
            // ignore — parent text is optional in the embed
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

        // Retry channel.send() up to 3 times; errors propagate to caller after exhaustion
        await retryAsync(async () => {
            const channel = await client.channels.fetch(adminDiscordChannelId);
            if(channel && 'send' in channel) {
                await channel.send({ embeds: [embed], components: [actionRow] });
            } else {
                throw new Error(`Admin channel ${adminDiscordChannelId} is not a sendable text channel`);
            }
        }, { policy: { maxAttempts: 3 } });
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

        await retryAsync(async () => {
            const channel = await client.channels.fetch(adminDiscordChannelId);
            if(channel && 'send' in channel) {
                await channel.send({ embeds: [embed], components: [actionRow] });
            } else {
                throw new Error(`Admin channel ${adminDiscordChannelId} is not a sendable text channel`);
            }
        }, { policy: { maxAttempts: 3 } });
    };
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression,LogicalOperator

    // Create outbound approval handler (handles bsky-send-* and bsky-dm-* button/modal interactions)
    // Stryker disable next-line ObjectLiteral: outbound approval handler wiring is integration-only
    const outboundApprovalHandler = new BskyOutboundApprovalHandler({
        client: bskyClient,
        allowlist,
        rejectionBackend,
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
