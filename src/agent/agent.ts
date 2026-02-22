import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, SDKUserMessage, SdkPluginConfig, SDKCompactBoundaryMessage, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import _ from 'lodash';
import type { MessageContext, PlatformImage } from './types';
import { formatLocalDateTime, resolveTimezone } from '../utils/time';
import type { ContextBuilder } from './context-builder';
import { buildSystemPrompt, COMPACTION_SUMMARY_PROMPT } from './prompts/index.js';
import { cleanupSession, extractSessionId } from './session-cleanup';
import type { AgentStreamEvent } from './types';
import { createRetryableQuery } from './claude-retry';
import { loadRetryConfig } from '../config/retry-config';
import type { ResumeContext } from './resume-prompt-builder';
import { StreamTracker } from './stream-tracker';
import { buildResumePrompt } from './resume-prompt-builder';
import { buildMultimodalContent, hasImages } from './multimodal-message-builder';
import type { TaskPersistenceCoordinator } from './task-persistence-coordinator';

const MAX_AUTO_RESUME_ATTEMPTS = 3;

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
    'TaskOutput',
    'TaskStop',
    // Task management (new task system)
    'TaskCreate',
    'TaskUpdate',
    'TaskGet',
    'TaskList',
    // Plan mode
    'EnterPlanMode',
    'ExitPlanMode',
    // Skills
    'Skill',
];

/**
 * Explicit sub-agent definitions.
 * Excludes statusline-setup (useless for Discord bot, saves context tokens).
 * Agent description/prompt strings are configuration - correctness validated by integration tests.
 */
const EXPLICIT_AGENTS = {
    'general-purpose': {
        description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks',
        prompt:      'You are a general-purpose assistant helping with software engineering tasks.',
        model:       'sonnet' as const,
    },
    Explore: {
        description: 'Fast agent specialized for exploring codebases. Use for finding files, searching code, or answering questions about the codebase.',
        prompt:      'You are a codebase exploration specialist. Focus on finding relevant files and understanding code structure.',
        tools:       ['Read', 'Glob', 'Grep'],
        model:       'haiku' as const,
    },
    Plan: {
        description: 'Software architect agent for designing implementation plans.',
        prompt:      'You are a software architect. Analyze requirements and design implementation approaches.',
        tools:       ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
        model:       'sonnet' as const,
    },
};

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
    // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant - non-assistant with no content returns '' via either path (filter returns [] → '' either way)
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
    // Stryker disable next-line ConditionalExpression,StringLiteral,BlockStatement: Equivalent mutant - '' falls through to regular tool path returning { module: 'claude', tool: '' } either way
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
    // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement: Equivalent mutant - null/undefined pass through isArray/isPlainObject checks unchanged, returning as-is
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
    contextBuilder?:             ContextBuilder
    /** Memory MCP server instance for deep memory access */
    memoryMcpServer?:            McpServerConfig
    /** Discord MCP server instance for message history access */
    discordMcpServer?:           McpServerConfig
    /** Inbox MCP server instance for inbox management */
    inboxMcpServer?:             McpServerConfig
    /** Email MCP server instance for email inbox access */
    emailMcpServer?:             McpServerConfig
    /** Plugins to load (from plugin-loader.ts) */
    plugins?:                    SdkPluginConfig[]
    /** Task persistence coordinator for maintaining tasks across sessions */
    taskPersistenceCoordinator?: TaskPersistenceCoordinator
    /** Claude model to use (defaults to 'sonnet' if not provided; normally set from IsambardMainModel SST secret via config) */
    mainModel?:                  string
}

/** Options for handleInput processing */
export interface HandleInputOptions {
    /** Session ID to resume (for SDK session continuity) */
    sessionId?:       string
    /** Resume context from interrupted processing */
    resumeContext?:   ResumeContext
    /** AbortController for cancellation */
    abortController?: AbortController
    /** Callback for stream events */
    onStreamEvent?:   (event: AgentStreamEvent) => void
    /** Optional images to include in the first message */
    images?:          PlatformImage[]
    /** Special mode for the session (affects tool availability) */
    specialMode?:     'catchup' | 'perching'
    /** Optional catch-up prompt to use instead of building from contexts */
    catchUpPrompt?:   string
    /** Optional perch prompt for autonomous perch time */
    perchPrompt?:     string
    /** Optional list of available channels for system prompt context */
    channelList?:     string[]
    /** Optional context note prepended to the user message (e.g., perch-time interruption notice) */
    contextNote?:     string
}

/** Result from handleInput processing */
export interface HandleInputResult {
    /** Final response text (null if interrupted or error) */
    response:       string | null
    /** Session ID for resuming */
    sessionId?:     string
    /** Whether processing was interrupted */
    wasInterrupted: boolean
    /** Stream tracker with captured progress and background task collection state */
    streamTracker:  StreamTracker
}

export interface ClaudeAgent {
    /**
     * Process multiple messages in batch with interruption support.
     *
     * @param contexts Array of Discord message contexts to process
     * @param options Optional configuration for batch processing
     * @returns Result with final response, interruption status, and stream tracker
     */
    handleInput: (
        contexts: MessageContext[],
        options?: HandleInputOptions
    ) => Promise<HandleInputResult>
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
function buildMcpServers(memoryMcpServer?: McpServerConfig, discordMcpServer?: McpServerConfig, inboxMcpServer?: McpServerConfig, emailMcpServer?: McpServerConfig, specialMode?: 'catchup' | 'perching'): Record<string, McpServerConfig> | undefined {
    if(!memoryMcpServer && !discordMcpServer && !inboxMcpServer && !emailMcpServer) {
        return undefined;
    }

    const servers: Record<string, McpServerConfig> = {};
    if(memoryMcpServer) {
        servers.memory = memoryMcpServer;
    }
    if(discordMcpServer) {
        servers.discord = discordMcpServer;
    }
    if(inboxMcpServer && specialMode === 'catchup') {
        servers.inbox = inboxMcpServer;
    }
    if(emailMcpServer) {
        servers.email = emailMcpServer;
    }
    return servers;
}

/**
 * Builds the allowedTools list based on which MCP servers are configured.
 */
function buildAllowedTools(discordMcpServer?: McpServerConfig, inboxMcpServer?: McpServerConfig, emailMcpServer?: McpServerConfig, specialMode?: 'catchup' | 'perching'): string[] {
    const baseTools = [
        // Memory MCP tools (auto-approved)
        'mcp__memory__*',
        // Read-only and safe tools (auto-approved)
        'Read',
        'Glob',
        'Grep',
        'WebFetch',
        'WebSearch',
        // Task management (new task system)
        'TaskCreate',
        'TaskUpdate',
        'TaskGet',
        'TaskList',
        'EnterPlanMode',
        'ExitPlanMode',
        'Task',
        'TaskOutput',
        'TaskStop',
        // Skills
        'Skill',
        // Bash commands (specific safe commands only)
        'Bash(git:*)',
        'Bash(bun run:*)',
        'Bash(bun test:*)',
        'Bash(bun lint:*)',
        'Bash(bun typecheck)',
        'Bash(ls:*)',
    ];

    const tools = [...baseTools];

    if(discordMcpServer) {
        tools.push('mcp__discord__*');
    }

    if(inboxMcpServer && specialMode === 'catchup') {
        tools.push('mcp__inbox__*');
    }

    if(emailMcpServer) {
        tools.push('mcp__email__*');
    }

    return tools;
}

/**
 * Logs error details from result events in the stream.
 * @param message Stream message to check for errors
 */
// Stryker disable StringLiteral,ObjectLiteral,ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement,ArrayDeclaration: Observability - error logging doesn't affect return value
function logResultErrors(message: { type: string, is_error?: boolean, subtype?: string, errors?: unknown[] }): void {
    if(message.type === 'result' && 'is_error' in message && message.is_error) {
        logger.error({
            subtype: 'subtype' in message ? message.subtype : undefined,
            errors:  'errors' in message ? message.errors : [],
            msg:     'Agent SDK returned error result',
        });
    }
}
// Stryker restore StringLiteral,ObjectLiteral,ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement,ArrayDeclaration

/**
 * Logs error details from assistant events in the stream.
 * @param message Stream message to check for errors
 */
// Stryker disable StringLiteral,ObjectLiteral,ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement: Observability - error logging doesn't affect return value
function logAssistantErrors(message: { type: string, error?: unknown }): void {
    if(message.type === 'assistant' && 'error' in message && message.error) {
        logger.error({
            error: message.error,
            msg:   'Agent SDK assistant message error',
        });
    }
}
// Stryker restore StringLiteral,ObjectLiteral,ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement

/**
 * Logs tool usage from assistant messages with redacted sensitive args.
 * @param message Stream message to extract tool uses from
 */
// Stryker disable StringLiteral,ObjectLiteral: Observability - debug logging doesn't affect return value
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
// Stryker restore StringLiteral,ObjectLiteral

/**
 * Module-level state for tracking pending tool requests by the LLM.
 * Used to correlate user events (tool responses) with the tools that were invoked.
 * Tracks ALL pending tools since multiple tools can be requested in a single turn.
 */
// Stryker disable next-line ArrayDeclaration: Module initialization - resetLogStreamState() is the tested behavior
let pendingToolRequests: string[] = [];

/**
 * Resets the log stream event state for testing purposes.
 */
export function resetLogStreamState(): void {
    pendingToolRequests = [];
}

/**
 * Logs user events - either tool responses or normal message sends.
 * @param _message User stream event (unused - logic based on pendingToolRequests state)
 */
function logUserEvent(_message: AgentStreamEvent): void {
    if(pendingToolRequests.length > 0) {
        // Log all pending tool responses
        for(const toolName of pendingToolRequests) {
            logger.debug({
                eventType: 'tool_response',
                toolName,
                msg:       `Tool result for LLM: ${toolName}`,
            });
        }
        // Clear pending tools after logging
        pendingToolRequests = [];
    } else {
        logger.debug({
            eventType: 'user',
            msg:       'Sending message to Claude LLM',
        });
    }
}

/**
 * Logs assistant events - either tool requests or thinking/responding.
 * @param message Assistant stream event
 */
function logAssistantEvent(message: AgentStreamEvent): void {
    const toolUses = extractToolUses(message);
    if(toolUses.length > 0) {
        // Log each tool request and track for response correlation
        for(const toolUse of toolUses) {
            logger.debug({
                eventType: 'tool_request',
                toolName:  toolUse.name,
                msg:       `LLM requesting tool: ${toolUse.name}`,
            });
            // Track ALL pending tools (not just the last one)
            pendingToolRequests.push(toolUse.name);
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
}

/**
 * Logs tool progress events.
 * @param message Tool progress stream event
 */
function logToolProgressEvent(message: AgentStreamEvent & { tool_name?: string }): void {
    const parsed = parseToolName(message.tool_name);
    logger.debug({
        eventType: 'tool_progress',
        module:    parsed.module,
        tool:      parsed.tool,
        msg:       'Tool execution started',
    });
}

/**
 * Logs tool result events.
 * @param message Tool result stream event
 */
function logToolResultEvent(message: AgentStreamEvent & { tool_name?: string }): void {
    const parsed = parseToolName(message.tool_name);
    logger.debug({
        eventType: 'tool_result',
        module:    parsed.module,
        tool:      parsed.tool,
        msg:       'Tool execution complete',
    });
}

/**
 * Logs system events, particularly compaction boundaries.
 * @param message System stream event
 */
function logSystemEvent(message: AgentStreamEvent): void {
    // Type guard: Only SystemEvent has subtype property
    // Stryker disable next-line ConditionalExpression: Equivalent mutant - message.type === 'system' is always true here (called from switch case 'system')
    if(message.type === 'system' && 'subtype' in message && message.subtype === 'compact_boundary') {
        const compactMessage = message as SDKCompactBoundaryMessage;
        const preTokens = compactMessage.compact_metadata?.pre_tokens;
        const trigger = compactMessage.compact_metadata?.trigger;
        const tokenInfo = preTokens
            ? ` (pre-compaction: ${preTokens.toLocaleString()} tokens)`
            : '';
        logger.info({
            eventType: 'compaction',
            trigger,
            preTokens,
            msg:       `Context compaction completed${tokenInfo}`,
        });
    }
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
export function logStreamEvent(message: AgentStreamEvent): void {
    switch(message.type) {
        case 'user':
            logUserEvent(message);
            break;

        case 'assistant':
            logAssistantEvent(message);
            break;

        case 'tool_progress':
            logToolProgressEvent(message as AgentStreamEvent & { tool_name?: string });
            break;

        case 'tool_result':
            logToolResultEvent(message as AgentStreamEvent & { tool_name?: string });
            break;

        // Stryker disable ConditionalExpression,BlockStatement: Observability - switch case routing and logging don't affect return value
        case 'result': {
            const resultMessage = message as { type: 'result', subtype?: 'success' | 'error_during_execution' | 'error_max_turns' };
            // Stryker disable StringLiteral,ObjectLiteral: Observability - log content doesn't affect return value
            logger.debug({
                eventType: 'result',
                status:    resultMessage.subtype,
                msg:       'Claude LLM stream complete',
            });
            // Stryker restore StringLiteral,ObjectLiteral
            break;
        }
        // Stryker restore ConditionalExpression,BlockStatement

        case 'system':
            logSystemEvent(message);
            break;
    }
}

/**
 * Build user message content for batch processing.
 * Handles resume context, catch-up prompts, perch prompts, and normal message formatting.
 * @param contexts Array of Discord message contexts
 * @param contextBuilder Context builder for loading memories
 * @param timezone Optional user timezone (already loaded)
 * @param resumeContext Optional resume context from interruption
 * @param catchUpPrompt Optional catch-up prompt (used in catch-up mode)
 * @param perchPrompt Optional perch prompt (used in perching mode)
 * @returns Formatted user message text
 */
async function buildUserMessageTextForBatch(
    contexts: MessageContext[],
    contextBuilder: ContextBuilder | undefined,
    timezone?: string,
    resumeContext?: ResumeContext,
    catchUpPrompt?: string,
    perchPrompt?: string
): Promise<string> {
    if(resumeContext) {
        // Use resume prompt when resuming after interruption
        return buildResumePrompt(resumeContext);
    }

    if(catchUpPrompt) {
        // Use catch-up prompt when in catch-up mode
        return catchUpPrompt;
    }

    if(perchPrompt) {
        // Use perch prompt when in perching mode
        return perchPrompt;
    }

    // Build context prefix from memories and events
    const contextPrefix = contextBuilder
        ? await contextBuilder.buildUserMessagePrefix(contexts[0].userId, timezone)
        : '';

    // Format multiple messages with timezone fallback
    const resolvedTz = resolveTimezone(timezone);
    const messageBlocks = _.map(contexts, (ctx) => {
        const timeStr = `${formatLocalDateTime(ctx.timestamp, resolvedTz)} ${resolvedTz} (UTC: ${ctx.timestamp})`;
        return `User @${ctx.userId} in #${ctx.channelId} at ${timeStr}: ${ctx.content}`;
    });

    return contextPrefix + messageBlocks.join('\n\n');
}

/**
 * Build prompt for SDK query as async generator for multimodal support.
 * Creates an async generator yielding a single SDKUserMessage with content blocks (images + text).
 * @param textContent The text content of the message
 * @param images Optional images to include
 * @returns Async generator yielding SDKUserMessage
 */
async function* buildPromptForSdk(
    textContent: string,
    images?: PlatformImage[]
): AsyncGenerator<SDKUserMessage> {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun runtime supports crypto.randomUUID
    const sessionId = crypto.randomUUID();

    const content = hasImages(images)
        ? buildMultimodalContent(textContent, images)
        : textContent;

    // Stryker disable ObjectLiteral,StringLiteral: Protocol constants for Claude SDK
    yield {
        type:    'user',
        message: {
            role: 'user',
            content,
        },
        parent_tool_use_id: null,
        session_id:         sessionId,
    };
    // Stryker restore ObjectLiteral,StringLiteral
}

/**
 * Handles session ID extraction and task persistence setup.
 * @param message Stream message to check for session ID
 * @param taskPersistenceCoordinator Optional coordinator for task copying
 * @param taskPersistenceCompleted Whether persistence has already been performed
 * @returns Object with extracted session ID and whether persistence was completed
 */
async function handleSessionIdExtraction(
    message: unknown,
    taskPersistenceCoordinator: TaskPersistenceCoordinator | undefined,
    taskPersistenceCompleted: boolean
): Promise<{ sessionId?: string, persistenceCompleted: boolean }> {
    const extractedSessionId = extractSessionId(message);
    if(!extractedSessionId) {
        return { sessionId: undefined, persistenceCompleted: taskPersistenceCompleted };
    }

    // IMMEDIATELY copy tasks from previous session when we get the session ID
    // This ensures TaskList calls during the stream see the copied tasks
    if(taskPersistenceCoordinator && !taskPersistenceCompleted) {
        try {
            await taskPersistenceCoordinator.prepareNewSession(extractedSessionId);
        } catch (error) {
            const errorMessage = _.isError(error) ? error.message : String(error);
            logger.warn({ error, sessionId: extractedSessionId }, `Task persistence failed: ${errorMessage}`);
        }
        return { sessionId: extractedSessionId, persistenceCompleted: true };
    }

    return { sessionId: extractedSessionId, persistenceCompleted: taskPersistenceCompleted };
}

/**
 * Processes a single stream message.
 * @param message Stream message to process
 * @param tracker Stream tracker to update
 * @param options Optional batch processing options
 */
function processSingleStreamMessage(
    message: unknown,
    tracker: StreamTracker,
    options?: HandleInputOptions
): void {
    // Update tracker with stream progress
    tracker.update(message as AgentStreamEvent);

    // Log descriptive stream events
    logStreamEvent(message as AgentStreamEvent);

    // Log errors from stream events
    logResultErrors(message as { type: string, is_error?: boolean, subtype?: string, errors?: unknown[] });
    logAssistantErrors(message as { type: string, error?: unknown });
    logToolUsage(message as { type: string, message?: { content?: unknown } });

    // Invoke stream event callback if provided
    if(options?.onStreamEvent) {
        options.onStreamEvent(message as AgentStreamEvent);
    }
}

/**
 * Checks if processing should be aborted.
 * @param options Optional batch processing options
 * @param capturedSessionId Current session ID
 * @returns true if processing should abort, false otherwise
 */
function shouldAbortProcessing(
    options: HandleInputOptions | undefined,
    capturedSessionId: string | undefined
): boolean {
    if(options?.abortController?.signal.aborted) {
        logger.info({
            sessionId: capturedSessionId,
            msg:       'Batch processing interrupted by abort signal',
        });
        return true;
    }
    return false;
}

/**
 * Process stream events from Agent SDK response.
 * Handles session ID extraction, tracker updates, logging, callbacks, and abort checking.
 * @param response Async iterable stream from Agent SDK
 * @param tracker Stream tracker to update with progress
 * @param options Optional batch processing options
 * @param taskPersistenceCoordinator Optional task persistence coordinator for immediate task copying
 * @returns Object with last assistant text and whether processing was interrupted
 */
async function processStreamEvents(
    response: AsyncIterable<unknown>,
    tracker: StreamTracker,
    options?: HandleInputOptions,
    taskPersistenceCoordinator?: TaskPersistenceCoordinator
): Promise<{ lastAssistantText: string, wasInterrupted: boolean, capturedSessionId?: string }> {
    let lastAssistantText = '';
    let wasInterrupted = false;
    let capturedSessionId: string | undefined;
    let taskPersistenceCompleted = false;

    try {
        // Session ID extraction race condition prevention:
        // The session ID is extracted from the first stream event (system init message),
        // which always arrives before any tool_use events. The sequential for-await loop
        // combined with the await on handleSessionIdExtraction() ensures the session ID
        // is always captured and persisted before any tool calls execute. This prevents
        // tool calls from running with an undefined session ID.
        for await (const message of response) {
            // Handle session ID extraction and task persistence
            const { sessionId, persistenceCompleted } = await handleSessionIdExtraction(
                message,
                taskPersistenceCoordinator,
                taskPersistenceCompleted
            );
            if(sessionId) {
                capturedSessionId = sessionId;
                taskPersistenceCompleted = persistenceCompleted;
            }

            // Process the stream message
            processSingleStreamMessage(message, tracker, options);

            // Check for abort signal
            if(shouldAbortProcessing(options, capturedSessionId)) {
                wasInterrupted = true;
                break;
            }

            // Extract assistant text
            const text = extractAssistantText(message as { type: string, message?: { content?: unknown } });
            if(text) {
                lastAssistantText = text;
            }
        }
    } catch (error) {
        // Check for AbortError OR any error when abort signal was triggered
        // The Claude Agent SDK may throw non-standard errors on abort
        if((_.isError(error) && error.name === 'AbortError') || options?.abortController?.signal.aborted) {
            wasInterrupted = true;
            // All abort-signal errors are expected — SDK throws "Operation aborted" (not standard AbortError)
            logger.info({
                sessionId: capturedSessionId,
                msg:       'Batch processing interrupted by abort',
            });
        } else {
            // Re-throw other errors
            throw error;
        }
    }

    return { lastAssistantText, wasInterrupted, capturedSessionId };
}

/**
 * Build query options for Agent SDK.
 * @param mainModel Model name to use for this query
 * @param systemPrompt System prompt with core identity
 * @param memoryMcpServer Memory MCP server configuration
 * @param discordMcpServer Discord MCP server configuration
 * @param inboxMcpServer Inbox MCP server configuration
 * @param emailMcpServer Email MCP server configuration
 * @param plugins Plugin configurations
 * @param options Optional batch processing options
 * @returns Query options object for Agent SDK
 */
function buildQueryOptions(
    mainModel: string,
    systemPrompt: string,
    memoryMcpServer: McpServerConfig | undefined,
    discordMcpServer: McpServerConfig | undefined,
    inboxMcpServer: McpServerConfig | undefined,
    emailMcpServer: McpServerConfig | undefined,
    plugins: SdkPluginConfig[] | undefined,
    options?: HandleInputOptions
) {
    return {
        model:             mainModel,
        systemPrompt,
        tools:             EXPLICIT_TOOLS,
        agents:            EXPLICIT_AGENTS,
        mcpServers:        buildMcpServers(memoryMcpServer, discordMcpServer, inboxMcpServer, emailMcpServer, options?.specialMode),
        plugins:           plugins && plugins.length > 0 ? plugins : undefined,
        permissionMode:    'acceptEdits' as const,
        allowedTools:      buildAllowedTools(discordMcpServer, inboxMcpServer, emailMcpServer, options?.specialMode),
        maxThinkingTokens: 10000,
        // Stryker disable ObjectLiteral,StringLiteral,BooleanLiteral: Configuration values - mutations don't change behavior
        compactionControl: {
            enabled:               true,
            contextTokenThreshold: 150000,
            model:                 'haiku',
            summaryPrompt:         COMPACTION_SUMMARY_PROMPT,
        },
        // Stryker restore ObjectLiteral,StringLiteral,BooleanLiteral
        settingSources:  ['project'] as SettingSource[],
        abortController: options?.abortController,
        ...(options?.sessionId && { resume: options.sessionId }),
        // Stryker disable StringLiteral,ObjectLiteral: Environment config - value doesn't affect test behavior
        env:             {
            ...process.env,
            CLAUDE_CODE_ENABLE_TASKS: 'true',
        },
        // Stryker restore StringLiteral,ObjectLiteral
        // Stryker disable StringLiteral,ObjectLiteral,ConditionalExpression,LogicalOperator,BlockStatement: Observability - stderr logging doesn't affect behavior
        stderr: (data: string) => {
            // SDK writes "Operation aborted" + stack trace to stderr during expected abort
            if(options?.abortController?.signal.aborted && data.includes('Operation aborted')) {
                logger.debug({ stderr: data }, 'Agent SDK stderr (abort)');
            } else {
                logger.error({ stderr: data }, 'Agent SDK stderr');
            }
        },
        // Stryker restore StringLiteral,ObjectLiteral,ConditionalExpression,LogicalOperator,BlockStatement
    };
}

/**
 * Build result object for handleInput.
 * @param lastAssistantText Final response text from assistant
 * @param wasInterrupted Whether processing was interrupted
 * @param capturedSessionId Session ID for resuming
 * @param tracker Stream tracker with captured progress
 * @returns HandleInputResult object
 */
function buildHandleInputResult(
    lastAssistantText: string,
    wasInterrupted: boolean,
    capturedSessionId: string | undefined,
    tracker: StreamTracker
): HandleInputResult {
    return {
        response:      wasInterrupted ? null : (lastAssistantText || null),
        sessionId:     capturedSessionId,
        wasInterrupted,
        streamTracker: tracker,
    };
}

/**
 * Load user timezone for normal message flows.
 * Returns undefined for catch-up/perch/resume flows which use server timezone.
 * @param contextBuilder Context builder with timezone loading capability
 * @param options Handle input options
 * @param contexts Message contexts (may be empty for catch-up/perch)
 * @returns User timezone or undefined
 */
async function loadUserTimezoneForFlow(
    contextBuilder: ContextBuilder | undefined,
    options: HandleInputOptions | undefined,
    contexts: MessageContext[]
): Promise<string | undefined> {
    // Only load user timezone for normal message flows — catch-up/perch/resume use server TZ
    const isNormalFlow = !options?.catchUpPrompt && !options?.perchPrompt && !options?.resumeContext;
    // Stryker disable next-line ConditionalExpression: Equivalent mutant - contexts.length === 0 → false is untestable without also crashing downstream code that accesses contexts[0]
    if(!contextBuilder || !isNormalFlow || contexts.length === 0) {
        return undefined;
    }

    // Stryker disable BlockStatement: Equivalent mutant - catch block with empty body still returns undefined implicitly
    try {
        return await contextBuilder.loadUserTimezone(contexts[0].userId);
    } catch (error) {
        /* Stryker disable StringLiteral,ObjectLiteral: Logging for observability */
        logger.warn({ error, userId: contexts[0].userId }, 'Failed to load user timezone, falling back to server timezone');
        /* Stryker restore StringLiteral,ObjectLiteral */
        return undefined;
    }
    // Stryker restore BlockStatement
}

/**
 * Build prompt for Agent SDK (string for text-only, async generator for images).
 * @param userMessageText Text content of the message
 * @param images Optional images to include
 * @returns String or async generator of SDK messages
 */
function buildPromptForHandleInput(
    userMessageText: string,
    images: PlatformImage[] | undefined
): string | AsyncIterable<SDKUserMessage> {
    return hasImages(images)
        ? buildPromptForSdk(userMessageText, images)
        : userMessageText;
}

/**
 * Clean up session if processing completed without interruption.
 * Fire-and-forget cleanup operation.
 * @param wasInterrupted Whether processing was interrupted
 * @param capturedSessionId Session ID to clean up
 */
function cleanupSessionIfComplete(
    wasInterrupted: boolean,
    capturedSessionId: string | undefined
): void {
    if(!wasInterrupted && capturedSessionId) {
        void cleanupSession(capturedSessionId);
    }
}

/**
 * Build error result for handleInput catch block.
 * Checks for abort signal and returns appropriate result.
 * @param error The caught error
 * @param options Handle input options
 * @param capturedSessionId Session ID if captured
 * @param tracker Stream tracker
 * @param contextCount Number of contexts being processed
 * @returns HandleInputResult for error case
 */
function buildErrorHandleInputResult(
    error: unknown,
    options: HandleInputOptions | undefined,
    capturedSessionId: string | undefined,
    tracker: StreamTracker,
    contextCount: number
): HandleInputResult {
    const errorMessage = _.isError(error) ? error.message : String(error);
    logger.error({ error, contextCount }, `Failed to process batch: ${errorMessage}`);
    // Check abort signal — SDK may throw non-AbortError on abort
    const abortedBySignal = options?.abortController?.signal.aborted ?? false;
    return buildHandleInputResult('', abortedBySignal, capturedSessionId, tracker);
}

/**
 * Result from auto-resume attempt to collect background tasks.
 */
interface AutoResumeResult {
    /** Updated response text (original preserved if resume fails) */
    lastAssistantText: string
    /** Updated session ID (original preserved if resume fails) */
    capturedSessionId: string | undefined
}

/**
 * Attempt to auto-resume a session to collect uncollected background tasks.
 *
 * This function is called when the agent ends its turn with background tasks
 * that were launched but not collected via TaskOutput. It attempts to resume
 * the session with a prompt instructing the agent to collect the results.
 *
 * @param tracker - StreamTracker instance for monitoring the resume
 * @param lastAssistantText - Original response text to preserve on failure
 * @param capturedSessionId - Session ID to resume
 * @param retryableQuery - Retryable query function for Claude API calls
 * @param queryOptions - Query options for the agent
 * @param options - HandleInput options (including abort controller)
 * @param taskPersistenceCoordinator - Task persistence coordinator if available
 * @returns Updated text and sessionId (original values preserved on failure)
 *
 * @remarks
 * - Max 1 auto-resume attempt per handleInput call
 * - Preserves initial response text on failure (try-catch wrapper)
 * - Logs warnings for incomplete collection or errors
 */
async function attemptAutoResume(
    tracker: StreamTracker,
    lastAssistantText: string,
    capturedSessionId: string,
    retryableQuery: typeof import('@anthropic-ai/claude-agent-sdk').query,
    queryOptions: ReturnType<typeof buildQueryOptions>,
    options: HandleInputOptions | undefined,
    taskPersistenceCoordinator: TaskPersistenceCoordinator | undefined
): Promise<AutoResumeResult> {
    /* Stryker disable StringLiteral,ObjectLiteral: Observability - logging for debugging auto-resume */
    logger.warn({
        sessionId: capturedSessionId,
        msg:       'Stream ended with uncollected background tasks, resuming to collect results',
    });
    /* Stryker restore StringLiteral,ObjectLiteral */

    let updatedText = lastAssistantText;
    let updatedSessionId: string | undefined = capturedSessionId;

    // Stryker disable BlockStatement: try-catch wraps resume to preserve initial response on failure
    try {
        const resumeResponse = retryableQuery({
            prompt:  'You launched background tasks but ended your turn without collecting the results. Use the TaskOutput tool to collect the results from each background task you launched, then provide your final response incorporating those results.',
            options: {
                ...queryOptions,
                resume: capturedSessionId,
            },
        });

        const resumeResult = await processStreamEvents(resumeResponse, tracker, options, taskPersistenceCoordinator);

        // Use resumed text if available, otherwise keep original
        if(resumeResult.lastAssistantText) {
            updatedText = resumeResult.lastAssistantText;
        }
        // Stryker disable next-line ConditionalExpression: Defensive guard — resume always returns sessionId in practice
        if(resumeResult.capturedSessionId) {
            updatedSessionId = resumeResult.capturedSessionId;
        }
    } catch (resumeError) {
        /* Stryker disable StringLiteral,ObjectLiteral: Observability - error logging for debugging auto-resume failures */
        const errorMessage = _.isError(resumeError) ? resumeError.message : String(resumeError);
        logger.error({ error: resumeError, sessionId: capturedSessionId }, `Auto-resume failed: ${errorMessage}`);
        /* Stryker restore StringLiteral,ObjectLiteral */
    }
    // Stryker restore BlockStatement

    return { lastAssistantText: updatedText, capturedSessionId: updatedSessionId };
}

/**
 * Collect uncollected background tasks by auto-resuming the session.
 * Iterates up to MAX_AUTO_RESUME_ATTEMPTS times, stopping early if no progress.
 *
 * @param tracker - StreamTracker instance for monitoring background task collection
 * @param lastAssistantText - Current response text to update with resumed text
 * @param capturedSessionId - Session ID to resume (undefined if interrupted or no session)
 * @param wasInterrupted - Whether processing was interrupted
 * @param retryableQuery - Retryable query function for Claude API calls
 * @param resolvedModel - Resolved model name for queries
 * @param systemPrompt - System prompt with core identity
 * @param memoryMcpServer - Memory MCP server configuration
 * @param discordMcpServer - Discord MCP server configuration
 * @param inboxMcpServer - Inbox MCP server configuration
 * @param emailMcpServer - Email MCP server configuration
 * @param plugins - Plugin configurations
 * @param options - HandleInput options (including abort controller)
 * @param taskPersistenceCoordinator - Task persistence coordinator if available
 * @returns Updated lastAssistantText and capturedSessionId
 */
async function collectBackgroundTasks(
    tracker: StreamTracker,
    lastAssistantText: string,
    capturedSessionId: string | undefined,
    wasInterrupted: boolean,
    retryableQuery: typeof import('@anthropic-ai/claude-agent-sdk').query,
    resolvedModel: string,
    systemPrompt: string,
    memoryMcpServer: McpServerConfig | undefined,
    discordMcpServer: McpServerConfig | undefined,
    inboxMcpServer: McpServerConfig | undefined,
    emailMcpServer: McpServerConfig | undefined,
    plugins: SdkPluginConfig[] | undefined,
    options: HandleInputOptions | undefined,
    taskPersistenceCoordinator: TaskPersistenceCoordinator | undefined
): Promise<{ lastAssistantText: string, capturedSessionId: string | undefined }> {
    if(wasInterrupted || !capturedSessionId) {
        return { lastAssistantText, capturedSessionId };
    }

    let updatedText = lastAssistantText;
    let updatedSessionId: string | undefined = capturedSessionId;
    let autoResumeAttempts = 0;

    while(tracker.hasUncollectedBackgroundTasks() && autoResumeAttempts < MAX_AUTO_RESUME_ATTEMPTS) {
        autoResumeAttempts++;
        const uncollectedBefore = tracker.getProgress().uncollectedBackgroundTasks;
        const queryOptions = buildQueryOptions(resolvedModel, systemPrompt, memoryMcpServer, discordMcpServer, inboxMcpServer, emailMcpServer, plugins, options);
        const resumeResult = await attemptAutoResume(
            tracker, updatedText, updatedSessionId,
            retryableQuery, queryOptions, options, taskPersistenceCoordinator
        );
        updatedText = resumeResult.lastAssistantText;
        updatedSessionId = resumeResult.capturedSessionId ?? updatedSessionId;
        // Break if no progress was made (error or agent didn't collect anything)
        if(tracker.getProgress().uncollectedBackgroundTasks >= uncollectedBefore) {
            break;
        }
    }

    return { lastAssistantText: updatedText, capturedSessionId: updatedSessionId };
}

export function createClaudeAgent(options: ClaudeAgentOptions): ClaudeAgent {
    const { contextBuilder, memoryMcpServer, discordMcpServer, inboxMcpServer, emailMcpServer, plugins, taskPersistenceCoordinator, mainModel } = options;
    const resolvedModel = mainModel ?? 'sonnet';

    // Load retry configuration
    const retryConfig = loadRetryConfig();

    // Create retryable query function
    // Stryker disable next-line ObjectLiteral: Retry policy config object is structural, mutations don't affect behavior
    const retryableQuery = createRetryableQuery(query, {
        policy: retryConfig.claude,
    });

    return {
        handleInput: async (
            contexts: MessageContext[],
            options?: HandleInputOptions
        ): Promise<HandleInputResult> => {
            const tracker = new StreamTracker();
            let capturedSessionId: string | undefined;

            try {
                // 1. Load user timezone for user message localization
                const userTimezone = await loadUserTimezoneForFlow(contextBuilder, options, contexts);

                // 2. Build system prompt with core identity and channel list
                const channelList = options?.channelList;
                const systemPrompt = await buildSystemPrompt({ contextBuilder, channelList });

                // 3. Build user message text
                const userMessageText = await buildUserMessageTextForBatch(
                    contexts,
                    contextBuilder,
                    userTimezone,
                    options?.resumeContext,
                    options?.catchUpPrompt,
                    options?.perchPrompt
                );

                // 3.5. Prepend context note if provided
                const finalMessageText = options?.contextNote
                    ? `[${options.contextNote}]\n\n${userMessageText}`
                    : userMessageText;

                // 4. Build prompt (string for text-only, async generator for images or text)
                const prompt = buildPromptForHandleInput(finalMessageText, options?.images);

                // 5. Log start of processing
                logger.info({
                    contextCount: contexts.length,
                    messageIds:   _.map(contexts, 'messageId'),
                    hasImages:    hasImages(options?.images),
                    msg:          'Agent starting batch processing',
                });

                // 6. Query with MCP servers, plugins, and sandboxed execution (with retry)
                const response = retryableQuery({
                    prompt,
                    options: buildQueryOptions(resolvedModel, systemPrompt, memoryMcpServer, discordMcpServer, inboxMcpServer, emailMcpServer, plugins, options),
                });

                // 7. Process stream events and track progress
                const { lastAssistantText: initialText, wasInterrupted: initialInterrupted, capturedSessionId: sessionId }
                    = await processStreamEvents(response, tracker, options, taskPersistenceCoordinator);
                capturedSessionId = sessionId;
                let lastAssistantText = initialText;
                const wasInterrupted = initialInterrupted;

                // 8. Auto-resume: collect background tasks
                const resumeCollected = await collectBackgroundTasks(
                    tracker, lastAssistantText, capturedSessionId, wasInterrupted,
                    retryableQuery, resolvedModel, systemPrompt, memoryMcpServer, discordMcpServer, inboxMcpServer, emailMcpServer, plugins, options, taskPersistenceCoordinator
                );
                lastAssistantText = resumeCollected.lastAssistantText;
                capturedSessionId = resumeCollected.capturedSessionId;

                // 9. Clean up session only on completion (not on interrupt)
                cleanupSessionIfComplete(wasInterrupted, capturedSessionId);

                // 10. Log completion
                /* Stryker disable StringLiteral,ObjectLiteral: Logging for observability */
                logger.info({
                    contextCount:   contexts.length,
                    wasInterrupted,
                    responseLength: lastAssistantText.length,
                    msg:            `Batch processing ${wasInterrupted ? 'interrupted' : 'completed'} (${lastAssistantText.length} chars)`,
                });
                /* Stryker restore StringLiteral,ObjectLiteral */

                // 11. Return result
                return buildHandleInputResult(lastAssistantText, wasInterrupted, capturedSessionId, tracker);
            } catch (error) {
                return buildErrorHandleInputResult(error, options, capturedSessionId, tracker, contexts.length);
            }
        },
    };
}
