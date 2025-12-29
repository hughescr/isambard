import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import _ from 'lodash';
import type { DiscordMessageContext } from '../integrations/discord/types';
import type { ContextBuilder } from './context-builder';
import type { AgentStreamEvent } from './types';

const CLAUDE_MODEL = 'claude-sonnet-4-5';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const TRUNCATION_BUFFER = 100; // Leave room for "..." and safety margin
const MAX_RESPONSE_LENGTH = DISCORD_MAX_MESSAGE_LENGTH - TRUNCATION_BUFFER;

/**
 * Extract text content from an assistant message.
 * @param message SDK message with potential content blocks
 * @returns Extracted text or empty string
 */
function extractAssistantText(message: { type: string, message?: { content?: unknown } }): string {
    if(message.type !== 'assistant') {
        return '';
    }

    interface ContentBlock {
        type:  string
        text?: string
    }
    const content = message.message?.content as ContentBlock[] | undefined;
    // Stryker disable next-line ArrayDeclaration: Equivalent mutant - _.filter on strings returns [] same as on []
    const textBlocks = _.filter(content ?? [], { type: 'text' });
    const text = _.chain(textBlocks).map('text').compact().join('\n').trim().value();
    return text;
}

export interface ClaudeAgentOptions {
    /** Context builder for loading memory (core identity + recent context) */
    contextBuilder?:  ContextBuilder
    /** Memory MCP server instance for deep memory access */
    memoryMcpServer?: McpServerConfig
}

export interface ClaudeAgent {
    /**
     * Process a Discord message and generate a response.
     *
     * @param context Discord message context
     * @param onStreamEvent Optional callback invoked for each stream event
     * @returns Claude's response text, or null if an error occurred
     */
    chat: (context: DiscordMessageContext, onStreamEvent?: (event: AgentStreamEvent) => void) => Promise<string | null>
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
        chat: async (context: DiscordMessageContext, onStreamEvent?: (event: AgentStreamEvent) => void): Promise<string | null> => {
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
                        contextPrefix = `[Recent context]\n${_.map(recentMemories, m => `- ${m}`).join('\n')}\n\n`;
                    }
                }

                // 3. Format user message with context
                const userMessage = `${contextPrefix}User @${context.userId} in #${context.channelId}: ${context.content}`;

                // 4. Query with memory MCP server
                const response = query({
                    prompt:  userMessage,
                    options: {
                        model:        CLAUDE_MODEL,
                        systemPrompt,
                        mcpServers:   memoryMcpServer ? { memory: memoryMcpServer } : undefined,
                        allowedTools: memoryMcpServer
                            ? ['mcp__memory__view', 'mcp__memory__store', 'mcp__memory__search']
                            : [],
                        permissionMode: 'bypassPermissions',
                    },
                });

                // 5. Extract final response (keep latest assistant message)
                let lastAssistantText = '';

                for await (const message of response) {
                    // Invoke stream event callback if provided
                    if(onStreamEvent) {
                        onStreamEvent(message as AgentStreamEvent);
                    }

                    const text = extractAssistantText(message);
                    if(text) {
                        lastAssistantText = text;
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
