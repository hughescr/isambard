import { logger } from '@hughescr/logger';
import { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction  } from 'discord.js';
import type { EmailAllowlist } from '@/integrations/email/allowlist';

/**
 * Build the /allowlist slash command with list, add, and remove subcommands.
 */
export function buildAllowlistCommand(): SlashCommandBuilder {
    return new SlashCommandBuilder()
        .setName('allowlist')
        .setDescription('Manage the email allowlist')
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel,
        ])
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
        .addSubcommand(sub =>
            sub
                .setName('list')
                .setDescription('Show all allowlist entries')
        )
        .addSubcommand(sub =>
            sub
                .setName('add')
                .setDescription('Add an email to the allowlist')
                .addStringOption(opt =>
                    opt
                        .setName('email')
                        .setDescription('Email address to add')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('name')
                        .setDescription('Display name for the entry')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt
                        .setName('notes')
                        .setDescription('Notes about this entry')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('remove')
                .setDescription('Remove an email from the allowlist')
                .addStringOption(opt =>
                    opt
                        .setName('email')
                        .setDescription('Email address to remove')
                        .setRequired(true)
                )
        ) as SlashCommandBuilder;
}

/**
 * Handles /allowlist slash command interactions.
 * Only the admin (adminDiscordUserId) is authorized to use these commands.
 */
export class AllowlistCommandHandler {
    private readonly allowlist:          EmailAllowlist;
    private readonly adminDiscordUserId: string;

    constructor(allowlist: EmailAllowlist, adminDiscordUserId: string) {
        this.allowlist          = allowlist;
        this.adminDiscordUserId = adminDiscordUserId;
    }

    async handle(interaction: ChatInputCommandInteraction): Promise<void> {
        // Permission check — only the admin may manage the allowlist
        if(interaction.user.id !== this.adminDiscordUserId) {
            await interaction.reply({
                content:   'Only the admin can manage the allowlist.',
                ephemeral: true,
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        await interaction.deferReply({ ephemeral: true });

        if(subcommand === 'list') {
            await this.handleList(interaction);
        } else if(subcommand === 'add') {
            await this.handleAdd(interaction);
        } else {
            await this.handleRemove(interaction);
        }
    }

    private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const entries = await this.allowlist.list();

            if(entries.length === 0) {
                await interaction.editReply({ content: 'No entries in allowlist.' });
                return;
            }

            const lines = entries.map((entry) => {
                const parts = [`**${entry.email}**`];
                if(entry.name) {
                    parts.push(`Name: ${entry.name}`);
                }
                if(entry.notes) {
                    parts.push(`Notes: ${entry.notes}`);
                }
                parts.push(`Added: ${entry.addedAt}`);
                return parts.join(' | ');
            });

            await interaction.editReply({ content: lines.join('\n') });
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, msg: 'Failed to list allowlist entries' });
            await interaction.editReply({ content: 'Failed to list allowlist entries.' });
        }
        // Stryker enable BlockStatement
    }

    private async handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - email is required option
        const email = interaction.options.getString('email') ?? '';
        const name = interaction.options.getString('name') ?? undefined;
        const notes = interaction.options.getString('notes') ?? undefined;

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            await this.allowlist.addEntry({
                email,
                name,
                notes,
                addedAt: new Date().toISOString(),
                addedBy: 'discord-command',
            });
            // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
            await interaction.editReply({ content: `Added ${email} to allowlist.` });
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, email, msg: 'Failed to add to allowlist' });
            await interaction.editReply({ content: `Failed to add ${email} to allowlist.` });
        }
        // Stryker enable BlockStatement
    }

    private async handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - email is required option
        const email = interaction.options.getString('email') ?? '';

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            await this.allowlist.removeEntry(email);
            // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
            await interaction.editReply({ content: `Removed ${email} from allowlist.` });
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, email, msg: 'Failed to remove from allowlist' });
            await interaction.editReply({ content: `Failed to remove ${email} from allowlist.` });
        }
        // Stryker enable BlockStatement
    }
}
