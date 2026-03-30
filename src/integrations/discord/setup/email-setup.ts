import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type Client, type MessageCreateOptions, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmailMCPServer, type ActivityLogger } from '@/agent';
import type { EmailConfig } from '@/config';
import { type ChannelId, createChannelId } from '@/integrations/discord/types';
import {
    EmailClassifier,
    EmailAllowlist,
    EmailProcessor,
    WildDuckListener,
    ReviewHandler,
    buildReviewEmbed,
    buildUnsafeAlert,
    buildRestrictedAccessEmbed,
    EmailFolder,
    WildDuckClient,
    SendRateLimiter,
    OutboundApprovalHandler
} from '@/integrations/email';
import { retryAsync } from '@/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailSetupOptions {
    emailConfig:        EmailConfig
    docClient:          DynamoDBDocumentClient
    tableName:          string
    /** Discord client instance */
    client:             Client
    /** Admin Discord user ID for authorization checks */
    adminDiscordUserId: string
    /** Optional activity logger for recording approval events */
    activityLogger?:    ActivityLogger
}

export interface EmailSetupResult {
    listener:                WildDuckListener
    reviewHandler:           ReviewHandler
    emailMcpServer:          McpServerConfig
    outboundApprovalHandler: OutboundApprovalHandler
    wildDuckClient:          WildDuckClient
    /** The email allowlist — exposed so the caller can wire it into AllowlistCommandHandler */
    allowlist:               EmailAllowlist
    /** Discord channel ID for the admin email channel, used to auto-mute it at startup */
    adminChannelId:          ChannelId
}

// ---------------------------------------------------------------------------
// Email setup
// ---------------------------------------------------------------------------

/**
 * Initialize all email integration components.
 *
 * Creates:
 * - WildDuck client, classifier, allowlist
 * - EmailProcessor with Discord DM callbacks for uncertain/unsafe verdicts
 * - WildDuckListener (NOT started — caller starts it after Discord client ready)
 * - ReviewHandler for button interactions
 * - Email MCP server for Claude agent
 *
 * @param options - Email setup options
 * @returns Email components for lifecycle management
 */
export async function setupEmail(options: EmailSetupOptions): Promise<EmailSetupResult> {
    const { emailConfig, docClient, tableName, client, adminDiscordUserId } = options;

    // Create classifier, allowlist
    const classifier = new EmailClassifier();
    const allowlist  = new EmailAllowlist(docClient, tableName);

    // Load allowlist from DynamoDB into memory cache
    await allowlist.load();

    // Create WildDuck client (required — wildDuckApiUrl is required in the config schema)
    // Stryker disable ObjectLiteral,StringLiteral: WildDuck client wiring is integration-only
    const wildDuckClient = new WildDuckClient({
        url:              emailConfig.wildDuckApiUrl,
        user:             emailConfig.user,
        password:         emailConfig.password,
        maxBodySizeBytes: emailConfig.maxBodySizeBytes,
    });
    // Stryker restore ObjectLiteral,StringLiteral
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('Starting WildDuck client...');
    await wildDuckClient.init();
    // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
    logger.info('WildDuck client initialized');

    // Create processor with Discord admin channel callbacks
    // Stryker disable ObjectLiteral,BlockStatement,ArrayDeclaration,StringLiteral: EmailProcessor config and callbacks are integration wiring - not unit testable
    const processor = new EmailProcessor(
        { allowlist, classifier, wildDuckClient },
        {
            onSafe: async (email, _verdict) => {
                await sendToAdminChannel(
                    client,
                    emailConfig.adminDiscordChannelId,
                    { content: `Safe email from **${email.from.address}** — not on allowlist.\nSubject: ${email.subject}\n\nUse \`/allowlist add ${email.from.address}\` to add to allowlist.` },
                    'Failed to send safe-but-not-allowlisted notification to admin channel'
                );
            },
            onReview: async (email, _verdict) => {
                const { embed, actionRow } = buildReviewEmbed(email, EmailFolder.Review);
                await sendToAdminChannel(
                    client,
                    emailConfig.adminDiscordChannelId,
                    { embeds: [embed], components: [actionRow] },
                    'Failed to send email review embed to admin channel'
                );
            },
            onUnsafe: async (email, verdict) => {
                const { embed, actionRow } = buildUnsafeAlert(email, verdict, EmailFolder.Quarantine);
                await sendToAdminChannel(
                    client,
                    emailConfig.adminDiscordChannelId,
                    { embeds: [embed], components: [actionRow] },
                    'Failed to send unsafe alert to admin channel'
                );
            },
        }
    );
    // Stryker restore ObjectLiteral,BlockStatement,ArrayDeclaration,StringLiteral

    // Create review handler (handles email-* button interactions)
    // Stryker disable next-line ObjectLiteral: ReviewHandler config object is integration wiring
    const reviewHandler = new ReviewHandler({ wildDuckClient, allowlist, adminDiscordUserId });

    // Create rate limiter for outbound email
    // Stryker disable next-line ObjectLiteral: SendRateLimiter config object is integration wiring
    const rateLimiter = new SendRateLimiter({ capacity: emailConfig.sendReservoirCapacity, refillRatePerHour: emailConfig.sendReservoirRefillRatePerHour });

    // Build sendApprovalRequest callback (posts approval embed to #admin channel)
    // Retries up to 3 times on transient failures. Propagates error to caller after exhaustion.
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression: sendApprovalRequest callback is integration wiring
    const sendApprovalRequest = async (to: string, subject: string, draftUid: number, cc?: string[]): Promise<void> => {
        const BLUE = 0x00_99_FF;
        const embed = new EmbedBuilder()
            .setTitle('Outbound Email Approval Required')
            .setColor(BLUE)
            .addFields(
                { name: 'To',      value: to,      inline: true  },
                { name: 'Subject', value: subject, inline: true  },
                { name: 'UID',     value: String(draftUid), inline: true }
            );

        // Stryker disable next-line ConditionalExpression,EqualityOperator: cc field conditional is integration wiring
        if(cc && cc.length > 0) {
            embed.addFields({ name: 'CC', value: cc.join(', '), inline: true });
        }

        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`email-send-approve:${draftUid}`)
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`email-send-approveallowlist:${draftUid}`)
                .setLabel('Approve + Allowlist...')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`email-send-reject:${draftUid}`)
                .setLabel('Reject')
                .setStyle(ButtonStyle.Danger)
        );

        // Retry channel.send() up to 3 times; errors propagate to caller after exhaustion
        await retryAsync(async () => {
            const channel = await client.channels.fetch(emailConfig.adminDiscordChannelId);
            if(channel && 'send' in channel) {
                await channel.send({ embeds: [embed], components: [actionRow] });
            } else {
                throw new Error(`Admin channel ${emailConfig.adminDiscordChannelId} is not a sendable text channel`);
            }
        }, { policy: { maxAttempts: 3 } });
    };
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression

    // Create listener (not started yet — started in clientReady handler)
    // Must be created after sendApprovalRequest and wildDuckClient are defined.
    // Stryker disable next-line ObjectLiteral: WildDuckListener config object is integration wiring
    const listener = new WildDuckListener(wildDuckClient, processor, {
        pollFallbackMs:        emailConfig.pollFallbackMs,
        sseReconnectDelayMs:   emailConfig.sseReconnectDelayMs,
        onSendApprovalRequest: sendApprovalRequest,
    });

    // Create outbound approval handler (handles email-send-* button/modal interactions)
    // Stryker disable next-line ObjectLiteral: outbound approval handler wiring is integration-only
    const outboundApprovalHandler = new OutboundApprovalHandler({
        wildDuckClient,
        allowlist,
        activityLogger: options.activityLogger,
    });

    // Create email MCP server for Claude agent
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral,ArrayDeclaration: MCP server options and admin notification callback are integration wiring - not unit testable
    const emailMcpServer = createEmailMCPServer({
        sendAdminNotification: async ({ mailboxName, uid, reference }) => {
            const { embed, actionRow } = buildRestrictedAccessEmbed(mailboxName, uid, reference);
            await sendToAdminChannel(
                client,
                emailConfig.adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                'Failed to send restricted mailbox notification to admin channel'
            );
        },
        wildDuckClient,
        rateLimiter,
        allowlist,
        sendApprovalRequest,
    });
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral,ArrayDeclaration

    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
    logger.info({ msg: 'Email integration initialized' });

    // Stryker disable next-line ObjectLiteral: return object is integration wiring
    return {
        listener,
        reviewHandler,
        emailMcpServer,
        outboundApprovalHandler,
        wildDuckClient,
        allowlist,
        adminChannelId: createChannelId(emailConfig.adminDiscordChannelId),
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the admin Discord channel and send a message payload to it.
 * Errors are non-fatal — logs the provided error message and returns.
 */
// Stryker disable all: sendToAdminChannel is integration-only wiring — not unit testable
async function sendToAdminChannel(
    client:    Client,
    channelId: string,
    payload:   MessageCreateOptions,
    errorMsg:  string
): Promise<void> {
    try {
        const channel = await client.channels.fetch(channelId);
        if(channel && 'send' in channel) {
            await channel.send(payload);
        }
    } catch (err) {
        logger.error({
            error: err instanceof Error ? err.message : String(err),
            msg:   errorMsg,
        });
    }
}
// Stryker restore all
