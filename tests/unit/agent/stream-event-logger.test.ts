/**
 * Tests for {@link createStreamEventLogger}, the per-instance stream-event logger lifted
 * verbatim out of agent.ts so two long-lived sessions never share `pendingToolRequests`
 * correlation state. Also covers {@link createRoleLogger}, the tiny wrapper that stamps a
 * `role` field onto every log call it forwards.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createStreamEventLogger, createRoleLogger, logAssistantErrors, logResultErrors, logToolUsage } from '../../../src/agent/stream-event-logger';
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

describe('one-shot stream log helpers', () => {
    test('logs result errors with their subtype and errors', () => {
        const errors = [new Error('failed')];

        logResultErrors({ type: 'result', is_error: true, subtype: 'error_max_turns', errors });

        expect(mockLogger.error).toHaveBeenCalledWith({
            subtype: 'error_max_turns',
            errors,
            msg:     'Agent SDK returned error result',
        });
    });

    test('only result frames marked as errors produce a result error log', () => {
        logResultErrors({ type: 'assistant', is_error: true, errors: ['wrong frame'] });
        logResultErrors({ type: 'result', is_error: false, errors: ['success'] });
        logResultErrors({ type: 'result', errors: ['unmarked'] });
        expect(mockLogger.error).not.toHaveBeenCalled();

        logResultErrors({ type: 'result', is_error: true });
        expect(mockLogger.error).toHaveBeenCalledWith({
            subtype: undefined,
            errors:  [],
            msg:     'Agent SDK returned error result',
        });
    });

    test('logs assistant errors', () => {
        const error = new Error('assistant failed');

        logAssistantErrors({ type: 'assistant', error });

        expect(mockLogger.error).toHaveBeenCalledWith({
            error,
            msg: 'Agent SDK assistant message error',
        });
    });

    test('only assistant frames with an error produce an assistant error log', () => {
        logAssistantErrors({ type: 'result', error: 'wrong frame' });
        logAssistantErrors({ type: 'assistant' });
        logAssistantErrors({ type: 'assistant', error: null });
        expect(mockLogger.error).not.toHaveBeenCalled();
    });

    test('logs every one-shot tool use', () => {
        logToolUsage({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', name: 'mcp__memory__view', input: { path: '/state' } }] },
        });

        expect(mockLogger.debug).toHaveBeenCalledWith({
            module: 'memory',
            tool:   'view',
            args:   { path: '/state' },
        });
    });
});

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

    test('an assistant event without text logs thinking', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'thinking', thinking: 'working' }] },
        } as unknown as AgentStreamEvent);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'assistant',
            hasText:   false,
            msg:       'Claude LLM thinking',
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

    test('an older compact_boundary without compact metadata still logs safely', () => {
        const streamLogger = createStreamEventLogger();
        const legacyFrame: AgentStreamEvent = {
            type:    'system',
            subtype: 'compact_boundary',
        };

        streamLogger.logStreamEvent(legacyFrame);

        expect(mockLogger.info).toHaveBeenCalledWith({
            eventType: 'compaction',
            trigger:   undefined,
            preTokens: undefined,
            msg:       'Context compaction completed',
        });
    });

    test('ordinary system events do not report a compaction', () => {
        const streamLogger = createStreamEventLogger();
        streamLogger.logStreamEvent({ type: 'system', subtype: 'init' });
        expect(mockLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'compaction' }));
    });
});
