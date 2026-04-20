import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { Client } from 'discord.js';
import { mockLogger } from '../../setup';
import type { BrowserAdapter } from '@/agent/browser';
import * as browserMcpModule from '@/agent/browser-mcp-server';
import * as bskyMcpModule from '@/agent/bsky-mcp-server';
import * as discordMcpModule from '@/agent/discord-mcp-server';
import * as inboxMcpModule from '@/agent/inbox-mcp-server';
import * as mediaMcpModule from '@/agent/media-mcp-server';
import * as memoryMcpModule from '@/agent/memory-mcp-server';
import type { createMemoryMCPServer } from '@/agent/memory-mcp-server';
import type { QuestionRegistry } from '@/agent/question-registry/registry';
import * as wikipediaMcpModule from '@/agent/wikipedia-mcp-server';
import * as mcpServersModule from '@/app/mcp-servers';
import type { MCPServersOptions } from '@/app/mcp-servers';
import { BskyCheckpointManager } from '@/integrations/bsky/checkpoint/checkpoint-manager';
import type { BlueskyClient } from '@/integrations/bsky/client';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { InboxManager } from '@/integrations/discord/inbox/inbox-manager';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import type { BotStateManager } from '@/integrations/discord/state/types';
import type { TokenBucketRateLimiter } from '@/services/rate-limiters/token-bucket';
import type { PersonAllowlist } from '@/storage';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';

type McpServerInstance = ReturnType<typeof createMemoryMCPServer>;

describe('createMCPServers', () => {
    let spies: ReturnType<typeof spyOn>[];
    let mockOptions: MCPServersOptions;

    beforeEach(() => {
        spies = [];
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();

        // Create mock options with all required properties
        mockOptions = {
            memoryBackend:        {} as unknown as MemoryToolBackend,
            messageSearchService: {} as unknown as MessageSearchService,
            discordClient:        {} as unknown as Client,
            questionRegistry:     {} as unknown as QuestionRegistry,
            channelRegistry:      {} as unknown as ChannelRegistryManager,
            inboxManager:         {} as unknown as InboxManager,
            botStateManager:      {} as unknown as BotStateManager,
            timezone:             'America/New_York',
        };
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

    test('should return all MCP server configs including wikipedia', () => {
        // Mock all MCP server creation functions
        const mockMemoryMcpServer = { name: 'memory', version: '1.0.0' } as unknown as McpServerInstance;
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcpServer);

        const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' } as unknown as McpServerInstance;
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue(mockDiscordMcpServer);

        const mockInboxMcpServer = { name: 'inbox', version: '1.0.0' } as unknown as McpServerInstance;
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue(mockInboxMcpServer);

        const mockWikipediaMcpServer = { name: 'wikipedia', version: '1.0.0' } as unknown as McpServerInstance;
        const createWikipediaMcpServerSpy = spyOn(wikipediaMcpModule, 'createWikipediaMCPServer').mockReturnValue(mockWikipediaMcpServer);

        const mockMediaMcpServer = { name: 'media', version: '1.0.0' } as unknown as McpServerInstance;
        const createMediaMcpServerSpy = spyOn(mediaMcpModule, 'createMediaMCPServer').mockReturnValue(mockMediaMcpServer);

        spies.push(createMemoryMcpServerSpy, createDiscordMcpServerSpy, createInboxMcpServerSpy, createWikipediaMcpServerSpy, createMediaMcpServerSpy);

        const result = mcpServersModule.createMCPServers(mockOptions);

        // Verify all servers are returned
        expect(result).toBeDefined();
        expect(result.memoryMcpServer).toBe(mockMemoryMcpServer);
        expect(result.discordMcpServer).toBe(mockDiscordMcpServer);
        expect(result.inboxMcpServer).toBe(mockInboxMcpServer);
        expect(result.wikipediaMcpServer).toBe(mockWikipediaMcpServer);
        expect(result.mediaMcpServer).toBe(mockMediaMcpServer);
    });

    test('should always create wikipedia MCP server', () => {
        const mockWikipediaMcpServer = { name: 'wikipedia', version: '1.0.0' } as unknown as McpServerInstance;
        const createWikipediaMcpServerSpy = spyOn(wikipediaMcpModule, 'createWikipediaMCPServer').mockReturnValue(mockWikipediaMcpServer);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createWikipediaMcpServerSpy
        );

        const result = mcpServersModule.createMCPServers(mockOptions);

        expect(result.wikipediaMcpServer).toBe(mockWikipediaMcpServer);
        expect(createWikipediaMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createWikipediaMcpServerSpy).toHaveBeenCalledWith();
    });

    test('should always create media MCP server', () => {
        const mockMediaMcpServer = { name: 'media', version: '1.0.0' } as unknown as McpServerInstance;
        const createMediaMcpServerSpy = spyOn(mediaMcpModule, 'createMediaMCPServer').mockReturnValue(mockMediaMcpServer);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createMediaMcpServerSpy
        );

        const result = mcpServersModule.createMCPServers(mockOptions);

        expect(result.mediaMcpServer).toBe(mockMediaMcpServer);
        expect(createMediaMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createMediaMcpServerSpy).toHaveBeenCalledWith();
    });

    test('should pass correct args to createMemoryMCPServer', () => {
        // Mock all three MCP server creation functions
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            createMemoryMcpServerSpy,
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance)
        );

        mcpServersModule.createMCPServers(mockOptions);

        // Verify createMemoryMCPServer was called with correct args
        expect(createMemoryMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createMemoryMcpServerSpy).toHaveBeenCalledWith(mockOptions.memoryBackend, {
            recordAccess: undefined,
        });
    });

    test('should pass recordAccess callback to createMemoryMCPServer', () => {
        // Set up a mock recordAccess callback
        const mockRecordAccess = mock(async () => { /* intentionally empty */ });
        const optionsWithRecordAccess = { ...mockOptions, recordAccess: mockRecordAccess };

        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            createMemoryMcpServerSpy,
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance)
        );

        mcpServersModule.createMCPServers(optionsWithRecordAccess);

        expect(createMemoryMcpServerSpy).toHaveBeenCalledWith(mockOptions.memoryBackend, {
            recordAccess: mockRecordAccess,
        });
    });

    test('should pass correct args to createDiscordMCPServer', () => {
        // Mock all three MCP server creation functions
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createDiscordMcpServerSpy,
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance)
        );

        mcpServersModule.createMCPServers(mockOptions);

        // Verify createDiscordMCPServer was called with single options object
        expect(createDiscordMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createDiscordMcpServerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                searchService:    mockOptions.messageSearchService,
                client:           mockOptions.discordClient,
                questionRegistry: mockOptions.questionRegistry,
                timezone:         mockOptions.timezone,
            })
        );
    });

    test('should pass correct args to createInboxMCPServer', () => {
        // Mock all three MCP server creation functions
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createInboxMcpServerSpy
        );

        mcpServersModule.createMCPServers(mockOptions);

        // Verify createInboxMCPServer was called with correct args
        expect(createInboxMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createInboxMcpServerSpy).toHaveBeenCalledWith(
            mockOptions.inboxManager,
            expect.objectContaining({
                resolveChannelId:   expect.any(Function),
                muteChannel:        expect.any(Function),
                unmuteChannel:      expect.any(Function),
                getAllChannels:     expect.any(Function),
                getUnmutedChannels: expect.any(Function),
            }),
            mockOptions.botStateManager,
            mockOptions.healthRegistry,
            mockOptions.discordReconnectionLoop
        );
    });

    test('should throw when createMemoryMCPServer throws', () => {
        // Mock createMemoryMCPServer to throw
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockImplementation(() => {
            throw new Error('Memory MCP server creation failed');
        });

        // Mock other MCP servers (shouldn't be called due to early failure)
        spies.push(
            createMemoryMcpServerSpy,
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance)
        );

        expect(() => mcpServersModule.createMCPServers(mockOptions)).toThrow('Memory MCP server creation failed');
    });

    test('should throw when createDiscordMCPServer throws', () => {
        // Mock createDiscordMCPServer to throw
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockImplementation(() => {
            throw new Error('Discord MCP server creation failed');
        });

        // Mock createInboxMCPServer (shouldn't be called due to early failure)
        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createDiscordMcpServerSpy,
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance)
        );

        expect(() => mcpServersModule.createMCPServers(mockOptions)).toThrow('Discord MCP server creation failed');
    });

    test('should throw when createInboxMCPServer throws', () => {
        // Mock createInboxMCPServer to throw
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockImplementation(() => {
            throw new Error('Inbox MCP server creation failed');
        });

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createInboxMcpServerSpy
        );

        expect(() => mcpServersModule.createMCPServers(mockOptions)).toThrow('Inbox MCP server creation failed');
    });

    test('should not create bskyMcpServer when bskyClient is not provided', () => {
        const createBskyMcpServerSpy = spyOn(bskyMcpModule, 'createBskyMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBskyMcpServerSpy
        );

        const result = mcpServersModule.createMCPServers(mockOptions);

        expect(result.bskyMcpServer).toBeUndefined();
        expect(createBskyMcpServerSpy).not.toHaveBeenCalled();
    });

    test('should create bskyMcpServer when bskyClient is provided', () => {
        const mockBskyMcpServer = { name: 'bsky', version: '1.0.0' } as unknown as McpServerInstance;
        const createBskyMcpServerSpy = spyOn(bskyMcpModule, 'createBskyMCPServer').mockReturnValue(mockBskyMcpServer);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBskyMcpServerSpy
        );

        const mockBskyClient = {} as unknown as BlueskyClient;
        const result = mcpServersModule.createMCPServers({ ...mockOptions, bskyClient: mockBskyClient });

        expect(result.bskyMcpServer).toBe(mockBskyMcpServer);
        expect(createBskyMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createBskyMcpServerSpy).toHaveBeenCalledWith({
            client:              mockBskyClient,
            checkpointManager:   expect.any(BskyCheckpointManager),
            rateLimiter:         undefined,
            allowlist:           undefined,
            sendApprovalRequest: undefined,
        });
    });

    test('should pass bsky safety rail fields to createBskyMCPServer when provided', () => {
        const mockBskyMcpServer = { name: 'bsky', version: '1.0.0' } as unknown as McpServerInstance;
        const createBskyMcpServerSpy = spyOn(bskyMcpModule, 'createBskyMCPServer').mockReturnValue(mockBskyMcpServer);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBskyMcpServerSpy
        );

        const mockBskyClient       = {} as unknown as BlueskyClient;
        const mockPersonAllowlist    = {} as unknown as PersonAllowlist;
        const mockBskyRateLimiter  = {} as unknown as TokenBucketRateLimiter;
        const mockSendApproval     = mock(async () => { /* no-op */ });

        mcpServersModule.createMCPServers({
            ...mockOptions,
            bskyClient:              mockBskyClient,
            bskyAllowlist:           mockPersonAllowlist,
            bskyRateLimiter:         mockBskyRateLimiter,
            bskySendApprovalRequest: mockSendApproval,
        });

        expect(createBskyMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createBskyMcpServerSpy).toHaveBeenCalledWith({
            client:              mockBskyClient,
            checkpointManager:   expect.any(BskyCheckpointManager),
            rateLimiter:         mockBskyRateLimiter,
            allowlist:           mockPersonAllowlist,
            sendApprovalRequest: mockSendApproval,
        });
    });

    // -------------------------------------------------------------------------
    // Browser MCP server (FIX 5 + FIX 7)
    // -------------------------------------------------------------------------

    test('should create browserMcpServer when browserAdapter and byte caps are provided', () => {
        const mockBrowserMcpServer = { name: 'browser', version: '1.0.0' } as unknown as McpServerInstance;
        const createBrowserMcpServerSpy = spyOn(browserMcpModule, 'createBrowserMCPServer').mockReturnValue(mockBrowserMcpServer);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBrowserMcpServerSpy
        );

        const fakeBrowserAdapter = {} as unknown as BrowserAdapter;
        const fakeBrowserPolicy = { allowlist: ['example.com'] };
        const result = mcpServersModule.createMCPServers({
            ...mockOptions,
            browserAdapter:            fakeBrowserAdapter,
            browserPolicy:             fakeBrowserPolicy,
            browserMaxScreenshotBytes: 2_000_000,
            browserMaxTextBytes:       100_000,
        });

        expect(result.browserMcpServer).toBe(mockBrowserMcpServer);
        expect(createBrowserMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createBrowserMcpServerSpy).toHaveBeenCalledWith(expect.objectContaining({
            adapter:            fakeBrowserAdapter,
            policy:             fakeBrowserPolicy,
            maxScreenshotBytes: 2_000_000,
            maxTextBytes:       100_000,
        }));
    });

    test('should skip browserMcpServer and log error when browserAdapter provided but byte caps missing', () => {
        const createBrowserMcpServerSpy = spyOn(browserMcpModule, 'createBrowserMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBrowserMcpServerSpy
        );

        const fakeBrowserAdapter = {} as unknown as BrowserAdapter;
        const result = mcpServersModule.createMCPServers({
            ...mockOptions,
            browserAdapter: fakeBrowserAdapter,
            // browserMaxScreenshotBytes and browserMaxTextBytes intentionally omitted
        });

        expect(result.browserMcpServer).toBeUndefined();
        expect(createBrowserMcpServerSpy).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('required when browserAdapter'));
    });

    test('should log warn when browserAdapter provided without browserPolicy', () => {
        const createBrowserMcpServerSpy = spyOn(browserMcpModule, 'createBrowserMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBrowserMcpServerSpy
        );

        const fakeBrowserAdapter = {} as unknown as BrowserAdapter;
        const result = mcpServersModule.createMCPServers({
            ...mockOptions,
            browserAdapter:            fakeBrowserAdapter,
            browserMaxScreenshotBytes: 2_000_000,
            browserMaxTextBytes:       100_000,
            // browserPolicy intentionally omitted
        });

        expect(createBrowserMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('browserPolicy'));
        expect(result.browserMcpServer).toBeDefined();
    });

    test('should not log warn when browserAdapter and browserPolicy are both provided', () => {
        const createBrowserMcpServerSpy = spyOn(browserMcpModule, 'createBrowserMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBrowserMcpServerSpy
        );

        const fakeBrowserAdapter = {} as unknown as BrowserAdapter;
        mcpServersModule.createMCPServers({
            ...mockOptions,
            browserAdapter:            fakeBrowserAdapter,
            browserPolicy:             { allowlist: ['example.com'] },
            browserMaxScreenshotBytes: 2_000_000,
            browserMaxTextBytes:       100_000,
        });

        expect(createBrowserMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('should not create browserMcpServer when browserAdapter is absent', () => {
        const createBrowserMcpServerSpy = spyOn(browserMcpModule, 'createBrowserMCPServer').mockReturnValue({} as unknown as McpServerInstance);

        spies.push(
            spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance),
            createBrowserMcpServerSpy
        );

        // No browser-related options passed
        const result = mcpServersModule.createMCPServers(mockOptions);

        expect(result.browserMcpServer).toBeUndefined();
        expect(createBrowserMcpServerSpy).not.toHaveBeenCalled();
        expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('browser'));
    });
});
