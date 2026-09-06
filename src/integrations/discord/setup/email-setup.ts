import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type Client, type MessageCreateOptions, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { BLUE } from '../colors';
import { createEmailMCPServer, type ActivityLogger, type NotifyFn } from '@/agent';
import type { EmailConfig } from '@/config';
import { ChannelNotAccessibleError } from '@/errors';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import type { DiscordCapability } from '@/integrations/discord/capability';
import { type ChannelId, createChannelId } from '@/integrations/discord/types';
import {
    EmailClassifier,
    EmailProcessor,
    WildDuckListener,
    ReviewHandler,
    buildReviewEmbed,
    buildUnsafeAlert,
    buildRestrictedAccessEmbed,
    EmailFolder,
    WildDuckClient,
    OutboundApprovalHandler,
    type ProcessEmailCallbacks
} from '@/integrations/email';
import { TokenBucketRateLimiter, type ApprovalSagaBackend, type ReconnectionLoop, type ServiceHealthRegistry } from '@/services';
import type { DynamoDBClientHolder, PersonAllowlist } from '@/storage';
import { retryAsync } from '@/utils';

/** Type guard: check if a Discord channel supports sending messages (has send method). */
function isSendableChannel(channel: unknown): channel is { send: (options: unknown) => Promise<unknown> } {
    return typeof channel === 'object' && channel !== null && 'send' in channel;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailSetupOptions {
    emailConfig:                 EmailConfig
    docClient:                   DynamoDBDocumentClient | DynamoDBClientHolder
    tableName:                   string
    /** Discord client instance */
    client:                      Client
    /** Admin Discord user ID for authorization checks */
    adminDiscordUserId:          string
    /** @internal Dependency injection for testing (e.g. fast sleep) */
    _deps?:                      { sleep?: (ms: number) => Promise<void> }
    /** Optional activity logger for recording approval events */
    activityLogger?:             ActivityLogger
    /**
     * Pre-created WildDuckClient to reuse.
     * When provided, client creation and init() are skipped — the caller is
     * responsible for calling init() separately (e.g. as part of a reconnection loop).
     */
    wildDuckClient?:             WildDuckClient
    /**
     * Optional service health registry for fast-fail guards in MCP tool handlers.
     */
    healthRegistry?:             ServiceHealthRegistry
    /**
     * Optional reconnection loop for email. When provided, the email MCP server can
     * trigger an immediate reconnection attempt on health-guard failures.
     */
    reconnectionLoop?:           ReconnectionLoop
    /**
     * Optional Discord capability facade.
     * When provided, admin channel notifications use the facade (with outbox fallback
     * when Discord is offline) instead of calling channel.send() directly.
     */
    discordCapability?:          DiscordCapability
    /** Approval saga backend for durable approval workflows */
    approvalSagaBackend:         ApprovalSagaBackend
    /** Pre-loaded PersonAllowlist for gating outbound email recipients */
    personAllowlist:             PersonAllowlist
    /** Allowlist interaction handler for the saga-based allowlist flow */
    allowlistInteractionHandler: AllowlistInteractionHandler
    /**
     * Shared notification bridge submission function (Q5/Q7, plan amendment B1-B2).
     * Required — a mis-ordered composition-root construction is a typecheck error here,
     * not a runtime log branch.
     */
    notify:                      NotifyFn
}

export interface EmailSetupResult {
    listener:                     WildDuckListener
    reviewHandler:                ReviewHandler
    emailMcpServer:               McpServerConfig
    outboundApprovalHandler:      OutboundApprovalHandler
    wildDuckClient:               WildDuckClient
    /** The person allowlist — exposed so the caller can wire it into AllowlistCommandHandler */
    allowlist:                    PersonAllowlist
    /** Discord channel ID for the admin email channel, used to auto-mute it at startup */
    adminChannelId:               ChannelId
    /** sendApprovalRequest callback — exposed for testing the isSendableChannel type guard */
    sendApprovalRequest:          (to: string, subject: string, draftUid: number, cc?: string[]) => Promise<void>
    /**
     * Builds a fresh email MCP server instance, closing over this setup's shared
     * dependencies (wildDuckClient, rateLimiter, allowlist, sendApprovalRequest).
     * Each call returns a brand-new `McpServerConfig` — an underlying SDK MCP server
     * instance can only be connected to one session at a time, so a second session
     * (e.g. the perch session) needing an email MCP server calls this again rather
     * than reusing `emailMcpServer`, which is simply the result of the first call.
     */
    createEmailMcpServerInstance: () => McpServerConfig
}

// ---------------------------------------------------------------------------
// Email processor callbacks
// ---------------------------------------------------------------------------

/** Dependencies for {@link buildEmailProcessorCallbacks}. */
export interface BuildEmailProcessorCallbacksDeps {
    /** Discord client instance, used when `discordCapability` is not provided */
    client:                Client
    /** Admin Discord channel ID to post notifications to */
    adminDiscordChannelId: string
    /**
     * Optional Discord capability facade. When provided, admin channel notifications use the
     * facade (with outbox fallback when Discord is offline) instead of calling channel.send()
     * directly.
     */
    discordCapability?:    DiscordCapability
    /** Shared notification bridge submission function (Q5/Q7, plan amendment B1-B2) */
    notify:                NotifyFn
}

/**
 * Builds the four `EmailProcessor` Discord admin-channel callbacks (`onSafe`/`onReview`/
 * `onUnsafe`/`onAuthFailed`), each paired with a `notify()` call to the shared notification
 * bridge (Q7, plan amendment B2) alongside the existing admin-channel embed/content payload.
 * `onSafe`/`onReview`/`onAuthFailed` accumulate (`wake:false`); `onUnsafe` wakes (`wake:true`) —
 * matching the design's "admin approval outcomes" wake row. Every `dedupeKey` is keyed on the
 * email's `uid`, which is stable for the life of that message. Extracted from `setupEmail` (and
 * exported directly) so mutation coverage on `wake`/`dedupeKey` is real rather than absorbed by
 * `setupEmail`'s integration-wiring Stryker-disable block below.
 * @param deps - client, admin channel id, optional Discord capability facade, and the shared notify function
 * @returns The `ProcessEmailCallbacks` passed to `EmailProcessor`
 */
export function buildEmailProcessorCallbacks(deps: BuildEmailProcessorCallbacksDeps): ProcessEmailCallbacks {
    const { client, adminDiscordChannelId, discordCapability, notify } = deps;

    return {
        onSafe: async (email, _verdict) => {
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
                { content: `Safe email from **${email.from.address}** — not on allowlist.\nSubject: ${email.subject}\n\nTo allowlist: first \`/contact add\` (if needed), then \`/allowlist add <personId>\`.` },
                // Stryker disable next-line StringLiteral: log message content is not behavior-affecting
                'Failed to send safe-but-not-allowlisted notification to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source:    'email',
                wake:      false,
                dedupeKey: `email-safe:${email.uid}`,
                text:      `Safe email from ${email.from.address} — not on allowlist. Subject: ${email.subject}`,
            });
        },
        onReview: async (email, _verdict) => {
            const { embed, actionRow } = buildReviewEmbed(email, EmailFolder.Review);
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                // Stryker disable next-line StringLiteral: log message content is not behavior-affecting
                'Failed to send email review embed to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source:    'email',
                wake:      false,
                dedupeKey: `email-review:${email.uid}`,
                text:      `Email needs review: ${email.subject}`,
            });
        },
        onUnsafe: async (email, verdict) => {
            const { embed, actionRow } = buildUnsafeAlert(email, verdict, EmailFolder.Quarantine);
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                // Stryker disable next-line StringLiteral: log message content is not behavior-affecting
                'Failed to send unsafe alert to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source:    'email',
                wake:      true,
                dedupeKey: `email-unsafe:${email.uid}`,
                text:      `Unsafe email quarantined: ${email.subject}`,
            });
        },
        onAuthFailed: async (email) => {
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
                { content: `Allowlisted sender **${email.from.address}** failed SPF/DKIM auth check.\nSubject: ${email.subject}\nEmail was sent to classifier instead of auto-approved.` },
                // Stryker disable next-line StringLiteral: log message content is not behavior-affecting
                'Failed to send auth-failure notification to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source:    'email',
                wake:      false,
                dedupeKey: `email-auth-failed:${email.uid}`,
                text:      `Allowlisted sender ${email.from.address} failed auth check. Subject: ${email.subject}`,
            });
        },
    };
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
    const { emailConfig, client, adminDiscordUserId } = options;
    // Stryker disable next-line ObjectLiteral: Dependency injection for testability — sleep override is a no-op in production
    const retryDeps = options._deps?.sleep ? { deps: { sleep: options._deps.sleep } } : {};

    // Create classifier; use the pre-loaded PersonAllowlist passed in by the caller
    const classifier = new EmailClassifier();
    const allowlist  = options.personAllowlist;

    // Use pre-created client if provided; otherwise create and init a new one.
    // When a pre-created client is passed in, the caller is responsible for having
    // already called (or will call) init() on it — this avoids recreating downstream
    // objects on reconnection and keeps all consumer references stable.
    // Stryker disable BlockStatement: WildDuck client creation and init are integration-only
    let wildDuckClient: WildDuckClient;
    if(options.wildDuckClient) {
        wildDuckClient = options.wildDuckClient;
    } else {
        // Stryker disable ObjectLiteral,StringLiteral: WildDuck client wiring is integration-only
        wildDuckClient = new WildDuckClient({
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
    }
    // Stryker restore BlockStatement

    // Create processor with Discord admin channel callbacks. Callback bodies themselves live in
    // buildEmailProcessorCallbacks (exported, directly unit-tested) — these disables cover only
    // the remaining EmailProcessor construction wiring. (Both mutants are also neutralised by
    // the TypeScript checker today, but the comments are kept anchored to the lines that
    // actually carry the mutants rather than the `new EmailProcessor(` call line above them.)
    const processor = new EmailProcessor(
        // Stryker disable next-line ObjectLiteral: EmailProcessor construction wiring is integration-only - not unit testable
        { allowlist, classifier, wildDuckClient },
        // Stryker disable next-line ObjectLiteral: EmailProcessor construction wiring is integration-only - not unit testable
        buildEmailProcessorCallbacks({
            client,
            adminDiscordChannelId: emailConfig.adminDiscordChannelId,
            discordCapability:     options.discordCapability,
            notify:                options.notify,
        })
    );

    // Create review handler (handles email-* button interactions)
    // Stryker disable next-line ObjectLiteral: ReviewHandler config object is integration wiring
    const reviewHandler = new ReviewHandler({ wildDuckClient, adminDiscordUserId, allowlistInteractionHandler: options.allowlistInteractionHandler });

    // Create rate limiter for outbound email
    // Stryker disable next-line ObjectLiteral: TokenBucketRateLimiter config object is integration wiring
    const rateLimiter = new TokenBucketRateLimiter({ capacity: emailConfig.sendReservoirCapacity, refillRatePerHour: emailConfig.sendReservoirRefillRatePerHour });

    // Build sendApprovalRequest callback (posts approval embed to #admin channel)
    // Retries up to 3 times on transient failures. Propagates error to caller after exhaustion.
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression: sendApprovalRequest callback is integration wiring
    const sendApprovalRequest = async (to: string, subject: string, draftUid: number, cc?: string[]): Promise<void> => {
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

        // When capability is available, use it for outbox fallback; otherwise retry channel.send() up to 3 times
        await (options.discordCapability
            ? options.discordCapability.sendToChannel(
                emailConfig.adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                { priority: 'high', type: 'email_approval' }
            )
            : retryAsync(async () => {
                const channel = await client.channels.fetch(emailConfig.adminDiscordChannelId);
                if(isSendableChannel(channel)) {
                    await channel.send({ embeds: [embed], components: [actionRow] });
                } else {
                    throw new ChannelNotAccessibleError(emailConfig.adminDiscordChannelId);
                }
            }, { policy: { maxAttempts: 3 }, ...retryDeps }));
    };
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral,BooleanLiteral,ArrayDeclaration,ConditionalExpression

    // Create listener (not started yet — started in clientReady handler)
    // Must be created after sendApprovalRequest and wildDuckClient are defined.
    // Stryker disable next-line ObjectLiteral: WildDuckListener config object is integration wiring
    const listener = new WildDuckListener(wildDuckClient, processor, {
        pollFallbackMs:      emailConfig.pollFallbackMs,
        sseReconnectDelayMs: emailConfig.sseReconnectDelayMs,
        healthRegistry:      options.healthRegistry,
    });

    // Create outbound approval handler (handles email-send-* button/modal interactions)
    // Stryker disable next-line ObjectLiteral: outbound approval handler wiring is integration-only
    const outboundApprovalHandler = new OutboundApprovalHandler({
        wildDuckClient,
        sagaBackend:                 options.approvalSagaBackend,
        activityLogger:              options.activityLogger,
        allowlistInteractionHandler: options.allowlistInteractionHandler,
        notify:                      options.notify,
    });

    // Create email MCP server for Claude agent. Wrapped in a factory (rather than a bare
    // object literal) so a second session's server set can build its own fresh instance —
    // see EmailSetupResult.createEmailMcpServerInstance — from the exact same closed-over
    // dependencies; emailMcpServer below is simply the first invocation.
    // Stryker disable ObjectLiteral,BlockStatement,StringLiteral,ArrayDeclaration: MCP server options and admin notification callback are integration wiring - not unit testable
    const createEmailMcpServerInstance = (): McpServerConfig => createEmailMCPServer({
        sendAdminNotification: async ({ mailboxName, uid, reference }) => {
            const { embed, actionRow } = buildRestrictedAccessEmbed(mailboxName, uid, reference);
            await sendToAdminChannel(
                client,
                emailConfig.adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                'Failed to send restricted mailbox notification to admin channel',
                options.discordCapability
            );
        },
        wildDuckClient,
        rateLimiter,
        allowlist,
        sendApprovalRequest,
        healthRegistry:   options.healthRegistry,
        reconnectionLoop: options.reconnectionLoop,
    });
    // Stryker restore ObjectLiteral,BlockStatement,StringLiteral,ArrayDeclaration

    const emailMcpServer = createEmailMcpServerInstance();

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
        sendApprovalRequest,
        createEmailMcpServerInstance,
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the admin Discord channel and send a message payload to it.
 * When a capability facade is provided, uses it for outbox fallback support.
 * Errors are non-fatal — logs the provided error message and returns.
 */
// Stryker disable all: sendToAdminChannel is integration-only wiring — not unit testable
async function sendToAdminChannel(
    client:             Client,
    channelId:          string,
    payload:            MessageCreateOptions,
    errorMsg:           string,
    discordCapability?: DiscordCapability
): Promise<void> {
    try {
        if(discordCapability) {
            await discordCapability.sendToChannel(channelId, {
                content:    payload.content,
                embeds:     payload.embeds as EmbedBuilder[] | undefined,
                components: payload.components as ActionRowBuilder[] | undefined,
            }, { priority: 'high', type: 'email_notification' });
        } else {
            const channel = await client.channels.fetch(channelId);
            if(isSendableChannel(channel)) {
                await channel.send(payload);
            }
        }
    } catch (err) {
        logger.error({
            error: err instanceof Error ? err.message : String(err),
            msg:   errorMsg,
        });
    }
}
// Stryker restore all
