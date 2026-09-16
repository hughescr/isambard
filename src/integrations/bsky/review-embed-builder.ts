import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { truncate } from 'lodash-es';

export interface BskyReplyApprovalEmbedParams {
    type:              'reply'
    text:              string             // the post text to be sent
    targetHandle:      string             // who we're replying to
    parentUri?:        string             // AT URI of parent post
    parentCid?:        string             // CID of parent post
    rootUri?:          string             // AT URI of root post
    rootCid?:          string             // CID of root post
    parentText?:       string             // preview of parent post text (optional)
}

export interface BskyDmApprovalEmbedParams {
    type:              'dm'
    text:              string             // the DM text to be sent
    recipientHandles:  string[]           // all recipient handles
    convoId?:          string             // conversation ID for sending on approval
}

export type BskyApprovalEmbedParams = BskyReplyApprovalEmbedParams | BskyDmApprovalEmbedParams;

interface BskyApprovalEmbedResult {
    embed:     EmbedBuilder
    actionRow: ActionRowBuilder<ButtonBuilder>
}

const BSKY_BLUE               = 0x00_85_FF;
const PARENT_TEXT_TRUNCATE_LENGTH = 280;

/**
 * Build a Bluesky approval embed for admin review.
 * Supports two types:
 * - 'reply': Bluesky post reply approval (uses bsky-send-* button prefixes)
 * - 'dm':    Bluesky DM approval (uses bsky-dm-* button prefixes)
 *
 * Returns a blue embed with post/DM text, metadata, and 3 action buttons:
 * Approve, Approve+Allowlist, Reject.
 */
export function buildBskyApprovalEmbed(params: BskyApprovalEmbedParams): BskyApprovalEmbedResult {
    const uuid = crypto.randomUUID();

    if(params.type === 'dm') {
        const embed = new EmbedBuilder()
            .setTitle('Bluesky DM Approval Required')
            .setColor(BSKY_BLUE)
            .setDescription(params.text)
            .addFields(
                { name: 'Recipients',      value: JSON.stringify(params.recipientHandles), inline: false },
                { name: 'Conversation ID', value: params.convoId ?? '',                                            inline: true }
            );

        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`bsky-dm-approve:${uuid}`)
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`bsky-dm-approveallowlist:${uuid}`)
                .setLabel('Approve + Allowlist')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`bsky-dm-reject:${uuid}`)
                .setLabel('Reject')
                .setStyle(ButtonStyle.Danger)
        );

        return { embed, actionRow };
    }

    const embed = new EmbedBuilder()
        .setTitle('Bluesky Post Approval Required')
        .setColor(BSKY_BLUE)
        .setDescription(params.text)
        .addFields(
            { name: 'Replying to', value: params.targetHandle, inline: true },
            { name: 'Parent URI',  value: params.parentUri ?? '',  inline: true },
            { name: 'Parent CID',  value: params.parentCid ?? '',  inline: true }
        );

    if(params.rootUri && params.rootCid) {
        embed.addFields(
            { name: 'Root URI', value: params.rootUri, inline: true },
            { name: 'Root CID', value: params.rootCid, inline: true }
        );
    }

    if(params.parentText) {
        embed.addFields(
            { name: 'Parent Post', value: truncate(params.parentText, { length: PARENT_TEXT_TRUNCATE_LENGTH }), inline: false }
        );
    }

    // Use a UUID for button custom IDs to avoid collisions
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`bsky-send-approve:${uuid}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`bsky-send-approveallowlist:${uuid}`)
            .setLabel('Approve + Allowlist')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`bsky-send-reject:${uuid}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
    );

    return { embed, actionRow };
}
