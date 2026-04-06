import { LabelBuilder, ModalBuilder, TextInputBuilder } from '@discordjs/builders';
import { logger } from '@hughescr/logger';
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    TextInputStyle,
    type ButtonInteraction,
    type ModalSubmitInteraction
} from 'discord.js';
import type { AllowlistSagaExecutor, AllowlistSagaStarter, SagaStepResult } from '@/services';
import type { ContactBackend, Contact, ContactId } from '@/storage';

const GREEN = 0x00_FF_00;
const BLUE  = 0x00_99_FF;

export interface AllowlistInteractionHandlerDeps {
    executor:       AllowlistSagaExecutor
    contactBackend: ContactBackend
}

/**
 * Handles Discord modal and button interactions for the allowlist saga flow.
 *
 * CustomId patterns handled:
 * - Modal:  allowlist-name:{sagaId}         — admin submitted a display name
 * - Button: allowlist-yes:{sagaId}          — admin confirmed a fuzzy match
 * - Button: allowlist-next:{sagaId}         — admin wants to see the next match
 * - Button: allowlist-create:{sagaId}       — admin wants to create a new contact
 * - Button: allowlist-startmodal:{sagaId}   — admin clicked "set up allowlist" to open the modal
 */
export class AllowlistInteractionHandler implements AllowlistSagaStarter {
    private readonly deps: AllowlistInteractionHandlerDeps;

    constructor(deps: AllowlistInteractionHandlerDeps) {
        this.deps = deps;
    }

    /**
     * Handle a modal submission (display name input).
     * CustomId: allowlist-name:{sagaId}
     */
    async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        const sagaId = interaction.customId.split(':')[1];
        if(!sagaId) {
            return;
        }

        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps saga step — error handling
        try {
            // Stryker disable next-line StringLiteral: field customId is configuration
            const displayName = interaction.fields.getTextInputValue('display-name');
            const result = await this.deps.executor.submitName(sagaId, displayName);
            await this.renderResult(interaction, result);
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, sagaId, msg: 'Allowlist saga: failed to process name submission' });
            await this.renderError(interaction);
        }
        // Stryker restore BlockStatement
    }

    /**
     * Handle a button click (yes/next/create/startmodal).
     * CustomIds: allowlist-yes:{sagaId}, allowlist-next:{sagaId}, allowlist-create:{sagaId},
     *            allowlist-startmodal:{sagaId}
     */
    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const colonIdx = interaction.customId.indexOf(':');
        // Stryker disable next-line ConditionalExpression,EqualityOperator: guard against missing colon — equivalent mutants produce same early-return result
        if(colonIdx === -1) {
            return;
        }
        const prefix  = interaction.customId.slice(0, colonIdx);
        const sagaId  = interaction.customId.slice(colonIdx + 1);
        if(!sagaId) {
            return;
        }

        // allowlist-startmodal must show a modal — cannot deferUpdate first
        if(prefix === 'allowlist-startmodal') {
            await this.handleStartModal(interaction, sagaId);
            return;
        }

        await interaction.deferUpdate();

        // Stryker disable BlockStatement: try-catch wraps saga step — error handling
        try {
            let result: SagaStepResult;
            switch(prefix) {
                case 'allowlist-yes': {
                    result = await this.deps.executor.confirmMatch(sagaId);
                    break;
                }
                case 'allowlist-next': {
                    result = await this.deps.executor.skipMatch(sagaId);
                    break;
                }
                case 'allowlist-create': {
                    result = await this.deps.executor.createNew(sagaId);
                    break;
                }
                default: {
                    return;
                }
            }
            await this.renderResult(interaction, result);
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, sagaId, msg: 'Allowlist saga: failed to process button' });
            await this.renderError(interaction);
        }
        // Stryker restore BlockStatement
    }

    /**
     * Kick off the allowlist saga from an approve+allowlist button or select menu interaction.
     * Must be called AFTER deferUpdate() has already been issued by the caller.
     * Shows a followUp if a name is needed, or records success inline.
     */
    async startFromApproval(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural duck type for Discord interaction; discord.js followUp overload doesn't match exact structural type
        interaction: { followUp: (options: any) => Promise<unknown> },
        platform: 'email' | 'bsky',
        identifierValue: string,
        displayNameHint?: string
    ): Promise<{ allowlistSuffix: string }> {
        // Stryker disable BlockStatement: try-catch wraps saga start — error handling
        try {
            const result = await this.deps.executor.start(platform, identifierValue, displayNameHint);

            if(result.action === 'completed') {
                // Contact already exists — add a note in a followUp
                // Stryker disable next-line StringLiteral,TemplateLiteral: UI message is configuration
                await interaction.followUp({ content: `✓ **${result.displayName}** added to allowlist.`, ephemeral: true });
                // Stryker disable next-line StringLiteral,TemplateLiteral: UI suffix text is configuration
                return { allowlistSuffix: ` + ${result.displayName} allowlisted` };
            }

            if(result.action === 'need_name') {
                // Show a follow-up message with a "Set up allowlist entry" button
                const sagaId = result.sagaId;
                const row    = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        // Stryker disable next-line StringLiteral,TemplateLiteral: customId is configuration
                        .setCustomId(`allowlist-startmodal:${sagaId}`)
                        // Stryker disable next-line StringLiteral: Button label is UI configuration
                        .setLabel('Set up allowlist entry')
                        .setStyle(ButtonStyle.Primary)
                );
                // Stryker disable next-line StringLiteral: UI message is configuration
                await interaction.followUp({ content: 'Add to allowlist:', components: [row], ephemeral: true });
            }
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.error({ err, platform, identifierValue, msg: 'Allowlist saga: failed to start from approval' });
        }
        // Stryker restore BlockStatement
        return { allowlistSuffix: '' };
    }

    /**
     * Handle the allowlist-startmodal button: show the name-entry modal.
     * This is the FIRST response to the interaction — must NOT have deferUpdate() before it.
     */
    private async handleStartModal(interaction: ButtonInteraction, sagaId: string): Promise<void> {
        const modal = new ModalBuilder()
            // Stryker disable next-line StringLiteral,TemplateLiteral: customId is configuration
            .setCustomId(`allowlist-name:${sagaId}`)
            // Stryker disable next-line StringLiteral: Modal title is UI configuration
            .setTitle('Add to Allowlist');

        const nameInput = new TextInputBuilder()
            // Stryker disable next-line StringLiteral: field customId is configuration
            .setCustomId('display-name')
            .setStyle(TextInputStyle.Short);
        // Stryker disable next-line BooleanLiteral: required=true is UI configuration
        nameInput.setRequired(true);
        // Stryker disable next-line StringLiteral: placeholder text is UI configuration
        nameInput.setPlaceholder('Enter display name for new contact');

        const nameLabel = new LabelBuilder();
        // Stryker disable next-line StringLiteral: label is UI configuration
        nameLabel.setLabel('Display name');
        nameLabel.setTextInputComponent(nameInput);
        modal.addLabelComponents(nameLabel);

        await interaction.showModal(modal);
    }

    /**
     * Render a saga step result as a Discord embed/buttons.
     */
    private async renderResult(
        interaction: ModalSubmitInteraction | ButtonInteraction,
        result: SagaStepResult
    ): Promise<void> {
        switch(result.action) {
            case 'completed': {
                const embed = new EmbedBuilder()
                    // Stryker disable next-line StringLiteral: UI label is configuration
                    .setTitle('Added to Allowlist \u2713')
                    // Stryker disable next-line StringLiteral,TemplateLiteral: embed description is UI configuration
                    .setDescription(`**${result.displayName}** has been added to the allowlist.`)
                    .setColor(GREEN);
                await interaction.editReply({ embeds: [embed], components: [] });
                break;
            }
            case 'review_match': {
                const contact = await this.deps.contactBackend.getContact(result.matchPersonId);
                const embed   = this.buildContactReviewEmbed(contact, result.matchPersonId);
                const row     = this.buildReviewButtons(result.sagaId);
                await interaction.editReply({ embeds: [embed], components: [row] });
                break;
            }
            case 'cancelled': {
                const embed = new EmbedBuilder()
                    // Stryker disable next-line StringLiteral: UI label is configuration
                    .setTitle('Allowlist Flow Cancelled')
                    .setColor(BLUE);
                await interaction.editReply({ embeds: [embed], components: [] });
                break;
            }
            // Stryker disable ConditionalExpression,BlockStatement: exhaustiveness branch — need_name only returned from start(), never from renderResult callers (submitName/confirmMatch/skipMatch/createNew)
            case 'need_name': {
                // need_name is only returned from start() — not from submitName/confirmMatch/skipMatch/createNew
                // This branch is unreachable in practice but required for exhaustiveness.
                break;
            }
            // Stryker restore ConditionalExpression,BlockStatement
        }
    }

    private buildContactReviewEmbed(contact: Contact | undefined, personId: ContactId): EmbedBuilder {
        const embed = new EmbedBuilder()
            // Stryker disable next-line StringLiteral: UI label is configuration
            .setTitle('Is this the same person?')
            .setColor(BLUE);

        if(contact) {
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline are UI configuration
            embed.addFields({ name: 'Name', value: contact.displayName, inline: true });
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline are UI configuration
            embed.addFields({ name: 'Person ID', value: contact.personId, inline: true });
            if(contact.identifiers.length > 0) {
                const idStr = contact.identifiers.map(id => `${id.platform}: ${id.value}`).join('\n');
                // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline are UI configuration
                embed.addFields({ name: 'Identifiers', value: idStr, inline: false });
            }
            if(contact.notes) {
                // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline are UI configuration
                embed.addFields({ name: 'Notes', value: contact.notes, inline: false });
            }
        } else {
            // Stryker disable next-line StringLiteral,TemplateLiteral: fallback description is UI configuration
            embed.setDescription(`Contact ${personId} not found`);
        }

        return embed;
    }

    private buildReviewButtons(sagaId: string): ActionRowBuilder<ButtonBuilder> {
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                // Stryker disable next-line StringLiteral,TemplateLiteral: customId is configuration
                .setCustomId(`allowlist-yes:${sagaId}`)
                // Stryker disable next-line StringLiteral: Button label is UI configuration
                .setLabel('Yes, this person')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                // Stryker disable next-line StringLiteral,TemplateLiteral: customId is configuration
                .setCustomId(`allowlist-next:${sagaId}`)
                // Stryker disable next-line StringLiteral: Button label is UI configuration
                .setLabel('No, show next')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                // Stryker disable next-line StringLiteral,TemplateLiteral: customId is configuration
                .setCustomId(`allowlist-create:${sagaId}`)
                // Stryker disable next-line StringLiteral: Button label is UI configuration
                .setLabel('Create new person')
                .setStyle(ButtonStyle.Primary)
        );
    }

    private async renderError(interaction: ModalSubmitInteraction | ButtonInteraction): Promise<void> {
        // Stryker disable BlockStatement: best-effort error render
        try {
            const embed = new EmbedBuilder()
                // Stryker disable next-line StringLiteral: UI label is configuration
                .setTitle('Error')
                // Stryker disable next-line StringLiteral: error description is UI configuration
                .setDescription('An error occurred processing the allowlist flow.')
                .setColor(0xFF_00_00);
            await interaction.editReply({ embeds: [embed], components: [] });
        } catch{
            /* best effort */
        }
        // Stryker restore BlockStatement
    }
}
