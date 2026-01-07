import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import _ from 'lodash';
import type { DiscordMessageContext } from '../integrations/discord/types';
import { getCurrentTimeContext } from '../utils/time';
import type { ContextBuilder } from './context-builder';
import { buildSystemPrompt } from './prompts/index.js';
import { cleanupSession, extractSessionId } from './session-cleanup';
import type { AgentStreamEvent } from './types';
import { createRetryableQuery } from './claude-retry';
import { loadRetryConfig } from '../config/retry-config';

const CLAUDE_MODEL = 'sonnet';

/**
 * Explicit list of tools available to Isambard.
 * Excludes NotebookEdit (not useful for Discord bot) and AskUserQuestion
 * (Izzy decides autonomously based on context and memories).
 * Memory tools are added via mcpServers configuration.
 */
const EXPLICIT_TOOLS = [
    // File operations
    'Read',
    'Write',
    'Edit',
    // Search
    'Glob',
    'Grep',
    // Web
    'WebFetch',
    'WebSearch',
    // Execution
    'Bash',
    // Agent spawning
    'Task',
    // Task management
    'TodoWrite',
    // Plan mode
    'EnterPlanMode',
    'ExitPlanMode',
];

/**
 * Explicit sub-agent definitions.
 * Excludes statusline-setup (useless for Discord bot, saves context tokens).
 * Agent description/prompt strings are configuration - correctness validated by integration tests.
 */
const EXPLICIT_AGENTS = {
    'general-purpose': {
        // Stryker disable next-line StringLiteral: Configuration string for Claude SDK
        description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks',
        // Stryker disable next-line StringLiteral: Configuration string for Claude SDK
        prompt:      'You are a general-purpose assistant helping with software engineering tasks.',
        model:       'sonnet' as const,
    },
    Explore: {
        // Stryker disable next-line StringLiteral: Configuration string for Claude SDK
        description: 'Fast agent specialized for exploring codebases. Use for finding files, searching code, or answering questions about the codebase.',
        // Stryker disable next-line StringLiteral: Configuration string for Claude SDK
        prompt:      'You are a codebase exploration specialist. Focus on finding relevant files and understanding code structure.',
        tools:       ['Read', 'Glob', 'Grep'],
        model:       'haiku' as const,
    },
    Plan: {
        // Stryker disable next-line StringLiteral: Configuration string for Claude SDK
        description: 'Software architect agent for designing implementation plans.',
        // Stryker disable next-line StringLiteral: Configuration string for Claude SDK
        prompt:      'You are a software architect. Analyze requirements and design implementation approaches.',
        tools:       ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
        model:       'sonnet' as const,
    },
};

/**
 * Build context prefix from user memories, bot memories, and recent events.
 * @param contextBuilder Context builder for loading memories
 * @param context Discord message context
 * @returns Context prefix string (empty if no context available)
 */
async function buildContextPrefix(contextBuilder: ContextBuilder, context: DiscordMessageContext): Promise<string> {
    // Stryker disable next-line ArrayDeclaration: Equivalent - sections always has time section pushed first
    const sections: string[] = [];

    // Time context (always first)
    const timeContext = getCurrentTimeContext();  // timezone support comes later via context-builder
    const timeSection = `## Current Time
- UTC: ${timeContext.utc} (${timeContext.dayOfWeek} ${timeContext.timeOfDay})`;
    sections.push(timeSection);

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
    const recentEvents = await contextBuilder.loadRecentEvents(50);
    if(recentEvents.length > 0) {
        sections.push(`[Recent events]\n${_.map(recentEvents, m => `- ${m}`).join('\n')}`);
    }

    // Stryker disable next-line StringLiteral: Equivalent - trailing newlines are formatting, tests verify content not whitespace
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

/**
 * Extract thinking content from an assistant message.
 * @param message SDK message with potential content blocks
 * @returns Extracted thinking text or empty string
 */
export function extractThinkingContent(message: { type: string, message?: { content?: unknown } }): string {
    if(message.type !== 'assistant') {
        return '';
    }

    interface ContentBlock {
        type:  string
        text?: string
    }
    const content = message.message?.content as ContentBlock[] | undefined;
    // Stryker disable next-line ArrayDeclaration: Equivalent mutant - _.filter on strings returns [] same as on []
    const thinkingBlocks = _.filter(content ?? [], { type: 'thinking' });
    const text = _.chain(thinkingBlocks).map('text').compact().join('\n').trim().value();
    return text;
}

/**
 * Extract tool_use blocks from an assistant message
 * @param message Stream message to extract from
 * @returns Array of tool use blocks or empty array
 */
export interface ToolUseBlock {
    type:  'tool_use'
    id:    string
    name:  string
    input: unknown
}

/**
 * Parsed tool name with module and tool components.
 */
export interface ParsedToolName {
    module: string
    tool:   string
}

/**
 * Parse tool name into module and tool components.
 * Converts MCP tool names from 'mcp__module__tool' to { module: 'module', tool: 'tool' }.
 * Regular tool names use 'claude' as the module.
 * @param toolName The tool name to parse
 * @returns ParsedToolName with module and tool components
 */
export function parseToolName(toolName: string | undefined): ParsedToolName {
    if(toolName === undefined) {
        return { module: 'claude', tool: 'unknown' };
    }
    // Stryker disable next-line ConditionalExpression: Empty string check is defensive coding for edge case
    if(toolName === '') {
        return { module: 'claude', tool: '' };
    }

    // MCP tools have format: mcp__module__tool (e.g., mcp__DevTools__find_symbol)
    if(_.startsWith(toolName, 'mcp__')) {
        const parts = _.split(toolName.slice(5), '__');
        if(parts.length >= 2) {
            const module = parts[0];
            const tool = parts.slice(1).join('__');
            return { module, tool };
        }
    }

    // Regular tools or malformed MCP names use 'claude' module
    return { module: 'claude', tool: toolName };
}

/**
 * Sensitive key patterns for redaction (case-insensitive).
 * Matches common credential-related key names.
 */
const SENSITIVE_KEY_PATTERNS = [
    /apikey/i,
    /privatekey/i,
    /secretkey/i,
    /accesskey/i,
    /authkey/i,
    /password/i,
    /passwd/i,
    /secret/i,
    /token/i,
    /credential/i,
    /auth/i,
    /key/i,  // Broad match - security over convenience
];

/**
 * Check if a key name matches any sensitive pattern.
 * @param key The key name to check
 * @returns true if the key matches a sensitive pattern
 */
function isSensitiveKey(key: string): boolean {
    return _.some(SENSITIVE_KEY_PATTERNS, pattern => pattern.test(key));
}

/**
 * Recursively redact sensitive values from an object.
 * Replaces values of keys matching sensitive patterns with '[REDACTED]'.
 * @param input The value to redact
 * @returns A new value with sensitive keys redacted
 */
export function redactSensitiveArgs(input: unknown): unknown {
    // Handle null/undefined
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: null/undefined check is defensive coding, both branches return input unchanged
    if(input === null || input === undefined) {
        return input;
    }

    // Handle arrays - map over elements
    if(_.isArray(input)) {
        return _.map(input, item => redactSensitiveArgs(item));
    }

    // Handle objects - check keys and recurse
    if(_.isPlainObject(input)) {
        const result: Record<string, unknown> = {};
        for(const [key, value] of _.toPairs(input as Record<string, unknown>)) {
            if(isSensitiveKey(key)) {
                result[key] = '[REDACTED]';
            } else {
                result[key] = redactSensitiveArgs(value);
            }
        }
        return result;
    }

    // Return primitives unchanged
    return input;
}

export function extractToolUses(message: { type: string, message?: { content?: unknown } }): ToolUseBlock[] {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent - _.filter on non-assistant messages returns [] same as early return
    if(message.type !== 'assistant') {
        return [];
    }
    const content = message.message?.content as { type: string, id?: string, name?: string, input?: unknown }[] | undefined;
    return _.filter(content ?? [], { type: 'tool_use' }) as ToolUseBlock[];
}

export interface ClaudeAgentOptions {
    /** Context builder for loading memory (core identity + recent context) */
    contextBuilder?:   ContextBuilder
    /** Memory MCP server instance for deep memory access */
    memoryMcpServer?:  McpServerConfig
    /** Discord MCP server instance for message history access */
    discordMcpServer?: McpServerConfig
    /** Plugins to load (from plugin-loader.ts) */
    plugins?:          SdkPluginConfig[]
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
/**
 * Builds the mcpServers configuration object based on provided servers.
 */
function buildMcpServers(memoryMcpServer?: McpServerConfig, discordMcpServer?: McpServerConfig): Record<string, McpServerConfig> | undefined {
    if(!memoryMcpServer && !discordMcpServer) {
        return undefined;
    }

    const servers: Record<string, McpServerConfig> = {};
    // Stryker disable next-line ConditionalExpression: Truthiness check for optional parameter
    if(memoryMcpServer) {
        servers.memory = memoryMcpServer;
    }
    // Stryker disable next-line ConditionalExpression: Truthiness check for optional parameter
    if(discordMcpServer) {
        servers.discord = discordMcpServer;
    }
    return servers;
}

/**
 * Builds the allowedTools list based on which MCP servers are configured.
 */
function buildAllowedTools(discordMcpServer?: McpServerConfig): string[] {
    const baseTools = [
        // Memory MCP tools (auto-approved)
        'mcp__memory__*',
        // Read-only and safe tools (auto-approved)
        'Read',
        'Glob',
        'Grep',
        'WebFetch',
        'WebSearch',
        'TodoWrite',
        'EnterPlanMode',
        'ExitPlanMode',
        'Task',
        // Bash commands (specific safe commands only)
        'Bash(git:*)',
        'Bash(bun run:*)',
        'Bash(bun test:*)',
        'Bash(bun lint:*)',
        'Bash(bun typecheck)',
        'Bash(ls:*)',
    ];

    if(discordMcpServer) {
        return [
            ...baseTools,
            // Discord MCP tools (auto-approved)
            'mcp__discord__*',
        ];
    }

    return baseTools;
}

/**
 * Logs error details from result events in the stream.
 * @param message Stream message to check for errors
 */
// Stryker disable all: Observability - error logging doesn't affect return value
function logResultErrors(message: { type: string, is_error?: boolean, subtype?: string, errors?: unknown[] }): void {
    if(message.type === 'result' && 'is_error' in message && message.is_error) {
        logger.error({
            subtype: 'subtype' in message ? message.subtype : undefined,
            errors:  'errors' in message ? message.errors : [],
            msg:     'Agent SDK returned error result',
        });
    }
}
// Stryker restore all

/**
 * Logs error details from assistant events in the stream.
 * @param message Stream message to check for errors
 */
// Stryker disable all: Observability - error logging doesn't affect return value
function logAssistantErrors(message: { type: string, error?: unknown }): void {
    if(message.type === 'assistant' && 'error' in message && message.error) {
        logger.error({
            error: message.error,
            msg:   'Agent SDK assistant message error',
        });
    }
}
// Stryker restore all

/**
 * Logs tool usage from assistant messages with redacted sensitive args.
 * @param message Stream message to extract tool uses from
 */
// Stryker disable all: Observability - debug logging doesn't affect return value
function logToolUsage(message: { type: string, message?: { content?: unknown } }): void {
    const toolUses = extractToolUses(message);
    for(const toolUse of toolUses) {
        const parsed = parseToolName(toolUse.name);
        logger.debug({
            module: parsed.module,
            tool:   parsed.tool,
            args:   redactSensitiveArgs(toolUse.input),
        });
    }
}
// Stryker restore all

/**
 * Module-level state for tracking the last tool requested by the LLM.
 * Used to correlate user events (tool responses) with the tool that was invoked.
 */
let lastRequestedTool: string | undefined;

/**
 * Resets the log stream event state for testing purposes.
 */
export function resetLogStreamState(): void {
    lastRequestedTool = undefined;
}

/**
 * Logs stream events with descriptive messages based on event type.
 *
 * Provides enhanced logging for tool request/response flow:
 * - When assistant event contains tool_use blocks → logs "LLM requesting tool: {toolName}"
 * - When user event arrives after a tool request → logs "Tool result for LLM: {lastToolName}"
 * - Keeps existing thinking/responding distinction for non-tool assistant events
 *
 * @param message Stream event to log
 */
// Stryker disable all: Observability - debug logging doesn't affect return value
export function logStreamEvent(message: AgentStreamEvent): void {
    switch(message.type) {
        case 'user':
            // User events after a tool request are tool responses
            if(lastRequestedTool) {
                logger.debug({
                    eventType: 'tool_response',
                    toolName:  lastRequestedTool,
                    msg:       `Tool result for LLM: ${lastRequestedTool}`,
                });
                lastRequestedTool = undefined;
            } else {
                logger.debug({
                    eventType: 'user',
                    msg:       'Sending message to Claude LLM',
                });
            }
            break;

        case 'assistant': {
            // Check for tool_use blocks first
            const toolUses = extractToolUses(message);
            if(toolUses.length > 0) {
                // Log each tool request
                for(const toolUse of toolUses) {
                    logger.debug({
                        eventType: 'tool_request',
                        toolName:  toolUse.name,
                        msg:       `LLM requesting tool: ${toolUse.name}`,
                    });
                    // Track the last tool for correlating with the response
                    lastRequestedTool = toolUse.name;
                }
            } else {
                // No tool use - log thinking/responding
                const hasText = Boolean(extractAssistantText(message));
                logger.debug({
                    eventType: 'assistant',
                    hasText,
                    msg:       hasText ? 'Claude LLM responding' : 'Claude LLM thinking',
                });
            }
            break;
        }

        case 'tool_progress': {
            const parsed = parseToolName(message.tool_name);
            logger.debug({
                eventType: 'tool_progress',
                module:    parsed.module,
                tool:      parsed.tool,
                msg:       'Tool execution started',
            });
            break;
        }

        case 'tool_result': {
            const parsed = parseToolName(message.tool_name);
            logger.debug({
                eventType: 'tool_result',
                module:    parsed.module,
                tool:      parsed.tool,
                msg:       'Tool execution complete',
            });
            break;
        }

        case 'result':
            logger.debug({
                eventType: 'result',
                status:    message.subtype,
                msg:       'Claude LLM stream complete',
            });
            break;
    }
}
// Stryker restore all

export function createClaudeAgent(options: ClaudeAgentOptions): ClaudeAgent {
    const { contextBuilder, memoryMcpServer, discordMcpServer, plugins } = options;

    // Load retry configuration
    const retryConfig = loadRetryConfig();

    // Create retryable query function
    const retryableQuery = createRetryableQuery(query, {
        policy: retryConfig.claude,
    });

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

                // 5. Query with MCP servers, plugins, and sandboxed execution (with retry)
                const response = retryableQuery({
                    prompt:  userMessage,
                    options: {
                        model:             CLAUDE_MODEL,
                        systemPrompt,
                        tools:             EXPLICIT_TOOLS,
                        agents:            EXPLICIT_AGENTS,
                        mcpServers:        buildMcpServers(memoryMcpServer, discordMcpServer),
                        plugins:           plugins && plugins.length > 0 ? plugins : undefined,
                        permissionMode:    'acceptEdits',
                        allowedTools:      buildAllowedTools(discordMcpServer),
                        maxThinkingTokens: 10000,  // Enable extended thinking for richer status context
                        // Explicitly disable filesystem settings loading - we provide all config programmatically
                        settingSources:    [],
                        // Stryker disable all: Observability - stderr logging doesn't affect behavior
                        stderr:            (data: string) => {
                            logger.error({ stderr: data, msg: 'Agent SDK stderr' });
                        },
                        // Stryker restore all
                    },
                });

                // 6. Extract final response (keep latest assistant message)
                let lastAssistantText = '';
                let sessionId: string | undefined;

                for await (const message of response) {
                    // Capture session ID from system init event
                    const extractedSessionId = extractSessionId(message);
                    if(extractedSessionId) {
                        sessionId = extractedSessionId;
                    }

                    // Log descriptive stream events
                    logStreamEvent(message as AgentStreamEvent);

                    // Log errors from stream events
                    logResultErrors(message as { type: string, is_error?: boolean, subtype?: string, errors?: unknown[] });
                    logAssistantErrors(message as { type: string, error?: unknown });
                    logToolUsage(message);

                    // Invoke stream event callback if provided
                    if(onStreamEvent) {
                        onStreamEvent(message as AgentStreamEvent);
                    }

                    const text = extractAssistantText(message);
                    if(text) {
                        lastAssistantText = text;
                    }
                }

                // 7. Clean up session file (fire-and-forget, errors logged internally)
                // Stryker disable next-line all: Cleanup is fire-and-forget, not observable in tests
                if(sessionId) {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Fire-and-forget cleanup
                    cleanupSession(sessionId);
                }

                // 8. Log completion
                logger.info({
                    messageId:      context.messageId,
                    responseLength: lastAssistantText.length,
                    msg:            `Agent completed processing (${lastAssistantText.length} chars)`,
                });

                // 9. Return full response (chunking is handled by Discord handlers)
                return lastAssistantText || null;
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                logger.error({ error, userId: context.userId, messageId: context.messageId, msg: `Failed to get Claude response for message ${context.messageId} from user ${context.userId}: ${errorMessage}` });
                return null;
            }
        },
    };
}
