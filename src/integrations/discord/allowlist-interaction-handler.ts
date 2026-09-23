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
import { BRIGHT_GREEN, BLUE, RED } from './colors';
import type { AllowlistSagaExecutor, AllowlistSagaStarter, SagaInteractionResult } from '@/services';
import type { ContactBackend, Contact, ContactId } from '@/storage';

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

        try {
            const displayName = interaction.fields.getTextInputValue('display-name');
            const result = await this.deps.executor.submitName(sagaId, displayName);
            await this.renderResult(interaction, result);
        } catch (err) {
            logger.error({ err, sagaId, msg: 'Allowlist saga: failed to process name submission' });
            await this.renderError(interaction);
        }
    }

    /**
     * Handle a button click (yes/next/create/startmodal).
     * CustomIds: allowlist-yes:{sagaId}, allowlist-next:{sagaId}, allowlist-create:{sagaId},
     *            allowlist-startmodal:{sagaId}
     */
    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const colonIdx = interaction.customId.indexOf(':');
        // Stryker disable next-line llm: String.indexOf returns only -1 or a non-negative integer, so `=== -1` and `< 0` are equivalent.
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

        try {
            let result: SagaInteractionResult;
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
            logger.error({ err, sagaId, msg: 'Allowlist saga: failed to process button' });
            await this.renderError(interaction);
        }
    }

    /**
     * Kick off the allowlist saga from an approve+allowlist button or select menu interaction.
     * Must be called AFTER deferUpdate() has already been issued by the caller.
     * Shows a followUp if a name is needed, or records success inline.
     */
    async startFromApproval(
        interaction: { followUp: (options: { content: string, components?: ActionRowBuilder<ButtonBuilder>[], ephemeral: true }) => Promise<unknown> },
        platform: 'email' | 'bsky',
        identifierValue: string,
        displayNameHint?: string
    ): Promise<{ allowlistSuffix: string }> {
        try {
            const result = await this.deps.executor.start(platform, identifierValue, displayNameHint);

            // Stryker disable next-line llm: result.action is a string-literal union, so loose and strict comparison to this literal are equivalent.
            if(result.action === 'completed') {
                // Contact already exists — add a note in a followUp
                await interaction.followUp({ content: `✓ **${result.displayName}** added to allowlist.`, ephemeral: true });
                return { allowlistSuffix: ` + ${result.displayName} allowlisted` };
            }

            if(result.action === 'need_name') {
                // Show a follow-up message with a "Set up allowlist entry" button
                const sagaId = result.sagaId;
                const row    = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`allowlist-startmodal:${sagaId}`)
                        .setLabel('Set up allowlist entry')
                        .setStyle(ButtonStyle.Primary)
                );
                await interaction.followUp({ content: 'Add to allowlist:', components: [row], ephemeral: true });
            }
        } catch (err) {
            logger.error({ err, platform, identifierValue, msg: 'Allowlist saga: failed to start from approval' });
        }
        return { allowlistSuffix: '' };
    }

    /**
     * Handle the allowlist-startmodal button: show the name-entry modal.
     * This is the FIRST response to the interaction — must NOT have deferUpdate() before it.
     */
    private async handleStartModal(interaction: ButtonInteraction, sagaId: string): Promise<void> {
        const modal = new ModalBuilder()
            .setCustomId(`allowlist-name:${sagaId}`)
            .setTitle('Add to Allowlist');

        const nameInput = new TextInputBuilder()
            .setCustomId('display-name')
            .setStyle(TextInputStyle.Short);
        nameInput.setRequired(true);
        nameInput.setPlaceholder('Enter display name for new contact');

        const nameLabel = new LabelBuilder();
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
        result: SagaInteractionResult
    ): Promise<void> {
        switch(result.action) {
            case 'completed': {
                await this.renderCompleted(interaction, result.displayName);
                break;
            }
            case 'review_match': {
                const contact = await this.deps.contactBackend.getContact(result.matchPersonId);
                const embed   = this.buildContactReviewEmbed(contact, result.matchPersonId);
                const row     = this.buildReviewButtons(result.sagaId);
                await interaction.editReply({ embeds: [embed], components: [row] });
                break;
            }
            case 'unavailable': {
                if(result.reason === 'already_completed') {
                    // A repeated click on a finished flow shows the same completion again.
                    await this.renderCompleted(interaction, result.displayName);
                    break;
                }
                const embed = new EmbedBuilder()
                    .setTitle('This request is no longer active')
                    .setDescription('It has expired or was already processed.')
                    .setColor(BLUE);
                await interaction.editReply({ embeds: [embed], components: [] });
                break;
            }
        }
    }

    private async renderCompleted(interaction: ModalSubmitInteraction | ButtonInteraction, displayName: string): Promise<void> {
        const embed = new EmbedBuilder()
            .setTitle('Added to Allowlist ✓')
            .setDescription(`**${displayName}** has been added to the allowlist.`)
            .setColor(BRIGHT_GREEN);
        await interaction.editReply({ embeds: [embed], components: [] });
    }

    private buildContactReviewEmbed(contact: Contact | undefined, personId: ContactId): EmbedBuilder {
        const embed = new EmbedBuilder()
            .setTitle('Is this the same person?')
            .setColor(BLUE);

        if(contact) {
            embed.addFields({ name: 'Name', value: contact.displayName, inline: true });
            embed.addFields({ name: 'Person ID', value: contact.personId, inline: true });
            // Stryker disable next-line EqualityOperator,llm: length > 0 and length >= 1 are equivalent for a non-negative integer array length
            if(contact.identifiers.length > 0) {
                const idStr = contact.identifiers.map(id => `${id.platform}: ${id.value}`).join('\n');
                embed.addFields({ name: 'Identifiers', value: idStr, inline: false });
            }
            if(contact.notes) {
                embed.addFields({ name: 'Notes', value: contact.notes, inline: false });
            }
        } else {
            embed.setDescription(`Contact ${personId} not found`);
        }

        return embed;
    }

    private buildReviewButtons(sagaId: string): ActionRowBuilder<ButtonBuilder> {
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`allowlist-yes:${sagaId}`)
                .setLabel('Yes, this person')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`allowlist-next:${sagaId}`)
                .setLabel('No, show next')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`allowlist-create:${sagaId}`)
                .setLabel('Create new person')
                .setStyle(ButtonStyle.Primary)
        );
    }

    private async renderError(interaction: ModalSubmitInteraction | ButtonInteraction): Promise<void> {
        try {
            const embed = new EmbedBuilder()
                .setTitle('Error')
                .setDescription('An error occurred processing the allowlist flow.')
                .setColor(RED);
            await interaction.editReply({ embeds: [embed], components: [] });
        } catch{
            // Silent: editReply can throw if the interaction already expired (15-minute Discord
            // limit) or if the bot lost message permission between processing and rendering.
            // The primary error has already been logged by the caller; failing to show the
            // error embed is a cosmetic degradation, not an additional error worth logging.
        }
    }
}
