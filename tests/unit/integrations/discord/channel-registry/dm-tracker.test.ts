/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Test mocks require type assertions and unsafe operations */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Client, DMChannel } from 'discord.js';
import _ from 'lodash';
import { DMTracker, formatDMChannelName, extractUsernameFromDM, isDMChannelName } from '../../../../../src/integrations/discord/channel-registry/dm-tracker';
import type { ChannelRegistryManager } from '../../../../../src/integrations/discord/channel-registry/manager';
import { createChannelId, createUserId } from '../../../../../src/integrations/discord/types';

describe('DM Tracker Utilities', () => {
    describe('formatDMChannelName', () => {
        test('should format username as DM channel name', () => {
            expect(formatDMChannelName('alice')).toBe('DM - alice');
        });

        test('should handle usernames with spaces', () => {
            expect(formatDMChannelName('alice smith')).toBe('DM - alice smith');
        });

        test('should handle usernames with special characters', () => {
            expect(formatDMChannelName('alice_123')).toBe('DM - alice_123');
        });

        test('should handle empty username', () => {
            expect(formatDMChannelName('')).toBe('DM - ');
        });
    });

    describe('extractUsernameFromDM', () => {
        test('should extract username from valid DM channel name', () => {
            expect(extractUsernameFromDM('DM - alice')).toBe('alice');
        });

        test('should extract username with spaces', () => {
            expect(extractUsernameFromDM('DM - alice smith')).toBe('alice smith');
        });

        test('should extract username with special characters', () => {
            expect(extractUsernameFromDM('DM - alice_123')).toBe('alice_123');
        });

        test('should return null for non-DM channel name', () => {
            expect(extractUsernameFromDM('general')).toBeNull();
        });

        test('should return null for empty string', () => {
            expect(extractUsernameFromDM('')).toBeNull();
        });

        test('should return null for partial prefix', () => {
            expect(extractUsernameFromDM('DM')).toBeNull();
        });

        test('should handle empty username in DM format', () => {
            expect(extractUsernameFromDM('DM - ')).toBe('');
        });
    });

    describe('isDMChannelName', () => {
        test('should return true for valid DM channel name', () => {
            expect(isDMChannelName('DM - alice')).toBe(true);
        });

        test('should return true for DM with empty username', () => {
            expect(isDMChannelName('DM - ')).toBe(true);
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
            getDMChannel: mock(_.constant(undefined)),

            trackDM: mock(_.noop),

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
            mockManager.getDMChannel = mock(() => undefined);

            const result = tracker.getDMChannel(userId);

            expect(result).toBeUndefined();

            expect(mockManager.getDMChannel).toHaveBeenCalledWith(userId);

            expect(mockManager.getDMChannel).toHaveBeenCalledTimes(1);
        });

        test('should return channelId when channel is tracked', () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            mockManager.getDMChannel = mock(() => channelId);

            const result = tracker.getDMChannel(userId);

            expect(result).toBe(channelId);
            expect(mockManager.getDMChannel).toHaveBeenCalledWith(userId);
        });
    });

    describe('getOrCreateDM', () => {
        beforeEach(() => {
            tracker = new DMTracker(mockManager, mockClient);
        });

        test('should return existing channel from cache', async () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            mockManager.getDMChannel = mock(() => channelId);

            const result = await tracker.getOrCreateDM(userId);

            expect(result).toBe(channelId);
            expect(mockManager.getDMChannel).toHaveBeenCalledWith(userId);
            expect(mockManager.trackDM).not.toHaveBeenCalled();
        });

        test('should create new DM channel when not cached', async () => {
            const userId = createUserId('123456789');
            const channelId = createChannelId('987654321');
            const username = 'alice';

            // Mock getDMChannel to return undefined (not cached)
            mockManager.getDMChannel = mock(_.constant(undefined));
            mockManager.trackDM = mock(_.noop);
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
            expect(mockManager.trackDM).toHaveBeenCalledWith(userId, channelId);
            expect(mockManager.trackDM).toHaveBeenCalledTimes(1);
            expect(mockManager.upsertChannel).toHaveBeenCalled();
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

            // Verify upsertChannel called with correct metadata
            const upsertCall = (mockManager.upsertChannel as any).mock.calls[0][0];
            expect(upsertCall.channelId).toBe(channelId);
            expect(upsertCall.guildId).toBe('DM');
            expect(upsertCall.channelName).toBe('DM - alice');
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

        test('should return null (not implemented)', async () => {
            const result = await tracker.getOrCreateDMByUsername();
            expect(result).toBeNull();
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

            mockManager.trackDM = mock(_.noop);
            mockManager.upsertChannel = mock(() => Promise.resolve());

            await tracker.trackFromMessage(userId, channelId, username);

            expect(mockManager.trackDM).toHaveBeenCalledWith(userId, channelId);
            expect(mockManager.trackDM).toHaveBeenCalledTimes(1);
            expect(mockManager.upsertChannel).toHaveBeenCalled();
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

            // Verify upsertChannel called with correct metadata
            const upsertCall = (mockManager.upsertChannel as any).mock.calls[0][0];
            expect(upsertCall.channelId).toBe(channelId);
            expect(upsertCall.guildId).toBe('DM');
            expect(upsertCall.channelName).toBe('DM - alice');
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

            mockManager.trackDM = mock(_.noop);
            mockManager.upsertChannel = mock(() => Promise.resolve());

            await tracker.trackFromMessage(userId, channelId, username);

            const upsertCall = (mockManager.upsertChannel as any).mock.calls[0][0];
            expect(upsertCall.channelName).toBe('DM - alice_123');
        });
    });
});
