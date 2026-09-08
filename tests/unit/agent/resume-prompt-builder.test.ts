import { describe, test, expect } from 'bun:test';
import { buildResumeNote } from '../../../src/agent/resume-prompt-builder';
import type { StreamProgress } from '../../../src/agent/stream-tracker';

describe('buildResumeNote', () => {
    const emptyProgress: StreamProgress = {
        thinking:       '',
        text:           '',
        pendingToolUse: null,
        sessionId:      undefined,
    };

    test('returns undefined when thinking, text, and pendingToolUse are all empty/null', () => {
        expect(buildResumeNote(emptyProgress)).toBeUndefined();
    });

    test('thinking only produces [RESUME NOTE] plus the thinking block, no text/tool lines', () => {
        const note = buildResumeNote({ ...emptyProgress, thinking: 'Pondering...' });

        expect(note).toContain('[RESUME NOTE]');
        expect(note).toContain('[Your thinking at the point of interruption:]');
        expect(note).toContain('Pondering...');
        expect(note).not.toContain('[You were composing this response:]');
        expect(note).not.toContain('[You were about to use tool');
        expect(note).not.toContain('[New message(s) received:]');
        expect(note).not.toContain('[Events that occurred during your processing:]');
    });

    test('text only produces [RESUME NOTE] plus the composing-response block', () => {
        const note = buildResumeNote({ ...emptyProgress, text: 'Sure, let me' });

        expect(note).toContain('[RESUME NOTE]');
        expect(note).toContain('[You were composing this response:]');
        expect(note).toContain('Sure, let me');
        expect(note).not.toContain('[Your thinking at the point of interruption:]');
        expect(note).not.toContain('[You were about to use tool');
    });

    test('pendingToolUse only produces [RESUME NOTE] plus the reconsider line naming the tool', () => {
        const note = buildResumeNote({
            ...emptyProgress,
            pendingToolUse: { type: 'tool_use', id: 'tool_1', name: 'memory_view', input: {} },
        });

        expect(note).toContain('[RESUME NOTE]');
        expect(note).toContain('[You were about to use tool "memory_view"');
        expect(note).not.toContain('[Your thinking at the point of interruption:]');
        expect(note).not.toContain('[You were composing this response:]');
    });

    test('renders all three blocks in order when all are present', () => {
        const note = buildResumeNote({
            ...emptyProgress,
            thinking:       'Thinking content',
            text:           'Response content',
            pendingToolUse: { type: 'tool_use', id: 'tool_1', name: 'test_tool', input: {} },
        });

        expect(note).toBeDefined();
        const headerIndex = note?.indexOf('[RESUME NOTE]') ?? -1;
        const thinkingIndex = note?.indexOf('[Your thinking at the point of interruption:]') ?? -1;
        const responseIndex = note?.indexOf('[You were composing this response:]') ?? -1;
        const toolIndex = note?.indexOf('[You were about to use tool') ?? -1;

        expect(headerIndex).toBe(0);
        expect(thinkingIndex).toBeGreaterThan(headerIndex);
        expect(responseIndex).toBeGreaterThan(thinkingIndex);
        expect(toolIndex).toBeGreaterThan(responseIndex);
    });
});
