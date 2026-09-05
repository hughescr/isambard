/**
 * Tests for {@link createStreamEventLogger}, the per-instance stream-event logger lifted
 * verbatim out of agent.ts so two long-lived sessions never share `pendingToolRequests`
 * correlation state. Also covers {@link createRoleLogger}, the tiny wrapper that stamps a
 * `role` field onto every log call it forwards.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createStreamEventLogger, createRoleLogger } from '../../../src/agent/stream-event-logger';
import type { AgentStreamEvent } from '../../../src/agent/types';
import { mockLogger } from '../../setup';

beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
});

afterEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
});

const userEvent: AgentStreamEvent = { type: 'user', message: { content: 'hi' } };
const assistantToolUseEvent: AgentStreamEvent = {
    type:    'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }] },
};
const assistantTextEvent: AgentStreamEvent = {
    type:    'assistant',
    message: { content: [{ type: 'text', text: 'hello there' }] },
};

describe('createRoleLogger', () => {
    test('stamps role onto every field object passed to debug/info/warn/error', () => {
        const roleLogger = createRoleLogger('perch', mockLogger);

        roleLogger.debug({ msg: 'd' });
        roleLogger.info({ msg: 'i' });
        roleLogger.warn({ msg: 'w' });
        roleLogger.error({ msg: 'e' });

        expect(mockLogger.debug).toHaveBeenCalledWith({ role: 'perch', msg: 'd' });
        expect(mockLogger.info).toHaveBeenCalledWith({ role: 'perch', msg: 'i' });
        expect(mockLogger.warn).toHaveBeenCalledWith({ role: 'perch', msg: 'w' });
        expect(mockLogger.error).toHaveBeenCalledWith({ role: 'perch', msg: 'e' });
    });

    test('defaults to the shared logger when no base is given', () => {
        const roleLogger = createRoleLogger('conversation');
        roleLogger.debug({ msg: 'd' });
        expect(mockLogger.debug).toHaveBeenCalledWith({ role: 'conversation', msg: 'd' });
    });
});

describe('createStreamEventLogger', () => {
    test('defaults to the shared logger with no role stamped', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent(userEvent);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'user',
            msg:       'Sending message to Claude LLM',
        });
    });

    test('logs a tool_request for each tool_use block and tracks it as pending', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent(assistantToolUseEvent);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'tool_request',
            toolName:  'Read',
            msg:       'LLM requesting tool: Read',
        });
    });

    test('a user event after a tool request logs a tool_response and clears pending state', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent(assistantToolUseEvent);
        mockLogger.debug.mockClear();

        streamLogger.logStreamEvent(userEvent);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'tool_response',
            toolName:  'Read',
            msg:       'Tool result for LLM: Read',
        });

        mockLogger.debug.mockClear();
        streamLogger.logStreamEvent(userEvent);
        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'user',
            msg:       'Sending message to Claude LLM',
        });
    });

    test('an assistant event with no tool use logs thinking or responding', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent(assistantTextEvent);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'assistant',
            hasText:   true,
            msg:       'Claude LLM responding',
        });
    });

    test('reset() clears pending tool state', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent(assistantToolUseEvent);
        streamLogger.reset();
        mockLogger.debug.mockClear();

        streamLogger.logStreamEvent(userEvent);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'user',
            msg:       'Sending message to Claude LLM',
        });
    });

    test('two instances keep independent pendingToolRequests', () => {
        const a = createStreamEventLogger();
        const b = createStreamEventLogger();

        a.logStreamEvent(assistantToolUseEvent);
        mockLogger.debug.mockClear();

        // b never saw a tool request, so its next user event must log a plain send, not a's pending tool.
        b.logStreamEvent(userEvent);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'user',
            msg:       'Sending message to Claude LLM',
        });
        expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'tool_response' }));
    });

    test('every log line from a role-tagged instance carries the role field', () => {
        const roleLogger = createRoleLogger('perch', mockLogger);
        const streamLogger = createStreamEventLogger(roleLogger);

        streamLogger.logStreamEvent(assistantToolUseEvent);
        expect(mockLogger.debug).toHaveBeenCalledWith({
            role:      'perch',
            eventType: 'tool_request',
            toolName:  'Read',
            msg:       'LLM requesting tool: Read',
        });

        mockLogger.debug.mockClear();
        streamLogger.logStreamEvent(userEvent);
        expect(mockLogger.debug).toHaveBeenCalledWith({
            role:      'perch',
            eventType: 'tool_response',
            toolName:  'Read',
            msg:       'Tool result for LLM: Read',
        });
    });

    test('tool_progress and tool_result events log with parsed module/tool', () => {
        const streamLogger = createStreamEventLogger();

        streamLogger.logStreamEvent({ type: 'tool_progress', tool_name: 'mcp__memory__search' });
        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'tool_progress',
            module:    'memory',
            tool:      'search',
            msg:       'Tool execution started',
        });

        mockLogger.debug.mockClear();
        streamLogger.logStreamEvent({ type: 'tool_result', tool_name: 'mcp__memory__search' });
        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'tool_result',
            module:    'memory',
            tool:      'search',
            msg:       'Tool execution complete',
        });
    });

    test('a result event logs stream completion at debug', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent({ type: 'result', subtype: 'success' });

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'result',
            status:    'success',
            msg:       'Claude LLM stream complete',
        });
    });

    test('a compact_boundary system event logs compaction completion at info', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent({
            type:             'system',
            subtype:          'compact_boundary',
            compact_metadata: { pre_tokens: 12_345, trigger: 'auto' },
        } as unknown as AgentStreamEvent);

        expect(mockLogger.info).toHaveBeenCalledWith({
            eventType: 'compaction',
            trigger:   'auto',
            preTokens: 12_345,
            msg:       'Context compaction completed (pre-compaction: 12,345 tokens)',
        });
    });
});
