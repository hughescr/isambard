/**
 * Per-instance stream-event logger, lifted verbatim out of agent.ts (formerly module-level
 * `pendingToolRequests` state plus the `log*` helpers) so that two concurrent long-lived
 * sessions never share tool-correlation state. agent.ts keeps its exported `logStreamEvent`/
 * `resetLogStreamState` as thin delegates to one module-level instance created here, so the
 * one-shot path and its existing tests are unchanged; `openSession` (./session/session.ts)
 * creates its own instance per session.
 *
 * Also exports {@link createRoleLogger}, a tiny wrapper that stamps a `role` field onto every
 * field object passed to `debug`/`info`/`warn`/`error` — used so every log line the long-lived
 * session core emits carries which of the two concurrent sessions (`conversation`/`perch`) it
 * came from.
 *
 * @module agent/stream-event-logger
 */
import type { SDKCompactBoundaryMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { SessionRole } from './session/types';
import { extractAssistantText, extractToolUses, parseToolName, redactSensitiveArgs } from './stream-extractors';
import type { AgentStreamEvent } from './types';

/**
 * The narrow logging surface {@link createStreamEventLogger} and {@link createRoleLogger} need:
 * each method takes exactly one metadata object, matching this module's (and the rest of the
 * codebase's) `logger.debug({ ...fields, msg: '...' })` convention. The real `@hughescr/logger`
 * `Logger` (and the test double in tests/setup.ts) both satisfy this structurally.
 */
export interface FieldLogger {
    debug: (fields: Record<string, unknown>) => void
    info:  (fields: Record<string, unknown>) => void
    warn:  (fields: Record<string, unknown>) => void
    error: (fields: Record<string, unknown>) => void
}

/**
 * Wraps `base` (defaulting to the shared `@hughescr/logger` logger) so every call stamps
 * `{ role, ...fields }` — the session-role tag every long-lived-session log line must carry.
 * @param role Which session (`conversation`/`perch`) every call through the wrapper belongs to
 * @param base Logger to forward stamped calls to
 * @returns A {@link FieldLogger} that tags every call with `role`
 */
export function createRoleLogger(role: SessionRole, base: FieldLogger = logger): FieldLogger {
    return {
        debug: (fields) => {
            base.debug({ role, ...fields });
        },
        info: (fields) => {
            base.info({ role, ...fields });
        },
        warn: (fields) => {
            base.warn({ role, ...fields });
        },
        error: (fields) => {
            base.error({ role, ...fields });
        },
    };
}

/**
 * Logs error details from result events in the stream. Stateless — used only by the one-shot
 * path (src/agent/agent.ts), which is the sole caller of `processSingleStreamMessage`.
 * @param message Stream message to check for errors
 */
// Stryker disable StringLiteral,ObjectLiteral,ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement,ArrayDeclaration: Observability - error logging doesn't affect return value
export function logResultErrors(message: { type: string, is_error?: boolean, subtype?: string, errors?: unknown[] }): void {
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
 * Logs error details from assistant events in the stream. Stateless — used only by the one-shot
 * path (src/agent/agent.ts).
 * @param message Stream message to check for errors
 */
// Stryker disable StringLiteral,ObjectLiteral,ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement: Observability - error logging doesn't affect return value
export function logAssistantErrors(message: { type: string, error?: unknown }): void {
    if(message.type === 'assistant' && 'error' in message && message.error) {
        logger.error({
            error: message.error,
            msg:   'Agent SDK assistant message error',
        });
    }
}
// Stryker restore StringLiteral,ObjectLiteral,ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement

/**
 * Logs tool usage from assistant messages with redacted sensitive args. Stateless — used only
 * by the one-shot path (src/agent/agent.ts).
 * @param message Stream message to extract tool uses from
 */
// Stryker disable StringLiteral,ObjectLiteral: Observability - debug logging doesn't affect return value
export function logToolUsage(message: { type: string, message?: { content?: unknown } }): void {
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

/** A per-instance stream-event logger: `logStreamEvent` dispatches, `reset` clears pending tool-correlation state. */
export interface StreamEventLogger {
    /**
     * Logs stream events with descriptive messages based on event type.
     *
     * Provides enhanced logging for tool request/response flow:
     * - When assistant event contains tool_use blocks -> logs "LLM requesting tool: {toolName}"
     * - When user event arrives after a tool request -> logs "Tool result for LLM: {lastToolName}"
     * - Keeps existing thinking/responding distinction for non-tool assistant events
     * @param message Stream event to log
     */
    logStreamEvent: (message: AgentStreamEvent) => void
    /** Resets pending tool-correlation state, for testing purposes. */
    reset:          () => void
}

/**
 * Creates a fresh {@link StreamEventLogger} with its own `pendingToolRequests` correlation
 * state, so two concurrent long-lived sessions never share it.
 * @param log Logger to write through; defaults to the shared `@hughescr/logger` logger (no role
 *   stamped) so the one-shot path's existing log output is unchanged. Pass a
 *   {@link createRoleLogger} instance to tag every line with a session role.
 * @returns A fresh {@link StreamEventLogger}
 */
export function createStreamEventLogger(log: FieldLogger = logger): StreamEventLogger {
    /**
     * Tracks pending tool requests by the LLM, for correlating user events (tool responses)
     * with the tools that were invoked. Tracks ALL pending tools since multiple tools can be
     * requested in a single turn.
     */
    // Stryker disable next-line ArrayDeclaration: Module initialization - reset() is the tested behavior
    let pendingToolRequests: string[] = [];

    function logUserEvent(_message: AgentStreamEvent): void {
        if(pendingToolRequests.length > 0) {
            // Log all pending tool responses
            for(const toolName of pendingToolRequests) {
                log.debug({
                    eventType: 'tool_response',
                    toolName,
                    msg:       `Tool result for LLM: ${toolName}`,
                });
            }
            // Clear pending tools after logging
            pendingToolRequests = [];
        } else {
            log.debug({
                eventType: 'user',
                msg:       'Sending message to Claude LLM',
            });
        }
    }

    function logAssistantEvent(message: AgentStreamEvent): void {
        const toolUses = extractToolUses(message);
        if(toolUses.length > 0) {
            // Log each tool request and track for response correlation
            for(const toolUse of toolUses) {
                log.debug({
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
            log.debug({
                eventType: 'assistant',
                hasText,
                msg:       hasText ? 'Claude LLM responding' : 'Claude LLM thinking',
            });
        }
    }

    function logToolProgressEvent(message: AgentStreamEvent & { tool_name?: string }): void {
        const parsed = parseToolName(message.tool_name);
        log.debug({
            eventType: 'tool_progress',
            module:    parsed.module,
            tool:      parsed.tool,
            msg:       'Tool execution started',
        });
    }

    function logToolResultEvent(message: AgentStreamEvent & { tool_name?: string }): void {
        const parsed = parseToolName(message.tool_name);
        log.debug({
            eventType: 'tool_result',
            module:    parsed.module,
            tool:      parsed.tool,
            msg:       'Tool execution complete',
        });
    }

    function logSystemEvent(message: AgentStreamEvent): void {
        // Type guard: Only SystemEvent has subtype property
        // Stryker disable next-line ConditionalExpression: Equivalent mutant - message.type === 'system' is always true here (called from switch case 'system')
        if(message.type === 'system' && 'subtype' in message && message.subtype === 'compact_boundary') {
            const compactMessage = message as SDKCompactBoundaryMessage;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: compact_metadata may be absent in older SDK versions despite types
            const preTokens = compactMessage.compact_metadata?.pre_tokens;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: compact_metadata may be absent in older SDK versions despite types
            const trigger = compactMessage.compact_metadata?.trigger;
            const tokenInfo = preTokens
                ? ` (pre-compaction: ${preTokens.toLocaleString()} tokens)`
                : '';
            log.info({
                eventType: 'compaction',
                trigger,
                preTokens,
                msg:       `Context compaction completed${tokenInfo}`,
            });
        }
    }

    function logStreamEvent(message: AgentStreamEvent): void {
        switch(message.type) {
            case 'user': {
                logUserEvent(message);
                break;
            }

            case 'assistant': {
                logAssistantEvent(message);
                break;
            }

            case 'tool_progress': {
                logToolProgressEvent(message);
                break;
            }

            case 'tool_result': {
                logToolResultEvent(message);
                break;
            }

            // Stryker disable ConditionalExpression,BlockStatement: Observability - switch case routing and logging don't affect return value
            case 'result': {
                const resultMessage = message as { type: 'result', subtype?: 'success' | 'error_during_execution' | 'error_max_turns' };
                // Stryker disable StringLiteral,ObjectLiteral: Observability - log content doesn't affect return value
                log.debug({
                    eventType: 'result',
                    status:    resultMessage.subtype,
                    msg:       'Claude LLM stream complete',
                });
                // Stryker restore StringLiteral,ObjectLiteral
                break;
            }
            // Stryker restore ConditionalExpression,BlockStatement

            case 'system': {
                logSystemEvent(message);
                break;
            }
        }
    }

    function reset(): void {
        pendingToolRequests = [];
    }

    return { logStreamEvent, reset };
}
