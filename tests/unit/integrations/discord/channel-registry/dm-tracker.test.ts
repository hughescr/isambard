/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Test mocks require type assertions and unsafe operations */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Client, DMChannel } from 'discord.js';
import _ from 'lodash';
import { DMTracker, formatDMChannelName, isDMChannelName } from '../../../../../src/integrations/discord/channel-registry/dm-tracker';
import type { ChannelRegistryManager } from '../../../../../src/integrations/discord/channel-registry/manager';
import { createChannelId, createUserId } from '../../../../../src/integrations/discord/types';

describe('DM Tracker Utilities', () => {
    describe('formatDMChannelName', () => {
        test('should format username as DM channel name', () => {
            expect(formatDMChannelName('alice')).toBe('@alice');
        });

        test('should handle usernames with spaces', () => {
            expect(formatDMChannelName('alice smith')).toBe('@alice smith');
        });

        test('should handle usernames with special characters', () => {
            expect(formatDMChannelName('alice_123')).toBe('@alice_123');
        });

        test('should handle empty username', () => {
            expect(formatDMChannelName('')).toBe('@');
        });
    });

    describe('isDMChannelName', () => {
        test('should return true for valid DM channel name', () => {
            expect(isDMChannelName('@alice')).toBe(true);
        });

        test('should return true for DM with empty username', () => {
            expect(isDMChannelName('@')).toBe(true);
        });

        test('should return false for non-DM channel name', () => {
            expect(isDMChannelName('general')).toBe(false);
        });

        test('should return false for empty string', () => {
            expect(isDMChannelName('')).toBe(false);
        });

        test('should return false for partial prefix', () => {
            expect(isDMChannelName('DM')).toBe(false);
        });

        test('should return false for case variation', () => {
            expect(isDMChannelName('dm - alice')).toBe(false);
        });
    });
});

describe('DMTracker', () => {
    let mockManager: ChannelRegistryManager;
    let mockClient: Client;
    let tracker: DMTracker;

    beforeEach(() => {
        // Mock ChannelRegistryManager
        mockManager = {
            upsertChannel: mock(_.noop),
        } as unknown as ChannelRegistryManager;

        // Mock Discord.js Client
        mockClient = {} as Client;
    });

    describe('constructor', () => {
        test('should create instance with manager and client', () => {
            tracker = new DMTracker(mockManager, mockClient);
            expect(tracker).toBeInstanceOf(DMTracker);
        });
    });

    describe('getDMChannel', () => {
        beforeEach(() => {
            tracker = new DMTracker(mockManager, mockClient);
        });

        test('should return undefined when channel not tracked', () => {
            const userId = createUserId('123456789');

            const result = tracker.getDMChannel(userId);

            expect(result).toBeUndefined();
        });

        test('should return channelId when channel is tracked', async () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            const username = 'alice';

            // Mock Discord.js User and DMChannel
            const mockDMChannel = {
                id: channelId,
            } as unknown as import('discord.js').DMChannel;

            const mockUser = {
                id:       userId,
                username,
                createDM: mock(async () => mockDMChannel),
            } as unknown as { id: string, username: string, createDM: () => Promise<import('discord.js').DMChannel> };

            mockClient.users = {
                fetch: mock(async () => mockUser),
            } as any;

            // Track the DM first
            await tracker.trackFromMessage(userId, channelId, username);

            const result = tracker.getDMChannel(userId);

            expect(result).toBe(channelId);
        });
    });

    describe('getOrCreateDM', () => {
        beforeEach(() => {
            tracker = new DMTracker(mockManager, mockClient);
        });

        test('should return existing channel from cache', async () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            const username = 'alice';

            // Track the DM first
            await tracker.trackFromMessage(userId, channelId, username);

            const result = await tracker.getOrCreateDM(userId);

            expect(result).toBe(channelId);
            // Should not call upsertChannel again since it's cached
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1); // Only from trackFromMessage
        });

        test('should create new DM channel when not cached', async () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            const username = 'alice';

            mockManager.upsertChannel = mock(() => Promise.resolve());

            // Mock Discord.js User and DMChannel
            const mockDMChannel = {
                id: channelId,
            } as unknown as DMChannel;

            const mockUser = {
                id:       userId,
                username,
                createDM: mock(async () => mockDMChannel),
            } as unknown as { id: string, username: string, createDM: () => Promise<DMChannel> };

            mockClient.users = {
                fetch: mock(async () => mockUser),
            } as any;

            const result = await tracker.getOrCreateDM(userId);

            expect(result).toBe(channelId);
            expect(mockClient.users.fetch).toHaveBeenCalledWith(userId);
            expect(mockClient.users.fetch).toHaveBeenCalledTimes(1);
            expect(mockUser.createDM).toHaveBeenCalled();
            expect(mockUser.createDM).toHaveBeenCalledTimes(1);
            expect(mockManager.upsertChannel).toHaveBeenCalled();
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

            // Verify upsertChannel called with correct metadata
            const upsertCall = (mockManager.upsertChannel as any).mock.calls[0][0];
            expect(upsertCall.channelId).toBe(channelId);
            expect(upsertCall.guildId).toBe('DM');
            expect(upsertCall.channelName).toBe('@alice');
            expect(upsertCall.isMuted).toBe(false);
            expect(upsertCall.discoveredAt).toBeDefined();
            expect(upsertCall.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(upsertCall.lastSeenAt).toBeDefined();
            expect(upsertCall.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(upsertCall.updatedAt).toBeDefined();
            expect(upsertCall.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe('getOrCreateDMByUsername', () => {
        beforeEach(() => {
            tracker = new DMTracker(mockManager, mockClient);
        });

        test('should find user by username and create DM', async () => {
            const username = 'alice';
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');

            mockManager.upsertChannel = mock(() => Promise.resolve());

            // Mock Discord.js Guild and GuildMember
            const mockDMChannel = {
                id: channelId,
            } as unknown as DMChannel;

            const mockUser = {
                id:       userId,
                username,
                tag:      `${username}#0000`,
                createDM: mock(async () => mockDMChannel),
            } as unknown as { id: string, username: string, tag: string, createDM: () => Promise<DMChannel> };

            const mockMember = {
                user: mockUser,
            } as unknown as { user: typeof mockUser };

            // Mock guild.members.fetch to return a collection with the member
            const mockMembers = new Map();
            mockMembers.set(userId, mockMember);

            (mockMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined => {
                for(const member of mockMembers.values()) {
                    if(predicate(member as unknown as typeof mockMember)) {
                        return member as unknown as typeof mockMember;
                    }
                }
                return undefined;
            };

            const mockGuild: { members: { fetch: ReturnType<typeof mock> } } = {
                members: {
                    fetch: mock(async () => mockMembers),
                },
            };

            mockClient.guilds = {
                cache: {
                    values: mock((): unknown[] => [mockGuild]),
                },
            } as unknown as typeof mockClient.guilds;

            mockClient.users = {
                fetch: mock(async () => mockUser),
            } as unknown as typeof mockClient.users;

            const result = await tracker.getOrCreateDMByUsername(username);

            expect(result).toBe(channelId);
            expect(mockGuild.members.fetch).toHaveBeenCalledWith({ query: username, limit: 10 });
            expect(mockUser.createDM).toHaveBeenCalled();
            expect(mockManager.upsertChannel).toHaveBeenCalled();
        });

        test('should find user by tag (username#discriminator)', async () => {
            const username = 'alice';
            const tag = 'alice#1234';
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');

            mockManager.upsertChannel = mock(() => Promise.resolve());

            const mockDMChannel = {
                id: channelId,
            } as unknown as DMChannel;

            const mockUser = {
                id:       userId,
                username,
                tag,
                createDM: mock(async () => mockDMChannel),
            } as unknown as { id: string, username: string, tag: string, createDM: () => Promise<DMChannel> };

            const mockMember = {
                user: mockUser,
            } as unknown as { user: typeof mockUser };

            const mockMembers = new Map();
            mockMembers.set(userId, mockMember);

            (mockMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined => {
                for(const member of mockMembers.values()) {
                    if(predicate(member as unknown as typeof mockMember)) {
                        return member as unknown as typeof mockMember;
                    }
                }
                return undefined;
            };

            const mockGuild: { members: { fetch: ReturnType<typeof mock> } } = {
                members: {
                    fetch: mock(async () => mockMembers),
                },
            };

            mockClient.guilds = {
                cache: {
                    values: mock((): unknown[] => [mockGuild]),
                },
            } as unknown as typeof mockClient.guilds;

            mockClient.users = {
                fetch: mock(async () => mockUser),
            } as unknown as typeof mockClient.users;

            const result = await tracker.getOrCreateDMByUsername(tag);

            expect(result).toBe(channelId);
        });

        test('should return null when user not found', async () => {
            const username = 'nonexistent';

            // Mock guild with empty members
            const mockMembers = new Map();

            (mockMembers as unknown as { find: () => undefined }).find = (): undefined => undefined;

            const mockGuild: { members: { fetch: ReturnType<typeof mock> } } = {
                members: {
                    fetch: mock(async () => mockMembers),
                },
            };

            mockClient.guilds = {
                cache: {
                    values: mock((): unknown[] => [mockGuild]),
                },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.getOrCreateDMByUsername(username);

            expect(result).toBeNull();
            expect(mockGuild.members.fetch).toHaveBeenCalledWith({ query: username, limit: 10 });
        });

        test('should return null when guild has members but none match username or tag', async () => {
            const searchUsername = 'nonexistent';
            const userId = createUserId('123456789');

            // Mock guild with members that don't match
            const mockUser = {
                id:       userId,
                username: 'bob',
                tag:      'bob#1234',
            };

            const mockMember = {
                user: mockUser,
            };

            const mockMembers = new Map();
            mockMembers.set(userId, mockMember);

            // Implement find() to actually check the predicate
            (mockMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined => {
                for(const member of mockMembers.values()) {
                    if(predicate(member as unknown as typeof mockMember)) {
                        return member as unknown as typeof mockMember;
                    }
                }
                return undefined;
            };

            const mockGuild: { members: { fetch: ReturnType<typeof mock> } } = {
                members: {
                    fetch: mock(async () => mockMembers),
                },
            };

            mockClient.guilds = {
                cache: {
                    values: mock((): unknown[] => [mockGuild]),
                },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.getOrCreateDMByUsername(searchUsername);

            expect(result).toBeNull();
            expect(mockGuild.members.fetch).toHaveBeenCalledWith({ query: searchUsername, limit: 10 });
        });

        test('should search multiple guilds until user found', async () => {
            const username = 'alice';
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');

            mockManager.upsertChannel = mock(() => Promise.resolve());

            const mockDMChannel = {
                id: channelId,
            } as unknown as DMChannel;

            const mockUser = {
                id:       userId,
                username,
                tag:      `${username}#0000`,
                createDM: mock(async () => mockDMChannel),
            } as unknown as { id: string, username: string, tag: string, createDM: () => Promise<DMChannel> };

            const mockMember = {
                user: mockUser,
            } as unknown as { user: typeof mockUser };

            // First guild - no match
            const emptyMembers = new Map();
            (emptyMembers as unknown as { find: () => undefined }).find = (): undefined => undefined;

            const mockGuild1: { members: { fetch: ReturnType<typeof mock> } } = {
                members: {
                    fetch: mock(async () => emptyMembers),
                },
            };

            // Second guild - has the user
            const matchingMembers = new Map();
            matchingMembers.set(userId, mockMember);
            (matchingMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined => {
                for(const member of matchingMembers.values()) {
                    if(predicate(member as unknown as typeof mockMember)) {
                        return member as unknown as typeof mockMember;
                    }
                }
                return undefined;
            };

            const mockGuild2: { members: { fetch: ReturnType<typeof mock> } } = {
                members: {
                    fetch: mock(async () => matchingMembers),
                },
            };

            mockClient.guilds = {
                cache: {
                    values: mock((): unknown[] => [mockGuild1, mockGuild2]),
                },
            } as unknown as typeof mockClient.guilds;

            mockClient.users = {
                fetch: mock(async () => mockUser),
            } as unknown as typeof mockClient.users;

            const result = await tracker.getOrCreateDMByUsername(username);

            expect(result).toBe(channelId);
            expect(mockGuild1.members.fetch).toHaveBeenCalledTimes(1);
            expect(mockGuild2.members.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('trackFromMessage', () => {
        beforeEach(() => {
            tracker = new DMTracker(mockManager, mockClient);
        });

        test('should track DM and upsert to registry', async () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            const username = 'alice';

            mockManager.upsertChannel = mock(() => Promise.resolve());

            await tracker.trackFromMessage(userId, channelId, username);

            expect(mockManager.upsertChannel).toHaveBeenCalled();
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

            // Verify upsertChannel called with correct metadata
            const upsertCall = (mockManager.upsertChannel as any).mock.calls[0][0];
            expect(upsertCall.channelId).toBe(channelId);
            expect(upsertCall.guildId).toBe('DM');
            expect(upsertCall.channelName).toBe('@alice');
            expect(upsertCall.isMuted).toBe(false);
            expect(upsertCall.discoveredAt).toBeDefined();
            expect(upsertCall.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(upsertCall.lastSeenAt).toBeDefined();
            expect(upsertCall.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(upsertCall.updatedAt).toBeDefined();
            expect(upsertCall.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        test('should handle usernames with special characters', async () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            const username = 'alice_123';

            mockManager.upsertChannel = mock(() => Promise.resolve());

            await tracker.trackFromMessage(userId, channelId, username);

            const upsertCall = (mockManager.upsertChannel as any).mock.calls[0][0];
            expect(upsertCall.channelName).toBe('@alice_123');
        });
    });
});
