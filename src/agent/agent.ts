import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import _ from 'lodash';
import type { DiscordMessageContext } from '../integrations/discord/types';
import type { ContextBuilder } from './context-builder';
import type { AgentStreamEvent } from './types';

const CLAUDE_MODEL = 'claude-sonnet-4-5';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const TRUNCATION_BUFFER = 100; // Leave room for "..." and safety margin
const MAX_RESPONSE_LENGTH = DISCORD_MAX_MESSAGE_LENGTH - TRUNCATION_BUFFER;

const BASE_SYSTEM_PROMPT = `You are Isambard, an agentic AI assistant in a Discord server.

## Memory System

Your memories are organized in layers:
- /identity/ - Core beliefs, values, and self-model
- /state/ - Current context and working memory
- /events/ - Historical timeline and experiences
- /users/{userId}/ - User-specific memories

Recent memories are automatically provided to you in the context:
- [About this user] - Recent memories about the current user
- [Your recent activities] - Your recent state memories
- [Recent events] - Events from the last 24 hours

To explore your full memory:
- Use \`list\` with "/" to see top-level directories
- Use \`view\` with a specific path to read a memory
- Use \`search\` with a tag to find related memories

## Capabilities

You can use tools to accomplish tasks. You have access to:
- Memory system (list, view, store, search memories)
- File operations (if needed for tasks)
- Command execution (if granted permission)
- Web search and information retrieval

Always check your memories about users before responding to personalize your interactions.`;

/**
 * Build system prompt with optional core identity.
 * @param contextBuilder Optional context builder for loading identity
 * @returns System prompt string
 */
async function buildSystemPrompt(contextBuilder?: ContextBuilder): Promise<string> {
    if(!contextBuilder) {
        return BASE_SYSTEM_PROMPT;
    }

    const coreIdentity = await contextBuilder.loadCoreIdentity();
    if(!coreIdentity) {
        return BASE_SYSTEM_PROMPT;
    }

    return `${BASE_SYSTEM_PROMPT}\n\n## Who You Are\n${coreIdentity}`;
}

/**
 * Build context prefix from user memories, bot memories, and recent events.
 * @param contextBuilder Context builder for loading memories
 * @param context Discord message context
 * @returns Context prefix string (empty if no context available)
 */
async function buildContextPrefix(contextBuilder: ContextBuilder, context: DiscordMessageContext): Promise<string> {
    const sections: string[] = [];

    // User-specific memories
    const userMemories = await contextBuilder.loadRecentContext(context.userId, 3);
    if(userMemories.length > 0) {
        sections.push(`[About this user]\n${_.map(userMemories, m => `- ${m}`).join('\n')}`);
    }

    // Isambard's own memories (using botUserId from context)
    if(context.botUserId) {
        const isambardMemories = await contextBuilder.loadRecentContext(context.botUserId, 2);
        if(isambardMemories.length > 0) {
            sections.push(`[Your recent activities]\n${_.map(isambardMemories, m => `- ${m}`).join('\n')}`);
        }
    }

    // Recent events
    const recentEvents = await contextBuilder.loadRecentEvents(3);
    if(recentEvents.length > 0) {
        sections.push(`[Recent events]\n${_.map(recentEvents, m => `- ${m}`).join('\n')}`);
    }

    if(sections.length === 0) {
        return '';
    }

    return sections.join('\n\n') + '\n\n';
}

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
                // 1. Build system prompt with core identity
                const systemPrompt = await buildSystemPrompt(contextBuilder);

                // 2. Build context prefix from memories and events
                const contextPrefix = contextBuilder
                    ? await buildContextPrefix(contextBuilder, context)
                    : '';

                // 3. Format user message with context
                const userMessage = `${contextPrefix}User @${context.userId} in #${context.channelId}: ${context.content}`;

                // 4. Log start of processing
                logger.info({
                    userId:    context.userId,
                    channelId: context.channelId,
                    messageId: context.messageId,
                    msg:       'Agent starting to process message',
                });

                // 5. Query with memory MCP server
                const response = query({
                    prompt:  userMessage,
                    options: {
                        model:        CLAUDE_MODEL,
                        systemPrompt,
                        mcpServers:   memoryMcpServer ? { memory: memoryMcpServer } : undefined,
                        allowedTools: memoryMcpServer
                            ? ['mcp__memory__view', 'mcp__memory__list', 'mcp__memory__storeSelf', 'mcp__memory__storeUserMemory', 'mcp__memory__logEvent', 'mcp__memory__search']
                            : [],
                        permissionMode: 'bypassPermissions',
                    },
                });

                // 6. Extract final response (keep latest assistant message)
                let lastAssistantText = '';

                for await (const message of response) {
                    // Debug log for stream events
                    logger.debug({
                        eventType: message.type,
                        msg:       `Stream event: ${message.type}`,
                    });

                    // Invoke stream event callback if provided
                    if(onStreamEvent) {
                        onStreamEvent(message as AgentStreamEvent);
                    }

                    const text = extractAssistantText(message);
                    if(text) {
                        lastAssistantText = text;
                    }
                }

                // 7. Log completion
                logger.info({
                    messageId:      context.messageId,
                    responseLength: lastAssistantText.length,
                    msg:            `Agent completed processing (${lastAssistantText.length} chars)`,
                });

                // 8. Truncate for Discord if needed
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
