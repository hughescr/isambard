/**
 * Tests for setupChannelCleanupHandlers in event-handler-setup.ts
 *
 * These tests directly exercise the exported function to kill specific Stryker mutants:
 * - Line 186: ConditionalExpression → false  (if(!('id' in channel)) guard)
 * - Line 204: MethodExpression → _(allChannels) (filter/map chain)
 */

import { describe, test, expect, mock } from 'bun:test';
import type { Client } from 'discord.js';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { MessageCoordinator } from '@/integrations/discord/message-coordinator';
import { setupChannelCleanupHandlers } from '@/integrations/discord/setup/event-handler-setup';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

// Helper to build a minimal Client mock that captures event handlers
function makeClientMock() {
    const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};

    const client = {
        on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- handlers[event] may not exist yet
            if(!handlers[event]) {
                handlers[event] = [];
            }
            handlers[event].push(handler);
            return client;
        }),
    } as unknown as Client;

    const emit = (event: string, ...args: unknown[]): void => {
        for(const handler of (handlers[event] ?? [])) {
            handler(...args);
        }
    };

    const emitAsync = async (event: string, ...args: unknown[]): Promise<void> => {
        for(const handler of (handlers[event] ?? [])) {
            handler(...args);
        }
        // Flush microtasks so async safeAsyncHandler bodies complete
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    };

    return { client, emit, emitAsync };
}

describe('setupChannelCleanupHandlers', () => {
    describe('channelDelete handler', () => {
        test('calls coordinator.removeChannel() with channel id when channel has id', () => {
            const mockRemoveChannel = mock(() => undefined);
            const mockCoordinator = { removeChannel: mockRemoveChannel } as unknown as MessageCoordinator;
            const mockRegistry = { getAllChannels: mock(() => []) } as unknown as ChannelRegistryManager;
            const { client, emit } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            const channelId = '123456789012345678';
            emit('channelDelete', { id: channelId });

            expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
            expect(mockRemoveChannel).toHaveBeenCalledWith(createChannelId(channelId));
        });

        test('does NOT call coordinator.removeChannel() when channel lacks id property', () => {
            // This test kills the ConditionalExpression mutant (if(!('id' in channel)) → if(false))
            // With the mutant, the guard is skipped, then channel.id access would throw or produce wrong result
            const mockRemoveChannel = mock(() => undefined);
            const mockCoordinator = { removeChannel: mockRemoveChannel } as unknown as MessageCoordinator;
            const mockRegistry = { getAllChannels: mock(() => []) } as unknown as ChannelRegistryManager;
            const { client, emit } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            // Channel without 'id' property (e.g. PartialGroupDMChannel in some Discord.js versions)
            emit('channelDelete', { name: 'some-channel' });

            // Guard should trigger early return — coordinator.removeChannel should NOT be called
            expect(mockRemoveChannel).not.toHaveBeenCalled();
        });

        test('does not throw when coordinator is undefined', () => {
            const mockRegistry = { getAllChannels: mock(() => []) } as unknown as ChannelRegistryManager;
            const { client, emit } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: undefined, channelRegistry: mockRegistry });

            expect(() => emit('channelDelete', { id: '123456789012345678' })).not.toThrow();
        });
    });

    describe('guildDelete handler', () => {
        test('calls coordinator.removeGuildChannels() with only matching guild channel IDs', async () => {
            // This test kills the MethodExpression mutant:
            // _(allChannels).filter(['guildId', guildId]).map('channelId').value() → _(allChannels)
            // With the mutant, a lodash wrapper is passed instead of a ChannelId array
            const mockRemoveGuildChannels = mock(() => undefined);
            const mockCoordinator = { removeGuildChannels: mockRemoveGuildChannels } as unknown as MessageCoordinator;

            const guildId       = createGuildId('guild-abc');
            const otherGuildId  = createGuildId('guild-xyz');
            const channelId1    = createChannelId('ch-1');
            const channelId2    = createChannelId('ch-2');
            const otherChannelId = createChannelId('ch-other');

            const mockRegistry = {
                getAllChannels: mock(() => [
                    { channelId: channelId1,    guildId,      channelName: 'chan-1' },
                    { channelId: channelId2,    guildId,      channelName: 'chan-2' },
                    { channelId: otherChannelId, guildId: otherGuildId, channelName: 'chan-other' },
                ]),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            await emitAsync('guildDelete', { id: guildId });

            expect(mockRemoveGuildChannels).toHaveBeenCalledTimes(1);
            // Should only contain the 2 channels from the deleted guild — NOT the other guild's channel
            const calledWith = (mockRemoveGuildChannels.mock.calls as unknown as [string[]][])[0]?.[0] ?? [];
            expect(calledWith).toHaveLength(2);
            expect(calledWith).toContain(channelId1);
            expect(calledWith).toContain(channelId2);
            expect(calledWith).not.toContain(otherChannelId);
        });

        test('calls coordinator.removeGuildChannels() with empty array when no matching channels', async () => {
            const mockRemoveGuildChannels = mock(() => undefined);
            const mockCoordinator = { removeGuildChannels: mockRemoveGuildChannels } as unknown as MessageCoordinator;

            const guildId      = createGuildId('guild-abc');
            const otherGuildId = createGuildId('guild-xyz');

            const mockRegistry = {
                getAllChannels: mock(() => [
                    { channelId: createChannelId('ch-other'), guildId: otherGuildId, channelName: 'other' },
                ]),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            await emitAsync('guildDelete', { id: guildId });

            expect(mockRemoveGuildChannels).toHaveBeenCalledTimes(1);
            expect(mockRemoveGuildChannels).toHaveBeenCalledWith([]);
        });

        test('does not call coordinator.removeGuildChannels() when coordinator is undefined', async () => {
            const mockRegistry = {
                getAllChannels: mock(() => []),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: undefined, channelRegistry: mockRegistry });

            // Should not throw even without a coordinator
            await emitAsync('guildDelete', { id: 'guild-abc' });

            expect(mockRegistry.getAllChannels).not.toHaveBeenCalled();
        });

        test('filters channel IDs only (not full channel objects)', async () => {
            // Additional check: the result is an array of ChannelId strings, not channel metadata objects
            const mockRemoveGuildChannels = mock(() => undefined);
            const mockCoordinator = { removeGuildChannels: mockRemoveGuildChannels } as unknown as MessageCoordinator;

            const guildId   = createGuildId('guild-abc');
            const channelId = createChannelId('ch-1');

            const mockRegistry = {
                getAllChannels: mock(() => [
                    { channelId, guildId, channelName: 'chan-1', someOtherProp: 'extra' },
                ]),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            await emitAsync('guildDelete', { id: guildId });

            const calledWith = (mockRemoveGuildChannels.mock.calls as unknown as [unknown[]][])[0]?.[0] ?? [];
            // Each entry should be the channelId string, not the full channel metadata object
            expect(calledWith).toHaveLength(1);
            expect(calledWith[0]).toBe(channelId);
            expect(calledWith.filter(item => typeof item === 'object' && item !== null)).toHaveLength(0);
        });
    });
});
