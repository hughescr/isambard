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

    describe('Background task tracking', () => {
        describe('Initial state', () => {
            test('hasUncollectedBackgroundTasks() should return false initially', () => {
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('getProgress().uncollectedBackgroundTasks should be false initially', () => {
                const progress = tracker.getProgress();
                expect(progress.uncollectedBackgroundTasks).toBe(false);
            });
        });

        describe('Background task launch detection', () => {
            test('should increment count when Task tool with run_in_background: true is used', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_123',
                                name:  'Task',
                                input: { description: 'test', prompt: 'do something', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(event);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(true);
            });

            test('should NOT increment for Task tool WITHOUT run_in_background', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_123',
                                name:  'Task',
                                input: { description: 'test', prompt: 'do something', subagent_type: 'general-purpose' },
                            },
                        ],
                    },
                };

                tracker.update(event);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(false);
            });

            test('should NOT increment for Task tool with run_in_background: false', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_123',
                                name:  'Task',
                                input: { description: 'test', prompt: 'do something', subagent_type: 'general-purpose', run_in_background: false },
                            },
                        ],
                    },
                };

                tracker.update(event);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(false);
            });

            test('should NOT increment for non-Task tool_use blocks', () => {
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
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(false);
            });

            test('should not count non-Task tool_use as background task launch even with run_in_background flag', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_read1',
                                name:  'Read',
                                input: { file_path: '/some/file', run_in_background: true },
                            },
                        ],
                    },
                };
                tracker.update(event);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should not throw and not count when Task tool_use has null input', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_task_null',
                                name:  'Task',
                                input: null,
                            },
                        ],
                    },
                };
                expect(() => tracker.update(event)).not.toThrow();
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should handle multiple background task launches in same event', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                            {
                                type:  'tool_use',
                                id:    'tool_2',
                                name:  'Task',
                                input: { description: 'task 2', prompt: 'do task 2', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(event);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });
        });

        describe('TaskOutput detection', () => {
            test('should increment count when TaskOutput tool is used', () => {
                // First, launch a background task
                const launchEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };
                tracker.update(launchEvent);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                // Now collect it
                const outputEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_2',
                                name:  'TaskOutput',
                                input: { task_id: 'task_1' },
                            },
                        ],
                    },
                };
                tracker.update(outputEvent);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should NOT increment for non-TaskOutput tools', () => {
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
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });
        });

        describe('hasUncollectedBackgroundTasks() logic', () => {
            test('should return true when launches > outputs (1 launch, 0 outputs)', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(event);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('should return false when launches == outputs (1 launch, 1 output)', () => {
                const launchEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };
                const outputEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_2',
                                name:  'TaskOutput',
                                input: { task_id: 'task_1' },
                            },
                        ],
                    },
                };

                tracker.update(launchEvent);
                tracker.update(outputEvent);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should return false when launches < outputs (edge case)', () => {
                // This edge case can happen if we call TaskOutput more times than launches
                // (e.g., after a reset, or if the stream is interrupted)
                const outputEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'TaskOutput',
                                input: { task_id: 'task_1' },
                            },
                        ],
                    },
                };

                tracker.update(outputEvent);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should return false when both are 0', () => {
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });
        });

        describe('getProgress() includes uncollectedBackgroundTasks', () => {
            test('should include uncollectedBackgroundTasks in progress object', () => {
                const progress = tracker.getProgress();
                expect(progress).toHaveProperty('uncollectedBackgroundTasks');
            });

            test('should reflect correct state (true when tasks uncollected)', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(event);
                const progress = tracker.getProgress();
                expect(progress.uncollectedBackgroundTasks).toBe(true);
            });

            test('should reflect correct state (false when tasks collected)', () => {
                const launchEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };
                const outputEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_2',
                                name:  'TaskOutput',
                                input: { task_id: 'task_1' },
                            },
                        ],
                    },
                };

                tracker.update(launchEvent);
                tracker.update(outputEvent);
                const progress = tracker.getProgress();
                expect(progress.uncollectedBackgroundTasks).toBe(false);
            });
        });

        describe('Reset behavior', () => {
            test('should reset counters to 0', () => {
                const launchEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(launchEvent);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                tracker.reset();
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should return false for hasUncollectedBackgroundTasks() after reset', () => {
                const launchEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(launchEvent);
                tracker.reset();

                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(false);
            });
        });

        describe('Accumulation across events', () => {
            test('should accumulate multiple launches across separate events', () => {
                const event1: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
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
                                id:    'tool_2',
                                name:  'Task',
                                input: { description: 'task 2', prompt: 'do task 2', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(event1);
                tracker.update(event2);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('should accumulate multiple outputs across separate events', () => {
                const launch1: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };
                const launch2: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_2',
                                name:  'Task',
                                input: { description: 'task 2', prompt: 'do task 2', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };
                const output1: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_3',
                                name:  'TaskOutput',
                                input: { task_id: 'task_1' },
                            },
                        ],
                    },
                };
                const output2: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_4',
                                name:  'TaskOutput',
                                input: { task_id: 'task_2' },
                            },
                        ],
                    },
                };

                tracker.update(launch1);
                tracker.update(launch2);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                tracker.update(output1);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true); // Still 1 uncollected

                tracker.update(output2);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false); // All collected
            });

            test('should handle mixed Task/TaskOutput events correctly', () => {
                const mixedEvent: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'task 1', prompt: 'do task 1', subagent_type: 'general-purpose', run_in_background: true },
                            },
                            {
                                type:  'tool_use',
                                id:    'tool_2',
                                name:  'TaskOutput',
                                input: { task_id: 'old_task' },
                            },
                            {
                                type:  'tool_use',
                                id:    'tool_3',
                                name:  'Task',
                                input: { description: 'task 2', prompt: 'do task 2', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                // Initially 0 launches, 0 outputs
                // After this event: 2 launches, 1 output
                tracker.update(mixedEvent);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('should handle non-background Task tools mixed with background ones', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [
                            {
                                type:  'tool_use',
                                id:    'tool_1',
                                name:  'Task',
                                input: { description: 'blocking task', prompt: 'do blocking task', subagent_type: 'general-purpose' },
                            },
                            {
                                type:  'tool_use',
                                id:    'tool_2',
                                name:  'Task',
                                input: { description: 'background task', prompt: 'do background task', subagent_type: 'general-purpose', run_in_background: true },
                            },
                        ],
                    },
                };

                tracker.update(event);
                // Should only count the background one
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });
        });
    });
});
