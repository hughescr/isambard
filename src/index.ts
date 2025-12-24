import { Resource } from 'sst';
import _ from 'lodash';
import { loadConfig, loadDynamoDBConfig } from './config/loader';
import { createDynamoDBClient } from './storage/client';
import { createMemoryTool } from './agent/claude';
import { createClaudeClient } from './agent/client';
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
 * 1. Load configuration (Discord, DynamoDB)
 * 2. Create Claude client (requires ANTHROPIC_API_KEY)
 * 3. Optionally create memory tool if DynamoDB is available
 * 4. Create Claude agent with optional memory tool
 * 5. Create Discord bot with agent as message handler
 *
 * Error handling:
 * - Missing required config (Discord, Anthropic) throws immediately
 * - Missing optional config (DynamoDB) logs warning and continues without memory
 *
 * @returns Application instance with start/stop methods
 * @throws {Error} If required configuration is missing or invalid
 */
export function createApp(): App {
    // Load Discord configuration (required)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
    const config = loadConfig(Resource as any);

    // Create Claude client (requires ANTHROPIC_API_KEY)
    const claudeClient = createClaudeClient();

    // Try to create memory tool (optional)
    let memoryTool;
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- SST Resource type is complex
        const dynamoDBConfig = loadDynamoDBConfig(Resource as any);
        const { docClient, tableName } = createDynamoDBClient(dynamoDBConfig);
        memoryTool = createMemoryTool(docClient, tableName);
        // eslint-disable-next-line no-console -- Startup logging
        console.log(`Memory tool initialized with DynamoDB backend: ${tableName} in ${dynamoDBConfig.region}`);
    } catch (error) {
        const errorMessage = _.isError(error) ? error.message : String(error);
        // eslint-disable-next-line no-console -- Warning about degraded functionality
        console.log(`Failed to initialize memory tool, continuing without persistent memory: ${errorMessage}`);
    // Continue without memory tool
    }

    // Create Claude agent
    const agent = createClaudeAgent({
        client:     claudeClient,
        // Type assertion needed because betaMemoryTool returns BetaRunnableTool
        // which is compatible at runtime but TypeScript sees different types
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Beta tool type compatibility
        memoryTool: memoryTool as any,
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
