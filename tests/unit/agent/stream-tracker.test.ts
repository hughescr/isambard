import { describe, test, expect, beforeEach } from 'bun:test';
import { StreamTracker } from '../../../src/agent/stream-tracker';
import type { AgentStreamEvent, AssistantEvent, SystemEvent } from '../../../src/agent/types';

describe('StreamTracker', () => {
    let tracker: StreamTracker;

    beforeEach(() => {
        tracker = new StreamTracker();
    });

    describe('Initial state', () => {
        test('should start with empty thinking', () => {
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
        });

        test('should start with empty text', () => {
            const progress = tracker.getProgress();
            expect(progress.text).toBe('');
        });

        test('should start with null pendingToolUse', () => {
            const progress = tracker.getProgress();
            expect(progress.pendingToolUse).toBeNull();
        });

        test('should start with undefined sessionId', () => {
            const progress = tracker.getProgress();
            expect(progress.sessionId).toBeUndefined();
        });
    });

    describe('update with assistant events', () => {
        test('should extract text content from assistant event', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Hello world' },
                    ],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.text).toBe('Hello world');
        });

        test('should extract thinking content from assistant event', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'Let me think about this...' },
                    ],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('Let me think about this...');
        });

        test('should extract tool_use blocks from assistant event', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_123',
                            name:  'memory_view',
                            input: { path: '/memories/test' },
                        },
                    ],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.pendingToolUse).toEqual({
                type:  'tool_use',
                id:    'tool_123',
                name:  'memory_view',
                input: { path: '/memories/test' },
            });
        });

        test('should handle assistant event with multiple content types', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'First thought' },
                        { type: 'text', text: 'Response text' },
                        {
                            type:  'tool_use',
                            id:    'tool_456',
                            name:  'memory_store',
                            input: { path: '/memories/new', content: 'data' },
                        },
                    ],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('First thought');
            expect(progress.text).toBe('Response text');
            expect(progress.pendingToolUse).toEqual({
                type:  'tool_use',
                id:    'tool_456',
                name:  'memory_store',
                input: { path: '/memories/new', content: 'data' },
            });
        });

        test('should capture the LAST tool_use when multiple tool_use blocks present', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_first',
                            name:  'first_tool',
                            input: { arg: 'first' },
                        },
                        {
                            type:  'tool_use',
                            id:    'tool_last',
                            name:  'last_tool',
                            input: { arg: 'last' },
                        },
                    ],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.pendingToolUse).toEqual({
                type:  'tool_use',
                id:    'tool_last',
                name:  'last_tool',
                input: { arg: 'last' },
            });
        });
    });

    describe('update with system events', () => {
        test('should extract sessionId from system init event', () => {
            const event: SystemEvent = {
                type:       'system',
                subtype:    'init',
                session_id: 'session_abc123',
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.sessionId).toBe('session_abc123');
        });

        test('should not update sessionId for non-init system events', () => {
            const event: SystemEvent = {
                type:    'system',
                subtype: 'status',
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.sessionId).toBeUndefined();
        });
    });

    describe('Multiple updates (accumulation)', () => {
        test('should replace thinking with latest thinking content', () => {
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [{ type: 'thinking', text: 'First thought' }],
                },
            };
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [{ type: 'thinking', text: 'Latest thought' }],
                },
            };

            tracker.update(event1);
            tracker.update(event2);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('Latest thought');
        });

        test('should replace text with latest text content', () => {
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [{ type: 'text', text: 'First text' }],
                },
            };
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [{ type: 'text', text: 'Latest text' }],
                },
            };

            tracker.update(event1);
            tracker.update(event2);
            const progress = tracker.getProgress();
            expect(progress.text).toBe('Latest text');
        });

        test('should replace pendingToolUse with latest tool_use block', () => {
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_old',
                            name:  'old_tool',
                            input: { old: 'value' },
                        },
                    ],
                },
            };
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_new',
                            name:  'new_tool',
                            input: { 'new': 'value' },
                        },
                    ],
                },
            };

            tracker.update(event1);
            tracker.update(event2);
            const progress = tracker.getProgress();
            expect(progress.pendingToolUse).toEqual({
                type:  'tool_use',
                id:    'tool_new',
                name:  'new_tool',
                input: { 'new': 'value' },
            });
        });

        test('should persist sessionId after initial capture', () => {
            const systemEvent: SystemEvent = {
                type:       'system',
                subtype:    'init',
                session_id: 'session_persistent',
            };
            const assistantEvent: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [{ type: 'text', text: 'Some text' }],
                },
            };

            tracker.update(systemEvent);
            tracker.update(assistantEvent);
            const progress = tracker.getProgress();
            expect(progress.sessionId).toBe('session_persistent');
        });

        test('should handle empty assistant event (no content to extract)', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            // Empty event should set empty strings but not null/undefined
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('');
            expect(progress.pendingToolUse).toBeNull();
        });
    });

    describe('reset', () => {
        test('should clear all accumulated state', () => {
            // First, set up some state
            const assistantEvent: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'Some thinking' },
                        { type: 'text', text: 'Some text' },
                        {
                            type:  'tool_use',
                            id:    'tool_123',
                            name:  'some_tool',
                            input: { arg: 'value' },
                        },
                    ],
                },
            };
            const systemEvent: SystemEvent = {
                type:       'system',
                subtype:    'init',
                session_id: 'session_xyz',
            };

            tracker.update(assistantEvent);
            tracker.update(systemEvent);

            // Verify state was set
            let progress = tracker.getProgress();
            expect(progress.thinking).toBe('Some thinking');
            expect(progress.text).toBe('Some text');
            expect(progress.pendingToolUse).not.toBeNull();
            expect(progress.sessionId).toBe('session_xyz');

            // Now reset
            tracker.reset();

            // Verify all state is cleared
            progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('');
            expect(progress.pendingToolUse).toBeNull();
            expect(progress.sessionId).toBeUndefined();
        });
    });

    describe('getProgress immutability', () => {
        test('should return a copy, not the internal object', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [{ type: 'text', text: 'Original text' }],
                },
            };

            tracker.update(event);
            const progress1 = tracker.getProgress();
            const progress2 = tracker.getProgress();

            // Should be different object instances
            expect(progress1).not.toBe(progress2);
            // But should have the same values
            expect(progress1).toEqual(progress2);
        });

        test('should not allow external mutation of internal state', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [{ type: 'text', text: 'Original text' }],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();

            // Mutate the returned object
            progress.text = 'Mutated text';
            progress.thinking = 'Mutated thinking';
            progress.sessionId = 'mutated_session';

            // Internal state should remain unchanged
            const freshProgress = tracker.getProgress();
            expect(freshProgress.text).toBe('Original text');
            expect(freshProgress.thinking).toBe('');
            expect(freshProgress.sessionId).toBeUndefined();
        });
    });

    describe('Non-assistant/system events', () => {
        test('should ignore user events', () => {
            const event: AgentStreamEvent = {
                type:    'user',
                message: { content: 'User message' },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('');
            expect(progress.pendingToolUse).toBeNull();
        });

        test('should ignore tool_progress events', () => {
            const event: AgentStreamEvent = {
                type:      'tool_progress',
                tool_name: 'some_tool',
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('');
            expect(progress.pendingToolUse).toBeNull();
        });

        test('should ignore tool_result events', () => {
            const event: AgentStreamEvent = {
                type:      'tool_result',
                tool_name: 'some_tool',
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('');
            expect(progress.pendingToolUse).toBeNull();
        });

        test('should ignore result events', () => {
            const event: AgentStreamEvent = {
                type:    'result',
                subtype: 'success',
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('');
            expect(progress.pendingToolUse).toBeNull();
        });
    });

    describe('Edge cases and clearing behavior', () => {
        test('should trim whitespace from extracted text', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: '  Hello world  ' },
                    ],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.text).toBe('Hello world');
        });

        test('should join multiple text blocks with newlines', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'First line' },
                        { type: 'text', text: 'Second line' },
                        { type: 'text', text: 'Third line' },
                    ],
                },
            };

            tracker.update(event);
            const progress = tracker.getProgress();
            expect(progress.text).toBe('First line\nSecond line\nThird line');
        });

        test('should clear thinking when message has content but no thinking', () => {
            // First, set thinking
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'Previous thinking' },
                    ],
                },
            };
            tracker.update(event1);
            expect(tracker.getProgress().thinking).toBe('Previous thinking');

            // Then send message with content but no thinking
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Just text now' },
                    ],
                },
            };
            tracker.update(event2);
            const progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('Just text now');
        });

        test('should clear text when message has content but no text', () => {
            // First, set text
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Previous text' },
                    ],
                },
            };
            tracker.update(event1);
            expect(tracker.getProgress().text).toBe('Previous text');

            // Then send message with content but no text
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'Just thinking now' },
                    ],
                },
            };
            tracker.update(event2);
            const progress = tracker.getProgress();
            expect(progress.text).toBe('');
            expect(progress.thinking).toBe('Just thinking now');
        });

        test('should clear pendingToolUse when message has content but no tool_use', () => {
            // First, set pendingToolUse
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_old',
                            name:  'old_tool',
                            input: { arg: 'value' },
                        },
                    ],
                },
            };
            tracker.update(event1);
            expect(tracker.getProgress().pendingToolUse).not.toBeNull();

            // Then send message with content but no tool_use
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Just text now' },
                    ],
                },
            };
            tracker.update(event2);
            const progress = tracker.getProgress();
            expect(progress.pendingToolUse).toBeNull();
            expect(progress.text).toBe('Just text now');
        });

        test('should not set pendingToolUse when toolUses array is empty', () => {
            // First, set pendingToolUse
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_123',
                            name:  'some_tool',
                            input: { arg: 'value' },
                        },
                    ],
                },
            };
            tracker.update(event1);
            expect(tracker.getProgress().pendingToolUse).not.toBeNull();

            // Then send assistant message with no content (empty array)
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [],
                },
            };
            tracker.update(event2);
            const progress = tracker.getProgress();
            // Empty content should clear pendingToolUse
            expect(progress.pendingToolUse).toBeNull();
        });

        test('should preserve pendingToolUse when assistant message has no content property', () => {
            // First, set pendingToolUse
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_123',
                            name:  'some_tool',
                            input: { arg: 'value' },
                        },
                    ],
                },
            };
            tracker.update(event1);
            expect(tracker.getProgress().pendingToolUse).not.toBeNull();

            // Then send assistant message with no content property at all
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {},
            };
            tracker.update(event2);
            const progress = tracker.getProgress();
            // Should preserve pendingToolUse since there's no content to indicate it should be cleared
            expect(progress.pendingToolUse).not.toBeNull();
            expect(progress.pendingToolUse?.id).toBe('tool_123');
        });

        test('should preserve thinking when assistant message has no content property', () => {
            // First, set thinking
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'Previous thinking' },
                    ],
                },
            };
            tracker.update(event1);
            expect(tracker.getProgress().thinking).toBe('Previous thinking');

            // Then send assistant message with no content property at all
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {},
            };
            tracker.update(event2);
            const progress = tracker.getProgress();
            // Should preserve thinking since there's no content to indicate it should be cleared
            expect(progress.thinking).toBe('Previous thinking');
        });

        test('should preserve text when assistant message has no content property', () => {
            // First, set text
            const event1: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Previous text' },
                    ],
                },
            };
            tracker.update(event1);
            expect(tracker.getProgress().text).toBe('Previous text');

            // Then send assistant message with no content property at all
            const event2: AssistantEvent = {
                type:    'assistant',
                message: {},
            };
            tracker.update(event2);
            const progress = tracker.getProgress();
            // Should preserve text since there's no content to indicate it should be cleared
            expect(progress.text).toBe('Previous text');
        });
    });
});
