import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { truncate } from 'lodash-es';
import type { BskyReplyInput } from './types';
import { encodeCustomId } from '@/utils';

export interface BskyReplyApprovalEmbedParams {
    type:         'reply'
    text:         string             // the post text to be sent
    targetHandle: string             // who we're replying to
    reply:        BskyReplyInput     // the strong ref of the post being replied to, and optional thread root
    parentText?:  string             // preview of parent post text (optional)
}

export interface BskyDmApprovalEmbedParams {
    type:             'dm'
    text:             string             // the DM text to be sent
    recipientHandles: string[]           // all recipient handles
    convoId?:         string             // conversation ID for sending on approval
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
                .setCustomId(encodeCustomId({ prefix: 'bsky-dm-approve', id: uuid }))
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(encodeCustomId({ prefix: 'bsky-dm-approveallowlist', id: uuid }))
                .setLabel('Approve + Allowlist')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(encodeCustomId({ prefix: 'bsky-dm-reject', id: uuid }))
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
            { name: 'Replying to', value: params.targetHandle,    inline: true },
            { name: 'Parent URI',  value: params.reply.parent.uri, inline: true },
            { name: 'Parent CID',  value: params.reply.parent.cid, inline: true }
        );

    if(params.reply.root) {
        embed.addFields(
            { name: 'Root URI', value: params.reply.root.uri, inline: true },
            { name: 'Root CID', value: params.reply.root.cid, inline: true }
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
            .setCustomId(encodeCustomId({ prefix: 'bsky-send-approve', id: uuid }))
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(encodeCustomId({ prefix: 'bsky-send-approveallowlist', id: uuid }))
            .setLabel('Approve + Allowlist')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(encodeCustomId({ prefix: 'bsky-send-reject', id: uuid }))
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
    );

    return { embed, actionRow };
}
