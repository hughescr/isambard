/**
 * Tests for Discord infrastructure factory.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Client } from 'discord.js';
import { mockLogger } from '../../setup';
import type { DiscordConfig } from '@/config/schemas';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry';
import type { InboxManager } from '@/integrations/discord/inbox';
import type { MessageFetcher } from '@/integrations/discord/message-history/fetcher';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import type { MessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import type { BotStateManager } from '@/integrations/discord/state';
import { createGuildId } from '@/integrations/discord/types';
import type { MemoryToolBackend } from '@/storage/memory-tool';

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
    const mockMemoryBackend = {} as unknown as MemoryToolBackend;

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

    test('returns all required infrastructure components', async () => {
        // Mock all the Discord integration modules
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        const mockDiscordClient = {} as unknown as Client;
        const mockChannelRegistryBackend = {};
        const mockChannelRegistry = {} as unknown as ChannelRegistryManager;
        const mockMessageFetcher = {} as unknown as MessageFetcher;
        const mockMessageSummarizer = {} as unknown as MessageSummarizer;
        const mockMessageSearchService = {} as unknown as MessageSearchService;
        const mockCheckpointManager = {};
        const mockInboxManager = {} as unknown as InboxManager;
        const mockBotStateManager = {} as unknown as BotStateManager;

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

        // @ts-expect-error - Mocking constructor
        const stateSpy = spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => mockBotStateManager);
        spies.push(stateSpy);

        // Import after mocks are set up
        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        const result = createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(result).toEqual({
            discordClient:        mockDiscordClient,
            channelRegistry:      mockChannelRegistry,
            messageSearchService: mockMessageSearchService,
            inboxManager:         mockInboxManager,
            botStateManager:      mockBotStateManager,
        });
    });

    test('passes discordConfig to createDiscordClient', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        const clientSpy = spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client);
        spies.push(clientSpy);
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})));
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({})));

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(clientSpy).toHaveBeenCalledWith(mockDiscordConfig);
    });

    test('creates ChannelRegistryBackend with docClient and tableName', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client));
        // @ts-expect-error - Mocking constructor
        const backendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
            return {};
        });
        spies.push(backendSpy);
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})));
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({})));

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(backendSpy).toHaveBeenCalledWith(mockDocClient, mockTableName);
    });

    test('creates ChannelRegistryManager with correct options', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        const mockDiscordClient = {} as unknown as Client;
        const mockBackend = {};

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockDiscordClient));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => mockBackend));
        // @ts-expect-error - Mocking constructor
        const managerSpy = spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => {
            return {};
        });
        spies.push(managerSpy);
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({})));

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(managerSpy).toHaveBeenCalledWith({
            backend:     mockBackend,
            homeGuildId: mockDiscordConfig.homeGuildId,
            client:      mockDiscordClient,
        });
    });

    test('creates message history chain with correct dependencies', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        const mockDiscordClient = {} as unknown as Client;
        const mockFetcher = {} as unknown as MessageFetcher;
        const mockSummarizer = {} as unknown as MessageSummarizer;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockDiscordClient));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})));
        const fetcherSpy = spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue(mockFetcher);
        spies.push(fetcherSpy);
        const summarizerSpy = spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue(mockSummarizer);
        spies.push(summarizerSpy);
        const searchSpy = spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService);
        spies.push(searchSpy);
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({})));

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(fetcherSpy).toHaveBeenCalledWith(mockDiscordClient);
        expect(summarizerSpy).toHaveBeenCalledWith({});
        expect(searchSpy).toHaveBeenCalledWith({
            fetcher:    mockFetcher,
            summarizer: mockSummarizer,
        });
    });

    test('creates CheckpointManager with memoryBackend', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})));
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService));
        // @ts-expect-error - Mocking constructor
        const checkpointSpy = spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => {
            return {};
        });
        spies.push(checkpointSpy);
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({})));

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(checkpointSpy).toHaveBeenCalledWith({ backend: mockMemoryBackend });
    });

    test('creates InboxManager with correct dependencies', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        const mockCheckpointManager = {};
        const mockSearchService = {} as unknown as MessageSearchService;
        const mockRegistry = {} as unknown as ChannelRegistryManager;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => mockRegistry));
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue(mockSearchService));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => mockCheckpointManager));
        // @ts-expect-error - Mocking constructor
        const inboxSpy = spyOn(inboxModule, 'InboxManager').mockImplementation(() => {
            return {};
        });
        spies.push(inboxSpy);
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({})));

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(inboxSpy).toHaveBeenCalledWith({
            checkpointManager:    mockCheckpointManager,
            messageSearchService: mockSearchService,
            channelRegistry:      mockRegistry,
            config:               mockDiscordConfig.inbox,
        });
    });

    test('creates BotStateManager with logger and throttle config', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})));
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        const stateSpy = spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({}));
        spies.push(stateSpy);

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(stateSpy).toHaveBeenCalledWith({
            logger:           expect.anything(),
            updateThrottleMs: mockDiscordConfig.presence?.updateThrottleMs,
        });
    });

    test('throws when createDiscordClient throws', async () => {
        const clientModule = await import('@/integrations/discord/client');

        const testError = new Error('Discord client creation failed');
        const clientSpy = spyOn(clientModule, 'createDiscordClient').mockImplementation(() => {
            throw testError;
        });
        spies.push(clientSpy);

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        expect(() => createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        })).toThrow(testError);
    });

    test('throws when ChannelRegistryBackend constructor throws', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');

        const testError = new Error('Backend creation failed');

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client));
        // @ts-expect-error - Mocking constructor that throws
        const backendSpy = spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => {
            throw testError;
        });
        spies.push(backendSpy);

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        expect(() => createDiscordInfrastructure({
            discordConfig: mockDiscordConfig,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        })).toThrow(testError);
    });

    test('handles missing presence config', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => ({})));
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue({} as unknown as MessageSearchService));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        const stateSpy = spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({}));
        spies.push(stateSpy);

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        const configWithoutPresence = {
            ...mockDiscordConfig,
            presence: undefined,
        };

        createDiscordInfrastructure({
            discordConfig: configWithoutPresence,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(stateSpy).toHaveBeenCalledWith({
            logger:           expect.anything(),
            updateThrottleMs: undefined,
        });
    });

    test('handles missing inbox config', async () => {
        const clientModule = await import('@/integrations/discord/client');
        const channelRegistryModule = await import('@/integrations/discord/channel-registry');
        const fetcherModule = await import('@/integrations/discord/message-history/fetcher');
        const summarizerModule = await import('@/integrations/discord/message-history/summarizer');
        const searchModule = await import('@/integrations/discord/message-history/search');
        const inboxModule = await import('@/integrations/discord/inbox');
        const stateModule = await import('@/integrations/discord/state');

        const mockSearchService = {} as unknown as MessageSearchService;
        const mockRegistry = {} as unknown as ChannelRegistryManager;
        const mockCheckpointManager = {};

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue({} as unknown as Client));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryBackend').mockImplementation(() => ({})));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(channelRegistryModule, 'ChannelRegistryManager').mockImplementation(() => mockRegistry));
        spies.push(spyOn(fetcherModule, 'createMessageFetcher').mockReturnValue({} as unknown as MessageFetcher));
        spies.push(spyOn(summarizerModule, 'createMessageSummarizer').mockReturnValue({} as unknown as MessageSummarizer));
        spies.push(spyOn(searchModule, 'createMessageSearchService').mockReturnValue(mockSearchService));
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(inboxModule, 'CheckpointManager').mockImplementation(() => mockCheckpointManager));
        // @ts-expect-error - Mocking constructor
        const inboxSpy = spyOn(inboxModule, 'InboxManager').mockImplementation(() => ({}));
        spies.push(inboxSpy);
        // @ts-expect-error - Mocking constructor
        spies.push(spyOn(stateModule, 'BotStateManagerImpl').mockImplementation(() => ({})));

        const { createDiscordInfrastructure } = await import('@/app/discord-infrastructure');

        const configWithoutInbox = {
            ...mockDiscordConfig,
            inbox: undefined,
        };

        createDiscordInfrastructure({
            discordConfig: configWithoutInbox,
            docClient:     mockDocClient,
            tableName:     mockTableName,
            memoryBackend: mockMemoryBackend,
        });

        expect(inboxSpy).toHaveBeenCalledWith({
            checkpointManager:    mockCheckpointManager,
            messageSearchService: mockSearchService,
            channelRegistry:      mockRegistry,
            config:               undefined,
        });
    });
});
