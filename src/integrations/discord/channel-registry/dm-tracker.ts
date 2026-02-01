import type { Client } from 'discord.js';
import _ from 'lodash';
import type { ChannelRegistryManager } from './manager';
import type { ChannelId, UserId } from '../types';
import { createChannelId } from '../types';

/**
 * Formats a DM channel name from a username.
 * @example formatDMChannelName("alice") → "DM - alice"
 */
export function formatDMChannelName(username: string): string {
    return `DM - ${username}`;
}

/**
 * Extracts username from a DM channel name.
 * @example extractUsernameFromDM("DM - alice") → "alice"
 * @returns null if not a valid DM channel name format
 */
export function extractUsernameFromDM(channelName: string): string | null {
    if(!_.startsWith(channelName, 'DM - ')) {
        return null;
    }
    return channelName.slice(5);
}

/**
 * Checks if a channel name is a DM channel format.
 */
export function isDMChannelName(channelName: string): boolean {
    return _.startsWith(channelName, 'DM - ');
}

/**
 * DM channel tracker with on-demand channel creation.
 */
export class DMTracker {
    constructor(
        private readonly manager: ChannelRegistryManager,
        private readonly client: Client
    ) {}

    /**
     * Gets an existing DM channel for a user, or undefined if not tracked.
     */
    getDMChannel(userId: UserId): ChannelId | undefined {
        return this.manager.getDMChannel(userId);
    }

    /**
     * Gets or creates a DM channel with a user.
     * Creates the channel via Discord API if not already tracked.
     */
    async getOrCreateDM(userId: UserId): Promise<ChannelId> {
        // Check cache first
        const existing = this.manager.getDMChannel(userId);
        if(existing) {
            return existing;
        }

        // Create DM via Discord API
        const user = await this.client.users.fetch(userId);
        const dmChannel = await user.createDM();
        const channelId = createChannelId(dmChannel.id);

        // Track the new DM channel
        this.manager.trackDM(userId, channelId);

        // Also upsert to registry for persistence
        await this.manager.upsertChannel({
            channelId,
            guildId:      'DM',
            channelName:  formatDMChannelName(user.username),
            isMuted:      false,
            discoveredAt: new Date().toISOString(),
            lastSeenAt:   new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        });

        return channelId;
    }

    /**
     * Gets or creates a DM channel by username.
     * Searches for user by username first.
     */
    async getOrCreateDMByUsername(): Promise<ChannelId | null> {
        // This is more complex - need to search for user
        // For now, return null and let caller handle
        // Full implementation would search guild members
        return _.constant(null)();
    }

    /**
     * Tracks a DM channel from an incoming message.
     * Call this when receiving a DM to ensure it's in the registry.
     */
    async trackFromMessage(userId: UserId, channelId: ChannelId, username: string): Promise<void> {
        this.manager.trackDM(userId, channelId);

        await this.manager.upsertChannel({
            channelId,
            guildId:      'DM',
            channelName:  formatDMChannelName(username),
            isMuted:      false,
            discoveredAt: new Date().toISOString(),
            lastSeenAt:   new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        });
    }
}
