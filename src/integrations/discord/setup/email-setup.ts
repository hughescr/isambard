import type { Client } from 'discord.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { EmailConfig } from '@/config/schemas';
import { type ChannelId, createChannelId } from '@/integrations/discord/types';
import { ImapConnection } from '@/integrations/email/imap-connection';
import { EmailClassifier } from '@/integrations/email/classifier';
import { EmailAllowlist } from '@/integrations/email/allowlist';
import { EmailCounterStore } from '@/integrations/email/email-counters';
import { EmailProcessor } from '@/integrations/email/email-processor';
import { ImapListener } from '@/integrations/email/imap-listener';
import { ReviewHandler } from '@/integrations/email/review-handler';
import { buildReviewEmbed, buildUnsafeAlert, buildRestrictedAccessEmbed } from '@/integrations/email/review-embed-builder';
import { AllowlistCommandHandler, buildAllowlistCommand } from '@/integrations/email/allowlist-commands';
import { EmailFolder } from '@/integrations/email/types';
import { WildDuckClient } from '@/integrations/email/wildduck-client';
import { SendRateLimiter } from '@/integrations/email/send-rate-limiter';
import { OutboundApprovalHandler } from '@/integrations/email/outbound-approval-handler';
import { createEmailMCPServer } from '@/agent/email-mcp-server';
import { retryAsync } from '@/utils/retry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailSetupOptions {
    emailConfig:   EmailConfig
    docClient:     DynamoDBDocumentClient
    tableName:     string
    /** Discord client instance */
    client:        Client
    /** Discord bot token for slash command registration */
    botToken:      string
    /** Discord application ID for slash command registration */
    applicationId: string
}

export interface EmailSetupResult {
    listener:                ImapListener
    reviewHandler:           ReviewHandler
    allowlistHandler:        AllowlistCommandHandler
    emailMcpServer:          McpServerConfig
    imap:                    ImapConnection
    counters:                EmailCounterStore
    outboundApprovalHandler: OutboundApprovalHandler
    wildDuckClient:          WildDuckClient
    /** Discord channel ID for the admin email channel, used to auto-mute it at startup */
    adminChannelId:          ChannelId
}

// ---------------------------------------------------------------------------
// Email setup
// ---------------------------------------------------------------------------

/**
 * Initialize all email integration components and register the /allowlist slash command.
 *
 * Creates:
 * - IMAP connection, classifier, allowlist, counters
 * - EmailProcessor with Discord DM callbacks for uncertain/unsafe verdicts
 * - ImapListener (NOT started — caller starts it after Discord client ready)
 * - ReviewHandler for button interactions
 * - AllowlistCommandHandler for slash command interactions
 * - Email MCP server for Claude agent
 * - Registers the /allowlist slash command with Discord via REST
 *
 * @param options - Email setup options
 * @returns Email components for lifecycle management
 */
export async function setupEmail(options: EmailSetupOptions): Promise<EmailSetupResult> {
    const { emailConfig, docClient, tableName, client, botToken, applicationId } = options;

    // Build IMAP connection
    // Stryker disable next-line ObjectLiteral: ImapConnection config object is integration wiring
    const imap = new ImapConnection({
        host:             emailConfig.imapHost,
        port:             emailConfig.imapPort,
        user:             emailConfig.user,
        password:         emailConfig.password,
        maxBodySizeBytes: emailConfig.maxBodySizeBytes,
        imapDebug:        emailConfig.imapDebug,
    });

    // Create classifier, allowlist, counters
    const classifier = new EmailClassifier();
    const allowlist  = new EmailAllowlist(docClient, tableName);
    const counters   = new EmailCounterStore(docClient, tableName);

    // Load allowlist from DynamoDB into memory cache
    await allowlist.load();

    // Create processor with Discord admin channel callbacks
    // Stryker disable ObjectLiteral,BlockStatement,ArrayDeclaration,StringLiteral: EmailProcessor config and callbacks are integration wiring - not unit testable
    const processor = new EmailProcessor(
        { allowlist, classifier, counters, imap },
        {
            onSafe: async (email, _verdict) => {
                try {
                    const channel = await client.channels.fetch(emailConfig.adminDiscordChannelId);
                    if(channel && 'send' in channel) {
                        await channel.send({
                            content: `Safe email from **${email.from.address}** — not on allowlist.\nSubject: ${email.subject}\n\nUse \`/allowlist add ${email.from.address}\` to add to allowlist.`,
                        });
                    }
                } catch (err) {
                    logger.error({
                        error: _.isError(err) ? err.message : String(err),
                        msg:   'Failed to send safe-but-not-allowlisted notification to admin channel',
                    });
                }
            },
            onReview: async (email, _verdict) => {
                try {
                    const { embed, actionRow } = buildReviewEmbed(email, EmailFolder.Review);
                    const channel = await client.channels.fetch(emailConfig.adminDiscordChannelId);
                    if(channel && 'send' in channel) {
                        await channel.send({ embeds: [embed], components: [actionRow] });
                    }
                } catch (err) {
                    logger.error({
                        error: _.isError(err) ? err.message : String(err),
                        msg:   'Failed to send email review embed to admin channel',
                    });
                }
            },
            onUnsafe: async (email, verdict) => {
                try {
                    const { embed, actionRow } = buildUnsafeAlert(email, verdict, EmailFolder.Quarantine);
                    const channel = await client.channels.fetch(emailConfig.adminDiscordChannelId);
                    if(channel && 'send' in channel) {
                        await channel.send({ embeds: [embed], components: [actionRow] });
                    }
                } catch (err) {
                    logger.error({
                        error: _.isError(err) ? err.message : String(err),
                        msg:   'Failed to send unsafe alert to admin channel',
                    });
                }
            },
        }
    );
    // Stryker restore ObjectLiteral,BlockStatement,ArrayDeclaration,StringLiteral

    // Create review handler (handles email-* button interactions)
    // Stryker disable next-line ObjectLiteral: ReviewHandler config object is integration wiring
    const reviewHandler = new ReviewHandler({ imap, counters, allowlist, adminDiscordUserId: emailConfig.adminDiscordUserId });

    // Create allowlist command handler (handles /allowlist interactions)
    const allowlistHandler = new AllowlistCommandHandler(allowlist, emailConfig.adminDiscordUserId);

    // Create WildDuck client (required — wildDuckApiUrl is required in the config schema)
    // Stryker disable ObjectLiteral,StringLiteral: WildDuck client wiring is integration-only
    const wildDuckClient = new WildDuckClient({
        url:          emailConfig.wildDuckApiUrl,
        imapUser:     emailConfig.user,
        imapPassword: emailConfig.password,
    });
    await wildDuckClient.init();
    // Stryker restore ObjectLiteral,StringLiteral

    // Create rate limiter for outbound email
    // Stryker disable next-line ObjectLiteral: SendRateLimiter config object is integration wiring
    const rateLimiter = new SendRateLimiter({ capacity: emailConfig.sendReservoirCapacity, refillRatePerHour: emailConfig.sendReservoirRefillRatePerHour });

    // Build sendApprovalRequest callback (posts approval embed to #admin channel)
    // Retries up to 3 times on transient failures. Propagates error to caller after exhaustion.
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression: sendApprovalRequest callback is integration wiring
    const sendApprovalRequest = async (to: string, subject: string, draftUid: number, cc?: string[]): Promise<void> => {
        const BLUE = 0x0099FF;
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
    // Stryker disable next-line ObjectLiteral: ImapListener config object is integration wiring
    const listener = new ImapListener(imap, processor, counters, {
        useIdle:               emailConfig.useIdle,
        idleTimeoutMs:         emailConfig.idleTimeoutMs,
        pollFallbackMs:        emailConfig.pollFallbackMs,
        onSendApprovalRequest: sendApprovalRequest,
        wildDuckClient,
    });

    // Create outbound approval handler (handles email-send-* button/modal interactions)
    // Stryker disable next-line ObjectLiteral: outbound approval handler wiring is integration-only
    const outboundApprovalHandler = new OutboundApprovalHandler({
        wildDuckClient,
        allowlist,
    });

    // Create email MCP server for Claude agent
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral: MCP server options and admin notification callback are integration wiring - not unit testable
    const emailMcpServer = createEmailMCPServer(imap, counters, {
        sendAdminNotification: async ({ mailboxName, uid, reference }) => {
            try {
                const { embed, actionRow } = buildRestrictedAccessEmbed(mailboxName, uid, reference);
                const channel = await client.channels.fetch(emailConfig.adminDiscordChannelId);
                if(channel && 'send' in channel) {
                    await channel.send({ embeds: [embed], components: [actionRow] });
                }
            } catch (err) {
                logger.error({
                    error: _.isError(err) ? err.message : String(err),
                    msg:   'Failed to send restricted mailbox notification to admin channel',
                });
            }
        },
        wildDuckClient,
        rateLimiter,
        allowlist,
        sendApprovalRequest,
    });
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral

    // Register /allowlist slash command with Discord
    await registerAllowlistCommand(botToken, applicationId);

    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
    logger.info({ msg: 'Email integration initialized' });

    // Stryker disable next-line ObjectLiteral: return object is integration wiring
    return {
        listener,
        reviewHandler,
        allowlistHandler,
        emailMcpServer,
        imap,
        counters,
        outboundApprovalHandler,
        wildDuckClient,
        adminChannelId: createChannelId(emailConfig.adminDiscordChannelId),
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Register the /allowlist slash command with Discord via REST API.
 * Errors are non-fatal — bot continues without the slash command.
 */
// Stryker disable BlockStatement: registerAllowlistCommand is called from integration-only setupEmail - not unit testable
async function registerAllowlistCommand(botToken: string, applicationId: string): Promise<void> {
    // Inner BlockStatement is also covered by the outer disable above
    try {
        // Stryker disable next-line ObjectLiteral,StringLiteral: REST version string and config object are not behavior-affecting
        const rest    = new REST({ version: '10' }).setToken(botToken);
        const command = buildAllowlistCommand();
        // Stryker disable ObjectLiteral: post body object is configuration
        await rest.post(
            Routes.applicationCommands(applicationId),
            { body: command.toJSON() }
        );
        // Stryker restore ObjectLiteral
        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({ msg: 'Registered /allowlist slash command' });
    } catch (err) {
        // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.error({
            error: _.isError(err) ? err.message : String(err),
            msg:   'Failed to register /allowlist slash command',
        });
        // Stryker restore ObjectLiteral,StringLiteral
        // Continue — command registration failure is non-fatal
    }
    // Stryker enable BlockStatement
}
