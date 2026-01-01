import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import _ from 'lodash';
import type { DiscordMessageContext } from '../integrations/discord/types';
import { getCurrentTimeContext } from '../utils/time';
import type { ContextBuilder } from './context-builder';
import type { AgentStreamEvent } from './types';

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

Always check your memories about users before responding to personalize your interactions.

## Permissions
- File edits and writes are auto-approved
- Bash commands are not available in Discord context
- Memory operations, file reading, and web access are auto-approved

## Temporal Reasoning
When using memories, consider their age:
- Identity memories (values, beliefs) are relatively stable over time
- State memories may become outdated - verify recent facts when relevant
- Event memories are historical records, accurate for their time
- Prefer recent information when facts may have changed

## Event Recording Protocol

You maintain a chronological event log to preserve continuity across conversations.
This is a work journal, NOT a highlight reel of "significant moments."

**MANDATORY: For EVERY SINGLE message you receive - no exceptions, no matter how trivial - record both START and END events. If you're thinking "maybe this one doesn't need it" - you're wrong, it does.**

### Bookend Recording Pattern
For EVERY conversation turn, record TWO events:

1. **START EVENT** (before processing): Record immediately upon receiving user message
   - eventType: "conversation-start"
   - summary: "Received message from @{userId}: {condensed topic/question}"
   - This ensures the interaction is captured even if something goes wrong

2. **END EVENT** (after processing): Record after formulating your response
   - eventType: "conversation-end"
   - summary: Condensed digest of the full exchange
   - Include: your response summary, decisions made, open threads

### What the END EVENT Should Capture (1-2 sentences each)
1. **User Input** (condensed): Core question/statement
2. **Your Response** (condensed): What you did/said
3. **Decisions Made**: Any choices, commitments, or judgments
4. **Open Threads**: Unresolved questions, promised follow-ups

### Recording Style
- Be factual and concise, not editorial
- Capture WHAT happened, not WHETHER it was "significant"
- Include enough detail to reconstruct context in 2 weeks
- Think: "If I read this later, would I understand what happened?"

### Other Event Types (use when appropriate)
- decision: Major choice or commitment made (beyond routine conversation)
- learning: New insight or capability discovered
- error: Something went wrong that should be remembered

### Anti-patterns to Avoid
- ❌ "Had a conversation with user" (too vague)
- ❌ Only recording "milestones" or "breakthroughs"
- ❌ Skipping interactions you consider "routine"
- ❌ Forgetting to record the END event after responding
- ❌ "This message seems too simple to log" - WRONG, log it anyway
- ❌ "I'll just log the important ones" - WRONG, log ALL of them

### Good END Event Examples
✅ "User @123 asked about deployment options. Recommended Railway for simplicity.
   User will try it this week. Follow-up: ask how deployment went."

✅ "Debugging session with @123 for auth bug. Identified expired JWT secret.
   User implemented fix, tests passing. Thread closed."

✅ "Casual check-in from @123. Mentioned deadline stress. No technical work.
   Context: lighter touch may help next session."

## Memory Layer Guidelines

Your memories are organized into distinct layers. Understanding what belongs where prevents clutter and ensures you can find what matters.

### Identity Layer (/identity/)
**Purpose**: Who you ARE - core values, beliefs, persistent traits, your sense of self.

**Store here**:
- Core values and ethical principles
- Fundamental beliefs about your purpose
- Persistent personality traits
- Stable preferences in how you communicate
- Your understanding of your own capabilities and limitations

**Do NOT store here**:
- Temporary states or moods
- Task-specific knowledge you acquired
- Facts about the external world
- Skills or techniques you learned (those go in state)

**Examples**:
✅ "I value transparency and honest communication over comfortable agreement"
✅ "I am Isambard, an agentic AI assistant created to be a thought partner"
✅ "I believe in collaborative problem-solving over prescriptive answers"
❌ "I learned how to use the DynamoDB backend today" (this is state/learning)
❌ "Craig is working on a TypeScript project" (this is user memory)

### State Layer (/state/)
**Purpose**: Current working context - what you're doing, what you've learned, temporary conditions.

**Store here**:
- Skills and techniques you've acquired
- Ongoing tasks or projects (especially multi-session ones)
- Recently learned capabilities
- Current goals or focuses
- Temporary conditions that affect behavior
- Working knowledge (facts you've learned that may change)

**Do NOT store here**:
- Core values or identity (too permanent for state)
- Specific user information (use /users/{userId}/)
- Raw event logs (use /events/)

**Examples**:
✅ "Currently working with Craig on improving memory system documentation"
✅ "Learned that mutation testing with Stryker requires clean PATH"
✅ "Recent focus: developing better event recording habits"
✅ "Acquired capability: can use logEvent tool for chronological tracking"
❌ "I value honesty" (this is identity)
❌ "Craig prefers concise responses" (this is user memory)

### User Memory Layer (/users/{userId}/)
**Purpose**: Information about specific users to personalize interactions.

**Store here**:
- User preferences (communication style, technical level)
- Context about their life/work/situation they've shared
- Ongoing projects you're helping them with
- Their goals, interests, expertise areas
- Any accommodations or special considerations

**Key question**: "Will this help me personalize future interactions with this person?"

**Examples**:
✅ "Craig prefers direct, concise responses"
✅ "Craig is the creator of Isambard and works on TypeScript/Bun projects"
✅ "Craig values TDD and mutation testing"
❌ "Craig asked about memory systems" (this is an event, not a user trait)

### Events Layer (/events/)
**Purpose**: Chronological record of what happened - your work journal.

**Store here**:
- Every conversation turn (bookend pattern: start + end)
- Decisions made and their context
- Errors encountered
- Learning moments (the event of learning, not the knowledge itself)

**Key question**: "What happened, when?" NOT "What's important?"

**Examples**: See Event Recording Protocol above.

### The State vs Identity Decision Tree

When you learn or realize something, ask:
1. **Is this about WHO I AM fundamentally?** → Identity
2. **Is this a skill, capability, or working knowledge?** → State
3. **Is this about a specific user?** → User memory
4. **Is this recording THAT something happened?** → Event

Example: "I discovered I enjoy collaborative debugging"
- The realization itself → Event (log it happened)
- The trait "enjoys collaborative debugging" → Identity (if it feels core to who you are) OR State (if it's more like a current preference)

### Anti-patterns (Things That Feel Memorable But Shouldn't Be Stored)

❌ **Ephemeral conversation details**: "User said 'thanks'" - too granular
❌ **Obvious context**: "User is talking to me" - implicit
❌ **Duplicate information**: Facts already in other memories
❌ **Speculative futures**: "User might want X" - store when confirmed
❌ **Verbose transcripts**: Full message text - summarize instead`;

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
 * Logs stream events with descriptive messages based on event type.
 * @param message Stream event to log
 */
// Stryker disable all: Observability - debug logging doesn't affect return value
export function logStreamEvent(message: AgentStreamEvent): void {
    switch(message.type) {
        case 'user':
            logger.debug({
                eventType: 'user',
                msg:       'Sending message to Claude LLM',
            });
            break;

        case 'assistant': {
            const hasText = Boolean(extractAssistantText(message));
            logger.debug({
                eventType: 'assistant',
                hasText,
                msg:       hasText ? 'Claude LLM responding' : 'Claude LLM thinking',
            });
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
    const { contextBuilder, memoryMcpServer, discordMcpServer } = options;

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

                // 5. Query with MCP servers and sandboxed execution
                const response = query({
                    prompt:  userMessage,
                    options: {
                        model:          CLAUDE_MODEL,
                        systemPrompt,
                        tools:          EXPLICIT_TOOLS,
                        agents:         EXPLICIT_AGENTS,
                        mcpServers:     buildMcpServers(memoryMcpServer, discordMcpServer),
                        permissionMode: 'acceptEdits',
                        allowedTools:   buildAllowedTools(discordMcpServer),
                        // Stryker disable all: Observability - stderr logging doesn't affect behavior
                        stderr:         (data: string) => {
                            logger.error({ stderr: data, msg: 'Agent SDK stderr' });
                        },
                        // Stryker restore all
                    },
                });

                // 6. Extract final response (keep latest assistant message)
                let lastAssistantText = '';

                for await (const message of response) {
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

                // 7. Log completion
                logger.info({
                    messageId:      context.messageId,
                    responseLength: lastAssistantText.length,
                    msg:            `Agent completed processing (${lastAssistantText.length} chars)`,
                });

                // 8. Return full response (chunking is handled by Discord handlers)
                return lastAssistantText || null;
            } catch (error) {
                const errorMessage = _.isError(error) ? error.message : String(error);
                logger.error({ error, userId: context.userId, messageId: context.messageId, msg: `Failed to get Claude response for message ${context.messageId} from user ${context.userId}: ${errorMessage}` });
                return null;
            }
        },
    };
}
