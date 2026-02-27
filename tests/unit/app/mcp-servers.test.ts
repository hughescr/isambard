import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { Client } from 'discord.js';
import { mockLogger } from '../../setup';
import type { createMemoryMCPServer } from '@/agent/memory-mcp-server';
import type { QuestionRegistry } from '@/agent/question-registry';
import type { MCPServersOptions } from '@/app/mcp-servers';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry';
import type { InboxManager } from '@/integrations/discord/inbox';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import type { BotStateManager } from '@/integrations/discord/state';
import type { MemoryToolBackend } from '@/storage/memory-tool';

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

    test('should return all three MCP server configs', async () => {
        // Mock all three MCP server creation functions
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const mockMemoryMcpServer = { name: 'memory', version: '1.0.0' } as unknown as McpServerInstance;
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcpServer);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' } as unknown as McpServerInstance;
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue(mockDiscordMcpServer);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const mockInboxMcpServer = { name: 'inbox', version: '1.0.0' } as unknown as McpServerInstance;
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue(mockInboxMcpServer);
        spies.push(createInboxMcpServerSpy);

        // Import and call createMCPServers
        const { createMCPServers } = await import('@/app/mcp-servers');
        const result = createMCPServers(mockOptions);

        // Verify all three servers are returned
        expect(result).toBeDefined();
        expect(result.memoryMcpServer).toBe(mockMemoryMcpServer);
        expect(result.discordMcpServer).toBe(mockDiscordMcpServer);
        expect(result.inboxMcpServer).toBe(mockInboxMcpServer);
    });

    test('should pass correct args to createMemoryMCPServer', async () => {
        // Mock all three MCP server creation functions
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createInboxMcpServerSpy);

        // Import and call createMCPServers
        const { createMCPServers } = await import('@/app/mcp-servers');
        createMCPServers(mockOptions);

        // Verify createMemoryMCPServer was called with correct args
        expect(createMemoryMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createMemoryMcpServerSpy).toHaveBeenCalledWith(mockOptions.memoryBackend, {
            recordAccess: undefined,
        });
    });

    test('should pass recordAccess callback to createMemoryMCPServer', async () => {
        // Set up a mock recordAccess callback
        const mockRecordAccess = mock(async () => { /* intentionally empty */ });
        const optionsWithRecordAccess = { ...mockOptions, recordAccess: mockRecordAccess };

        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        spies.push(spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance));

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        spies.push(spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance));

        const { createMCPServers } = await import('@/app/mcp-servers');
        createMCPServers(optionsWithRecordAccess);

        expect(createMemoryMcpServerSpy).toHaveBeenCalledWith(mockOptions.memoryBackend, {
            recordAccess: mockRecordAccess,
        });
    });

    test('should pass correct args to createDiscordMCPServer', async () => {
        // Mock all three MCP server creation functions
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createInboxMcpServerSpy);

        // Import and call createMCPServers
        const { createMCPServers } = await import('@/app/mcp-servers');
        createMCPServers(mockOptions);

        // Verify createDiscordMCPServer was called with correct args
        expect(createDiscordMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createDiscordMcpServerSpy).toHaveBeenCalledWith(
            mockOptions.messageSearchService,
            mockOptions.discordClient,
            mockOptions.questionRegistry,
            mockOptions.channelRegistry,
            mockOptions.timezone
        );
    });

    test('should pass correct args to createInboxMCPServer', async () => {
        // Mock all three MCP server creation functions
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createInboxMcpServerSpy);

        // Import and call createMCPServers
        const { createMCPServers } = await import('@/app/mcp-servers');
        createMCPServers(mockOptions);

        // Verify createInboxMCPServer was called with correct args
        expect(createInboxMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createInboxMcpServerSpy).toHaveBeenCalledWith(
            mockOptions.inboxManager,
            mockOptions.channelRegistry,
            mockOptions.botStateManager
        );
    });

    test('should throw when createMemoryMCPServer throws', async () => {
        // Mock createMemoryMCPServer to throw
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockImplementation(() => {
            throw new Error('Memory MCP server creation failed');
        });
        spies.push(createMemoryMcpServerSpy);

        // Mock other MCP servers (shouldn't be called due to early failure)
        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createInboxMcpServerSpy);

        // Import and verify createMCPServers throws
        const { createMCPServers } = await import('@/app/mcp-servers');
        expect(() => createMCPServers(mockOptions)).toThrow('Memory MCP server creation failed');
    });

    test('should throw when createDiscordMCPServer throws', async () => {
        // Mock createMemoryMCPServer to succeed
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createMemoryMcpServerSpy);

        // Mock createDiscordMCPServer to throw
        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockImplementation(() => {
            throw new Error('Discord MCP server creation failed');
        });
        spies.push(createDiscordMcpServerSpy);

        // Mock createInboxMCPServer (shouldn't be called due to early failure)
        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createInboxMcpServerSpy);

        // Import and verify createMCPServers throws
        const { createMCPServers } = await import('@/app/mcp-servers');
        expect(() => createMCPServers(mockOptions)).toThrow('Discord MCP server creation failed');
    });

    test('should throw when createInboxMCPServer throws', async () => {
        // Mock createMemoryMCPServer and createDiscordMCPServer to succeed
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as unknown as McpServerInstance);
        spies.push(createDiscordMcpServerSpy);

        // Mock createInboxMCPServer to throw
        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockImplementation(() => {
            throw new Error('Inbox MCP server creation failed');
        });
        spies.push(createInboxMcpServerSpy);

        // Import and verify createMCPServers throws
        const { createMCPServers } = await import('@/app/mcp-servers');
        expect(() => createMCPServers(mockOptions)).toThrow('Inbox MCP server creation failed');
    });
});
