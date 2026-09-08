/**
 * Stream Event Handler Test Suite (ledger variant)
 *
 * Tests the conductor-mode ledger stream event handler and its thinking-synopsis
 * pre-generation helper. The legacy botStateManager-driven `createStreamEventHandler`/
 * `buildThinkingSynopsis` variant was retired in P14.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { AgentStreamEvent } from '../../../../../src/agent/types.js';
import type { DynamicStatusGenerator } from '../../../../../src/integrations/discord/presence/status-generator-dynamic.js';
import { buildLedgerThinkingSynopsis, createLedgerStreamEventHandler, type CreateLedgerStreamEventHandlerDeps } from '../../../../../src/integrations/discord/presence/stream-event-handler.js';

// Helper to wait for async promises to settle.
// Three rounds drain the full async chain in updatePhaseWithSynopsis:
// outer IIFE → await generateSynopsis continuation → await safeUpdatePhase continuation.
const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

describe('buildLedgerThinkingSynopsis', () => {
    function makeThrottle(shouldUpdate = true) {
        return { shouldUpdate: mock(() => shouldUpdate), record: mock(() => undefined) };
    }

    it('returns the generated synopsis when the throttle allows an update', async () => {
        const generator = { generateSynopsis: mock(async (): Promise<string | null> => 'Analyzing your request') } as unknown as DynamicStatusGenerator;
        const throttle = makeThrottle(true);

        const result = await buildLedgerThinkingSynopsis(generator, throttle, 'hello world');

        expect(result).toBe('Analyzing your request');
        expect(generator.generateSynopsis).toHaveBeenCalledWith({ phase: 'thinking', userMessage: 'hello world' });
    });

    it('returns undefined without calling generateSynopsis when dynamicStatusGenerator is undefined', async () => {
        const throttle = makeThrottle(true);

        const result = await buildLedgerThinkingSynopsis(undefined, throttle, 'hello');

        expect(result).toBeUndefined();
    });

    it('returns undefined without calling generateSynopsis when the throttle window has not elapsed', async () => {
        const generator = { generateSynopsis: mock(async (): Promise<string | null> => 'some status') } as unknown as DynamicStatusGenerator;
        const throttle = makeThrottle(false);

        const result = await buildLedgerThinkingSynopsis(generator, throttle, 'hello');

        expect(result).toBeUndefined();
        expect(generator.generateSynopsis).not.toHaveBeenCalled();
    });

    it('swallows a generateSynopsis throw and returns undefined', async () => {
        const generator = {
            generateSynopsis: mock(async (): Promise<string | null> => {
                throw new Error('LLM timeout');
            }),
        } as unknown as DynamicStatusGenerator;
        const throttle = makeThrottle(true);

        const result = await buildLedgerThinkingSynopsis(generator, throttle, 'hello');

        expect(result).toBeUndefined();
    });

    it('converts a null generateSynopsis result to undefined', async () => {
        const generator = { generateSynopsis: mock(async (): Promise<string | null> => null) } as unknown as DynamicStatusGenerator;
        const throttle = makeThrottle(true);

        const result = await buildLedgerThinkingSynopsis(generator, throttle, 'hello');

        expect(result).toBeUndefined();
    });
});

describe('createLedgerStreamEventHandler', () => {
    let mockDynamicStatusGenerator: DynamicStatusGenerator;
    let sink: { dispatch: ReturnType<typeof mock> };
    let throttle: { shouldUpdate: ReturnType<typeof mock>, record: ReturnType<typeof mock> };
    let baseDeps: CreateLedgerStreamEventHandlerDeps;

    beforeEach(() => {
        mockDynamicStatusGenerator = {
            generateSynopsis: mock(async () => 'Generated synopsis'),
        };
        sink = { dispatch: mock(() => undefined) };
        throttle = { shouldUpdate: mock(() => true), record: mock(() => undefined) };
        baseDeps = {
            turnId:                 'turn-1',
            sink,
            throttle,
            dynamicStatusGenerator: mockDynamicStatusGenerator,
            logger:                 { error: mock(() => undefined) },
            userMessage:            'Test message',
            thinkingSynopsis:       'Pre-generated thinking synopsis',
        };
    });

    it('dispatches phase_synopsis { turnId, phaseType, text } after a resolved synopsis (using_tool)', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch).toHaveBeenCalledWith({
            type: 'phase_synopsis', turnId: 'turn-1', phaseType: 'using_tool', text: 'Generated synopsis', at: expect.any(Date),
        });
    });

    it('does not re-dispatch using_tool phase_synopsis when the same tool name repeats consecutively', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        const toolEvent = {
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent;

        onStreamEvent(toolEvent);
        await flushPromises();
        onStreamEvent(toolEvent);
        await flushPromises();

        const usingToolDispatches = sink.dispatch.mock.calls.filter(call => (call[0] as { phaseType?: string }).phaseType === 'using_tool');
        expect(usingToolDispatches).toHaveLength(1);
    });

    it('dispatches phase_synopsis for a responding transition', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ phaseType: 'responding', text: 'Generated synopsis' }));
    });

    it('never dispatches anything but a phase_synopsis event', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);
        onStreamEvent({ type: 'result' } as unknown as AgentStreamEvent);
        await flushPromises();

        for(const call of sink.dispatch.mock.calls) {
            expect((call[0] as { type: string }).type).toBe('phase_synopsis');
        }
    });

    it('falls back to the pre-generated thinkingSynopsis on the first thinking transition (no context yet to regenerate from)', () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        // No delta.text and no prior thinking content/tool history: newPhase 'thinking', nothing to regenerate from.
        onStreamEvent({ type: 'assistant' } as unknown as AgentStreamEvent);

        expect(sink.dispatch).toHaveBeenCalledWith({
            type: 'phase_synopsis', turnId: 'turn-1', phaseType: 'thinking', text: 'Pre-generated thinking synopsis', at: expect.any(Date),
        });
    });

    it('suppresses synopsis generation when throttle.shouldUpdate() is false, and never calls throttle.record', async () => {
        throttle.shouldUpdate = mock(() => false);
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockDynamicStatusGenerator.generateSynopsis).not.toHaveBeenCalled();
        expect(sink.dispatch).not.toHaveBeenCalled();
        expect(throttle.record).not.toHaveBeenCalled();
    });

    it('drops a synopsis that resolves after complete() (deferred-promise staleness test)', async () => {
        let resolveSynopsis!: (value: string) => void;
        mockDynamicStatusGenerator.generateSynopsis = mock(async () => new Promise<string>((resolve) => {
            resolveSynopsis = resolve;
        }));

        const { onStreamEvent, complete } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await Promise.resolve(); // let generateAndDispatch's async IIFE reach the await

        complete();
        resolveSynopsis('Late synopsis');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    it('dispatches phase_synopsis for a task_progress event with a summary, keyed to the current phase', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);
        onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();

        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'still working',
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ phaseType: 'responding', text: 'Generated synopsis' }));
    });

    it('does not regenerate for a repeated task_progress summary on the same task', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);
        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'same summary',
        } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();
        (mockDynamicStatusGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'same summary',
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockDynamicStatusGenerator.generateSynopsis).not.toHaveBeenCalled();
        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    it('does not dispatch anything for a result event', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({ type: 'result' } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    it('caps recentToolCalls at MAX_RECENT_TOOLS (3), dropping the oldest', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        // Each transition captures `recentToolCalls` BEFORE unshifting the current tool, so the
        // ring-buffer cap (the `.pop()` after a 4th tool pushes it past MAX_RECENT_TOOLS) is only
        // observable on the NEXT (5th) transition's capture, once the internal array has already
        // been trimmed back down.
        for(const toolName of ['Tool1', 'Tool2', 'Tool3', 'Tool4', 'Tool5']) {
            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: `id-${toolName}`, name: toolName, input: {} }] },
            } as unknown as AgentStreamEvent);
        }
        await flushPromises();

        const lastCallArgs = (mockDynamicStatusGenerator.generateSynopsis as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as { recentToolCalls?: string[] };
        expect(lastCallArgs.recentToolCalls).toEqual(['Tool4', 'Tool3', 'Tool2']);
    });

    it('regenerates a fresh thinking synopsis (not the pre-generated fallback) once tool history exists', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();

        // No delta text, no accumulated thinking content — but tool history now exists, so this
        // must take the regeneration branch, not the `thinkingSynopsis` fallback.
        onStreamEvent({ type: 'assistant', message: { content: [] } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockDynamicStatusGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'thinking', recentToolCalls: ['Read'],
        }));
        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ phaseType: 'thinking', text: 'Generated synopsis' }));
    });

    it('falls back to the pre-generated thinkingSynopsis when regeneration throws after tool history exists', async () => {
        mockDynamicStatusGenerator.generateSynopsis = mock(async () => {
            throw new Error('LLM error');
        });
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();

        onStreamEvent({ type: 'assistant', message: { content: [] } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ phaseType: 'thinking', text: 'Pre-generated thinking synopsis' }));
    });

    it('caps accumulated thinking content at 1500 chars, keeping the most recent tail', () => {
        const capturedUpdates: string[] = [];
        const { onStreamEvent } = createLedgerStreamEventHandler({
            ...baseDeps,
            onThinkingContentUpdate: (content) => {
                capturedUpdates.push(content);
            },
        });

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a'.repeat(100) }] },
        } as unknown as AgentStreamEvent);
        // 100 + 1600 = 1700 accumulated chars; the last 1500 fall entirely within the 'z' block
        // (which starts at offset 100), so a correct `.slice(-1500)` drops every 'a'.
        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'z'.repeat(1600) }] },
        } as unknown as AgentStreamEvent);

        const last = capturedUpdates.at(-1)!;
        expect(last).toHaveLength(1500);
        expect(last).toBe('z'.repeat(1500));
    });

    it('dispatches a phase_synopsis for a tool_progress event, falling back to "unknown" when tool_name is absent', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({ type: 'tool_progress' } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockDynamicStatusGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'unknown' }));
        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ phaseType: 'using_tool', text: 'Generated synopsis' }));
    });

    it('dedupes a task_progress with no task_id against one with an explicit empty-string task_id (pins the "" fallback)', async () => {
        const { onStreamEvent } = createLedgerStreamEventHandler(baseDeps);

        onStreamEvent({
            type: 'system', subtype: 'task_progress', summary: 'no task id here',
        } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();
        (mockDynamicStatusGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        // Same summary, this time with an EXPLICIT task_id of '' — only dedupes against the
        // first event if the missing-task_id fallback is truly the empty string, not some other
        // sentinel value.
        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: '', summary: 'no task id here',
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockDynamicStatusGenerator.generateSynopsis).not.toHaveBeenCalled();
        expect(sink.dispatch).not.toHaveBeenCalled();
    });
});
