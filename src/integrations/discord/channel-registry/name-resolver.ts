import _ from 'lodash';
import type { ChannelRegistryManager } from './manager';
import type { ChannelReference } from './types';
import type { ChannelId, GuildId } from '../types';
import { ChannelNotFoundError, AmbiguousChannelError } from './errors';

/**
 * Normalizes a channel name by stripping # prefix and @ prefix for DMs.
 * Examples:
 *   "#general" → "general"
 *   "#DM - username" → "DM - username"
 *   "#DM - @username" → "DM - username"
 */
export function normalizeChannelName(name: string): string {
    let normalized = _.startsWith(name, '#') ? name.slice(1) : name;
    // Handle DM format with optional @ prefix
    if(_.startsWith(normalized, 'DM - @')) {
        normalized = 'DM - ' + normalized.slice(6);
    }
    return normalized;
}

/**
 * Formats a channel reference for display.
 * Examples:
 *   { channelName: "general", guildName: "My Server" } → "#general (My Server)"
 *   { channelName: "general" } → "#general"
 *   { channelName: "DM - alice" } → "#DM - alice"
 */
export function formatChannelReference(ref: ChannelReference): string {
    const base = `#${ref.channelName}`;
    return ref.guildName ? `${base} (${ref.guildName})` : base;
}

/**
 * Channel name resolver with disambiguation support.
 */
export class ChannelNameResolver {
    constructor(private readonly manager: ChannelRegistryManager) {}

    /**
     * Resolves a channel name to a single channel ID.
     * @throws ChannelNotFoundError if no channel matches
     * @throws AmbiguousChannelError if multiple channels match
     */
    async resolveToId(name: string, contextGuildId?: GuildId): Promise<ChannelId> {
        const normalized = normalizeChannelName(name);
        const matches = await this.manager.resolveByName(normalized, contextGuildId);

        if(matches.length === 0) {
            throw new ChannelNotFoundError(name);
        }

        if(matches.length > 1) {
            throw new AmbiguousChannelError(name, matches.length);
        }

        return matches[0].channelId;
    }

    /**
     * Resolves a channel name to all matching references (for disambiguation).
     */
    async resolveToReferences(name: string, contextGuildId?: GuildId): Promise<ChannelReference[]> {
        const normalized = normalizeChannelName(name);
        return this.manager.resolveByName(normalized, contextGuildId);
    }

    /**
     * Formats a channel ID back to a display name.
     */
    async formatChannelId(channelId: ChannelId): Promise<string> {
        const channel = await this.manager.getChannel(channelId);
        if(!channel) {
            return `#unknown-${channelId}`;
        }
        return `#${channel.channelName}`;
    }
}
