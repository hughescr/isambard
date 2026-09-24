/**
 * Tests for Discord infrastructure factory.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Client } from 'discord.js';
import { mockLogger } from '../../setup';
import * as discordInfrastructureModule from '@/app/discord-infrastructure';
import type { DiscordConfig } from '@/config/schemas';
import * as channelRegistryModule from '@/integrations/discord/channel-registry';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import * as clientModule from '@/integrations/discord/client';
import * as inboxModule from '@/integrations/discord/inbox';
import type { InboxManager } from '@/integrations/discord/inbox/inbox-manager';
import * as fetcherModule from '@/integrations/discord/message-history/fetcher';
import type { MessageFetcher } from '@/integrations/discord/message-history/fetcher';
import * as searchModule from '@/integrations/discord/message-history/search';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import * as summarizerModule from '@/integrations/discord/message-history/summarizer';
import type { MessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import { createGuildId } from '@/integrations/discord/types';
import type { OperationalStateStore } from '@/storage/operational-state';

describe('createDiscordInfrastructure', () => {
    let spies: ReturnType<typeof spyOn>[];

    const mockDiscordConfig: DiscordConfig = {
        botToken:      'test-bot-token',
        applicationId: 'test-app-id',
        homeGuildId:   createGuildId('123456789012345678'),
        presence:      {
            updateThrottleMs:      5000,
            idleTimeoutMs:         60_000,
            idleRefreshIntervalMs: 300_000,
        },
        inbox: {
            minGapDurationMs:   10_000,
            maxCatchUpMessages: 100,
            maxCatchUpAgeDays:  7,
        },
    };

    const mockDocClient = {} as unknown as DynamoDBDocumentClient;
    const mockTableName = 'test-table';
    const mockOperationalStateStore = {} as unknown as OperationalStateStore;

    beforeEach(() => {
        spies = [];
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // Ignore errors - spy may already be restored
            }
        }
        spies.length = 0;
    });

    test('returns all required infrastructure components', () => {
        // Mock all the Discord integration modules
        const destroy = mock(async () => undefined);
        const mockDiscordClient = { destroy } as unknown as Client;
        const mockChannelRegistryBackend = {};
        const mockChannelRegistry = {} as unknown as ChannelRegistryManager;
        const mockMessageFetcher = {} as unknown as MessageFetcher;
        const mockMessageSummarizer = {} as unknown as MessageSummarizer;
        const mockMessageSearchService = {} as unknown as MessageSearchService;
        const mockCheckpointManager = {};
        const mockInboxManager = {} as unknown as InboxManager;

        const clientSpy = spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockDiscordClient);
        spies.push(clientSpy);

        // @ts-expect-error - Mocking constructor
        const backendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
            return mockChannelRegistryBackend;
        });
        spies.push(backendSpy);

        // @ts-expect-error - Mocking constructor
        const managerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => {
            return mockChannelRegistry;
        });
        spies.push(managerSpy);

        const fetcherSpy = spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue(mockMessageFetcher);
        spies.push(fetcherSpy);

        const summarizerSpy = spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue(mockMessageSummarizer);
        spies.push(summarizerSpy);

        const searchSpy = spyOn(searchModule, 'createMessageSearchService').mockReturnValue(mockMessageSearchService);
        spies.push(searchSpy);

        // @ts-expect-error - Mocking constructor
        const checkpointSpy = spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => {
            return mockCheckpointManager;
        });
        spies.push(checkpointSpy);

        // @ts-expect-error - Mocking constructor
        const inboxSpy = spyOn(inboxModule, 'InboxManager').mockImplementation(() => {
            return mockInboxManager;
        });
        spies.push(inboxSpy);

        const result = discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(result).toEqual({
            discordClient:        mockDiscordClient,
            channelRegistry:      mockChannelRegistry,
            messageSearchService: mockMessageSearchService,
            inboxManager:         mockInboxManager,
        });
        expect(mockLogger.info).toHaveBeenNthCalledWith(1, 'Discord message history enabled');
        expect(mockLogger.info).toHaveBeenNthCalledWith(2, 'Inbox system initialized');
        expect(destroy).not.toHaveBeenCalled();
    });

    test('passes discordConfig to createDiscordClient', () => {
        const clientSpy = spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client);
        spies.push(
            clientSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})),
            spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher),
            spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer),
            spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}))
        );

        discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(clientSpy).toHaveBeenCalledWith(mockDiscordConfig);
    });

    test('creates ChannelRegistryBackend with docClient and tableName', () => {
        // @ts-expect-error - Mocking constructor
        const backendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
            return {};
        });
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client),
            backendSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})),
            spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher),
            spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer),
            spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}))
        );

        discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(backendSpy).toHaveBeenCalledWith(mockDocClient, mockTableName);
    });

    test('creates ChannelRegistryManager with correct options', () => {
        const mockDiscordClient = {} as unknown as Client;
        const mockBackend = {};

        // @ts-expect-error - Mocking constructor
        const managerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => {
            return {};
        });
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockDiscordClient),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => mockBackend),
            managerSpy,
            spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher),
            spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer),
            spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}))
        );

        discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(managerSpy).toHaveBeenCalledWith({
            backend:     mockBackend,
            homeGuildId: mockDiscordConfig.homeGuildId,
            client:      mockDiscordClient,
        });
    });

    test('creates message history chain with correct dependencies', () => {
        const mockDiscordClient = {} as unknown as Client;
        const mockFetcher = {} as unknown as MessageFetcher;
        const mockSummarizer = {} as unknown as MessageSummarizer;

        const fetcherSpy = spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue(mockFetcher);
        const summarizerSpy = spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue(mockSummarizer);
        const searchSpy = spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService);
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockDiscordClient),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})),
            fetcherSpy,
            summarizerSpy,
            searchSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}))
        );

        discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(fetcherSpy).toHaveBeenCalledWith(mockDiscordClient);
        expect(summarizerSpy).toHaveBeenCalledWith({});
        expect(searchSpy).toHaveBeenCalledWith({
            fetcher:    mockFetcher,
            summarizer: mockSummarizer,
        });
    });

    test('creates CheckpointManager with the operational-state store', () => {
        // @ts-expect-error - Mocking constructor
        const checkpointSpy = spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => {
            return {};
        });
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})),
            spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher),
            spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer),
            spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService),
            checkpointSpy,
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}))
        );

        discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(checkpointSpy).toHaveBeenCalledWith({ store: mockOperationalStateStore });
    });

    test('creates InboxManager with correct dependencies', () => {
        const mockCheckpointManager = {};
        const mockSearchService = {} as unknown as MessageSearchService;
        const mockRegistry = {} as unknown as ChannelRegistryManager;

        // @ts-expect-error - Mocking constructor
        const inboxSpy = spyOn(inboxModule, 'InboxManager').mockImplementation(() => {
            return {};
        });
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => mockRegistry),
            spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher),
            spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer),
            spyOn(searchModule, 'createMessageSearchService').mockReturnValue(mockSearchService),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => mockCheckpointManager),
            inboxSpy
        );

        discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(inboxSpy).toHaveBeenCalledWith({
            checkpointManager:    mockCheckpointManager,
            messageSearchService: mockSearchService,
            channelRegistry:      mockRegistry,
            config:               mockDiscordConfig.inbox,
        });
    });

    test('throws when createDiscordClient throws', () => {
        const testError = new Error('Discord client creation failed');
        const clientSpy = spyOn(clientModule, 'createDiscordClient').mockImplementation(() => {
            throw testError;
        });
        spies.push(clientSpy);

        expect(() => discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        })).toThrow(testError);
    });

    test('throws when ChannelRegistryBackend constructor throws', async () => {
        const testError = new Error('Backend creation failed');
        const destroy = mock(async () => {
            throw new Error('dispose failed');
        });
        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({ destroy } as unknown as Client));
        // @ts-expect-error - Mocking constructor that throws
        const backendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
            throw testError;
        });
        spies.push(backendSpy);

        expect(() => discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        })).toThrow(testError);
        await Promise.resolve();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    test('releases a client if the registry manager constructor fails', async () => {
        const testError = new Error('Manager creation failed');
        const destroy = mock(async () => undefined);
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue({ destroy } as unknown as Client),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})),
            // @ts-expect-error - Deliberately failing manager constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => { throw testError; })
        );

        expect(() => discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        })).toThrow(testError);
        await Promise.resolve();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    test('transfers the client at acquisition when a construction owner is supplied', async () => {
        const testError = new Error('Backend creation failed');
        const destroy = mock(async () => undefined);
        const client = { destroy } as unknown as Client;
        const acquired: Client[] = [];
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue(client),
            // @ts-expect-error - Deliberately failing backend constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => { throw testError; })
        );

        expect(() => discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
            onClientCreated:       (owner) => { acquired.push(owner); },
        })).toThrow(testError);
        expect(acquired).toEqual([client]);
        expect(destroy).not.toHaveBeenCalled();
        await acquired[0].destroy();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    test('disposes locally if acquisition registration itself throws', async () => {
        const registrationError = new Error('owner registration failed');
        const destroy = mock(async () => undefined);
        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({ destroy } as unknown as Client));

        expect(() => discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         mockDiscordConfig,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
            onClientCreated:       () => {
                throw registrationError;
            },
        })).toThrow(registrationError);
        await Promise.resolve();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    test('handles missing presence config', () => {
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})),
            spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher),
            spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer),
            spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}))
        );

        const configWithoutPresence = {
            ...mockDiscordConfig,
            presence: undefined,
        };

        expect(() => discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         configWithoutPresence,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        })).not.toThrow();
    });

    test('handles missing inbox config', () => {
        const mockSearchService = {} as unknown as MessageSearchService;
        const mockRegistry = {} as unknown as ChannelRegistryManager;
        const mockCheckpointManager = {};

        // @ts-expect-error - Mocking constructor
        const inboxSpy = spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}));
        spies.push(
            spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})),
            // @ts-expect-error - Mocking constructor
            spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => mockRegistry),
            spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher),
            spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer),
            spyOn(searchModule, 'createMessageSearchService').mockReturnValue(mockSearchService),
            // @ts-expect-error - Mocking constructor
            spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => mockCheckpointManager),
            inboxSpy
        );

        const configWithoutInbox = {
            ...mockDiscordConfig,
            inbox: undefined,
        };

        discordInfrastructureModule.createDiscordInfrastructure({
            discordConfig:         configWithoutInbox,
            docClient:             mockDocClient,
            tableName:             mockTableName,
            operationalStateStore: mockOperationalStateStore,
        });

        expect(inboxSpy).toHaveBeenCalledWith({
            checkpointManager:    mockCheckpointManager,
            messageSearchService: mockSearchService,
            channelRegistry:      mockRegistry,
            config:               undefined,
        });
    });
});
