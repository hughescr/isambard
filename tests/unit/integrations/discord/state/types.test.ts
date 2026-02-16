/**
 * Tests for BotStateManager types and schemas.
 * Following TDD - these tests are written before implementation.
 */

import { describe, expect, it } from 'bun:test';
import {
    type OperationalMode,
    type ActivityPhase,
    type BotState,
    type StateChange,
    type IdleModeContext,
    type CatchingUpModeContext,
    type ProcessingMessageModeContext,
    type PerchingModeContext,
    operationalModeSchema,
    activityPhaseSchema,
    botStateSchema,
    stateChangeSchema,
    modeContextSchema,
    isActivityPhase,
    isModeContext,
    createDefaultBotState
} from '@/integrations/discord/state/types';
import { createChannelId } from '@/integrations/discord/types';

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe('operationalModeSchema', () => {
    it('should accept valid operational modes', () => {
        const modes: OperationalMode[] = ['idle', 'catching_up', 'processing_message', 'perching'];
        for(const mode of modes) {
            expect(() => operationalModeSchema.parse(mode)).not.toThrow();
        }
    });

    it('should reject invalid operational modes', () => {
        expect(() => operationalModeSchema.parse('invalid')).toThrow();
        expect(() => operationalModeSchema.parse('')).toThrow();
        expect(() => operationalModeSchema.parse(null)).toThrow();
        expect(() => operationalModeSchema.parse(undefined)).toThrow();
    });
});

describe('activityPhaseSchema', () => {
    it('should accept thinking phase with required fields', () => {
        const phase: ActivityPhase = {
            type:      'thinking',
            startedAt: new Date(),
        };
        expect(() => activityPhaseSchema.parse(phase)).not.toThrow();
    });

    it('should accept thinking phase with optional fields', () => {
        const phase: ActivityPhase = {
            type:            'thinking',
            startedAt:       new Date(),
            userMessage:     'Test message',
            generatedStatus: 'Pondering...',
        };
        expect(() => activityPhaseSchema.parse(phase)).not.toThrow();
    });

    it('should accept using_tool phase', () => {
        const phase: ActivityPhase = {
            type:            'using_tool',
            toolName:        'memory_tool',
            startedAt:       new Date(),
            generatedStatus: 'Searching memories...',
        };
        expect(() => activityPhaseSchema.parse(phase)).not.toThrow();
    });

    it('should accept responding phase', () => {
        const phase: ActivityPhase = {
            type:      'responding',
            startedAt: new Date(),
        };
        expect(() => activityPhaseSchema.parse(phase)).not.toThrow();
    });

    it('should reject invalid phase types', () => {
        const invalidPhase = {
            type:      'invalid',
            startedAt: new Date(),
        };
        expect(() => activityPhaseSchema.parse(invalidPhase)).toThrow();
    });

    it('should reject using_tool phase without toolName', () => {
        const invalidPhase = {
            type:      'using_tool',
            startedAt: new Date(),
        };
        expect(() => activityPhaseSchema.parse(invalidPhase)).toThrow();
    });

    it('should reject phase without startedAt', () => {
        const invalidPhase = {
            type: 'thinking',
        };
        expect(() => activityPhaseSchema.parse(invalidPhase)).toThrow();
    });
});

describe('modeContextSchema', () => {
    it('should accept idle mode context', () => {
        const context: IdleModeContext = {};
        expect(() => modeContextSchema.parse(context)).not.toThrow();
    });

    it('should accept catching_up mode context', () => {
        const context: CatchingUpModeContext = {
            viewedChannels:      new Set([createChannelId('123')]),
            sessionId:           'session-123',
            startedAt:           new Date(),
            unreadCount:         42,
            channelNames:        ['general', 'random'],
            topAuthors:          ['Alice', 'Bob'],
            timeSinceLastActive: '3 hours',
        };
        expect(() => modeContextSchema.parse(context)).not.toThrow();
    });

    it('should accept processing_message mode context', () => {
        const context: ProcessingMessageModeContext = {
            channelId:   createChannelId('123'),
            userMessage: 'Hello!',
            sessionId:   'session-123',
        };
        expect(() => modeContextSchema.parse(context)).not.toThrow();
    });

    it('should accept perching mode context', () => {
        const context: PerchingModeContext = {
            activityType: 'Observing',
            sessionId:    'session-123',
        };
        expect(() => modeContextSchema.parse(context)).not.toThrow();
    });

    it('should accept context with null sessionId', () => {
        const context: ProcessingMessageModeContext = {
            channelId:   createChannelId('123'),
            userMessage: 'Hello!',
            sessionId:   null,
        };
        expect(() => modeContextSchema.parse(context)).not.toThrow();
    });
});

describe('botStateSchema', () => {
    it('should accept valid idle state', () => {
        const state: BotState = {
            mode:          'idle',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   {},
        };
        expect(() => botStateSchema.parse(state)).not.toThrow();
    });

    it('should accept state with activity phase', () => {
        const state: BotState = {
            mode:          'processing_message',
            activityPhase: {
                type:      'thinking',
                startedAt: new Date(),
            },
            modeEnteredAt: new Date(),
            modeContext:   {
                channelId:   createChannelId('123'),
                userMessage: 'Hello!',
                sessionId:   null,
            },
        };
        expect(() => botStateSchema.parse(state)).not.toThrow();
    });

    it('should reject state without required fields', () => {
        expect(() => botStateSchema.parse({})).toThrow();
        expect(() => botStateSchema.parse({ mode: 'idle' })).toThrow();
    });
});

describe('stateChangeSchema', () => {
    it('should accept valid state change', () => {
        const previousState: BotState = {
            mode:          'idle',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   {},
        };

        const newState: BotState = {
            mode:          'processing_message',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   {
                channelId:   createChannelId('123'),
                userMessage: 'Hello!',
                sessionId:   null,
            },
        };

        const change: StateChange = {
            previousState,
            newState,
            changeType: 'mode_transition',
        };

        expect(() => stateChangeSchema.parse(change)).not.toThrow();
    });

    it('should accept all change types', () => {
        const state: BotState = {
            mode:          'idle',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   {},
        };

        const changeTypes = ['mode_transition', 'activity_phase', 'context_update'] as const;

        for(const changeType of changeTypes) {
            const change: StateChange = {
                previousState: state,
                newState:      state,
                changeType,
            };
            expect(() => stateChangeSchema.parse(change)).not.toThrow();
        }
    });

    it('should reject invalid change type', () => {
        const state: BotState = {
            mode:          'idle',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   {},
        };

        const invalidChange = {
            previousState: state,
            newState:      state,
            changeType:    'invalid',
        };

        expect(() => stateChangeSchema.parse(invalidChange)).toThrow();
    });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('isActivityPhase', () => {
    it('should return true for valid thinking phase', () => {
        const phase: ActivityPhase = {
            type:      'thinking',
            startedAt: new Date(),
        };
        expect(isActivityPhase(phase)).toBe(true);
    });

    it('should return true for valid using_tool phase', () => {
        const phase: ActivityPhase = {
            type:      'using_tool',
            toolName:  'memory_tool',
            startedAt: new Date(),
        };
        expect(isActivityPhase(phase)).toBe(true);
    });

    it('should return true for valid responding phase', () => {
        const phase: ActivityPhase = {
            type:      'responding',
            startedAt: new Date(),
        };
        expect(isActivityPhase(phase)).toBe(true);
    });

    it('should return false for invalid values', () => {
        expect(isActivityPhase(null)).toBe(false);
        expect(isActivityPhase(undefined)).toBe(false);
        expect(isActivityPhase({})).toBe(false);
        expect(isActivityPhase({ type: 'invalid' })).toBe(false);
        expect(isActivityPhase('thinking')).toBe(false);
    });
});

describe('isModeContext', () => {
    it('should return true for idle mode context', () => {
        const context: IdleModeContext = {};
        expect(isModeContext(context)).toBe(true);
    });

    it('should return true for catching_up mode context', () => {
        const context: CatchingUpModeContext = {
            viewedChannels:      new Set(),
            sessionId:           null,
            startedAt:           new Date(),
            unreadCount:         0,
            channelNames:        [],
            topAuthors:          [],
            timeSinceLastActive: null,
        };
        expect(isModeContext(context)).toBe(true);
    });

    it('should return true for processing_message mode context', () => {
        const context: ProcessingMessageModeContext = {
            channelId:   createChannelId('123'),
            userMessage: 'Hello!',
            sessionId:   null,
        };
        expect(isModeContext(context)).toBe(true);
    });

    it('should return true for perching mode context', () => {
        const context: PerchingModeContext = {
            activityType: 'Observing',
            sessionId:    null,
        };
        expect(isModeContext(context)).toBe(true);
    });

    it('should return false for invalid values', () => {
        expect(isModeContext(null)).toBe(false);
        expect(isModeContext(undefined)).toBe(false);
        expect(isModeContext('context')).toBe(false);
    });
});

// ============================================================================
// Default State Factory Tests
// ============================================================================

describe('createDefaultBotState', () => {
    it('should create default idle state', () => {
        const state = createDefaultBotState();

        expect(state.mode).toBe('idle');
        expect(state.activityPhase).toBeNull();
        expect(state.modeEnteredAt).toBeInstanceOf(Date);
        expect(state.modeContext).toEqual({});
    });

    it('should create new Date instances for each call', () => {
        const state1 = createDefaultBotState();
        const state2 = createDefaultBotState();

        // Should be different Date instances (not the same reference)
        expect(state1.modeEnteredAt).not.toBe(state2.modeEnteredAt);
    });

    it('should create valid BotState according to schema', () => {
        const state = createDefaultBotState();
        expect(() => botStateSchema.parse(state)).not.toThrow();
    });
});
