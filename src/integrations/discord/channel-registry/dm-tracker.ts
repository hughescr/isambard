import type { Client } from 'discord.js';
import { type ChannelId, type UserId, createChannelId, createUserId  } from '../types';
import type { ChannelRegistryManager } from './manager';

/**
 * Formats a DM channel name from a username.
 * @example formatDMChannelName("alice") → "@alice"
 */
export function formatDMChannelName(username: string): string {
    return `@${username}`;
}

/**
 * Checks if a channel name is a DM channel format.
 */
export function isDMChannelName(channelName: string): boolean {
    return channelName.startsWith('@');
}

/**
 * DM channel tracker with on-demand channel creation.
 */
export class DMTracker {
    private readonly dmUserMap = new Map<UserId, ChannelId>();

    constructor(
        private readonly manager: ChannelRegistryManager,
        private readonly client: Client
    ) {}

    /**
     * Gets an existing DM channel for a user, or undefined if not tracked.
     */
    getDMChannel(userId: UserId): ChannelId | undefined {
        return this.dmUserMap.get(userId);
    }

    /**
     * Gets or creates a DM channel with a user.
     * Creates the channel via Discord API if not already tracked.
     */
    async getOrCreateDM(userId: UserId): Promise<ChannelId> {
        // Check cache first
        const existing = this.dmUserMap.get(userId);
        if(existing) {
            return existing;
        }

        // Create DM via Discord API
        const user = await this.client.users.fetch(userId);
        const dmChannel = await user.createDM();
        const channelId = createChannelId(dmChannel.id);

        // Track the new DM channel
        this.dmUserMap.set(userId, channelId);

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
     * Searches for user by username first across all guilds the bot is in.
     * @param username - Username to search for (with or without discriminator)
     * @returns Channel ID of the DM, or null if user not found
     */
    async getOrCreateDMByUsername(username: string): Promise<ChannelId | null> {
        // Search all guilds the bot is in for a member with this username
        for(const guild of this.client.guilds.cache.values()) {
            // Fetch members (search by username)
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API, stop on first match
            const members = await guild.members.fetch({ query: username, limit: 10 });

            // Try exact match on username or full tag (username#discriminator)
            // Discord.js Collection is a Map subclass, so we must use its find method directly

            const member = members.find(m =>
                m.user.username === username
                || m.user.tag === username
            );

            if(member) {
                // Found user, create/get DM channel
                return this.getOrCreateDM(createUserId(member.user.id));
            }
        }

        // User not found in any guild
        return null;
    }

    /**
     * Tracks a DM channel from an incoming message.
     * Call this when receiving a DM to ensure it's in the registry.
     */
    async trackFromMessage(userId: UserId, channelId: ChannelId, username: string): Promise<void> {
        this.dmUserMap.set(userId, channelId);

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
