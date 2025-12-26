import { query } from '@anthropic-ai/claude-agent-sdk';
import _ from 'lodash';
import type { DiscordMessageContext } from '../integrations/discord/types';
import type { ContextBuilder } from './context-builder';

const CLAUDE_MODEL = 'claude-sonnet-4-5';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const TRUNCATION_BUFFER = 100; // Leave room for "..." and safety margin
const MAX_RESPONSE_LENGTH = DISCORD_MAX_MESSAGE_LENGTH - TRUNCATION_BUFFER;

export interface ClaudeAgentOptions {
    /** Context builder for loading memory (core identity + recent context) */
    contextBuilder?: ContextBuilder
    /** Memory MCP server instance for deep memory access */
    memoryMcpServer?: any
}

export interface ClaudeAgent {
    /**
     * Process a Discord message and generate a response.
     *
     * @param context Discord message context
     * @returns Claude's response text, or null if an error occurred
     */
    chat: (context: DiscordMessageContext) => Promise<string | null>
}

/**
 * Creates a Claude agent for processing Discord messages using the Agent SDK.
 *
 * The agent uses a hybrid memory approach:
 * - Core identity loaded into system prompt (always present)
 * - Recent context injected into user message (user-specific)
 * - Deep memory archive available via MCP tools (on-demand)
 *
 * @param options Agent configuration
 * @returns Claude agent instance
 */
export function createClaudeAgent(options: ClaudeAgentOptions): ClaudeAgent {
    const { contextBuilder, memoryMcpServer } = options;

    return {
        chat: async (context: DiscordMessageContext): Promise<string | null> => {
            try {
                // 1. Load core identity (cached, essential) for system prompt
                let systemPrompt = `You are Isambard, an agentic AI assistant in a Discord server.

You can use tools to accomplish tasks. You have access to:
- Memory system (view, store, search memories)
- File operations (if needed for tasks)
- Command execution (if granted permission)
- Web search and information retrieval

Always check your memories about users before responding to personalize your interactions.`;

                if(contextBuilder) {
                    const coreIdentity = await contextBuilder.loadCoreIdentity();
                    if(coreIdentity) {
                        systemPrompt += `\n\n## Who You Are\n${coreIdentity}`;
                    }
                }

                // 2. Load recent context for this user (injected in prompt)
                let contextPrefix = '';
                if(contextBuilder) {
                    const recentMemories = await contextBuilder.loadRecentContext(context.userId, 3);
                    if(recentMemories.length > 0) {
                        contextPrefix = `[Recent context]\n${recentMemories.map(m => `- ${m}`).join('\n')}\n\n`;
                    }
                }

                // 3. Format user message with context
                const userMessage = `${contextPrefix}User @${context.userId} in #${context.channelId}: ${context.content}`;

                // 4. Query with memory MCP server
                const response = query({
                    prompt: userMessage,
                    options: {
                        model:         CLAUDE_MODEL,
                        systemPrompt,
                        mcpServers:    memoryMcpServer ? { memory: memoryMcpServer } : undefined,
                        allowedTools:  memoryMcpServer
                            ? ['mcp__memory__view', 'mcp__memory__store', 'mcp__memory__search']
                            : [],
                        permissionMode: 'bypassPermissions',
                    },
                });

                // 5. Extract final response (keep latest assistant message)
                let lastAssistantText = '';

                for await (const message of response) {
                    if(message.type === 'assistant') {
                        // Keep latest assistant message (not intermediate thinking)
                        const textBlocks = message.message?.content?.filter((b: any) => b.type === 'text') || [];
                        const text = textBlocks.map((b: any) => b.text).join('\n').trim();
                        if(text) lastAssistantText = text;
                    }
                }

                // 6. Truncate for Discord if needed
                if(lastAssistantText.length > MAX_RESPONSE_LENGTH) {
                    // eslint-disable-next-line no-console -- Logging truncation for debugging
                    console.log(`Truncating Claude response for message ${context.messageId}: ${lastAssistantText.length} -> ${MAX_RESPONSE_LENGTH}`);
                    return lastAssistantText.slice(0, MAX_RESPONSE_LENGTH - 3) + '...';
                }

                return lastAssistantText || null;
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                // eslint-disable-next-line no-console -- Error logging
                console.error(`Failed to get Claude response for message ${context.messageId} from user ${context.userId}: ${errorMessage}`, error);
                return null;
            }
        },
    };
}
