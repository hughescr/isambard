import type { Client } from 'discord.js';
import { REST, Routes } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { EmailConfig } from '@/config/schemas';
import { ImapConnection } from '@/integrations/email/imap-connection';
import { EmailClassifier } from '@/integrations/email/classifier';
import { EmailAllowlist } from '@/integrations/email/allowlist';
import { EmailCounterStore } from '@/integrations/email/email-counters';
import { EmailProcessor } from '@/integrations/email/email-processor';
import { ImapListener } from '@/integrations/email/imap-listener';
import { ReviewHandler } from '@/integrations/email/review-handler';
import { buildReviewEmbed, buildUnsafeAlert } from '@/integrations/email/review-embed-builder';
import { AllowlistCommandHandler, buildAllowlistCommand } from '@/integrations/email/allowlist-commands';
import { EmailFolder } from '@/integrations/email/types';
import { createEmailMCPServer } from '@/agent/email-mcp-server';

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
    listener:         ImapListener
    reviewHandler:    ReviewHandler
    allowlistHandler: AllowlistCommandHandler
    emailMcpServer:   McpServerConfig
    imap:             ImapConnection
    counters:         EmailCounterStore
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

    // Create processor with Discord DM callbacks
    // Stryker disable ObjectLiteral,BlockStatement,ArrayDeclaration,StringLiteral: EmailProcessor config and callbacks are integration wiring - not unit testable
    const processor = new EmailProcessor(
        { allowlist, classifier, counters, imap },
        {
            onReview: async (email, _verdict) => {
                try {
                    const { embed, actionRow } = buildReviewEmbed(email, EmailFolder.Review);
                    const user = await client.users.fetch(emailConfig.adminDiscordUserId);
                    await user.send({ embeds: [embed], components: [actionRow] });
                } catch (err) {
                    logger.error({
                        error: _.isError(err) ? err.message : String(err),
                        msg:   'Failed to send email review DM to admin',
                    });
                }
            },
            onUnsafe: async (email, verdict) => {
                try {
                    const { embed, actionRow } = buildUnsafeAlert(email, verdict, EmailFolder.Quarantine);
                    const user = await client.users.fetch(emailConfig.adminDiscordUserId);
                    await user.send({ embeds: [embed], components: [actionRow] });
                } catch (err) {
                    logger.error({
                        error: _.isError(err) ? err.message : String(err),
                        msg:   'Failed to send unsafe alert DM to admin',
                    });
                }
            },
        }
    );
    // Stryker restore ObjectLiteral,BlockStatement,ArrayDeclaration,StringLiteral

    // Create listener (not started yet — started in clientReady handler)
    // Stryker disable next-line ObjectLiteral: ImapListener config object is integration wiring
    const listener = new ImapListener(imap, processor, counters, {
        useIdle:        emailConfig.useIdle,
        idleTimeoutMs:  emailConfig.idleTimeoutMs,
        pollFallbackMs: emailConfig.pollFallbackMs,
    });

    // Create review handler (handles email-* button interactions)
    // Stryker disable next-line ObjectLiteral: ReviewHandler config object is integration wiring
    const reviewHandler = new ReviewHandler({ imap, counters, allowlist, adminDiscordUserId: emailConfig.adminDiscordUserId });

    // Create allowlist command handler (handles /allowlist interactions)
    const allowlistHandler = new AllowlistCommandHandler(allowlist, emailConfig.adminDiscordUserId);

    // Create email MCP server for Claude agent
    const emailMcpServer = createEmailMCPServer(imap, counters);

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
