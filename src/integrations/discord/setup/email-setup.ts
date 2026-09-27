import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import type { Client, Message } from 'discord.js';
import { createEmailMCPServer, generateTextWithSystemPrompt, type ActivityLogger, type NotifyFn } from '@/agent';
import type { EmailConfig } from '@/config';
import { ChannelNotAccessibleError } from '@/errors';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { approvalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import { EmailApprovalInteractionAdapter } from '@/integrations/discord/approvals/email-adapter';
import type { EmailApprovalCard } from '@/integrations/discord/approvals/email-approval-card';
import { EmailApprovalCardPresenter, type ApprovalCardChannel, type EmailApprovalCardPresenterDeps } from '@/integrations/discord/approvals/email-approval-cards';
import { buildReviewEmbed, buildUnsafeAlert, buildRestrictedAccessEmbed } from '@/integrations/discord/approvals/email-embeds';
import { EmailReviewHandler } from '@/integrations/discord/approvals/email-review-handler';
import type { ChannelContent, DiscordCapability, SendResult } from '@/integrations/discord/capability';
import { createChannelId, type ChannelId } from '@/integrations/discord/types';
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
import { TokenBucketRateLimiter, type ApprovedOutboundActionBackend, type ApprovedOutboundActionWriter, type ReconnectionLoop, type ServiceHealthRegistry } from '@/services';
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
     * Production (src/index.ts) always passes it, so the direct channel.send() fallback only
     * runs for callers that omit it (tests and embedders). Those fallbacks are admin approval
     * cards and email notifications, not sends Izzy starts through a tool, so they are not
     * routed through the outbox (#138).
     */
    discordCapability?:          DiscordCapability
    /** Records admin-approved outbound actions for the services executor (and wakes it) */
    approvedActions:             ApprovedOutboundActionWriter
    /** Reads an approved action (strongly consistent), to tell a complete approval from one whose row was never written */
    approvedActionReader:        Pick<ApprovedOutboundActionBackend, 'get'>
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
    /** The approval card presenter the email tools drive (#158) */
    approvalCards:                EmailApprovalCardPresenter
    /**
     * Builds a fresh email MCP server instance, closing over this setup's shared
     * dependencies (wildDuckClient, rateLimiter, allowlist, approvalCards).
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

    // Create listener (not started yet — started in clientReady handler)
    const listener = new WildDuckListener(wildDuckClient, processor, {
        pollFallbackMs:      emailConfig.pollFallbackMs,
        sseReconnectDelayMs: emailConfig.sseReconnectDelayMs,
        healthRegistry:      options.healthRegistry,
    });

    // The outbound approval operations — the only writer of an existing draft's metaData, under
    // `email-draft:<uid>` keys on the process-wide card gate — and their Discord adapter (handles
    // email-send-* button/modal and email-allowlist-select interactions, on the same gate).
    const outboundApprovals = new EmailOutboundApprovals({
        wildDuckClient,
        actionWriter:   options.approvedActions,
        actionReader:   options.approvedActionReader,
        draftLocks:     approvalCardEditGate,
        activityLogger: options.activityLogger,
        notify:         options.notify,
    });
    const outboundApprovalHandler = new EmailApprovalInteractionAdapter({
        approvals: outboundApprovals,
        allowlist: options.allowlistInteractionHandler,
    });

    // The approval cards the email tools present, edit in place and mark deleted (#158).
    const approvalCards = new EmailApprovalCardPresenter({
        wildDuckClient,
        draftMeta: outboundApprovals,
        ...buildEmailApprovalCardTransport({ client, adminDiscordChannelId, discordCapability: options.discordCapability, retryDeps }),
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
        approvalCards,
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
        approvalCards,
        createEmailMcpServerInstance,
    };
}

/** Dependencies for {@link buildEmailApprovalCardTransport}. */
export interface EmailApprovalCardTransportDeps {
    client:                Client
    adminDiscordChannelId: ChannelId
    /** Production always passes it; without it cards go straight to the channel, retried. */
    discordCapability?:    DiscordCapability
    retryDeps:             { deps?: { sleep: (ms: number) => Promise<void> } }
}

/**
 * How the approval card presenter reaches Discord: post a card to the admin channel (through
 * the capability, whose outbox queues it while Discord is offline; otherwise straight to the
 * channel, retried up to 3 times, rejecting with ChannelNotAccessibleError when it cannot take
 * messages), read a card's channel (null when unreachable or not a text channel), and reply
 * under a card. Exported so the transport is unit-tested directly.
 */
export function buildEmailApprovalCardTransport(deps: EmailApprovalCardTransportDeps): Pick<EmailApprovalCardPresenterDeps, 'postCard' | 'fetchChannel' | 'reply'> {
    const { client, adminDiscordChannelId, discordCapability, retryDeps } = deps;
    return {
        postCard: async (card: EmailApprovalCard): Promise<SendResult> => (discordCapability
            ? discordCapability.sendToChannel(adminDiscordChannelId, card, { priority: 'high', type: 'email_approval' })
            : retryAsync(async (): Promise<SendResult> => {
                const channel = await client.channels.fetch(adminDiscordChannelId);
                if(!isSendableChannel(channel)) {
                    throw new ChannelNotAccessibleError(adminDiscordChannelId);
                }
                return { status: 'sent', message: await channel.send(card) as Message };
            }, retryDeps)),
        fetchChannel: async (channelId: string): Promise<ApprovalCardChannel | null> => {
            const channel = discordCapability
                ? await discordCapability.fetchChannel(createChannelId(channelId))
                : await client.channels.fetch(channelId);
            return channel?.isTextBased() === true ? channel : null;
        },
        reply: async (card, text): Promise<void> => {
            if(discordCapability) {
                await discordCapability.sendText(createChannelId(card.channelId), text, { replyToMessageId: card.messageId, priority: 'high', type: 'email_notification' });
                return;
            }
            const channel = await client.channels.fetch(card.channelId);
            if(isSendableChannel(channel)) {
                await channel.send({ content: text, reply: { messageReference: card.messageId } });
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the admin Discord channel and send a message payload to it.
 * When a capability facade is provided, uses it for outbox fallback support. Production always
 * provides it; the direct channel.send() branch serves callers that omit it (tests and embedders).
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
