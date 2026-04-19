import { describe, test, expect, beforeEach } from 'bun:test';
import { StreamTracker } from '../../../src/agent/stream-tracker';
import type { AgentStreamEvent, AssistantEvent, SystemEvent } from '../../../src/agent/types';

/** Build an assistant event with a TaskOutput tool-use block. */
function makeTaskOutputEvent(taskId: string): AssistantEvent {
    return {
        type:    'assistant',
        message: {
            content: [
                {
                    type:  'tool_use',
                    id:    `tool-output-${taskId}`,
                    name:  'TaskOutput',
                    input: { task_id: taskId },
                },
            ],
        },
    };
}

/**
 * Build an assistant event with a Task tool-use block (background or foreground).
 * Matches the real SDK AgentInput shape — NO task_id in input (AgentInput has no such field).
 * The block's own id (toolUseId) is used for Phase-1 correlation with SDKTaskStartedMessage.
 */
function makeTaskLaunchEvent(toolUseId: string, runInBackground: boolean | undefined): AssistantEvent {
    const taskInput: Record<string, unknown> = {
        description:   'test task',
        prompt:        'do work',
        subagent_type: 'general-purpose',
    };
    if(runInBackground !== undefined) {
        taskInput.run_in_background = runInBackground;
    }
    // Real SDK Task tool_use input has NO task_id field (AgentInput in sdk-tools.d.ts).
    // The block's own `id` field is used for Phase-1 correlation.
    return {
        type:    'assistant',
        message: {
            content: [
                {
                    type:  'tool_use',
                    id:    toolUseId,
                    name:  'Task',
                    input: taskInput,
                },
            ],
        },
    };
}

/**
 * Build a system event matching the real SDKTaskStartedMessage shape.
 * Carries both task_id (SDK-assigned) and tool_use_id (links to the originating Task block).
 * Per sdk.d.ts: type='system', subtype='task_started', task_id, tool_use_id? (optional), description, uuid, session_id.
 */
function makeTaskStartedSystemEvent(taskId: string, toolUseId?: string, sessionId = 'session-test'): SystemEvent {
    return {
        type:        'system',
        subtype:     'task_started',
        task_id:     taskId,
        tool_use_id: toolUseId,
        description: 'test task description',
        session_id:  sessionId,
    };
}

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
            // Set up: assistant event with thinking + text + tool_use
            const assistantWithThinking: AssistantEvent = {
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

            tracker.update(assistantWithThinking);
            tracker.update(systemEvent);

            // Verify thinking/text/tool state (before adding background task)
            let progress = tracker.getProgress();
            expect(progress.thinking).toBe('Some thinking');
            expect(progress.text).toBe('Some text');
            expect(progress.pendingToolUse).not.toBeNull();
            expect(progress.sessionId).toBe('session_xyz');

            // Add a background task via the two-phase flow:
            // Phase 1: Task tool_use with run_in_background:true
            // Phase 2: SDKTaskStartedMessage linking tool_use_id → task_id
            // Note: the Task launch event has only a tool_use block (no thinking),
            // so it will clear thinking per the "replace on new content" design.
            tracker.update(makeTaskLaunchEvent('toolu-reset-1', true));
            tracker.update(makeTaskStartedSystemEvent('task-abc', 'toolu-reset-1'));
            expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(1);

            // Now reset
            tracker.reset();

            // Verify all state is cleared
            progress = tracker.getProgress();
            expect(progress.thinking).toBe('');
            expect(progress.text).toBe('');
            expect(progress.pendingToolUse).toBeNull();
            expect(progress.sessionId).toBeUndefined();
            expect(progress.uncollectedBackgroundTasks).toBe(0);
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

    describe('Background task tracking — two-phase stream-driven correlation', () => {
        describe('Initial state', () => {
            test('hasUncollectedBackgroundTasks() should return false initially', () => {
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('getProgress().uncollectedBackgroundTasks should be 0 initially', () => {
                const progress = tracker.getProgress();
                expect(progress.uncollectedBackgroundTasks).toBe(0);
            });
        });

        describe('Phase 1: Task tool_use observation (adds to pendingToolUseIds)', () => {
            test('Task tool_use with run_in_background:true adds to pendingToolUseIds and returns true from hasUncollectedBackgroundTasks', () => {
                // Phase 1 only: tool_use_id goes into pendingToolUseIds (not yet outstandingTaskIds).
                // hasUncollectedBackgroundTasks() returns true for phase-1 pending entries too,
                // so that auto-resume catches sessions aborted between task emission and task_started.
                tracker.update(makeTaskLaunchEvent('toolu-abc', true));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('should NOT track task when Task tool_use has run_in_background:false', () => {
                tracker.update(makeTaskLaunchEvent('toolu-fg', false));
                // Even sending a task_started event won't help since toolu-fg is not in pendingToolUseIds
                tracker.update(makeTaskStartedSystemEvent('task-fg-1', 'toolu-fg'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should NOT track task when Task tool_use has no run_in_background field', () => {
                tracker.update(makeTaskLaunchEvent('toolu-noflag', undefined));
                tracker.update(makeTaskStartedSystemEvent('task-noflag-1', 'toolu-noflag'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should NOT add to pending when Task tool_use has empty string tool_use.id', () => {
                // tool_use.id must be a non-empty string to be added to pendingToolUseIds
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [{
                            type:  'tool_use',
                            id:    '',
                            name:  'Task',
                            input: { run_in_background: true, description: 'task', prompt: 'work', subagent_type: 'general-purpose' },
                        }],
                    },
                };
                tracker.update(event);
                // Even sending task_started with matching (empty) tool_use_id won't match
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should NOT add to pending when Task tool_use has malformed input (non-object)', () => {
                const event: AssistantEvent = {
                    type:    'assistant',
                    message: {
                        content: [{
                            type:  'tool_use',
                            id:    'tool-bad',
                            name:  'Task',
                            input: 'not-an-object',
                        }],
                    },
                };
                expect(() => tracker.update(event)).not.toThrow();
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });
        });

        describe('Phase 2: SDKTaskStartedMessage promotes pending → outstanding', () => {
            test('Task tool_use + SDKTaskStartedMessage with matching tool_use_id → outstanding populated by task_id', () => {
                tracker.update(makeTaskLaunchEvent('toolu-bg-1', true));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true); // pending only (phase-1), still counts

                tracker.update(makeTaskStartedSystemEvent('task-id-1', 'toolu-bg-1'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(1);
            });

            test('SDKTaskStartedMessage with non-matching tool_use_id leaves pending entry intact', () => {
                tracker.update(makeTaskLaunchEvent('toolu-pending', true));
                // Sends a task_started with a different tool_use_id — no match; toolu-pending stays in pending
                tracker.update(makeTaskStartedSystemEvent('task-nomatch', 'toolu-other'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('SDKTaskStartedMessage without tool_use_id leaves pending entry intact (no way to correlate)', () => {
                tracker.update(makeTaskLaunchEvent('toolu-abc2', true));
                // task_started with no tool_use_id cannot be correlated; toolu-abc2 stays in pending
                tracker.update(makeTaskStartedSystemEvent('task-no-link', undefined));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('SDKTaskStartedMessage with no matching pending entries is ignored (no orphan task_ids added)', () => {
                // Rogue task_started with no preceding Task tool_use — should not create outstanding entry
                tracker.update(makeTaskStartedSystemEvent('orphan-task', 'toolu-unknown'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should track multiple background tasks via individual two-phase flows', () => {
                tracker.update(makeTaskLaunchEvent('toolu-a', true));
                tracker.update(makeTaskLaunchEvent('toolu-b', true));
                tracker.update(makeTaskStartedSystemEvent('task-a', 'toolu-a'));
                tracker.update(makeTaskStartedSystemEvent('task-b', 'toolu-b'));
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(2);
            });

            test('should be idempotent — same tool_use_id promoted twice counts once', () => {
                tracker.update(makeTaskLaunchEvent('toolu-idem', true));
                tracker.update(makeTaskStartedSystemEvent('task-idem', 'toolu-idem'));
                // Second task_started for the same tool_use_id — pending already removed, so ignored
                tracker.update(makeTaskStartedSystemEvent('task-idem-2', 'toolu-idem'));
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(1);
            });
        });

        describe('TaskOutput stream parsing (authoritative collection signal)', () => {
            test('should remove a task from outstanding when TaskOutput tool-use is observed', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                tracker.update(makeTaskOutputEvent('task-1'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should only remove the task whose task_id matches the TaskOutput input', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskLaunchEvent('toolu-2', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                tracker.update(makeTaskStartedSystemEvent('task-2', 'toolu-2'));
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(2);

                tracker.update(makeTaskOutputEvent('task-1'));
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(1);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('should be idempotent — double TaskOutput for the same task is safe', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                tracker.update(makeTaskOutputEvent('task-1'));
                tracker.update(makeTaskOutputEvent('task-1'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should be safe when TaskOutput references an unknown task_id', () => {
                expect(() => tracker.update(makeTaskOutputEvent('nonexistent-task'))).not.toThrow();
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should handle multiple TaskOutput events clearing multiple tasks', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskLaunchEvent('toolu-2', true));
                tracker.update(makeTaskLaunchEvent('toolu-3', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                tracker.update(makeTaskStartedSystemEvent('task-2', 'toolu-2'));
                tracker.update(makeTaskStartedSystemEvent('task-3', 'toolu-3'));

                tracker.update(makeTaskOutputEvent('task-1'));
                tracker.update(makeTaskOutputEvent('task-3'));

                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(1);
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                tracker.update(makeTaskOutputEvent('task-2'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });
        });

        describe('Full two-phase flow: launch → task_started → TaskOutput', () => {
            test('complete happy path: Phase1 + Phase2 + collection → 0 outstanding', () => {
                // Phase 1: observe Task tool_use (pending phase — counts as uncollected)
                tracker.update(makeTaskLaunchEvent('toolu-full', true));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                // Phase 2: SDKTaskStartedMessage promotes to outstanding
                tracker.update(makeTaskStartedSystemEvent('task-full', 'toolu-full'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                // Collection: TaskOutput removes from outstanding
                tracker.update(makeTaskOutputEvent('task-full'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('SDKTaskStartedMessage before Task tool_use (out-of-order) — not correlated but pending still detected', () => {
                // If task_started arrives before the Task tool_use, no pending entry exists → ignored
                tracker.update(makeTaskStartedSystemEvent('task-early', 'toolu-early'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);

                // Now the Task tool_use arrives — adds to pending but task_started already fired
                tracker.update(makeTaskLaunchEvent('toolu-early', true));
                // No second task_started arrives → stays in pending phase (phase-1), still detectable
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });
        });

        describe('hasUncollectedBackgroundTasks() logic', () => {
            test('auto-resume detects phase-1 pending tasks without promoted task_ids', () => {
                // Scenario: session aborts between Task tool_use emission and SDKTaskStartedMessage.
                // Only phase-1 pendingToolUseIds is populated (no promotion to outstandingTaskIds).
                // hasUncollectedBackgroundTasks() must return true so auto-resume is triggered.
                tracker.update(makeTaskLaunchEvent('toolu-phase1-only', true));
                // No SDKTaskStartedMessage arrives (session aborted in the narrow window)
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('should return true when tasks exist in outstanding set', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);
            });

            test('should return false when all created tasks are collected via TaskOutput', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskLaunchEvent('toolu-2', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                tracker.update(makeTaskStartedSystemEvent('task-2', 'toolu-2'));
                tracker.update(makeTaskOutputEvent('task-1'));
                tracker.update(makeTaskOutputEvent('task-2'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should return false when no tasks have been created', () => {
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });
        });

        describe('getProgress() includes uncollectedBackgroundTasks', () => {
            test('should include uncollectedBackgroundTasks in progress object', () => {
                const progress = tracker.getProgress();
                expect(progress).toHaveProperty('uncollectedBackgroundTasks');
            });

            test('should reflect correct count (1 when one task outstanding after two-phase)', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                const progress = tracker.getProgress();
                expect(progress.uncollectedBackgroundTasks).toBe(1);
            });

            test('should reflect correct count (0 when all tasks collected via TaskOutput)', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                tracker.update(makeTaskOutputEvent('task-1'));
                const progress = tracker.getProgress();
                expect(progress.uncollectedBackgroundTasks).toBe(0);
            });

            test('should count phase-1 pending entries in uncollectedBackgroundTasks (stall-detection fix)', () => {
                // Regression test for bug where getProgress().uncollectedBackgroundTasks only counted
                // outstandingTaskIds (phase-2) but NOT pendingToolUseIds (phase-1). This caused the
                // collectBackgroundTasks stall-detection loop to break immediately after a phase-2
                // promotion: uncollectedBefore=0 (only pending, not counted), then after resume
                // the task_started arrives → outstanding becomes 1. The stall check "1 >= 0" fired
                // and broke out, discarding the result. Fix: count both sets in getProgress().

                // Step 1: emit Task tool_use with run_in_background:true (phase-1 pending)
                tracker.update(makeTaskLaunchEvent('toolu-phase1-stall', true));

                // Step 2: phase-1 pending must be visible in getProgress() — was returning 0 before fix
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(1);

                // Step 3: emit matching task_started (phase-2 promotion: pending → outstanding)
                tracker.update(makeTaskStartedSystemEvent('task-phase1-stall', 'toolu-phase1-stall'));

                // Step 4: count must remain 1 (moved from pending to outstanding, total unchanged)
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(1);

                // Step 5: emit TaskOutput (collection)
                tracker.update(makeTaskOutputEvent('task-phase1-stall'));

                // Step 6: count drops to 0
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(0);
            });
        });

        describe('Reset behavior', () => {
            test('should clear outstanding task set on reset', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(true);

                tracker.reset();
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });

            test('should return 0 for uncollectedBackgroundTasks after reset', () => {
                tracker.update(makeTaskLaunchEvent('toolu-1', true));
                tracker.update(makeTaskLaunchEvent('toolu-2', true));
                tracker.update(makeTaskStartedSystemEvent('task-1', 'toolu-1'));
                tracker.update(makeTaskStartedSystemEvent('task-2', 'toolu-2'));
                tracker.reset();

                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
                expect(tracker.getProgress().uncollectedBackgroundTasks).toBe(0);
            });

            test('should clear pending tool_use_ids on reset so no stale correlation occurs', () => {
                // Add a task to pending (Phase 1 only, no task_started yet)
                tracker.update(makeTaskLaunchEvent('toolu-stale', true));
                tracker.reset();

                // After reset, the pending entry is gone, so task_started won't promote it
                tracker.update(makeTaskStartedSystemEvent('task-stale', 'toolu-stale'));
                expect(tracker.hasUncollectedBackgroundTasks()).toBe(false);
            });
        });
    });

    describe('hasMeaningfulProgress()', () => {
        test('should return false for a fresh tracker', () => {
            expect(tracker.hasMeaningfulProgress()).toBe(false);
        });

        test('should return true after receiving thinking content', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'Let me think about this' },
                    ],
                },
            };
            tracker.update(event);
            expect(tracker.hasMeaningfulProgress()).toBe(true);
        });

        test('should return true after receiving text content', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Here is my response' },
                    ],
                },
            };
            tracker.update(event);
            expect(tracker.hasMeaningfulProgress()).toBe(true);
        });

        test('should return true after receiving a tool_use block', () => {
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
            expect(tracker.hasMeaningfulProgress()).toBe(true);
        });

        test('should return false after only receiving system events (no assistant content)', () => {
            const event: SystemEvent = {
                type:       'system',
                subtype:    'init',
                session_id: 'session_abc123',
            };
            tracker.update(event);
            expect(tracker.hasMeaningfulProgress()).toBe(false);
        });

        test('should return false after reset even if progress was made', () => {
            const event: AssistantEvent = {
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Some text' },
                    ],
                },
            };
            tracker.update(event);
            expect(tracker.hasMeaningfulProgress()).toBe(true);
            tracker.reset();
            expect(tracker.hasMeaningfulProgress()).toBe(false);
        });
    });
});
