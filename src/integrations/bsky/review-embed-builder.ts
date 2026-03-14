import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { truncate } from 'lodash-es';

export interface BskyApprovalEmbedParams {
    text:         string     // the post text to be sent
    targetHandle: string     // who we're replying to
    parentUri:    string     // AT URI of parent post
    parentCid:    string     // CID of parent post
    rootUri?:     string     // AT URI of root post
    rootCid?:     string     // CID of root post
    parentText?:  string     // preview of parent post text (optional)
}

export interface BskyApprovalEmbedResult {
    embed:     EmbedBuilder
    actionRow: ActionRowBuilder<ButtonBuilder>
}

// Stryker disable next-line ArithmeticOperator: Bluesky brand color is configuration
const BSKY_BLUE               = 0x00_85_FF;
const PARENT_TEXT_TRUNCATE_LENGTH = 280;

/**
 * Build a Bluesky reply approval embed for admin review.
 * Returns a blue embed with post text, reply target metadata, and 3 action buttons:
 * Approve, Approve+Allowlist, Reject.
 */
export function buildBskyApprovalEmbed(params: BskyApprovalEmbedParams): BskyApprovalEmbedResult {
    const embed = new EmbedBuilder()
        // Stryker disable next-line StringLiteral: UI label is configuration
        .setTitle('Bluesky Post Approval Required')
        .setColor(BSKY_BLUE)
        .setDescription(params.text)
        .addFields(
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Replying to', value: params.targetHandle, inline: true },
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Parent URI',  value: params.parentUri,    inline: true },
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Parent CID',  value: params.parentCid,    inline: true }
        );

    if(params.rootUri && params.rootCid) {
        embed.addFields(
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Root URI', value: params.rootUri, inline: true },
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Root CID', value: params.rootCid, inline: true }
        );
    }

    if(params.parentText) {
        embed.addFields(
            // Stryker disable next-line StringLiteral,BooleanLiteral: Field name and inline layout are UI configuration
            { name: 'Parent Post', value: truncate(params.parentText, { length: PARENT_TEXT_TRUNCATE_LENGTH }), inline: false }
        );
    }

    // Use a UUID for button custom IDs to avoid collisions
    const uuid = crypto.randomUUID();
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`bsky-send-approve:${uuid}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`bsky-send-approveallowlist:${uuid}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Approve + Allowlist')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            // Stryker disable next-line StringLiteral: Button customId is UI configuration
            .setCustomId(`bsky-send-reject:${uuid}`)
            // Stryker disable next-line StringLiteral: Button label is UI configuration
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
    );

    return { embed, actionRow };
}
