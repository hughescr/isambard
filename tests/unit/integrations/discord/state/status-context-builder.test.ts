/**
 * Tests for StatusContextBuilder.
 */

import { describe, expect, it } from 'bun:test';
import { constant, noop as _ } from 'lodash';
import { createStatusContextBuilder } from '@/integrations/discord/state/status-context-builder';
import { type BotState, type BotStateManager, createDefaultBotState } from '@/integrations/discord/state/types';
import { createChannelId } from '@/integrations/discord/types';

/**
 * Create a mock state manager with a specific state.
 */
function createMockStateManager(state: BotState): BotStateManager {
    return {
        getState:             () => state,
        getMode:              () => state.mode,
        shouldUpdatePresence: constant(true),
        getSessionType:       (isDMChannel?: boolean) => {
            if(state.mode === 'catching_up') {
                return 'catching_up';
            }
            if(state.mode === 'perching') {
                return 'perching';
            }
            if(isDMChannel) {
                return 'dm';
            }
            return 'processing_message';
        },
        startCatchUp:           _,
        startProcessingMessage: _,
        startPerching:          _,
        goIdle:                 _,
        updateActivityPhase:    _,
        clearActivityPhase:     _,
        markChannelViewed:      _,
        setSessionId:           _,
        recordPresenceUpdate:   _,
        subscribe:              () => _,
        start:                  _,
        stop:                   _,
    };
}

describe('StatusContextBuilder', () => {
    describe('emoji prefix', () => {
        it('should return 💤 for idle mode', () => {
            const state = createDefaultBotState();
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.emojiPrefix).toBe('💤');
        });

        it('should return 📥 for catching_up mode', () => {
            const state: BotState = {
                mode:          'catching_up',
                activityPhase: null,
                modeEnteredAt: new Date(),
                modeContext:   {
                    viewedChannels:      new Set(),
                    sessionId:           null,
                    startedAt:           new Date(),
                    unreadCount:         5,
                    channelNames:        ['general'],
                    topAuthors:          ['Alice'],
                    timeSinceLastActive: '1 hour',
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.emojiPrefix).toBe('📥');
        });

        it('should return 💬 for processing_message mode', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: null,
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.emojiPrefix).toBe('💬');
        });

        it('should return 🪶 for perching mode', () => {
            const state: BotState = {
                mode:          'perching',
                activityPhase: null,
                modeEnteredAt: new Date(),
                modeContext:   {
                    activityType: 'Observing',
                    sessionId:    null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.emojiPrefix).toBe('🪶');
        });
    });

    describe('status generation behavior', () => {
        it('should generate LLM-based idle status for idle mode', () => {
            const state = createDefaultBotState();
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            // Behavior: Idle mode uses LLM for creative status (no prompt context)
            expect(context.emojiPrefix).toBe('💤');
            expect(context.strategy).toBe('idle_llm');
            expect(context.promptContext).toBeUndefined();
        });

        it('should use static fallback for active mode without activityPhase', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: null,
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            // Behavior: Active without phase uses static status (no prompt context)
            expect(context.emojiPrefix).toBe('💬');
            expect(context.strategy).toBe('active_static');
            expect(context.promptContext).toBeUndefined();
        });

        it('should generate dynamic LLM-based status for active mode with activityPhase', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:      'thinking',
                    startedAt: new Date(),
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            // Behavior: Active with phase uses dynamic status (has prompt context)
            expect(context.emojiPrefix).toBe('💬');
            expect(context.strategy).toBe('active_dynamic');
            expect(context.promptContext).toBeDefined();
            expect(context.promptContext?.phase).toBe('thinking');
        });
    });

    describe('prompt context extraction', () => {
        it('should extract thinking phase context', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:            'thinking',
                    startedAt:       new Date(),
                    userMessage:     'What is the weather?',
                    generatedStatus: 'Pondering your question...',
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'What is the weather?',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.promptContext).toEqual({
                phase:           'thinking',
                userMessage:     'What is the weather?',
                generatedStatus: 'Pondering your question...',
            });
        });

        it('should extract using_tool phase context', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:            'using_tool',
                    toolName:        'memory_tool',
                    startedAt:       new Date(),
                    generatedStatus: 'Searching memories...',
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.promptContext).toEqual({
                phase:           'using_tool',
                toolName:        'memory_tool',
                generatedStatus: 'Searching memories...',
            });
        });

        it('should extract responding phase context', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:            'responding',
                    startedAt:       new Date(),
                    generatedStatus: 'Crafting my response...',
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.promptContext).toEqual({
                phase:           'responding',
                generatedStatus: 'Crafting my response...',
            });
        });

        it('should extract catch-up context from catching_up mode', () => {
            const state: BotState = {
                mode:          'catching_up',
                activityPhase: {
                    type:            'thinking',
                    startedAt:       new Date(),
                    generatedStatus: 'Reviewing messages...',
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    viewedChannels:      new Set([createChannelId('123'), createChannelId('456')]),
                    sessionId:           'session-123',
                    startedAt:           new Date(),
                    unreadCount:         42,
                    channelNames:        ['general', 'random', 'tech'],
                    topAuthors:          ['Alice', 'Bob', 'Charlie'],
                    timeSinceLastActive: '3 hours',
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.promptContext?.catchUpContext).toEqual({
                unreadCount:         42,
                channelNames:        ['general', 'random', 'tech'],
                topAuthors:          ['Alice', 'Bob', 'Charlie'],
                timeSinceLastActive: '3 hours',
                viewedChannelCount:  2,
            });
        });

        it('should not include prompt context for idle mode', () => {
            const state = createDefaultBotState();
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.promptContext).toBeUndefined();
        });

        it('should not include prompt context for active mode without activityPhase', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: null,
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContext();

            expect(context.promptContext).toBeUndefined();
        });
    });

    describe('buildContextWithActivity', () => {
        it('should merge provided userMessage into thinking phase', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:      'thinking',
                    startedAt: new Date(),
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Original message',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContextWithActivity({
                userMessage: 'Override message',
            });

            expect(context.promptContext?.userMessage).toBe('Override message');
        });

        it('should merge provided toolName into using_tool phase', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:      'using_tool',
                    toolName:  'old_tool',
                    startedAt: new Date(),
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContextWithActivity({
                toolName: 'new_tool',
            });

            expect(context.promptContext?.toolName).toBe('new_tool');
        });

        it('should merge provided accumulatedText into responding phase', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:      'responding',
                    startedAt: new Date(),
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Hello',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContextWithActivity({
                accumulatedText: 'Here is my response...',
            });

            expect(context.promptContext?.accumulatedText).toBe('Here is my response...');
        });

        it('should preserve existing prompt context fields when merging', () => {
            const state: BotState = {
                mode:          'processing_message',
                activityPhase: {
                    type:            'thinking',
                    startedAt:       new Date(),
                    userMessage:     'Original message',
                    generatedStatus: 'Thinking...',
                },
                modeEnteredAt: new Date(),
                modeContext:   {
                    channelId:   createChannelId('123'),
                    userMessage: 'Original message',
                    sessionId:   null,
                },
            };
            const manager = createMockStateManager(state);
            const builder = createStatusContextBuilder({ stateManager: manager });

            const context = builder.buildContextWithActivity({
                userMessage: 'Override message',
            });

            expect(context.promptContext).toEqual({
                phase:           'thinking',
                userMessage:     'Override message',
                generatedStatus: 'Thinking...',
            });
        });
    });
});
