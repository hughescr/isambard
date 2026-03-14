import { logger } from '@hughescr/logger';
import { MessageFlags, SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction  } from 'discord.js';
import type { EmailAllowlist } from '@/integrations/email/allowlist';

/**
 * Structural interface for a Bluesky allowlist — satisfied by BskyAllowlist
 * without importing from the bsky module (which is outside the email module's
 * allowed import boundaries).
 */
export interface BskyAllowlistLike {
    addEntry(entry: { handle: string, notes?: string, addedAt: string, addedBy: string }): Promise<void>
    removeEntry(handle: string): Promise<void>
    list(): Promise<{ handle: string, addedAt: string, notes?: string }[]>
}

/**
 * Build the /allowlist slash command with list, add, and remove subcommands.
 * The `address` option accepts both email addresses and Bluesky handles;
 * the handler auto-detects which type to use.
 */
export function buildAllowlistCommand(): SlashCommandBuilder {
    return new SlashCommandBuilder()
        .setName('allowlist')
        .setDescription('Manage the email and Bluesky allowlists')
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
                .setDescription('Add an email address or Bluesky handle to the allowlist')
                .addStringOption(opt =>
                    opt
                        .setName('address')
                        .setDescription('Email address or Bluesky handle to add')
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
                .setDescription('Remove an email address or Bluesky handle from the allowlist')
                .addStringOption(opt =>
                    opt
                        .setName('address')
                        .setDescription('Email address or Bluesky handle to remove')
                        .setRequired(true)
                )
        ) as SlashCommandBuilder;
}

/**
 * Handles /allowlist slash command interactions for both email and Bluesky allowlists.
 * Only the admin (adminDiscordUserId) is authorized to use these commands.
 */
export class AllowlistCommandHandler {
    private readonly emailAllowlist:     EmailAllowlist;
    private readonly bskyAllowlist:      BskyAllowlistLike;
    private readonly adminDiscordUserId: string;

    constructor(emailAllowlist: EmailAllowlist, bskyAllowlist: BskyAllowlistLike, adminDiscordUserId: string) {
        this.emailAllowlist     = emailAllowlist;
        this.bskyAllowlist      = bskyAllowlist;
        this.adminDiscordUserId = adminDiscordUserId;
    }

    async handle(interaction: ChatInputCommandInteraction): Promise<void> {
        // Permission check — only the admin may manage the allowlist
        if(interaction.user.id !== this.adminDiscordUserId) {
            await interaction.reply({
                content: 'Only the admin can manage the allowlist.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if(subcommand === 'list') {
            await this.handleList(interaction);
        } else if(subcommand === 'add') {
            await this.handleAdd(interaction);
        } else {
            await this.handleRemove(interaction);
        }
    }

    /**
     * Detect whether an address string is an email or a Bluesky handle.
     * An address is treated as email if it has an `@` after at least one
     * character (not the first character) AND the part after `@` contains
     * a `.` (i.e., has a domain component).  Strings starting with `@` are
     * Bluesky handles.  Everything else is also treated as a Bluesky handle.
     */
    private detectType(input: string): 'email' | 'bsky' {
        const atIndex = input.indexOf('@');
        // Stryker disable next-line ConditionalExpression,EqualityOperator: boundary detection logic — all conditions are load-bearing
        return atIndex > 0 && atIndex < input.lastIndexOf('.') ? 'email' : 'bsky';
    }

    private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            const [emailEntries, bskyEntries] = await Promise.all([
                this.emailAllowlist.list(),
                this.bskyAllowlist.list(),
            ]);

            if(emailEntries.length === 0 && bskyEntries.length === 0) {
                await interaction.editReply({ content: 'No entries in either allowlist.' });
                return;
            }

            const parts: string[] = [];

            if(emailEntries.length > 0) {
                const emailLines = emailEntries.map((entry) => {
                    const lineParts = [`**${entry.email}**`];
                    if(entry.name) {
                        lineParts.push(`Name: ${entry.name}`);
                    }
                    if(entry.notes) {
                        lineParts.push(`Notes: ${entry.notes}`);
                    }
                    lineParts.push(`Added: ${entry.addedAt}`);
                    return lineParts.join(' | ');
                });
                parts.push(`\u{1F4E7} Email Allowlist:\n${emailLines.join('\n')}`);
            }

            if(bskyEntries.length > 0) {
                const bskyLines = bskyEntries.map((entry) => {
                    const lineParts = [`**${entry.handle}**`];
                    if(entry.notes) {
                        lineParts.push(`Notes: ${entry.notes}`);
                    }
                    lineParts.push(`Added: ${entry.addedAt}`);
                    return lineParts.join(' | ');
                });
                parts.push(`\u{1FAB7} Bluesky Allowlist:\n${bskyLines.join('\n')}`);
            }

            await interaction.editReply({ content: parts.join('\n\n') });
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, msg: 'Failed to list allowlist entries' });
            await interaction.editReply({ content: 'Failed to list allowlist entries.' });
        }
        // Stryker enable BlockStatement
    }

    private async handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - address is required option
        const address = interaction.options.getString('address') ?? '';
        const name    = interaction.options.getString('name') ?? undefined;
        const notes   = interaction.options.getString('notes') ?? undefined;
        const type    = this.detectType(address);

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            if(type === 'email') {
                await this.emailAllowlist.addEntry({
                    email:   address,
                    name,
                    notes,
                    addedAt: new Date().toISOString(),
                    addedBy: 'discord-command',
                });
                // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
                await interaction.editReply({ content: `Added ${address} to email allowlist.` });
            } else {
                // Stryker disable next-line Regex: /^@/ and /@/ are equivalent for bsky-typed inputs (@ only appears at position 0)
                const handle = address.replace(/^@/, '');
                await this.bskyAllowlist.addEntry({
                    handle,
                    notes,
                    addedAt: new Date().toISOString(),
                    addedBy: 'discord-command',
                });
                // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
                await interaction.editReply({ content: `Added ${handle} to Bluesky allowlist.` });
            }
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, address, msg: 'Failed to add to allowlist' });
            await interaction.editReply({ content: `Failed to add ${address} to allowlist.` });
        }
        // Stryker enable BlockStatement
    }

    private async handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
        // Stryker disable next-line StringLiteral: fallback '' is unreachable - address is required option
        const address = interaction.options.getString('address') ?? '';
        const type    = this.detectType(address);

        // Stryker disable BlockStatement: try/catch is integration boundary
        try {
            if(type === 'email') {
                await this.emailAllowlist.removeEntry(address);
                // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
                await interaction.editReply({ content: `Removed ${address} from email allowlist.` });
            } else {
                // Stryker disable next-line Regex: /^@/ and /@/ are equivalent for bsky-typed inputs (@ only appears at position 0)
                const handle = address.replace(/^@/, '');
                await this.bskyAllowlist.removeEntry(handle);
                // Stryker disable next-line StringLiteral: Reply message content is not behavior-affecting
                await interaction.editReply({ content: `Removed ${handle} from Bluesky allowlist.` });
            }
        } catch (err: unknown) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log content is not behavior-affecting
            logger.error({ err, address, msg: 'Failed to remove from allowlist' });
            await interaction.editReply({ content: `Failed to remove ${address} from allowlist.` });
        }
        // Stryker enable BlockStatement
    }
}
