import { logger } from '@hughescr/logger';
import type { Client, Message, TextChannel } from 'discord.js';
import type { AttachmentMetadata } from './attachments/types';
import type { DiscordCapability } from './capability';
import type { ChannelRegistryManager, DMTracker, ResponseRouter } from './channel-registry';
import { inferImageContentType } from './content-type';
import type { InboxManager } from './inbox';
import type { IngressGate } from './ingress-gate';
import type { MessageCoordinator } from './message-coordinator';
import type { DiscordRateLimiter } from './rate-limiter';
import { sendEnvelopeResponse } from './response-sender';
import { withDiscordRetry } from './retry';
import { type DiscordMessageContext, type UserId, type ChannelId, createGuildId, createChannelId, createUserId  } from './types';
import { buildDiscordEnvelope, type QuestionRegistry, type AnswerClassifier, type Conductor, type ContextBuilder } from '@/agent';
import { formatTimeHeader, resolveTimezone } from '@/utils';

/** Type guard: check if a channel supports typing indicators (has sendTyping). */
function isTypingChannel(channel: unknown): channel is { sendTyping(): Promise<void> } {
    return typeof channel === 'object' && channel !== null && 'sendTyping' in channel;
}

/**
 * Helper function to extract attachment metadata from a Discord message.
 * Converts Discord.js Attachment objects to AttachmentMetadata.
 *
 * @param message Discord message with attachments
 * @returns Array of attachment metadata
 */
export function extractAttachmentMetadata(message: Message): AttachmentMetadata[] {
    // Stryker disable next-line ConditionalExpression: Equivalent for the message-handler tests that cover this — attachments is always a proper Map (never undefined) in those tests; empty Map → Array.from([]).values() returns [] either way
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: message.attachments typed non-nullable but checking defensively against SDK reality
    if(!message.attachments || message.attachments.size === 0) {
        return [];
    }

    return [...message.attachments.values()].map(attachment => ({
        url:         attachment.url,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: attachment.name typed as string but may be null at runtime
        filename:    attachment.name ?? 'unknown',
        // Stryker disable next-line StringLiteral: Equivalent — when attachment.name is null and contentType is null, inferImageContentType('unknown', null) and inferImageContentType('', null) both return 'application/octet-stream'; when contentType is valid (e.g., 'image/png'), the filename is ignored entirely
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: attachment.name typed as string but may be null at runtime
        contentType: inferImageContentType(attachment.name ?? 'unknown', attachment.contentType),
        size:        attachment.size,
        width:       attachment.width ?? undefined,
        height:      attachment.height ?? undefined,
    }));
}

/**
 * Creates a handler for the Discord 'clientReady' event.
 *
 * The handler logs when the bot successfully connects to Discord.
 *
 * @returns Event handler function for the 'clientReady' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * client.on('clientReady', createReadyHandler());
 * ```
 */
export function createReadyHandler(): (client: Client) => void {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- factory pattern: returns a handler function; keeping inner arrow for future extensibility when params are added
    return (client: Client) => {
        if(client.user) {
            logger.info(`Discord bot ready: Logged in as ${client.user.tag}`);
        } else {
            logger.info('Discord bot ready: Logged in (user not available)');
        }
    };
}

/**
 * Creates a handler for the Discord 'error' event.
 *
 * The handler logs Discord client errors for debugging and monitoring.
 *
 * @returns Event handler function for the 'error' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * client.on('error', createErrorHandler());
 * ```
 */
export function createErrorHandler(): (error: Error) => void {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- factory pattern: returns a handler function; keeping inner arrow for future extensibility when params are added
    return (error: Error) => {
        // Use object spread to satisfy logger typing while maintaining structured logging
        logger.error({ error, msg: `Discord client error: ${error.message}` });
    };
}

/**
 * Options for configuring the message handler.
 */
interface MessageHandlerOptions {
    /**
     * The bot's user ID (used to detect @mentions and ignore own messages).
     */
    botUserId: UserId

    /**
     * Channel registry for dynamic channel management.
     * Used to determine if messages should be processed.
     */
    channelRegistry: ChannelRegistryManager

    /**
     * Optional callback to track recent message content for context-aware idle status.
     */
    addRecentMessage?: (content: string, author: 'user' | 'izzy') => void

    /**
     * Message coordinator for multi-message handling with interruption support.
     * Handles batching and processing messages through the coordinator.
     */
    coordinator: MessageCoordinator

    /**
     * Optional question registry for answer correlation.
     */
    questionRegistry?: QuestionRegistry

    /**
     * Optional answer classifier for message classification.
     */
    answerClassifier?: AnswerClassifier

    /**
     * Optional inbox manager for tracking channel activity and unread messages.
     */
    inboxManager?: InboxManager

    /**
     * Optional DM tracker for tracking DM channels.
     */
    dmTracker?: DMTracker

    /**
     * The ingress gate: the checkpoint is written first (receipt-time lastSeen, unconditionally),
     * then the inbox bookkeeping (channel-metadata refresh) and `addRecentMessage` also run
     * unconditionally — regardless of what the gate decides — before the gate decides whether the
     * message dispatches now ('pass') or is buffered/dropped by the boot sequence's gate. A
     * message arriving during boot's replay is routed to the coordinator (or the perch conductor)
     * exactly once via the gate's `onDrain`, not by this handler — but its checkpoint/inbox
     * bookkeeping already happened here at receipt time even when the boot sequence's replay
     * later excludes it from `onDrain` entirely (see `dispatchAdmittedMessage`'s own doc for why
     * those two are NOT gated on admission).
     */
    ingressGate: IngressGate<Message>

    /**
     * Optional perch-channel routing (conductor mode). When supplied, an ADMITTED message
     * (see {@link dispatchAdmittedMessage}'s own doc for why this is gated by `ingressGate` first)
     * in the well-known `perch-time` channel is submitted to the perch conductor instead of the
     * (conversation) coordinator. Omitted whenever no perch conductor exists.
     */
    perch?: PerchRoutingDeps
}

/**
 * The perch conductor's own delivery surface (P12): `submit` to run the perch-channel turn,
 * `deliver` for the same idempotent, journal-backed delivery the conversation coordinator uses
 * (`setup/coordinator-setup.ts`) — never a raw `sendEnvelopeResponse` call, so a crash between
 * `submit` resolving and the response landing is recovered exactly like any other conductor
 * delivery (see `createPerchConductor`'s own boot-bundle recovery, `src/app/sessions.ts`).
 */
export interface PerchRoutingDeps {
    conductor:          Pick<Conductor, 'submit' | 'deliver'>
    responseRouter:     ResponseRouter
    client:             Client
    rateLimiter:        DiscordRateLimiter
    discordCapability?: DiscordCapability
    /**
     * Resolves the author's stored timezone for the envelope stamp — the same `discord`-kind
     * envelope convention `conductor-processor.ts` uses for the conversation path. Omitted (or a
     * lookup that resolves `undefined`) falls back to `resolveTimezone()`'s own server-zone
     * default, exactly as before this field existed.
     */
    contextBuilder?:    Pick<ContextBuilder, 'loadUserTimezone'>
}

/** Sentinel thrown inside {@link PerchRoutingDeps.conductor}'s `deliver` callback to skip the journal write when nothing was actually sent (the `@@NO_RESPONSE@@` sentinel or a missing well-known channel) — mirrors `coordinator-setup.ts`'s identical `ResponseNotSentError`. */
class PerchResponseNotSentError extends Error {}

/**
 * Creates a handler for the Discord 'messageCreate' event.
 *
 * The handler processes messages based on the following rules:
 * - Ignores all bot messages (including its own)
 * - Responds to:
 *   1. Direct messages (DMs)
 *   2. Messages that @mention the bot
 *   3. Messages in monitored channels
 *
 * When a message matches these criteria:
 * 1. Converts the Discord.js Message to DiscordMessageContext
 * 2. Hands off to the message coordinator for batching and processing
 * 3. Coordinator handles interruption, batching, and response routing
 *
 * Additional features:
 * - Routes a well-known perch-channel message to the perch conductor instead of the coordinator
 * - Tracks pending questions and correlates answers
 * - Updates inbox checkpoints for catch-up tracking
 *
 * @param options - Configuration for the message handler
 * @returns Event handler function for the 'messageCreate' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * const coordinator = new MessageCoordinator({ onResponse: ... });
 *
 * client.on('messageCreate', createMessageHandler({
 *   botUserId: myBotUserId,
 *   channelRegistry: myChannelRegistry,
 *   coordinator: coordinator,
 *   ingressGate: myIngressGate,
 * }));
 * ```
 */
/**
 * Helper function to update channel metadata in inbox manager.
 * This is a synchronous operation that just updates the cache.
 */
// Stryker disable StringLiteral,LogicalOperator,BlockStatement: Optional inbox integration - tested via inbox-manager.test.ts; BlockStatement equivalent (fire-and-forget metadata update, no observable state)
function updateChannelMetadataInInbox(
    message: Message,
    inboxManager: InboxManager
): void {
    const channel = message.channel as TextChannel;
    inboxManager.updateChannelMetadata(
        createChannelId(message.channel.id),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: DM channels have null name despite TextChannel cast
        channel.name ?? message.channel.id,
        createGuildId(message.guild?.id ?? 'DM')
    );
}
// Stryker restore StringLiteral,LogicalOperator,BlockStatement

/**
 * Helper function to refresh channel metadata in the inbox once a message is known to warrant a
 * response — presence/activity-phase transitions are driven entirely by the conductor's own
 * turn lifecycle (composed in `presence-setup.ts`), never by this handler.
 */
function refreshInboxChannelMetadata(
    message: Message,
    inboxManager: InboxManager | undefined,
    shouldRespond: boolean
): void {
    if(inboxManager && shouldRespond) {
        updateChannelMetadataInInbox(message, inboxManager);
    }
}

/**
 * Helper function to update inbox checkpoint after message processing.
 */
async function updateInboxCheckpoint(
    message: Message,
    inboxManager: InboxManager | undefined,
    shouldRespond: boolean
): Promise<void> {
    if(inboxManager && shouldRespond) {
        await inboxManager.recordActivity(
            createChannelId(message.channel.id),
            createGuildId(message.guild?.id ?? 'DM'),
            message.id,
            message.createdAt.toISOString()
        );
    }
}

/**
 * Helper function to check if a message should be ignored.
 * Returns true if the message is from a bot or from the bot itself.
 */
// Stryker disable ConditionalExpression,EqualityOperator,BooleanLiteral: shouldIgnoreMessage guards — flipping bot/self checks causes test feedback loops (bot processes its own messages)
function shouldIgnoreMessage(message: Message, botUserId: UserId): boolean {
    // Ignore bot messages
    if(message.author.bot) {
        return true;
    }

    // Ignore messages from the bot itself
    if(message.author.id === botUserId) {
        return true;
    }

    return false;
}
// Stryker restore ConditionalExpression,EqualityOperator,BooleanLiteral

/**
 * Helper function to determine response context for a message.
 * Returns an object with isDM, isMention, isReplyToBot, and shouldRespond.
 */
async function determineResponseContext(
    message: Message,
    botUserId: UserId,
    channelRegistry: ChannelRegistryManager
): Promise<{ isDM: boolean, isMention: boolean, isReplyToBot: boolean, shouldRespond: boolean }> {
    const isDM = !message.guild; // DM channels have no guild
    const isMention = message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
    const channelId = createChannelId(message.channel.id);

    // Check for reply to bot
    let isReplyToBot = false;
    // Stryker disable next-line ConditionalExpression: Guard skips fetch when no reference exists; catch swallows the same failure
    if(message.reference?.messageId) {
        // Stryker disable BlockStatement — Discord API call to fetch referenced message; catch silently ignores unavailable/deleted messages
        try {
            const referencedMessage = await message.fetchReference();
            isReplyToBot = referencedMessage.author.id === botUserId;
        } catch{
            // Silent: fetchReference() throws when the referenced message was deleted or is
            // in a channel the bot cannot read. The safe fallback is isReplyToBot = false,
            // meaning the bot treats the message as not a reply to itself — a minor false
            // negative that avoids responding to deleted-message replies. Logging every
            // deleted-reference lookup would be very noisy in active channels.
        }
        // Stryker restore BlockStatement
    }

    // Muting applies at the channel level only. Threads inherit their parent channel's mute state.
    // For thread messages, check parent channel mute state
    // If parent is muted, threads inherit the mute unless override conditions apply
    let shouldRespond = channelRegistry.shouldProcess(channelId, isDM, isMention, isReplyToBot);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: isThread typed as non-optional but may be absent on older discord.js versions
    if(shouldRespond && message.channel.isThread?.() && message.channel.parentId) {
        const parentChannelId = createChannelId(message.channel.parentId);
        // Check if parent channel is muted. Override conditions (mention, reply) still apply - if someone @mentions Izzy in a thread of a muted channel, still respond.
        shouldRespond = channelRegistry.shouldProcess(parentChannelId, false, isMention, isReplyToBot);
    }

    return { isDM, isMention, isReplyToBot, shouldRespond };
}

/**
 * Helper function to check for pending questions and handle answers/interruptions/unrelated.
 * Returns true if message was handled (early return), false to continue normal processing.
 */
async function handlePendingQuestion(
    message: Message,
    questionRegistry: QuestionRegistry,
    answerClassifier: AnswerClassifier,
    isMention: boolean
): Promise<boolean> {
    // For threads, use parent channel ID for lookup; for regular channels, use the channel ID
    let lookupChannelId: ChannelId;
    let lookupThreadId: string | undefined;

    if(message.channel.isThread()) {
        // Thread messages: parent channel + thread ID
        lookupChannelId = createChannelId(message.channel.parentId ?? message.channel.id);
        lookupThreadId = message.channel.id;
    } else {
        // Regular channel messages: just channel ID, no thread
        lookupChannelId = createChannelId(message.channel.id);
        lookupThreadId = undefined;
    }

    const pendingQuestion = questionRegistry.findPendingQuestion(
        lookupChannelId,
        lookupThreadId
    );

    if(!pendingQuestion) {
        return false;
    }

    const classification = await answerClassifier.classify(pendingQuestion, {
        content:             message.cleanContent,
        authorId:            message.author.id,
        channelId:           message.channel.id,
        threadId:            lookupThreadId,
        referencedMessageId: message.reference?.messageId,
        isBotMentioned:      isMention,
        targetUserId:        pendingQuestion.targetUserId,
    });

    // Stryker disable all: Logger debug object
    logger.debug({
        questionId: pendingQuestion.questionId,
        channelId:  lookupChannelId,
        threadId:   lookupThreadId,
        classification,
        msg:        `Message classified as ${classification}`,
    });
    // Stryker restore all

    if(classification === 'answer') {
        // Stryker disable all: Logger info object
        logger.info({
            questionId:  pendingQuestion.questionId,
            responderId: message.author.id,
            messageId:   message.id,
            msg:         'Question resolved with text answer',
        });
        // Stryker restore all

        // Resolve the question - don't send to coordinator
        questionRegistry.resolveWithAnswer(pendingQuestion.questionId, {
            content:     message.cleanContent,
            responderId: createUserId(message.author.id),
            messageId:   message.id,
            channelId:   lookupChannelId,
            threadId:    lookupThreadId,
        });
        return true; // Early return
    }

    if(classification === 'interruption') {
        // Stryker disable all: Logger info object
        logger.info({
            questionId: pendingQuestion.questionId,
            msg:        'Question cancelled due to interruption',
        });
        // Stryker restore all

        // Cancel pending question and continue to normal processing
        questionRegistry.cancel(pendingQuestion.questionId);
        return false;
    }

    // Unrelated — send polite reply and keep question pending
    // Stryker disable all: Logger debug object
    logger.debug({
        questionId: pendingQuestion.questionId,
        msg:        'Message classified as unrelated, question still pending',
    });
    // Stryker restore all
    await withDiscordRetry(
        async () => {
            await message.reply({
                content: "I'm not sure if this message is for me. If you'd like my help, please @mention me!",
            });
        }
    );
    return true; // Early return - don't continue processing
}

/**
 * Converts a Discord.js Message into a DiscordMessageContext and hands it off to the message
 * coordinator (batching, interruption, and onResponse are the coordinator's concern from here).
 *
 * Extracted so both call sites — the handler's own 'pass'/no-gate dispatch below, and the ingress
 * gate's `onDrain` callback (wired up where the gate is constructed) — share exactly one path
 * into the coordinator, rather than re-deriving the context independently.
 */
export function dispatchToCoordinator(
    message: Message,
    botUserId: UserId,
    coordinator: MessageCoordinator
): void {
    const attachments = extractAttachmentMetadata(message);
    const context: DiscordMessageContext = {
        guildId:     createGuildId(message.guild?.id ?? 'DM'),
        channelId:   createChannelId(message.channel.id),
        userId:      createUserId(message.author.id),
        username:    message.author.username,
        messageId:   message.id,
        content:     message.cleanContent,
        timestamp:   message.createdAt.toISOString(),
        botUserId,
        attachments: attachments.length > 0 ? attachments : undefined,
    };

    const channel = isTypingChannel(message.channel) ? message.channel : undefined;
    coordinator.handleMessage(context, message, channel);
}

/**
 * Submits `message` (already known to be in the well-known `perch-time` channel) to the perch
 * conductor as a `discord`-kind envelope: priority `'other'` so it never interrupts a running
 * perch slot turn (see `perch-driver.ts`'s own overlap contract — this is a completely separate
 * queue from the slot/wrap-up envelopes it submits). On a settled turn with a response, delivers
 * it back to the originating channel through `perch.conductor.deliver` (the same idempotent,
 * journal-backed path `coordinator-setup.ts` uses for conversation turns) rather than a raw send,
 * so a crash between the turn settling and the send landing is recovered on the next boot instead
 * of silently lost or double-sent. Either way, the channel's HANDLED watermark advances via
 * `inboxManager.recordHandled` — a perch-channel batch (one message here; the coordinator's own
 * batching does not apply to this path) is "handled" once its turn has settled, whether or not it
 * produced a reply.
 */
async function submitPerchChannelMessage(
    message: Message,
    botUserId: UserId,
    perch: PerchRoutingDeps,
    inboxManager?: InboxManager
): Promise<void> {
    const channelId = createChannelId(message.channel.id);
    const channel = message.channel as TextChannel;
    // Same `discord`-kind envelope convention conductor-processor.ts uses for the conversation
    // path: the author's own stored timezone, falling back to resolveTimezone()'s server-zone
    // default when nothing is stored (or no contextBuilder was supplied at all).
    const storedTimezone = await perch.contextBuilder?.loadUserTimezone(message.author.id);
    const timezone = resolveTimezone(storedTimezone);

    const envelope = buildDiscordEnvelope({
        messages: [{
            channelId: message.channel.id,
            userId:    message.author.id,
            messageId: message.id,
            content:   `${message.author.username}: ${message.cleanContent}`,
            timestamp: message.createdAt.toISOString(),
            botUserId,
            guildId:   message.guild?.id,
        }],
        authorId:    message.author.id,
        authorName:  message.author.username,
        channelId:   message.channel.id,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: DM channels have null name despite TextChannel cast
        channelName: channel.name ?? message.channel.id,
        isDM:        false,
        now:         new Date(),
        timezone,
        timeHeader:  formatTimeHeader(timezone),
    });

    // Not `return`ed on a submit failure: this channel is entirely excluded from
    // replayUnhandled (bot.ts's own excludeChannelIds, applied whenever `perch` is even
    // constructed — see PerchRoutingDeps's own doc), so a submit rejection has no OTHER recovery
    // path — leaving the watermark stuck "unhandled" here would not enable a retry, only leave a
    // permanent phantom entry. recordHandled below always runs so the watermark reflects "this
    // message's perch turn was attempted" regardless of outcome.
    let result: { response: string | null } | undefined;
    try {
        result = await perch.conductor.submit(envelope, { priority: 'other', requestingChannelId: message.channel.id });
    } catch (err) {
        logger.error({ err, channelId: message.channel.id, msg: 'Perch-channel envelope submission failed' });
    }

    if(result?.response) {
        try {
            await perch.conductor.deliver(envelope.id, async () => {
                const sendResult = await sendEnvelopeResponse({
                    envelopeId:        envelope.id,
                    kind:              'discord',
                    channelId,
                    text:              result.response!,
                    responseRouter:    perch.responseRouter,
                    client:            perch.client,
                    rateLimiter:       perch.rateLimiter,
                    discordCapability: perch.discordCapability,
                });
                if(!sendResult.sent && !sendResult.queued) {
                    throw new PerchResponseNotSentError();
                }
                return { channelId: message.channel.id, messageIds: [] };
            });
        } catch (err) {
            if(!(err instanceof PerchResponseNotSentError)) {
                logger.error({ err, channelId: message.channel.id, msg: 'Perch-channel response delivery failed' });
            }
        }
    }

    if(inboxManager) {
        try {
            await inboxManager.recordHandled(channelId, message.id, message.createdAt.toISOString());
        } catch (err) {
            logger.warn({ err, channelId: message.channel.id, msg: 'Failed to record handled watermark for perch-channel message' });
        }
    }
}

/**
 * The subset of {@link MessageHandlerOptions} {@link dispatchAdmittedMessage} needs. Neither
 * `addRecentMessage` nor the inbox-metadata refresh appears here — both run at receipt time in
 * {@link createMessageHandler} itself; see {@link dispatchAdmittedMessage}'s own doc for why.
 */
interface DispatchAdmittedMessageOptions {
    channelRegistry: ChannelRegistryManager
    inboxManager?:   InboxManager
    perch?:          PerchRoutingDeps
}

/**
 * Everything that happens for a message ONCE it is admitted — passed straight through by the
 * handler's own 'pass' branch, or replayed later by the boot sequence's ingress-gate drain — so a
 * perch-channel message arriving during boot is buffered exactly like any other (the folded gap
 * this function closes): the ingress gate decides admission FIRST, and only an admitted message
 * ever reaches the perch-vs-coordinator routing decision below.
 *
 * The inbox-metadata refresh/`addRecentMessage` are deliberately NOT here — the caller
 * (`createMessageHandler`) runs those at RECEIPT time, ahead of the ingress gate, alongside
 * `updateInboxCheckpoint`. If they lived here instead, a message the boot sequence's
 * `replayUnhandled` already covers is excluded from `onDrain` entirely (`ingress-gate.ts`'s own
 * `open()`), so this function would never run for it — losing its channel metadata refresh and
 * idle-status ring-buffer entry for every replayed message, not just the ones this function
 * actually gets called for.
 * @param message The admitted Discord message.
 * @param botUserId The bot's own user id (mention detection upstream; envelope authorship here).
 * @param coordinator The (conversation) message coordinator — untouched for a perch-channel message.
 * @param options See {@link DispatchAdmittedMessageOptions}.
 */
export async function dispatchAdmittedMessage(
    message: Message,
    botUserId: UserId,
    coordinator: MessageCoordinator,
    options: DispatchAdmittedMessageOptions
): Promise<void> {
    const { channelRegistry, inboxManager, perch } = options;

    if(perch) {
        // Guarded: a rejection here (the backend read inside getWellKnownChannel is not itself
        // try/caught — see channel-registry/manager.ts) must not drop this message outright.
        // Falling back to "not the perch channel" routes it to the (conversation) coordinator
        // below instead — the same degrade bot.ts's own clientReady lookup uses for the same
        // failure — rather than losing it with no reply and no coordinator dispatch.
        //
        // Known follow-up, not fixed here: ChannelRegistryManager only caches a SUCCESSFUL
        // well-known-channel lookup (manager.ts's own `wellKnownCache`) — while no `perch-time`
        // channel is registered, every admitted message re-hits the backend (a per-message
        // DynamoDB read in the hot path). Fixing that means caching (with a TTL, so a
        // later-registered channel is still picked up) inside manager.ts itself, out of this
        // package's scope; the correctness half (never dropping a message on a rejected lookup)
        // is handled by the try/catch below regardless.
        let perchChannel: Awaited<ReturnType<typeof channelRegistry.getWellKnownChannel>> = null;
        try {
            perchChannel = await channelRegistry.getWellKnownChannel('perch-time');
        } catch (err) {
            logger.error({ err, channelId: message.channel.id, msg: 'Failed to resolve the well-known perch-time channel; routing to the coordinator instead' });
        }
        if(perchChannel !== null && perchChannel.channelId === message.channel.id) {
            await submitPerchChannelMessage(message, botUserId, perch, inboxManager);
            return;
        }
    }

    dispatchToCoordinator(message, botUserId, coordinator);
}

export function createMessageHandler(options: MessageHandlerOptions): (message: Message) => Promise<void> {
    const { botUserId, channelRegistry, addRecentMessage, coordinator, questionRegistry, answerClassifier, inboxManager, dmTracker, ingressGate, perch } = options;

    return async (message: Message) => {
        logger.debug({
            authorId:  message.author.id,
            channelId: message.channel.id,
            isDM:      !message.guild,
            msg:       `Message received from ${message.author.tag}`,
        });

        // Check if message should be ignored
        if(shouldIgnoreMessage(message, botUserId)) {
            return;
        }

        // Determine response context
        const { isDM, isMention, isReplyToBot, shouldRespond } = await determineResponseContext(
            message,
            botUserId,
            channelRegistry
        );

        // FIRST: Check for pending questions BEFORE shouldRespond filtering
        // This allows answers in unmonitored channels or without mentions
        if(questionRegistry && answerClassifier) {
            const handled = await handlePendingQuestion(message, questionRegistry, answerClassifier, isMention);
            if(handled) {
                return;
            }
        }

        // THEN: Normal shouldRespond check for non-pending-question messages
        logger.debug({
            isDM,
            isMention,
            isReplyToBot,
            shouldRespond,
            msg: `Filtering: isDM=${isDM}, isMention=${isMention}, isReplyToBot=${isReplyToBot} → shouldRespond=${shouldRespond}`,
        });

        if(!shouldRespond) {
            return;
        }

        // Track DM channel if this is a DM message
        if(dmTracker && isDM) {
            try {
                await dmTracker.trackFromMessage(
                    createUserId(message.author.id),
                    createChannelId(message.channel.id),
                    message.author.username
                );
            } catch (error) {
                // Log tracking failure but continue processing message
                logger.warn({
                    error,
                    userId:    message.author.id,
                    channelId: message.channel.id,
                    msg:       'Failed to track DM channel, continuing message processing',
                });
            }
        }

        // The ingress gate is checked FIRST — before the perch-vs-coordinator routing decision,
        // which lives in dispatchAdmittedMessage — so a perch-channel message arriving during boot
        // is buffered exactly like any other. The receipt-time checkpoint (lastSeen),
        // channel-metadata refresh, and idle-status ring-buffer entry all happen unconditionally
        // here, ahead of the gate — NOT gated on admission, so a message the boot sequence's
        // replay later excludes from onDrain entirely (see dispatchAdmittedMessage's own doc)
        // still gets them, exactly as it would have before this handler had a gate at all.
        await updateInboxCheckpoint(message, inboxManager, shouldRespond);
        refreshInboxChannelMetadata(message, inboxManager, shouldRespond);
        addRecentMessage?.(message.cleanContent, 'user');

        if(ingressGate.admit(message) !== 'pass') {
            return;
        }

        await dispatchAdmittedMessage(message, botUserId, coordinator, {
            channelRegistry, inboxManager, perch,
        });
    };
}
