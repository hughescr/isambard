import type { Client } from 'discord.js';
import { type ChannelId, type UserId, createChannelId, createUserId  } from '../types';
import type { ChannelRegistryManager } from './manager';

/**
 * Information about a resolved Discord user (without internal Discord ID).
 */
export interface ResolvedUser {
    userId:      UserId
    username:    string
    displayName: string
    nickname:    string | null
}

/**
 * Result of attempting to resolve a human-readable name to a Discord user.
 */
export type UserResolveResult
    = | { status: 'resolved',  user: ResolvedUser                      }
      | { status: 'ambiguous', matches: Omit<ResolvedUser, 'userId'>[] }
      | { status: 'not_found'                                          };

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
    // eslint-disable-next-line sonarjs/function-return-type -- legitimately returns ChannelId | undefined
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
     * Resolves a human-readable name to a Discord user without side effects.
     * Searches all guilds for members matching the name across username, tag,
     * displayName, and nickname (case-insensitive).
     *
     * @param name - Name to search for (e.g., "Craig", "hughescr")
     * @returns Resolution result: resolved (single match), ambiguous (multiple), or not_found
     */
    async resolveUserByName(name: string): Promise<UserResolveResult> {
        const lowerName = name.toLowerCase();
        const lowerEq = (n: string): boolean => n.toLowerCase() === lowerName;
        const matchedById = new Map<string, ResolvedUser>();

        for(const guild of this.client.guilds.cache.values()) {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API, collect all matches across guilds
            const members = await guild.members.fetch({ query: name, limit: 10 });

            for(const member of members.values()) {
                const isMatch = lowerEq(member.user.username)
                  || lowerEq(member.user.tag)
                  || lowerEq(member.displayName)
                  || (member.nickname !== null && lowerEq(member.nickname));

                if(isMatch && !matchedById.has(member.user.id)) {
                    matchedById.set(member.user.id, {
                        userId:      createUserId(member.user.id),
                        username:    member.user.username,
                        displayName: member.displayName,
                        nickname:    member.nickname ?? null,
                    });
                }
            }
        }

        if(matchedById.size === 0) {
            return { status: 'not_found' };
        }

        if(matchedById.size === 1) {
            const [user] = matchedById.values();
            return { status: 'resolved', user };
        }

        // Multiple matches — omit userId to prevent Izzy from seeing Discord IDs
        const matches = [...matchedById.values()].map(({ username, displayName, nickname }) => ({
            username,
            displayName,
            nickname,
        }));
        return { status: 'ambiguous', matches };
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
