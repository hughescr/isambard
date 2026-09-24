import { logger } from '@hughescr/logger';
import { MessageFlags, type ButtonInteraction, EmbedBuilder  } from 'discord.js';
import { EmailFolder, EMAIL_REVIEW_PREFIXES } from '@/config';
import { EmailProcessingError } from '@/errors';
import type { AllowlistApprovalStarter } from '@/integrations/discord/allowlist-interaction-handler';
import type { WildDuckClient } from '@/integrations/email';
import { parseCustomId } from '@/utils';

const GREEN = 0x00_AA_00;
const RED   = 0xFF_00_00;

interface EmailReviewHandlerDeps {
    wildDuckClient:              WildDuckClient
    adminDiscordUserId:          string
    allowlistInteractionHandler: AllowlistApprovalStarter
}

/**
 * Handles button interactions from inbound email review embeds.
 * Supports four actions: trash, junk, allow, and allow+allowlist.
 */
export class EmailReviewHandler {
    private readonly wildDuckClient:              WildDuckClient;
    private readonly adminDiscordUserId:          string;
    private readonly allowlistInteractionHandler: AllowlistApprovalStarter;

    constructor(deps: EmailReviewHandlerDeps) {
        this.wildDuckClient              = deps.wildDuckClient;
        this.adminDiscordUserId          = deps.adminDiscordUserId;
        this.allowlistInteractionHandler = deps.allowlistInteractionHandler;
    }

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        if(interaction.user.id !== this.adminDiscordUserId) {
            await interaction.reply({
                content: 'Only the admin can review emails.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }

        const parsed     = parseCustomId(interaction.customId);
        const prefix     = parsed?.prefix;
        const uidStr     = parsed?.id;
        const folderStr  = parsed?.value;

        if(!prefix || !(EMAIL_REVIEW_PREFIXES as readonly string[]).includes(prefix)) {
            return;
        }

        // Stryker disable next-line StringLiteral: absent UID parses as NaN with either empty or nonnumeric fallback and exits before any action
        const uid = Number.parseInt(uidStr ?? '', 10);
        if(Number.isNaN(uid)) {
            return;
        }

        const validFolderSet = new Set<string>(Object.values(EmailFolder));
        if(!folderStr || !validFolderSet.has(folderStr)) {
            await interaction.reply({
                content: 'Invalid folder in button interaction.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }
        const sourceFolder = folderStr as EmailFolder;

        // Acknowledge the interaction immediately to avoid Discord's 3-second timeout.
        // All subsequent responses must use editReply() instead of update().
        await interaction.deferUpdate();

        try {
            await this.dispatchReviewAction(prefix, interaction, uid, sourceFolder);
        } catch (err) {
            logger.error({ err, uid, prefix, msg: 'Review button handler failed' });
            try {
                await interaction.editReply({
                    content:    'An error occurred processing your request. Please try again.',
                    embeds:     [],
                    components: [],
                });
            } catch (error) {
                logger.error({ err: error, msg: 'Failed to send error editReply' });
            }
        }
    }

    private async dispatchReviewAction(prefix: string, interaction: ButtonInteraction, uid: number, sourceFolder: EmailFolder): Promise<void> {
        // Stryker disable next-line llm: prefix is typed string, so `prefix + ''` is the identity and the switch selects the same branch.
        switch(prefix) {
            case 'email-trash': {
                await this.handleTrash(interaction, uid, sourceFolder);
                break;
            }
            case 'email-junk': {
                await this.handleJunk(interaction, uid, sourceFolder);
                break;
            }
            case 'email-allow': {
                await this.handleAllow(interaction, uid, sourceFolder);
                break;
            }
            default: {
                await this.handleAllowlist(interaction, uid, sourceFolder);
            }
        }
    }

    private async handleTrash(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.Trash);

        const updatedEmbed = new EmbedBuilder()
            .setTitle('Trashed')
            .setColor(RED);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleJunk(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.Junk);

        const updatedEmbed = new EmbedBuilder()
            .setTitle('Junked')
            .setColor(RED);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleAllow(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.CleanInbox);

        const updatedEmbed = new EmbedBuilder()
            .setTitle('Allowed')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }

    private async handleAllowlist(interaction: ButtonInteraction, uid: number, sourceFolder: string): Promise<void> {
        // Fetch email to get sender address for allowlist
        const email = await this.wildDuckClient.getFullMessage(sourceFolder, uid);
        if(!email) {
            throw new EmailProcessingError(`Message UID ${uid} not found in ${sourceFolder}`, { uid, sourceFolder });
        }

        await this.wildDuckClient.moveMessage(sourceFolder, uid, EmailFolder.CleanInbox);

        // Kick off allowlist saga with sender address. startFromApproval is called after deferUpdate
        // so it uses followUp (not showModal) for the saga prompt.
        const senderAddress = email.from.address;
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- name can be '', and '' should map to undefined (|| intentional)
        const senderName    = email.from.name || undefined;
        await this.allowlistInteractionHandler.startFromApproval(interaction, 'email', senderAddress, senderName);

        const updatedEmbed = new EmbedBuilder()
            .setTitle('Allowed \u2713')
            .setColor(GREEN);

        await interaction.editReply({
            embeds:     [updatedEmbed],
            components: [],
        });
    }
}
