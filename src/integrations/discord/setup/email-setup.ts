import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { type Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { BLUE } from '../colors';
import { createEmailMCPServer, generateTextWithSystemPrompt, type ActivityLogger, type NotifyFn } from '@/agent';
import type { EmailConfig } from '@/config';
import { ChannelNotAccessibleError } from '@/errors';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { EmailApprovalInteractionAdapter } from '@/integrations/discord/approvals/email-adapter';
import { buildReviewEmbed, buildUnsafeAlert, buildRestrictedAccessEmbed } from '@/integrations/discord/approvals/email-embeds';
import { EmailReviewHandler } from '@/integrations/discord/approvals/email-review-handler';
import type { ChannelContent, DiscordCapability } from '@/integrations/discord/capability';
import type { ChannelId } from '@/integrations/discord/types';
import {
    EmailClassifier,
    EmailProcessor,
    WildDuckListener,
    EmailFolder,
    formatMailboxMessageRef,
    WildDuckClient,
    EmailOutboundApprovals,
    type ProcessEmailCallbacks
} from '@/integrations/email';
import { TokenBucketRateLimiter, type ApprovedOutboundActionWriter, type ReconnectionLoop, type ServiceHealthRegistry } from '@/services';
import type { DynamoDBClientHolder, PersonAllowlist } from '@/storage';
import { encodeCustomId, retryAsync } from '@/utils';

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
    /**
     * The admin review channel (top-level `config.adminDiscordChannelId`), used for inbound review
     * notices, outbound approval embeds and restricted-mailbox notices.
     */
    adminDiscordChannelId:       ChannelId
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
    /** Records admin-approved outbound actions for the services executor (and wakes it) */
    approvedActions:             ApprovedOutboundActionWriter
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
    reviewHandler:                EmailReviewHandler
    emailMcpServer:               McpServerConfig
    outboundApprovalHandler:      EmailApprovalInteractionAdapter
    wildDuckClient:               WildDuckClient
    /** The person allowlist — exposed so the caller can wire it into AllowlistCommandHandler */
    allowlist:                    PersonAllowlist
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
    adminDiscordChannelId: ChannelId
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
 * matching the design's "admin approval outcomes" wake row. Every notify `key` is keyed on the
 * email's `uid`, which is stable for the life of that message. Extracted from `setupEmail` (and
 * exported directly) so mutation coverage on `wake`/`key` is real rather than absorbed by
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
                'Failed to send safe-but-not-allowlisted notification to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source: 'email',
                wake:   false,
                key:    `safe:${email.uid}`,
                text:   `Safe email from ${email.from.address} — not on allowlist. Subject: ${email.subject}`,
            });
        },
        onReview: async (email, _verdict) => {
            const { embed, actionRow } = buildReviewEmbed(email, EmailFolder.Review);
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                'Failed to send email review embed to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source: 'email',
                wake:   false,
                key:    `review:${email.uid}`,
                text:   `Email needs review: ${email.subject}`,
            });
        },
        onUnsafe: async (email, verdict) => {
            const { embed, actionRow } = buildUnsafeAlert(email, verdict, EmailFolder.Quarantine);
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                'Failed to send unsafe alert to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source: 'email',
                wake:   true,
                key:    `unsafe:${email.uid}`,
                text:   `Unsafe email quarantined: ${email.subject}`,
            });
        },
        onAuthFailed: async (email) => {
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
                { content: `Allowlisted sender **${email.from.address}** failed SPF/DKIM auth check.\nSubject: ${email.subject}\nEmail was sent to classifier instead of auto-approved.` },
                'Failed to send auth-failure notification to admin channel',
                discordCapability
            );
            // Fire-and-forget: a `false` return (e.g. conductor not yet open at boot) is not
            // retried or logged here — deliberate per Q7 plan amendment B2.
            notify({
                source: 'email',
                wake:   false,
                key:    `auth-failed:${email.uid}`,
                text:   `Allowlisted sender ${email.from.address} failed auth check. Subject: ${email.subject}`,
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
 * - EmailReviewHandler for inbound review button interactions
 * - EmailOutboundApprovals + EmailApprovalInteractionAdapter for outbound approval interactions
 * - Email MCP server for Claude agent
 *
 * @param options - Email setup options
 * @returns Email components for lifecycle management
 */
export async function setupEmail(options: EmailSetupOptions): Promise<EmailSetupResult> {
    const { emailConfig, client, adminDiscordUserId, adminDiscordChannelId } = options;
    const retryDeps = options._deps?.sleep ? { deps: { sleep: options._deps.sleep } } : {};

    // Create classifier; use the pre-loaded PersonAllowlist passed in by the caller
    const classifier = new EmailClassifier({ generateText: generateTextWithSystemPrompt });
    const allowlist  = options.personAllowlist;

    // Use pre-created client if provided; otherwise create and init a new one.
    // When a pre-created client is passed in, the caller is responsible for having
    // already called (or will call) init() on it — this avoids recreating downstream
    // objects on reconnection and keeps all consumer references stable.
    let wildDuckClient: WildDuckClient;
    if(options.wildDuckClient) {
        wildDuckClient = options.wildDuckClient;
    } else {
        wildDuckClient = new WildDuckClient({
            url:              emailConfig.wildDuckApiUrl,
            user:             emailConfig.user,
            password:         emailConfig.password,
            maxBodySizeBytes: emailConfig.maxBodySizeBytes,
        });
        logger.info('Starting WildDuck client...');
        await wildDuckClient.init();
        logger.info('WildDuck client initialized');
    }

    // Create processor with Discord admin channel callbacks. Callback bodies themselves live in
    // buildEmailProcessorCallbacks (exported, directly unit-tested) — these disables cover only
    // the remaining EmailProcessor construction wiring. (Both mutants are also neutralised by
    // the TypeScript checker today, but the comments are kept anchored to the lines that
    // actually carry the mutants rather than the `new EmailProcessor(` call line above them.)
    const processor = new EmailProcessor(
        { allowlist, classifier, wildDuckClient },
        buildEmailProcessorCallbacks({
            client,
            adminDiscordChannelId,
            discordCapability: options.discordCapability,
            notify:            options.notify,
        })
    );

    // Create review handler (handles email-* button interactions)
    const reviewHandler = new EmailReviewHandler({ wildDuckClient, adminDiscordUserId, allowlistInteractionHandler: options.allowlistInteractionHandler });

    // Create rate limiter for outbound email
    const rateLimiter = new TokenBucketRateLimiter({ capacity: emailConfig.sendReservoirCapacity, refillRatePerHour: emailConfig.sendReservoirRefillRatePerHour });

    // Build sendApprovalRequest callback (posts approval embed to #admin channel)
    // Retries up to 3 times on transient failures. Propagates error to caller after exhaustion.
    const sendApprovalRequest = async (to: string, subject: string, draftUid: number, cc?: string[]): Promise<void> => {
        const embed = new EmbedBuilder()
            .setTitle('Outbound Email Approval Required')
            .setColor(BLUE)
            .addFields(
                { name: 'To',      value: to,      inline: true  },
                { name: 'Subject', value: subject, inline: true  },
                // Stryker disable next-line llm: draftUid is typed number from the WildDuck draft UID, so String(n) and n.toString() are identical
                { name: 'UID',     value: String(draftUid), inline: true }
            );

        if(cc && cc.length > 0) {
            embed.addFields({ name: 'CC', value: cc.join(', '), inline: true });
        }

        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(encodeCustomId({ prefix: 'email-send-approve', id: String(draftUid) }))
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(encodeCustomId({ prefix: 'email-send-approveallowlist', id: String(draftUid) }))
                .setLabel('Approve + Allowlist...')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(encodeCustomId({ prefix: 'email-send-reject', id: String(draftUid) }))
                .setLabel('Reject')
                .setStyle(ButtonStyle.Danger)
        );

        // When capability is available, use it for outbox fallback; otherwise retry channel.send() up to 3 times
        await (options.discordCapability
            ? options.discordCapability.sendToChannel(
                adminDiscordChannelId,
                { embeds: [embed], components: [actionRow] },
                { priority: 'high', type: 'email_approval' }
            )
            : retryAsync(async () => {
                const channel = await client.channels.fetch(adminDiscordChannelId);
                if(isSendableChannel(channel)) {
                    await channel.send({ embeds: [embed], components: [actionRow] });
                } else {
                    throw new ChannelNotAccessibleError(adminDiscordChannelId);
                }
            }, retryDeps));
    };

    // Create listener (not started yet — started in clientReady handler)
    // Must be created after sendApprovalRequest and wildDuckClient are defined.
    const listener = new WildDuckListener(wildDuckClient, processor, {
        pollFallbackMs:      emailConfig.pollFallbackMs,
        sseReconnectDelayMs: emailConfig.sseReconnectDelayMs,
        healthRegistry:      options.healthRegistry,
    });

    // Create the outbound approval operations and their Discord adapter (handles email-send-*
    // button/modal and email-allowlist-select interactions)
    const outboundApprovalHandler = new EmailApprovalInteractionAdapter({
        approvals: new EmailOutboundApprovals({
            wildDuckClient,
            actionWriter:   options.approvedActions,
            activityLogger: options.activityLogger,
            notify:         options.notify,
        }),
        allowlist: options.allowlistInteractionHandler,
    });

    // Create email MCP server for Claude agent. Wrapped in a factory (rather than a bare
    // object literal) so a second session's server set can build its own fresh instance —
    // see EmailSetupResult.createEmailMcpServerInstance — from the exact same closed-over
    // dependencies; emailMcpServer below is simply the first invocation.
    const createEmailMcpServerInstance = (): McpServerConfig => createEmailMCPServer({
        sendAdminNotification: async (reference) => {
            const { embed, actionRow } = buildRestrictedAccessEmbed(reference.folder, reference.uid, formatMailboxMessageRef(reference));
            await sendToAdminChannel(
                client,
                adminDiscordChannelId,
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

    const emailMcpServer = createEmailMcpServerInstance();

    logger.info({ msg: 'Email integration initialized' });

    return {
        listener,
        reviewHandler,
        emailMcpServer,
        outboundApprovalHandler,
        wildDuckClient,
        allowlist,
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
async function sendToAdminChannel(
    client:             Client,
    channelId:          ChannelId,
    payload:            ChannelContent,
    errorMsg:           string,
    discordCapability?: DiscordCapability
): Promise<void> {
    try {
        if(discordCapability) {
            await discordCapability.sendToChannel(channelId, payload, { priority: 'high', type: 'email_notification' });
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
