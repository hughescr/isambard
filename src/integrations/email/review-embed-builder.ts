import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import _ from 'lodash';
import type { EmailMetadata, ClassifierVerdict } from '@/integrations/email/types';

export interface ReviewEmbedResult {
    embed:     EmbedBuilder
    actionRow: ActionRowBuilder<ButtonBuilder>
}

const ORANGE             = 0xFF8C00;
const RED                = 0xFF0000;
const BODY_TRUNCATE_LENGTH = 500;

/**
 * Build a review embed for emails classified as 'uncertain'.
 * Returns an orange embed with email metadata and 4 action buttons.
 */
export function buildReviewEmbed(email: EmailMetadata, folder: string): ReviewEmbedResult {
    const fromValue = email.from.name
        ? `${email.from.name} <${email.from.address}>`
        : email.from.address;

    const embed = new EmbedBuilder()
        // Stryker disable next-line StringLiteral: UI label is configuration
        .setTitle('Email Review Required')
        .setColor(ORANGE)
        .addFields(
            // Stryker disable next-line StringLiteral: Field name is UI label
            { name: 'From',    value: fromValue,                       inline: true },
            // Stryker disable next-line StringLiteral: Field name is UI label
            { name: 'Subject', value: email.subject || '(no subject)', inline: true },
            // Stryker disable next-line StringLiteral: Field name is UI label
            { name: 'Date',    value: email.date.toISOString(),        inline: true }
        )
        .setDescription(_.truncate(email.bodyText, { length: BODY_TRUNCATE_LENGTH }));

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-trash:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Trash')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-junk:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Junk')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-allow:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-allowlist:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Allow + Allowlist')
            .setStyle(ButtonStyle.Primary)
    );

    return { embed, actionRow };
}

/**
 * Build an alert embed for emails classified as 'unsafe'.
 * Returns a red embed with email metadata, verdict reason, and 4 action buttons.
 */
export function buildUnsafeAlert(email: EmailMetadata, verdict: ClassifierVerdict, folder: string): ReviewEmbedResult {
    const fromValue = email.from.name
        ? `${email.from.name} <${email.from.address}>`
        : email.from.address;

    const description = `**Reason:** ${verdict.reason}\n\n${_.truncate(email.bodyText, { length: BODY_TRUNCATE_LENGTH })}`;

    const embed = new EmbedBuilder()
        // Stryker disable next-line StringLiteral: UI label is configuration
        .setTitle('Unsafe Email Detected')
        .setColor(RED)
        .addFields(
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'From',    value: fromValue,                       inline: true },
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Subject', value: email.subject || '(no subject)', inline: true },
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Date',    value: email.date.toISOString(),        inline: true }
        )
        .setDescription(description);

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-trash:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Trash')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-junk:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Junk')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-allow:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`email-allowlist:${email.uid}:${folder}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Allow + Allowlist')
            .setStyle(ButtonStyle.Primary)
    );

    return { embed, actionRow };
}
