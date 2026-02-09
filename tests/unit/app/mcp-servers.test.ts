/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- Test mocks */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockLogger } from '../../setup';
import type { MCPServersOptions } from '@/app/mcp-servers';

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
            memoryBackend:        {} as any,
            messageSearchService: {} as any,
            discordClient:        {} as any,
            questionRegistry:     {} as any,
            channelRegistry:      {} as any,
            inboxManager:         {} as any,
            botStateManager:      {} as any,
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
        const mockMemoryMcpServer = { name: 'memory', version: '1.0.0' } as any;
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue(mockMemoryMcpServer);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' } as any;
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue(mockDiscordMcpServer);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const mockInboxMcpServer = { name: 'inbox', version: '1.0.0' } as any;
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
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
        spies.push(createInboxMcpServerSpy);

        // Import and call createMCPServers
        const { createMCPServers } = await import('@/app/mcp-servers');
        createMCPServers(mockOptions);

        // Verify createMemoryMCPServer was called with correct args
        expect(createMemoryMcpServerSpy).toHaveBeenCalledTimes(1);
        expect(createMemoryMcpServerSpy).toHaveBeenCalledWith(mockOptions.memoryBackend);
    });

    test('should pass correct args to createDiscordMCPServer', async () => {
        // Mock all three MCP server creation functions
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
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
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
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
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
        spies.push(createDiscordMcpServerSpy);

        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
        spies.push(createInboxMcpServerSpy);

        // Import and verify createMCPServers throws
        const { createMCPServers } = await import('@/app/mcp-servers');
        expect(() => createMCPServers(mockOptions)).toThrow('Memory MCP server creation failed');
    });

    test('should throw when createDiscordMCPServer throws', async () => {
        // Mock createMemoryMCPServer to succeed
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
        spies.push(createMemoryMcpServerSpy);

        // Mock createDiscordMCPServer to throw
        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockImplementation(() => {
            throw new Error('Discord MCP server creation failed');
        });
        spies.push(createDiscordMcpServerSpy);

        // Mock createInboxMCPServer (shouldn't be called due to early failure)
        const inboxMcpModule = await import('@/agent/inbox-mcp-server');
        const createInboxMcpServerSpy = spyOn(inboxMcpModule, 'createInboxMCPServer').mockReturnValue({} as any);
        spies.push(createInboxMcpServerSpy);

        // Import and verify createMCPServers throws
        const { createMCPServers } = await import('@/app/mcp-servers');
        expect(() => createMCPServers(mockOptions)).toThrow('Discord MCP server creation failed');
    });

    test('should throw when createInboxMCPServer throws', async () => {
        // Mock createMemoryMCPServer and createDiscordMCPServer to succeed
        const memoryMcpModule = await import('@/agent/memory-mcp-server');
        const createMemoryMcpServerSpy = spyOn(memoryMcpModule, 'createMemoryMCPServer').mockReturnValue({} as any);
        spies.push(createMemoryMcpServerSpy);

        const discordMcpModule = await import('@/agent/discord-mcp-server');
        const createDiscordMcpServerSpy = spyOn(discordMcpModule, 'createDiscordMCPServer').mockReturnValue({} as any);
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
