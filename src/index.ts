import { Resource } from 'sst';
import _ from 'lodash';
import { loadConfig, loadDynamoDBConfig } from './config/loader';
import { createDynamoDBClient } from './storage/client';
import { MemoryToolBackend } from './storage/memory-tool';
import { createContextBuilder } from './agent/context-builder';
import { createMemoryMCPServer } from './agent/memory-mcp-server';
import { createClaudeAgent } from './agent/agent';
import { createDiscordBot } from './integrations/discord/bot';
import type { DiscordBot } from './integrations/discord/bot';

export interface App {
    /**
     * Start the application (Discord bot and Claude agent).
     */
    start: () => Promise<void>

    /**
     * Stop the application gracefully.
     */
    stop: () => Promise<void>
}

/**
 * Creates the Isambard application with all components wired together.
 *
 * Initialization flow:
 * 1. Load configuration (Discord, Agent OAuth token)
 * 2. Set CLAUDE_CODE_OAUTH_TOKEN for Agent SDK
 * 3. Optionally create memory system (context builder + MCP server) if DynamoDB is available
 * 4. Create Claude agent with hybrid memory support
 * 5. Create Discord bot with agent as message handler
 *
 * Error handling:
 * - Missing required config (Discord, OAuth token) throws immediately
 * - Missing optional config (DynamoDB) logs warning and continues without memory
 *
 * @returns Application instance with start/stop methods
 * @throws {Error} If required configuration is missing or invalid
 */
export function createApp(): App {
    // Load configuration (required)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
    const config = loadConfig(Resource as any);

    // Set OAuth token for Agent SDK
    process.env.CLAUDE_CODE_OAUTH_TOKEN = config.agent.oauthToken;

    // Try to create memory system (optional)
    let contextBuilder;
    let memoryMcpServer;

    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
        const dynamoDBConfig = loadDynamoDBConfig(Resource as any);
        const { docClient, tableName } = createDynamoDBClient(dynamoDBConfig);

        // Create memory backend
        const memoryBackend = new MemoryToolBackend(docClient, tableName);

        // Create context builder (for core identity + recent context)
        contextBuilder = createContextBuilder({ backend: memoryBackend });

        // Create MCP server (for deep memory access)
        memoryMcpServer = createMemoryMCPServer(memoryBackend);

        // eslint-disable-next-line no-console -- Startup logging
        console.log(`Memory system initialized with DynamoDB: ${tableName} in ${dynamoDBConfig.region}`);
    } catch (error) {
        const errorMessage = _.isError(error) ? error.message : String(error);
        // eslint-disable-next-line no-console -- Warning about degraded functionality
        console.log(`Memory not configured, continuing without persistent memory: ${errorMessage}`);
        // Continue without memory system
    }

    // Create Claude agent with hybrid memory support
    const agent = createClaudeAgent({
        contextBuilder,
        memoryMcpServer,
    });

    // Create Discord bot with agent as message handler
    const bot: DiscordBot = createDiscordBot({
        config:    config.discord,
        onMessage: async (context) => {
            return await agent.chat(context);
        },
    });

    return {
        start: async () => {
            // eslint-disable-next-line no-console -- Startup logging
            console.log('Starting Isambard application...');
            await bot.start();
            // eslint-disable-next-line no-console -- Startup logging
            console.log('Isambard application started successfully');
        },

        stop: async () => {
            // eslint-disable-next-line no-console -- Shutdown logging
            console.log('Stopping Isambard application...');
            await bot.stop();
            // eslint-disable-next-line no-console -- Shutdown logging
            console.log('Isambard application stopped');
        },
    };
}

// Application entry point - only run if this is the main module
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- import.meta.main is required for Bun
if(import.meta.main) {
    // eslint-disable-next-line no-console -- Startup message
    console.log('Isambard starting...');

    const app = createApp();

    // Start the application
    await app.start();

    // Handle graceful shutdown
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
    process.on('SIGINT', async () => {
        // eslint-disable-next-line no-console -- Shutdown logging
        console.log('Received SIGINT, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async shutdown handler is intentional
    process.on('SIGTERM', async () => {
        // eslint-disable-next-line no-console -- Shutdown logging
        console.log('Received SIGTERM, shutting down gracefully...');
        await app.stop();
        // eslint-disable-next-line n/no-process-exit -- Graceful shutdown requires exit
        process.exit(0);
    });
}
