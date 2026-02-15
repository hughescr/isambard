import _ from 'lodash';
import { describe, test, expect } from 'bun:test';
import { buildResumePrompt } from '../../../src/agent/resume-prompt-builder';
import type { ResumeContext } from '../../../src/agent/resume-prompt-builder';
import type { MessageContext } from '../../../src/agent/types';

describe('buildResumePrompt', () => {
    const createBasicMessage = (overrides?: Partial<MessageContext>): MessageContext => ({
        guildId:   'guild_123',
        channelId: 'channel_456',
        userId:    'user_789',
        messageId: 'msg_001',
        content:   'Test message',
        timestamp: '2026-01-16T10:00:00Z',
        botUserId: 'bot_999',
        ...overrides,
    });

    describe('Basic resume prompt with only new message (minimal case)', () => {
        test('should include context update header and new message', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('[CONTEXT UPDATE]');
            expect(result).toContain('A new message arrived while you were processing');
            expect(result).toContain('[New message(s) received:]');
            expect(result).toContain('Time: 2026-01-16T10:00:00Z');
            expect(result).toContain('Channel: #channel_456');
            expect(result).toContain('User: @user_789');
            expect(result).toContain('Content: Test message');
        });

        test('should not include partial thinking section when thinking is empty', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).not.toContain('[Your thinking at the point of interruption:]');
        });

        test('should not include partial response section when text is empty', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).not.toContain('[You were composing this response:]');
        });

        test('should not include pending tool section when pendingToolUse is null', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).not.toContain('[You were about to use tool');
        });
    });

    describe('Resume prompt with partial thinking', () => {
        test('should include partial thinking section when thinking is non-empty', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   'I need to analyze the user\'s request carefully...',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('[Your thinking at the point of interruption:]');
            expect(result).toContain('I need to analyze the user\'s request carefully...');
        });
    });

    describe('Resume prompt with partial text', () => {
        test('should include partial response section when text is non-empty', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       'Sure, I can help you with that. Let me',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('[You were composing this response:]');
            expect(result).toContain('Sure, I can help you with that. Let me');
        });
    });

    describe('Resume prompt with pending tool use', () => {
        test('should include pending tool section when pendingToolUse is present', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:       '',
                    text:           '',
                    pendingToolUse: {
                        type:  'tool_use',
                        id:    'tool_123',
                        name:  'memory_view',
                        input: { path: '/memories/test' },
                    },
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('[You were about to use tool "memory_view"');
            expect(result).toContain('reconsider if this is still appropriate');
        });
    });

    describe('Resume prompt with new events', () => {
        test('should include new events section when newEvents is non-empty', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents: [
                    '- User @user_123 mentioned keyword "deployment"',
                    '- User @user_456 mentioned keyword "production"',
                ],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('[Events that occurred during your processing:]');
            expect(result).toContain('- User @user_123 mentioned keyword "deployment"');
            expect(result).toContain('- User @user_456 mentioned keyword "production"');
        });

        test('should not include events section when newEvents is empty', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            expect(result).not.toContain('[Events that occurred during your processing:]');
        });
    });

    describe('Resume prompt with multiple new messages', () => {
        test('should include all new messages in order', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [
                    createBasicMessage({
                        userId:    'user_001',
                        messageId: 'msg_001',
                        content:   'First message',
                        timestamp: '2026-01-16T10:00:00Z',
                    }),
                    createBasicMessage({
                        userId:    'user_002',
                        messageId: 'msg_002',
                        content:   'Second message',
                        timestamp: '2026-01-16T10:01:00Z',
                    }),
                    createBasicMessage({
                        userId:    'user_003',
                        messageId: 'msg_003',
                        content:   'Third message',
                        timestamp: '2026-01-16T10:02:00Z',
                    }),
                ],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('[New message(s) received:]');
            expect(result).toContain('User: @user_001');
            expect(result).toContain('Content: First message');
            expect(result).toContain('Time: 2026-01-16T10:00:00Z');
            expect(result).toContain('User: @user_002');
            expect(result).toContain('Content: Second message');
            expect(result).toContain('Time: 2026-01-16T10:01:00Z');
            expect(result).toContain('User: @user_003');
            expect(result).toContain('Content: Third message');
            expect(result).toContain('Time: 2026-01-16T10:02:00Z');
        });
    });

    describe('Full resume prompt with all sections', () => {
        test('should include all sections when all data is present', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:       'Let me analyze this request...',
                    text:           'I understand your question. Let me',
                    pendingToolUse: {
                        type:  'tool_use',
                        id:    'tool_xyz',
                        name:  'memory_store',
                        input: { path: '/test', content: 'data' },
                    },
                    sessionId:                  'session_abc',
                    uncollectedBackgroundTasks: 0,
                },
                newEvents: [
                    '- User @user_111 mentioned keyword "urgent"',
                ],
                newMessages: [
                    createBasicMessage({
                        userId:  'user_999',
                        content: 'Actually, can you do this first?',
                    }),
                ],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('[CONTEXT UPDATE]');
            expect(result).toContain('[Your thinking at the point of interruption:]');
            expect(result).toContain('Let me analyze this request...');
            expect(result).toContain('[You were composing this response:]');
            expect(result).toContain('I understand your question. Let me');
            expect(result).toContain('[You were about to use tool "memory_store"');
            expect(result).toContain('[Events that occurred during your processing:]');
            expect(result).toContain('- User @user_111 mentioned keyword "urgent"');
            expect(result).toContain('[New message(s) received:]');
            expect(result).toContain('User: @user_999');
            expect(result).toContain('Content: Actually, can you do this first?');
        });
    });

    describe('Section order', () => {
        test('should present sections in correct order', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:       'Thinking content',
                    text:           'Response content',
                    pendingToolUse: {
                        type:  'tool_use',
                        id:    'tool_1',
                        name:  'test_tool',
                        input: {},
                    },
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   ['- Event 1'],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            // Find indices of each section
            const contextIndex = result.indexOf('[CONTEXT UPDATE]');
            const thinkingIndex = result.indexOf('[Your thinking at the point of interruption:]');
            const responseIndex = result.indexOf('[You were composing this response:]');
            const toolIndex = result.indexOf('[You were about to use tool');
            const eventsIndex = result.indexOf('[Events that occurred during your processing:]');
            const messagesIndex = result.indexOf('[New message(s) received:]');

            // Verify order
            expect(contextIndex).toBeGreaterThan(-1);
            expect(thinkingIndex).toBeGreaterThan(contextIndex);
            expect(responseIndex).toBeGreaterThan(thinkingIndex);
            expect(toolIndex).toBeGreaterThan(responseIndex);
            expect(eventsIndex).toBeGreaterThan(toolIndex);
            expect(messagesIndex).toBeGreaterThan(eventsIndex);
        });
    });

    describe('Section separators', () => {
        test('should use double newline between sections', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   'Thinking content',
                    text:                       'Response content',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   ['- Event 1'],
                newMessages: [createBasicMessage()],
            };

            const result = buildResumePrompt(context);

            // Check for double newlines between sections
            const sections = _.split(result, '\n\n');
            expect(sections.length).toBeGreaterThan(3); // At least header, thinking, response, events, messages
        });
    });

    describe('Timestamp formatting', () => {
        test('should preserve ISO timestamp format', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [
                    createBasicMessage({
                        timestamp: '2026-01-16T14:30:45.123Z',
                    }),
                ],
            };

            const result = buildResumePrompt(context);

            expect(result).toContain('Time: 2026-01-16T14:30:45.123Z');
        });
    });

    describe('Mutant killer tests', () => {
        test('should start output with [CONTEXT UPDATE] (no prefix content)', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [createBasicMessage()],
            };
            const result = buildResumePrompt(context);
            expect(result).toMatch(/^\[CONTEXT UPDATE\]/);  // starts with
        });

        test('should separate multiple events with single newline', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   ['- Event 1', '- Event 2'],
                newMessages: [createBasicMessage()],
            };
            const result = buildResumePrompt(context);
            expect(result).toContain('- Event 1\n- Event 2');
        });

        test('should separate multiple messages with double newline', () => {
            const context: ResumeContext = {
                partialWork: {
                    thinking:                   '',
                    text:                       '',
                    pendingToolUse:             null,
                    sessionId:                  undefined,
                    uncollectedBackgroundTasks: 0,
                },
                newEvents:   [],
                newMessages: [
                    createBasicMessage({ content: 'First' }),
                    createBasicMessage({ content: 'Second' }),
                ],
            };
            const result = buildResumePrompt(context);
            // Each message block ends with Content: X, next starts with Time:
            expect(result).toContain('Content: First\n\nTime:');
        });
    });
});
