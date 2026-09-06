/**
 * Builds the platform-agnostic `DiscordEnvelopeInput` a Discord turn hands to the conductor
 * (P9, design section 3.1/6): the channel list shown to every turn and boot bundle (unmuted
 * only, `(guild)` suffix, `[well-known: type]` annotation, a hydrating marker before the channel
 * registry has warmed — lifted verbatim from coordinator-setup.ts's inline block), per-message
 * name resolution for the envelope header, and the final, pure assembly of one batch of
 * `DiscordMessageContext`s + already-fetched images into a `DiscordEnvelopeInput`.
 *
 * @module integrations/discord/setup/discord-envelope-provider
 */
import type { Client } from 'discord.js';
import type { ChannelRegistryManager } from '../channel-registry/manager';
import type { ChannelMetadata } from '../channel-registry/types';
import { createChannelId, type DiscordMessageContext } from '../types';
import type { DiscordEnvelopeInput, PlatformImage } from '@/agent';
import { InvariantViolationError } from '@/errors';

/**
 * The sole `channelList` entry rendered before the channel registry has finished its initial
 * hydration — mute state and channel names are simply not known yet, so a turn or boot bundle
 * built during that window gets a legible placeholder instead of silently reporting no channels
 * at all.
 */
export const CHANNEL_LIST_HYDRATING_MARKER = '(channel list still hydrating — registry not ready yet)';

/**
 * `channelName (guildName) [well-known: type]` — matches coordinator-setup.ts's legacy format
 * exactly (no leading `#`). Guild-name lookup is cosmetic disambiguation only: a `guilds.cache`
 * miss or throw (stale cache entry, corrupted guild object) silently omits the suffix rather
 * than failing the whole channel list.
 */
function formatChannelEntry(channel: ChannelMetadata, client: Client): string {
    let guildName: string | undefined;
    if(channel.guildId !== 'DM') {
        try {
            guildName = client.guilds.cache.get(channel.guildId)?.name;
        } catch{
            // Silent: see this function's own doc comment.
        }
    }

    let formatted = channel.channelName;
    if(guildName) {
        formatted += ` (${guildName})`;
    }
    if(channel.isWellKnown) {
        formatted += ` [well-known: ${channel.isWellKnown}]`;
    }
    return formatted;
}

/**
 * Builds the list of channel-name strings visible to a turn or the boot bundle: unmuted only,
 * each formatted by {@link formatChannelEntry}. Returns the single {@link CHANNEL_LIST_HYDRATING_MARKER}
 * entry (never an empty array) while `registry.isReady()` is false, without even calling
 * `getUnmutedChannels` (mute state read from a cold cache would be wrong, not merely incomplete).
 * @param registry The channel registry to read unmuted channels from.
 * @param client The Discord client whose guild cache resolves guild names.
 * @returns A closure a turn or the boot bundle can call fresh on every use (mute state changes).
 */
export function channelListProvider(registry: ChannelRegistryManager, client: Client): () => Promise<string[]> {
    return async () => {
        if(!registry.isReady()) {
            return [CHANNEL_LIST_HYDRATING_MARKER];
        }
        const channels = await registry.getUnmutedChannels();
        return channels.map(channel => formatChannelEntry(channel, client));
    };
}

/** Display names resolved for one Discord message context's envelope header. */
export interface ResolvedDiscordNames {
    channelName: string
    guildName?:  string
    authorName:  string
    isDM:        boolean
}

/**
 * Resolves the channel/guild/author display names for one {@link DiscordMessageContext}'s
 * envelope header. `context.guildId === 'DM'` (the same sentinel `handlers.ts` stamps via
 * `createGuildId(message.guild?.id ?? 'DM')`) is the DM signal; the channel name comes from the
 * registry (falling back to the raw channel id when the registry has no record yet — cosmetic
 * only, never fatal), and the guild name from the client's own guild cache (cosmetic
 * disambiguation only, per {@link formatChannelEntry}'s own note).
 * @param registry The channel registry to resolve the channel name from.
 * @param client The Discord client whose guild cache resolves the guild name.
 * @returns A closure resolving one context's names, for the conductor processor to call per turn.
 */
export function resolveNames(registry: ChannelRegistryManager, client: Client): (context: DiscordMessageContext) => Promise<ResolvedDiscordNames> {
    return async (context) => {
        const isDM = context.guildId === 'DM';
        const channel = await registry.getChannel(createChannelId(context.channelId));
        const channelName = channel?.channelName ?? context.channelId;

        let guildName: string | undefined;
        if(!isDM) {
            try {
                guildName = client.guilds.cache.get(context.guildId)?.name;
            } catch{
                // Silent: see formatChannelEntry's own note.
            }
        }

        return {
            channelName, guildName, authorName: context.username ?? context.userId, isDM,
        };
    };
}

/**
 * Assembles one batch's {@link DiscordEnvelopeInput}. Pure and synchronous: `names`/`images`/
 * `channelList` are already resolved by the caller (conductor-processor.ts, via
 * {@link resolveNames}, attachment processing, and {@link channelListProvider}). The envelope's
 * `content` joins every batched context's text — multiple contexts arrive together only after
 * the coordinator's debounce merges a channel's pending messages into one turn — and
 * `messageId`/`channelId`/`createdAt` are the batch's FIRST context's, the same
 * single-message-representative convention `EnvelopeMeta` uses elsewhere in this codebase.
 * @param contexts One channel's batched Discord message contexts (non-empty).
 * @param names This batch's resolved display names, from {@link resolveNames}.
 * @param images Already-fetched image attachments, converted to `PlatformImage[]`.
 * @param channelList The channel list visible to this turn, from {@link channelListProvider}.
 * @returns A `DiscordEnvelopeInput` ready for `./envelope`'s `buildDiscordEnvelope`.
 * @throws {InvariantViolationError} If `contexts` is empty — the coordinator never calls a
 * processor with an empty batch, so this guards a caller invariant rather than a reachable state.
 */
export function toEnvelopeInput(
    contexts: DiscordMessageContext[],
    names: ResolvedDiscordNames,
    images: PlatformImage[],
    channelList: string[]
): DiscordEnvelopeInput {
    const first = contexts[0];
    if(first === undefined) {
        throw new InvariantViolationError('toEnvelopeInput', 'contexts must be non-empty');
    }

    return {
        messageId:   first.messageId,
        channelId:   first.channelId,
        channelName: names.channelName,
        guildName:   names.guildName,
        authorId:    first.userId,
        authorName:  names.authorName,
        content:     contexts.map(ctx => ctx.content).join('\n\n'),
        createdAt:   new Date(first.timestamp),
        images:      images.length > 0 ? images : undefined,
        isDM:        names.isDM,
        channelList,
    };
}
