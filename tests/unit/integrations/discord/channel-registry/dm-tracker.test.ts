import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Client, DMChannel } from 'discord.js';
// eslint-disable-next-line lodash-es/suggest-native-alternatives -- noop is used as a mock function, not a no-op return value
import { noop } from 'lodash-es';
import { DMTracker, formatDMChannelName, isDMChannelName, type ResolvedUser, type UserResolveResult } from '../../../../../src/integrations/discord/channel-registry/dm-tracker';
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
            upsertChannel: mock(noop),
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
            } as unknown as DMChannel;

            const mockUser = {
                id:       userId,
                username,
                createDM: mock(async () => mockDMChannel),
            } as unknown as { id: string, username: string, createDM: () => Promise<DMChannel> };

            mockClient.users = {
                fetch: mock(async () => mockUser),
            } as unknown as typeof mockClient.users;

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
            } as unknown as typeof mockClient.users;

            const result = await tracker.getOrCreateDM(userId);

            expect(result).toBe(channelId);
            expect(mockClient.users.fetch).toHaveBeenCalledWith(userId);
            expect(mockClient.users.fetch).toHaveBeenCalledTimes(1);
            expect(mockUser.createDM).toHaveBeenCalled();
            expect(mockUser.createDM).toHaveBeenCalledTimes(1);
            expect(mockManager.upsertChannel).toHaveBeenCalled();
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

            // Verify upsertChannel called with correct metadata
            const upsertCall = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
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
            };

            // Mock guild.members.fetch to return a collection with the member
            const mockMembers = new Map([[userId, mockMember]]);

            (mockMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined =>
                [...mockMembers.values()].find(m => predicate(m));

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
            };

            const mockMembers = new Map([[userId, mockMember]]);

            (mockMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined =>
                [...mockMembers.values()].find(m => predicate(m));

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

            const mockMembers = new Map([[userId, mockMember]]);

            // Implement find() to actually check the predicate
            (mockMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined =>
                [...mockMembers.values()].find(m => predicate(m));

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
            };

            // First guild - no match
            const emptyMembers = new Map();
            (emptyMembers as unknown as { find: () => undefined }).find = (): undefined => undefined;

            const mockGuild1: { members: { fetch: ReturnType<typeof mock> } } = {
                members: {
                    fetch: mock(async () => emptyMembers),
                },
            };

            // Second guild - has the user
            const matchingMembers = new Map([[userId, mockMember]]);
            (matchingMembers as unknown as { find: (predicate: (m: typeof mockMember) => boolean) => typeof mockMember | undefined }).find = (predicate: (m: typeof mockMember) => boolean): typeof mockMember | undefined =>
                [...matchingMembers.values()].find(m => predicate(m));

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
            const upsertCall = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
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

            const upsertCall = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
            expect(upsertCall.channelName).toBe('@alice_123');
        });
    });

    describe('resolveUserByName', () => {
        interface MockMemberUser {
            id:           string
            username:     string
            tag:          string
            displayName?: string
        }

        interface MockMember {
            user:        MockMemberUser
            displayName: string
            nickname:    string | null
        }

        function makeMockMembers(members: MockMember[]): Map<string, MockMember> & { find: (predicate: (m: MockMember) => boolean) => MockMember | undefined } {
            const map = new Map(members.map(m => [m.user.id, m])) as Map<string, MockMember> & { find: (predicate: (m: MockMember) => boolean) => MockMember | undefined };
            map.find = (predicate: (m: MockMember) => boolean): MockMember | undefined =>
                [...map.values()].find(m => predicate(m));
            return map;
        }

        function makeMockGuild(members: MockMember[]): { members: { fetch: ReturnType<typeof mock> } } {
            return {
                members: {
                    fetch: mock(async () => makeMockMembers(members)),
                },
            };
        }

        beforeEach(() => {
            tracker = new DMTracker(mockManager, mockClient);
        });

        test('should resolve exact username match', async () => {
            const userId = '111111111';
            const members: MockMember[] = [{
                user:        { id: userId, username: 'craig', tag: 'craig#0000' },
                displayName: 'Craig',
                nickname:    null,
            }];
            const guild = makeMockGuild(members);
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [guild]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('craig');

            expect(result.status).toBe('resolved');
            const resolved = result as Extract<UserResolveResult, { status: 'resolved' }>;
            expect(resolved.user.username).toBe('craig');
            expect(resolved.user.displayName).toBe('Craig');
            expect(resolved.user.nickname).toBeNull();
            // userId should be present but it's a UserId branded type
            expect(typeof resolved.user.userId).toBe('string');
            // Verify fetch called with correct search parameters
            expect(guild.members.fetch).toHaveBeenCalledWith({ query: 'craig', limit: 10 });
        });

        test('should resolve case-insensitive displayName match', async () => {
            const userId = '222222222';
            const members: MockMember[] = [{
                user:        { id: userId, username: 'hughescr', tag: 'hughescr#0000' },
                displayName: 'Craig',
                nickname:    null,
            }];
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild(members)]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('craig');

            expect(result.status).toBe('resolved');
            const resolved = result as Extract<UserResolveResult, { status: 'resolved' }>;
            expect(resolved.user.username).toBe('hughescr');
            expect(resolved.user.displayName).toBe('Craig');
        });

        test('should resolve nickname match', async () => {
            const userId = '333333333';
            const members: MockMember[] = [{
                user:        { id: userId, username: 'bob_smith', tag: 'bob_smith#0000' },
                displayName: 'Bob',
                nickname:    'Bobby',
            }];
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild(members)]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('bobby');

            expect(result.status).toBe('resolved');
            const resolved = result as Extract<UserResolveResult, { status: 'resolved' }>;
            expect(resolved.user.username).toBe('bob_smith');
            expect(resolved.user.nickname).toBe('Bobby');
        });

        test('should resolve tag match', async () => {
            const userId = '444444444';
            const members: MockMember[] = [{
                user:        { id: userId, username: 'alice', tag: 'alice#1234' },
                displayName: 'Alice',
                nickname:    null,
            }];
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild(members)]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('alice#1234');

            expect(result.status).toBe('resolved');
            const resolved = result as Extract<UserResolveResult, { status: 'resolved' }>;
            expect(resolved.user.username).toBe('alice');
        });

        test('should return ambiguous when multiple distinct users match', async () => {
            const members: MockMember[] = [
                {
                    user:        { id: '555555555', username: 'craig_a', tag: 'craig_a#0000' },
                    displayName: 'Craig A',
                    nickname:    'Craig',
                },
                {
                    user:        { id: '666666666', username: 'craig_b', tag: 'craig_b#0000' },
                    displayName: 'Craig B',
                    nickname:    'Craig',
                },
            ];
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild(members)]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('Craig');

            expect(result.status).toBe('ambiguous');
            const ambiguous = result as Extract<UserResolveResult, { status: 'ambiguous' }>;
            expect(ambiguous.matches).toHaveLength(2);
            // Ambiguous matches must NOT contain userId
            for(const match of ambiguous.matches) {
                expect(Object.keys(match)).not.toContain('userId');
            }
            expect(ambiguous.matches[0].username).toBe('craig_a');
            expect(ambiguous.matches[1].username).toBe('craig_b');
        });

        test('should return not_found when no members match', async () => {
            const members: MockMember[] = [{
                user:        { id: '777777777', username: 'zoe', tag: 'zoe#0000' },
                displayName: 'Zoe',
                nickname:    null,
            }];
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild(members)]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('nobody');

            expect(result.status).toBe('not_found');
        });

        test('should deduplicate same user found in multiple guilds', async () => {
            const userId = '888888888';
            const member: MockMember = {
                user:        { id: userId, username: 'craig', tag: 'craig#0000' },
                displayName: 'Craig',
                nickname:    null,
            };
            // Same user appears in two guilds
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild([member]), makeMockGuild([member])]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('craig');

            // Should resolve to single user, not ambiguous
            expect(result.status).toBe('resolved');
            const resolved = result as Extract<UserResolveResult, { status: 'resolved' }>;
            expect(resolved.user.username).toBe('craig');
        });

        test('should return not_found when guilds cache is empty', async () => {
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => []) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('anyone');

            expect(result.status).toBe('not_found');
        });

        test('should not create DM channel — resolveUserByName has no side effects', async () => {
            const userId = '999999999';
            const members: MockMember[] = [{
                user:        { id: userId, username: 'craig', tag: 'craig#0000' },
                displayName: 'Craig',
                nickname:    null,
            }];
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild(members)]) },
            } as unknown as typeof mockClient.guilds;
            mockManager.upsertChannel = mock(() => Promise.resolve());

            await tracker.resolveUserByName('craig');

            // Must NOT have called upsertChannel or users.fetch (no DM creation)
            expect(mockManager.upsertChannel).not.toHaveBeenCalled();
        });

        test('should produce resolved user with correct ResolvedUser shape', async () => {
            const userId = '101010101';
            const members: MockMember[] = [{
                user:        { id: userId, username: 'dana', tag: 'dana#0000' },
                displayName: 'Dana',
                nickname:    'D',
            }];
            mockClient.guilds = {
                cache: { values: mock((): unknown[] => [makeMockGuild(members)]) },
            } as unknown as typeof mockClient.guilds;

            const result = await tracker.resolveUserByName('D');

            expect(result.status).toBe('resolved');
            const resolved = result as Extract<UserResolveResult, { status: 'resolved' }>;
            const user: ResolvedUser = resolved.user;
            expect(user.username).toBe('dana');
            expect(user.displayName).toBe('Dana');
            expect(user.nickname).toBe('D');
        });
    });
});
