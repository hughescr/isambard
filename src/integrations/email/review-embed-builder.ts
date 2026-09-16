import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { truncate } from 'lodash-es';
import type { EmailMetadata, ClassifierVerdict, EmailFolder } from '@/integrations/email/types';

interface OutboundApprovalEmbedParams {
    to:       string
    subject:  string
    draftUid: number
    cc?:      string[]
}

interface ReviewEmbedResult {
    embed:     EmbedBuilder
    actionRow: ActionRowBuilder<ButtonBuilder>
}

const ORANGE             = 0xFF_8C_00;
const RED                = 0xFF_00_00;
const BLUE               = 0x00_55_FF;
const YELLOW             = 0xFF_CC_00;
const BODY_TRUNCATE_LENGTH = 500;

/**
 * Format the "from" display value as "Name <address>" or just "address" if no name.
 */
function formatFromValue(email: EmailMetadata): string {
    return email.from.name
        ? `${email.from.name} <${email.from.address}>`
        : email.from.address;
}

/**
 * Build the 4-button inbox action row (Trash, Junk, Allow, Allow + Allowlist).
 */
function buildInboxActionRow(uid: number, folder: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`email-trash:${uid}:${folder}`)
            .setLabel('Trash')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`email-junk:${uid}:${folder}`)
            .setLabel('Junk')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`email-allow:${uid}:${folder}`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`email-allowlist:${uid}:${folder}`)
            .setLabel('Allow + Allowlist')
            .setStyle(ButtonStyle.Primary)
    );
}

/**
 * Build a review embed for emails classified as 'uncertain'.
 * Returns an orange embed with email metadata and 4 action buttons.
 */
export function buildReviewEmbed(email: EmailMetadata, folder: EmailFolder): ReviewEmbedResult {
    const fromValue = formatFromValue(email);

    const embed = new EmbedBuilder()
        .setTitle('Email Review Required')
        .setColor(ORANGE)
        .addFields(
            { name: 'From',    value: fromValue,                       inline: true },
            { name: 'Subject', value: email.subject || '(no subject)', inline: true },
            { name: 'Date',    value: email.date.toISOString(),        inline: true }
        )
        .setDescription(truncate(email.bodyText, { length: BODY_TRUNCATE_LENGTH }));

    const actionRow = buildInboxActionRow(email.uid, folder);

    return { embed, actionRow };
}

/**
 * Build an alert embed for emails classified as 'unsafe'.
 * Returns a red embed with email metadata, verdict reason, and 4 action buttons.
 */
export function buildUnsafeAlert(email: EmailMetadata, verdict: ClassifierVerdict, folder: EmailFolder): ReviewEmbedResult {
    const fromValue = formatFromValue(email);

    const description = `**Reason:** ${verdict.reason}\n\n${truncate(email.bodyText, { length: BODY_TRUNCATE_LENGTH })}`;

    const embed = new EmbedBuilder()
        .setTitle('Unsafe Email Detected')
        .setColor(RED)
        .addFields(
            { name: 'From',    value: fromValue,                       inline: true },
            { name: 'Subject', value: email.subject || '(no subject)', inline: true },
            { name: 'Date',    value: email.date.toISOString(),        inline: true }
        )
        .setDescription(description);

    const actionRow = buildInboxActionRow(email.uid, folder);

    return { embed, actionRow };
}

/**
 * Build a notification embed for restricted mailbox access requests.
 * Returns a yellow embed with mailbox/uid/reference fields and a 'Move to CleanInbox' button.
 */
export function buildRestrictedAccessEmbed(mailboxName: string, uid: number, reference: string): ReviewEmbedResult {
    const embed = new EmbedBuilder()
        .setTitle('Restricted Mailbox Access Requested')
        .setColor(YELLOW)
        .addFields(
            { name: 'Mailbox',   value: mailboxName, inline: true },
            { name: 'UID',       value: String(uid), inline: true },
            { name: 'Reference', value: reference,   inline: true }
        );

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`email-allow:${uid}:${mailboxName}`)
            .setLabel('Move to CleanInbox')
            .setStyle(ButtonStyle.Success)
    );

    return { embed, actionRow };
}

/**
 * Build an outbound email approval embed for Craig's review.
 * Returns a blue embed with draft metadata and 3 action buttons:
 * Approve, Approve+Allowlist, Reject.
 */
export function buildOutboundApprovalEmbed(params: OutboundApprovalEmbedParams): ReviewEmbedResult {
    const ccFields = params.cc && params.cc.length > 0
        ? [{ name: 'Cc', value: params.cc.join(', '), inline: true }]
        : [];
    // Stryker restore BooleanLiteral

    const embed = new EmbedBuilder()
        .setTitle('Outbound Email Approval Required')
        .setColor(BLUE)
        .addFields(
            { name: 'To',      value: params.to,     inline: true },
            { name: 'Subject', value: params.subject, inline: true },
            ...ccFields
        );

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`email-send-approve:${params.draftUid}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`email-send-approveallowlist:${params.draftUid}`)
            .setLabel('Approve + Allowlist')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`email-send-reject:${params.draftUid}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
    );

    return { embed, actionRow };
}
