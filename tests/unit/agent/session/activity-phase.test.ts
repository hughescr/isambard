import { describe, expect, it } from 'bun:test';
import type { SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage, SDKToolProgressMessage } from '@anthropic-ai/claude-agent-sdk';
import * as frames from '../../../helpers/sdk-frames';
import {
    type ActivityPhase,
    activityPhaseSchema,
    isActivityPhase,
    phaseFromFrame
} from '@/agent/session/activity-phase';

const AT = new Date('2026-09-04T12:00:00Z');

// ============================================================================
// activityPhaseSchema — acceptance/rejection table (no Stryker disables: this
// table is what kills the mutants the moved schema used to suppress).
// ============================================================================

describe('activityPhaseSchema', () => {
    describe('thinking', () => {
        it('accepts required fields only', () => {
            expect(() => activityPhaseSchema.parse({ type: 'thinking', startedAt: AT })).not.toThrow();
        });

        it('accepts every optional field present', () => {
            expect(() => activityPhaseSchema.parse({
                type: 'thinking', startedAt: AT, userMessage: 'hi', generatedStatus: 'Thinking…',
            })).not.toThrow();
        });

        it('rejects a non-string userMessage', () => {
            expect(() => activityPhaseSchema.parse({ type: 'thinking', startedAt: AT, userMessage: 42 })).toThrow();
        });

        it('rejects a non-string generatedStatus', () => {
            expect(() => activityPhaseSchema.parse({ type: 'thinking', startedAt: AT, generatedStatus: 42 })).toThrow();
        });

        it('rejects a missing startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'thinking' })).toThrow();
        });

        it('rejects a non-Date startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'thinking', startedAt: AT.toISOString() })).toThrow();
        });
    });

    describe('using_tool', () => {
        it('accepts required fields only', () => {
            expect(() => activityPhaseSchema.parse({ type: 'using_tool', toolName: 'Bash', startedAt: AT })).not.toThrow();
        });

        it('accepts every optional field present', () => {
            expect(() => activityPhaseSchema.parse({
                type: 'using_tool', toolName: 'Bash', startedAt: AT, generatedStatus: 'Running…',
            })).not.toThrow();
        });

        it('rejects a missing toolName', () => {
            expect(() => activityPhaseSchema.parse({ type: 'using_tool', startedAt: AT })).toThrow();
        });

        it('rejects a missing startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'using_tool', toolName: 'Bash' })).toThrow();
        });

        it('rejects a non-Date startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'using_tool', toolName: 'Bash', startedAt: AT.toISOString() })).toThrow();
        });
    });

    describe('responding', () => {
        it('accepts required fields only', () => {
            expect(() => activityPhaseSchema.parse({ type: 'responding', startedAt: AT })).not.toThrow();
        });

        it('accepts every optional field present', () => {
            expect(() => activityPhaseSchema.parse({ type: 'responding', startedAt: AT, generatedStatus: 'Replying…' })).not.toThrow();
        });

        it('rejects a missing startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'responding' })).toThrow();
        });

        it('rejects a non-Date startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'responding', startedAt: AT.toISOString() })).toThrow();
        });
    });

    describe('compacting', () => {
        it('accepts required fields only', () => {
            expect(() => activityPhaseSchema.parse({ type: 'compacting', startedAt: AT })).not.toThrow();
        });

        it('accepts trigger "manual"', () => {
            expect(() => activityPhaseSchema.parse({ type: 'compacting', startedAt: AT, trigger: 'manual' })).not.toThrow();
        });

        it('accepts trigger "auto"', () => {
            expect(() => activityPhaseSchema.parse({ type: 'compacting', startedAt: AT, trigger: 'auto' })).not.toThrow();
        });

        it('rejects trigger "invalid"', () => {
            expect(() => activityPhaseSchema.parse({ type: 'compacting', startedAt: AT, trigger: 'invalid' })).toThrow();
        });

        it('rejects a missing startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'compacting' })).toThrow();
        });

        it('rejects a non-Date startedAt', () => {
            expect(() => activityPhaseSchema.parse({ type: 'compacting', startedAt: AT.toISOString() })).toThrow();
        });
    });

    it('rejects an unknown type', () => {
        expect(() => activityPhaseSchema.parse({ type: 'other', startedAt: AT })).toThrow();
    });
});

// ============================================================================
// isActivityPhase — parity with the schema
// ============================================================================

describe('isActivityPhase', () => {
    it('is true for a valid thinking phase', () => {
        expect(isActivityPhase({ type: 'thinking', startedAt: AT })).toBe(true);
    });

    it('is true for a valid using_tool phase', () => {
        expect(isActivityPhase({ type: 'using_tool', toolName: 'Bash', startedAt: AT })).toBe(true);
    });

    it('is true for a valid compacting phase', () => {
        expect(isActivityPhase({ type: 'compacting', startedAt: AT, trigger: 'auto' })).toBe(true);
    });

    it('is false for null/undefined/empty/unknown type/wrong shape', () => {
        expect(isActivityPhase(null)).toBe(false);
        expect(isActivityPhase(undefined)).toBe(false);
        expect(isActivityPhase({})).toBe(false);
        expect(isActivityPhase({ type: 'invalid' })).toBe(false);
        expect(isActivityPhase('thinking')).toBe(false);
    });
});

// ============================================================================
// phaseFromFrame — the explicit rule table from the P4 brief
// ============================================================================

describe('phaseFromFrame', () => {
    it('maps a result frame (any subtype) to null', () => {
        expect(phaseFromFrame(frames.resultSuccess(), null, AT)).toBeNull();
        expect(phaseFromFrame(frames.resultInterrupted(), { type: 'thinking', startedAt: AT }, AT)).toBeNull();
    });

    it('maps an assistant frame with one tool_use block to using_tool with that toolName', () => {
        const frame = frames.assistantToolUse('Bash', { command: 'ls' }, 'toolu_1');

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: AT });
    });

    it('maps an assistant frame with two tool_use blocks to using_tool with the LAST block\'s name', () => {
        const base = frames.assistantToolUse('Bash', { command: 'ls' }, 'toolu_1');
        const frame: SDKAssistantMessage = {
            ...base,
            message: {
                ...base.message,
                content: [
                    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {}, caller: { type: 'direct' } },
                    { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {}, caller: { type: 'direct' } },
                ] as SDKAssistantMessage['message']['content'],
            },
        };

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'using_tool', toolName: 'Read', startedAt: AT });
    });

    it('returns prev by reference when the assistant frame names the same tool prev is already using', () => {
        const frame = frames.assistantToolUse('Bash', { command: 'ls' }, 'toolu_1');
        const prev: ActivityPhase = { type: 'using_tool', toolName: 'Bash', startedAt: new Date('2026-09-04T11:00:00Z') };

        const phase = phaseFromFrame(frame, prev, AT);

        expect(phase).toBe(prev);
    });

    it('opens a new using_tool phase (not prev) when the tool name differs', () => {
        const frame = frames.assistantToolUse('Read', { file_path: 'x' }, 'toolu_2');
        const prev: ActivityPhase = { type: 'using_tool', toolName: 'Bash', startedAt: new Date('2026-09-04T11:00:00Z') };

        const phase = phaseFromFrame(frame, prev, AT);

        expect(phase).toEqual({ type: 'using_tool', toolName: 'Read', startedAt: AT });
        expect(phase).not.toBe(prev);
    });

    it('maps an assistant frame with a non-empty text block to responding', () => {
        const frame = frames.assistantText('hello there');

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'responding', startedAt: AT });
    });

    it('maps a thinking-only assistant frame to thinking', () => {
        const base = frames.assistantText('hello there');
        const frame: SDKAssistantMessage = {
            ...base,
            message: { ...base.message, content: [{ type: 'thinking', thinking: 'pondering', signature: 'sig' }] as SDKAssistantMessage['message']['content'] },
        };

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'thinking', startedAt: AT });
    });

    it('maps an assistant frame with empty content to thinking', () => {
        const base = frames.assistantText('hello there');
        const frame: SDKAssistantMessage = { ...base, message: { ...base.message, content: [] } };

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'thinking', startedAt: AT });
    });

    it('maps an assistant frame with a blank text block to thinking (empty text does not count as responding)', () => {
        const base = frames.assistantText('');
        const frame: SDKAssistantMessage = { ...base, message: { ...base.message, content: [{ type: 'text', text: '' }] as SDKAssistantMessage['message']['content'] } };

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'thinking', startedAt: AT });
    });

    it('maps a stream_event content_block_delta text_delta to responding', () => {
        const frame: SDKPartialAssistantMessage = {
            type:               'stream_event',
            event:              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
            parent_tool_use_id: null,
            uuid:               'uuid-1' as SDKPartialAssistantMessage['uuid'],
            session_id:         'sess-1',
        };

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'responding', startedAt: AT });
    });

    it('returns prev for any other stream_event', () => {
        const frame: SDKPartialAssistantMessage = {
            type:               'stream_event',
            event:              { type: 'message_stop' },
            parent_tool_use_id: null,
            uuid:               'uuid-1' as SDKPartialAssistantMessage['uuid'],
            session_id:         'sess-1',
        };
        const prev: ActivityPhase = { type: 'thinking', startedAt: AT };

        expect(phaseFromFrame(frame, prev, AT)).toBe(prev);
    });

    it('maps a tool_progress frame to using_tool with tool_name', () => {
        const frame: SDKToolProgressMessage = {
            type:                 'tool_progress',
            tool_use_id:          'toolu_1',
            tool_name:            'Bash',
            parent_tool_use_id:   null,
            elapsed_time_seconds: 3,
            uuid:                 'uuid-1' as SDKToolProgressMessage['uuid'],
            session_id:           'sess-1',
        };

        const phase = phaseFromFrame(frame, null, AT);

        expect(phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: AT });
    });

    it('returns prev by reference for a tool_progress frame naming the same tool as prev', () => {
        const frame: SDKToolProgressMessage = {
            type:                 'tool_progress',
            tool_use_id:          'toolu_1',
            tool_name:            'Bash',
            parent_tool_use_id:   null,
            elapsed_time_seconds: 3,
            uuid:                 'uuid-1' as SDKToolProgressMessage['uuid'],
            session_id:           'sess-1',
        };
        const prev: ActivityPhase = { type: 'using_tool', toolName: 'Bash', startedAt: new Date('2026-09-04T11:00:00Z') };

        expect(phaseFromFrame(frame, prev, AT)).toBe(prev);
    });

    it('maps task_progress with a summary to responding when prev is responding', () => {
        const frame = frames.taskProgress({ summary: 'Almost done' });
        const prev: ActivityPhase = { type: 'responding', startedAt: new Date('2026-09-04T11:00:00Z') };

        expect(phaseFromFrame(frame, prev, AT)).toEqual({ type: 'responding', startedAt: AT });
    });

    it('maps task_progress with a summary to thinking when prev is thinking', () => {
        const frame = frames.taskProgress({ summary: 'Almost done' });
        const prev: ActivityPhase = { type: 'thinking', startedAt: new Date('2026-09-04T11:00:00Z') };

        expect(phaseFromFrame(frame, prev, AT)).toEqual({ type: 'thinking', startedAt: AT });
    });

    it('maps task_progress with a summary to thinking when prev is null', () => {
        const frame = frames.taskProgress({ summary: 'Almost done' });

        expect(phaseFromFrame(frame, null, AT)).toEqual({ type: 'thinking', startedAt: AT });
    });

    it('returns prev by reference for task_progress without a summary', () => {
        const frame = frames.taskProgress({ summary: undefined });
        const prev: ActivityPhase = { type: 'responding', startedAt: AT };

        expect(phaseFromFrame(frame, prev, AT)).toBe(prev);
    });

    it('returns prev by reference for an unrelated system frame', () => {
        const frame = frames.backgroundTasksChanged([]);
        const prev: ActivityPhase = { type: 'thinking', startedAt: AT };

        expect(phaseFromFrame(frame, prev, AT)).toBe(prev);
    });

    it('returns prev (null) for an unrelated system frame when no phase is open', () => {
        const frame = frames.backgroundTasksChanged([]);

        expect(phaseFromFrame(frame, null, AT)).toBeNull();
    });

    it('returns prev by reference for every other frame type (e.g. init)', () => {
        const frame: SDKMessage = frames.init('sess-1');
        const prev: ActivityPhase = { type: 'compacting', startedAt: AT };

        expect(phaseFromFrame(frame, prev, AT)).toBe(prev);
    });
});
