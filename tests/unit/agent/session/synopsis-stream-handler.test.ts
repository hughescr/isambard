/**
 * Turn synopsis stream handler test suite (session core, #39).
 *
 * Tests the ledger-sink stream handler that publishes `turn_synopsis` events and its seed
 * pre-generation helper. Imports nothing from Discord.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import type { SynopsisGenerator } from '@/agent/session/synopsis-generator';
import { buildSeedSynopsis, createSynopsisStreamHandler, type CreateSynopsisStreamHandlerDeps } from '@/agent/session/synopsis-stream-handler';
import type { AgentStreamEvent } from '@/agent/types';

// Helper to wait for async promises to settle.
// Three rounds drain the full async chain of a synopsis dispatch:
// outer synopsis IIFE → await generateSynopsis continuation → ledger sink dispatch.
const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

/** The FakeClock's instant: every dispatched event's `at` is `new Date(clock.now())`. */
const CLOCK_START = 1_757_000_000_000;
const AT = new Date(CLOCK_START);

describe('buildSeedSynopsis', () => {
    function makeBudget(shouldGenerate = true) {
        return { shouldGenerate: mock(() => shouldGenerate) };
    }

    it('returns the generated synopsis when the budget allows a generation', async () => {
        const generator = { generateSynopsis: mock(async (): Promise<string | null> => 'Analyzing your request') } as unknown as SynopsisGenerator;
        const budget = makeBudget(true);

        const result = await buildSeedSynopsis(generator, budget, 'hello world');

        expect(result).toBe('Analyzing your request');
        expect(generator.generateSynopsis).toHaveBeenCalledWith({ phase: 'thinking', userMessage: 'hello world' });
        expect(budget.shouldGenerate).toHaveBeenCalledTimes(1);
    });

    it('returns undefined without calling generateSynopsis when the budget says no', async () => {
        const generator = { generateSynopsis: mock(async (): Promise<string | null> => 'some status') } as unknown as SynopsisGenerator;
        const budget = makeBudget(false);

        const result = await buildSeedSynopsis(generator, budget, 'hello');

        expect(result).toBeUndefined();
        expect(generator.generateSynopsis).not.toHaveBeenCalled();
    });

    it('swallows a generateSynopsis throw and returns undefined', async () => {
        const generator = {
            generateSynopsis: mock(async (): Promise<string | null> => {
                throw new Error('LLM timeout');
            }),
        } as unknown as SynopsisGenerator;
        const budget = makeBudget(true);

        const result = await buildSeedSynopsis(generator, budget, 'hello');

        expect(result).toBeUndefined();
    });

    it('converts a null generateSynopsis result to undefined', async () => {
        const generator = { generateSynopsis: mock(async (): Promise<string | null> => null) } as unknown as SynopsisGenerator;
        const budget = makeBudget(true);

        const result = await buildSeedSynopsis(generator, budget, 'hello');

        expect(result).toBeUndefined();
    });
});

describe('createSynopsisStreamHandler', () => {
    let mockGenerator: SynopsisGenerator;
    let sink: { dispatch: ReturnType<typeof mock> };
    let budget: { shouldGenerate: ReturnType<typeof mock> };
    let baseDeps: CreateSynopsisStreamHandlerDeps;

    beforeEach(() => {
        mockGenerator = {
            generateSynopsis: mock(async () => 'Generated synopsis'),
        };
        sink = { dispatch: mock(() => undefined) };
        budget = { shouldGenerate: mock(() => true) };
        // No seed by default: a seed is dispatched as soon as it settles (see the seed describe
        // below), so tests about live generation leave it out.
        baseDeps = {
            turnId:      'turn-1',
            sink,
            budget,
            generator:   mockGenerator,
            clock:       new FakeClock(CLOCK_START),
            userMessage: 'Test message',
        };
    });

    it('dispatches exactly turn_synopsis { turnId, text, at: clock.now() } after a resolved synopsis (using_tool)', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch.mock.calls).toEqual([[{ type: 'turn_synopsis', turnId: 'turn-1', text: 'Generated synopsis', at: AT }]]);
        expect(Object.keys(sink.dispatch.mock.calls[0]?.[0] as object)).toEqual(['type', 'turnId', 'text', 'at']);
    });

    it('does not re-generate a using_tool synopsis when the same tool name repeats consecutively', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        const toolEvent = {
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent;

        onStreamEvent(toolEvent);
        await flushPromises();
        onStreamEvent(toolEvent);
        await flushPromises();

        const toolGenerations = (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mock.calls
            .filter(call => (call[0] as { phase: string }).phase === 'using_tool');
        expect(toolGenerations).toHaveLength(1);
    });

    it('returns a repeated tool frame to thinking without generating a second tool synopsis', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);
        const toolEvent = {
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent;

        onStreamEvent(toolEvent);
        await flushPromises();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent(toolEvent);

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledTimes(1);
        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'thinking', recentToolCalls: ['Read'],
        }));
    });

    it('generates the same tool again after an intervening responding phase', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);
        const toolEvent = {
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent;
        onStreamEvent(toolEvent);
        await flushPromises();
        onStreamEvent({ type: 'assistant', delta: { text: 'intermediate answer' } } as unknown as AgentStreamEvent);
        await flushPromises();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent(toolEvent);

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledTimes(1);
        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({ phase: 'using_tool', toolName: 'Read' }));
    });

    it('passes a redacted tool input to the generated tool synopsis', () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/tmp/a.txt' } }] },
        } as unknown as AgentStreamEvent);

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'using_tool', toolInput: { file_path: '/tmp/a.txt' },
        }));
    });

    it('redacts a sensitive key in the tool input stored for the tool synopsis', () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { apiKey: 'sk-live-abcdef', command: 'ls' } }] },
        } as unknown as AgentStreamEvent);

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'using_tool', toolInput: { apiKey: '[REDACTED]', command: 'ls' },
        }));
    });

    it('dispatches a turn_synopsis for a responding transition', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_synopsis', text: 'Generated synopsis' }));
    });

    it('does not accumulate an empty assistant frame as response text', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({ type: 'assistant' } as unknown as AgentStreamEvent);
        await flushPromises();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
            accumulatedText: 'Hello', phase: 'responding',
        }));
    });

    it('never dispatches anything but a turn_synopsis event', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);
        onStreamEvent({ type: 'result' } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch.mock.calls.length).toBeGreaterThan(0);
        for(const call of sink.dispatch.mock.calls) {
            expect((call[0] as { type: string }).type).toBe('turn_synopsis');
        }
    });

    it('a first thinking transition with no context to generate from spends no budget and generates nothing', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        // No delta.text and no prior thinking content/tool history: newPhase 'thinking', nothing to regenerate from.
        onStreamEvent({ type: 'assistant' } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(budget.shouldGenerate).not.toHaveBeenCalled();
        expect(mockGenerator.generateSynopsis).not.toHaveBeenCalled();
        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    it('suppresses synopsis generation when budget.shouldGenerate() is false', async () => {
        budget.shouldGenerate = mock(() => false);
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type:    'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).not.toHaveBeenCalled();
        expect(sink.dispatch).not.toHaveBeenCalled();
        expect(budget.shouldGenerate).toHaveBeenCalledTimes(1);
    });

    it('drops a synopsis that resolves after complete() (deferred-promise staleness test)', async () => {
        let resolveSynopsis!: (value: string) => void;
        mockGenerator.generateSynopsis = mock(async () => new Promise<string>((resolve) => {
            resolveSynopsis = resolve;
        }));

        const { onStreamEvent, complete } = createSynopsisStreamHandler(baseDeps);

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

    it('dispatches a turn_synopsis for a task_progress event with a summary, generated for the current (responding) phase', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);
        onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();

        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'still working',
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'responding', subagentSummary: 'still working' }));
        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_synopsis', text: 'Generated synopsis' }));
    });

    it('does not regenerate for a repeated task_progress summary on the same task', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);
        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'same summary',
        } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'same summary',
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).not.toHaveBeenCalled();
        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    it('does not dispatch anything for a result event', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({ type: 'result' } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    it('caps recentToolCalls at MAX_RECENT_TOOLS (3), dropping the oldest', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

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

        const lastCallArgs = (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as { recentToolCalls?: string[] };
        expect(lastCallArgs.recentToolCalls).toEqual(['Tool4', 'Tool3', 'Tool2']);
    });

    it('regenerates a fresh thinking synopsis once tool history exists', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();

        // No delta text, no accumulated thinking content — but tool history now exists, so this
        // must take the regeneration branch.
        onStreamEvent({ type: 'assistant', message: { content: [] } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'thinking', recentToolCalls: ['Read'], thinkingContent: undefined,
        }));
        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_synopsis', text: 'Generated synopsis' }));
    });

    it('a regeneration that throws after tool history exists dispatches nothing (no fallback)', async () => {
        mockGenerator.generateSynopsis = mock(async () => {
            throw new Error('LLM error');
        });
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        onStreamEvent({ type: 'assistant', message: { content: [] } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledTimes(2);
        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    it('a thinking transition with accumulated thinking content but no tool history still generates', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'weighing options' }] } } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith({
            phase: 'thinking', userMessage: 'Test message', thinkingContent: 'weighing options', recentToolCalls: [], subagentSummary: undefined,
        });
        expect(sink.dispatch).toHaveBeenCalledTimes(1);
    });

    it('caps accumulated thinking content at 1500 chars, keeping the most recent tail', () => {
        const capturedUpdates: string[] = [];
        const { onStreamEvent } = createSynopsisStreamHandler({
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

    it('passes accumulated thinking content to live thinking synopsis generation', () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'checking the evidence' }] },
        } as unknown as AgentStreamEvent);

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'thinking', thinkingContent: 'checking the evidence',
        }));
    });

    it('ignores a thinking-shaped property on non-thinking content blocks', () => {
        const onThinkingContentUpdate = mock(() => undefined);
        const { onStreamEvent } = createSynopsisStreamHandler({ ...baseDeps, onThinkingContentUpdate });

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'text', thinking: 'not model thinking', text: 'reply' }] },
        } as unknown as AgentStreamEvent);

        expect(onThinkingContentUpdate).not.toHaveBeenCalled();
    });

    it('dispatches a turn_synopsis for a tool_progress event, falling back to "unknown" when tool_name is absent', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({ type: 'tool_progress' } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'unknown' }));
        expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_synopsis', text: 'Generated synopsis' }));
    });

    it('a result frame clears the per-task summary dedupe map, so the same summary regenerates on the next turn', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);
        const progress = {
            type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'still working',
        } as unknown as AgentStreamEvent;

        onStreamEvent(progress);
        await flushPromises();
        expect(mockGenerator.generateSynopsis).toHaveBeenCalledTimes(1);

        // Without the result case's `lastSummaryByTask.clear()`, the identical summary below
        // dedupes against the first one and never regenerates.
        onStreamEvent({ type: 'result' } as unknown as AgentStreamEvent);
        onStreamEvent(progress);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledTimes(2);
    });

    it('a result frame drops the latest sub-agent summary so a later tool synopsis does not carry it', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'sub-agent said this',
        } as unknown as AgentStreamEvent);
        await flushPromises();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent({ type: 'result' } as unknown as AgentStreamEvent);
        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({ subagentSummary: undefined }));
    });

    it('accumulates response text across frames, so a later synopsis carries it', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({ type: 'assistant', delta: { text: 'part one ' } } as unknown as AgentStreamEvent);
        await flushPromises();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent({
            type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({ accumulatedText: 'part one ' }));
    });

    it('does not generate another responding synopsis for a second frame in the same phase', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);
        onStreamEvent({ type: 'assistant', delta: { text: 'part one ' } } as unknown as AgentStreamEvent);
        await flushPromises();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent({ type: 'assistant', delta: { text: 'part two' } } as unknown as AgentStreamEvent);

        expect(mockGenerator.generateSynopsis).not.toHaveBeenCalled();
    });

    it('ignores summaries on system events that are not task progress', () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({ type: 'system', subtype: 'init', summary: 'not progress' } as unknown as AgentStreamEvent);

        expect(mockGenerator.generateSynopsis).not.toHaveBeenCalled();
    });

    it('generates task progress in thinking phase with accumulated thinking and tool history', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);
        onStreamEvent({
            type:    'assistant', message: { content: [
                { type: 'thinking', thinking: 'working it out' },
                { type: 'tool_use', id: 'tool1', name: 'Read', input: {} },
            ] },
        } as unknown as AgentStreamEvent);
        await flushPromises();
        onStreamEvent({ type: 'assistant', message: { content: [] } } as unknown as AgentStreamEvent);
        await flushPromises();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'still working',
        } as unknown as AgentStreamEvent);

        expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith({
            phase:           'thinking',
            userMessage:     'Test message',
            subagentSummary: 'still working',
            thinkingContent: 'working it out',
            recentToolCalls: ['Read'],
        });
    });

    it('dedupes a task_progress with no task_id against one with an explicit empty-string task_id (pins the "" fallback)', async () => {
        const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

        onStreamEvent({
            type: 'system', subtype: 'task_progress', summary: 'no task id here',
        } as unknown as AgentStreamEvent);
        await flushPromises();
        sink.dispatch.mockClear();
        (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

        // Same summary, this time with an EXPLICIT task_id of '' — only dedupes against the
        // first event if the missing-task_id fallback is truly the empty string, not some other
        // sentinel value.
        onStreamEvent({
            type: 'system', subtype: 'task_progress', task_id: '', summary: 'no task id here',
        } as unknown as AgentStreamEvent);
        await flushPromises();

        expect(mockGenerator.generateSynopsis).not.toHaveBeenCalled();
        expect(sink.dispatch).not.toHaveBeenCalled();
    });

    describe('the seed (thinkingSynopsis) is dispatched as soon as it settles, at most once per handler', () => {
        // Defect 1 (production log, 2026-09-08): the old fallback fired on EVERY thinking
        // transition where generation was skipped, so the turn's first synopsis ("Audit trail…")
        // overwrote two fresher ones minutes later — and each overwrite reached Discord
        // immediately via presence-setup's synopsis-arrival bypass.
        it('dispatches the seed at CONSTRUCTION, with no stream event at all', async () => {
            // #39 design review, challenge 1: the seed spends the session's budget, so waiting for
            // a `thinking` transition that a tool-first or text-first turn never has would leave
            // that turn with no synopsis for a whole window.
            createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis: Promise.resolve('Seed synopsis') });
            await flushPromises();

            expect(sink.dispatch.mock.calls).toEqual([[{ type: 'turn_synopsis', turnId: 'turn-1', text: 'Seed synopsis', at: AT }]]);
        });

        it('without a seed, construction alone dispatches nothing', async () => {
            createSynopsisStreamHandler(baseDeps);
            await flushPromises();

            expect(sink.dispatch).not.toHaveBeenCalled();
        });

        it('a seed goes out once, never again on later thinking transitions', async () => {
            budget.shouldGenerate = mock(() => false);
            const { onStreamEvent } = createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis: Promise.resolve('Seed synopsis') });
            await flushPromises();
            expect(sink.dispatch).toHaveBeenCalledTimes(1);

            onStreamEvent({ type: 'assistant' } as unknown as AgentStreamEvent);
            onStreamEvent({ type: 'tool_progress', tool_name: 'Read' } as unknown as AgentStreamEvent);
            onStreamEvent({ type: 'assistant' } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(sink.dispatch).toHaveBeenCalledTimes(1);
        });

        it('a seed resolving AFTER a tool-first frame (budget closed) still dispatches once it settles', async () => {
            budget.shouldGenerate = mock(() => false);
            let resolveSeed!: (value: string | undefined) => void;
            const thinkingSynopsis = new Promise<string | undefined>((resolve) => {
                resolveSeed = resolve;
            });
            const { onStreamEvent } = createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis });

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();
            expect(sink.dispatch).not.toHaveBeenCalled();

            resolveSeed('Late seed');
            await flushPromises();

            expect(sink.dispatch.mock.calls).toEqual([[{ type: 'turn_synopsis', turnId: 'turn-1', text: 'Late seed', at: AT }]]);
        });

        it('a seed that went out first is superseded by a later live synopsis (both dispatched, seed first)', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis: Promise.resolve('Seed synopsis') });
            await flushPromises();

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(sink.dispatch.mock.calls.map(call => (call[0] as { text: string }).text)).toEqual(['Seed synopsis', 'Generated synopsis']);
        });

        it('a seed resolving to undefined dispatches nothing', async () => {
            createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis: Promise.resolve(undefined) });
            await flushPromises();

            expect(sink.dispatch).not.toHaveBeenCalled();
        });

        it('a rejecting seed dispatches nothing and raises no unhandled rejection', async () => {
            createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis: Promise.reject(new Error('seed generation failed')) });
            await flushPromises();

            expect(sink.dispatch).not.toHaveBeenCalled();
        });

        it('complete() before the seed settles suppresses its dispatch', async () => {
            let resolveSeed!: (value: string | undefined) => void;
            const thinkingSynopsis = new Promise<string | undefined>((resolve) => {
                resolveSeed = resolve;
            });
            const { complete } = createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis });

            complete();
            resolveSeed('Too late');
            await flushPromises();

            expect(sink.dispatch).not.toHaveBeenCalled();
        });

        it('a fresher live synopsis dispatched first means the stale seed is never dispatched', async () => {
            let resolveSeed!: (value: string | undefined) => void;
            const thinkingSynopsis = new Promise<string | undefined>((resolve) => {
                resolveSeed = resolve;
            });
            const { onStreamEvent } = createSynopsisStreamHandler({ ...baseDeps, thinkingSynopsis });

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();
            expect(sink.dispatch).toHaveBeenCalledTimes(1);

            resolveSeed('Stale seed');
            await flushPromises();

            expect(sink.dispatch).toHaveBeenCalledTimes(1);
            expect(sink.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'Stale seed' }));
        });

        it('dispatches nothing when a regeneration fails and there is no seed', async () => {
            mockGenerator.generateSynopsis = mock(async () => {
                throw new Error('LLM error');
            });
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            // Tool history first (so the thinking transition takes the regeneration branch), then
            // a thinking transition whose regeneration throws.
            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();
            onStreamEvent({ type: 'assistant' } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(sink.dispatch).not.toHaveBeenCalled();
        });
    });

    describe('complete assistant text frames are responding, not thinking', () => {
        // Defect 2: `delta` only exists on PARTIAL stream events, so a complete assistant message
        // carrying a text block registered as a thinking transition (mirrors phaseFromAssistant in
        // src/agent/session/activity-phase.ts, which already gets this right for the ledger).
        it('classifies a complete message with a non-empty text block as responding, accumulating that text', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'text', text: 'Here is the answer' }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase:           'responding',
                accumulatedText: 'Here is the answer',
            }));
            expect(sink.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_synopsis', text: 'Generated synopsis' }));
        });

        it('does not carry a redundant responseFragment on the responding context', async () => {
            // The handler appends the text to accumulatedText BEFORE building the context, so a
            // separate fragment field would only duplicate its tail.
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'text', text: 'Here is the answer' }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            const args = (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as Record<string, unknown>;
            expect(args).not.toHaveProperty('responseFragment');
        });

        it('prefers a real text block over an empty delta (an empty delta must not mask it)', async () => {
            // `??` would have taken the empty-string delta and classified the frame as thinking.
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type:    'assistant',
                delta:   { text: '' },
                message: { content: [{ type: 'text', text: 'Real answer' }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase:           'responding',
                accumulatedText: 'Real answer',
            }));
        });

        it('concatenates every non-empty text block of a frame, in order', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'First half. ' },
                        { type: 'text', text: 'Second half.' },
                    ],
                },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase:           'responding',
                accumulatedText: 'First half. Second half.',
            }));
        });

        it('accumulates complete-frame text into accumulatedText, keeping the 200-char tail', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'text', text: 'a'.repeat(150) }] },
            } as unknown as AgentStreamEvent);
            // Already responding, so this frame dispatches nothing — it only accumulates.
            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'text', text: 'b'.repeat(100) }] },
            } as unknown as AgentStreamEvent);
            // A tool transition captures the accumulated text as it stands.
            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            const args = (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as { accumulatedText?: string };
            expect(args.accumulatedText).toBe('a'.repeat(100) + 'b'.repeat(100));
        });

        it('takes the reply text from the block whose own type is text, not from any block carrying a text field', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        // A non-text block that happens to carry a `text` property must be ignored:
                        // the block TYPE decides, not the mere presence of the field.
                        { type: 'thinking', thinking: 'pondering', text: 'not the reply' },
                        { type: 'text', text: 'Real answer' },
                    ],
                },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase: 'responding', accumulatedText: 'Real answer',
            }));
        });

        it('does not append anything to accumulatedText for a frame with no response text', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            // A content-less (thinking) frame carries no response text at all.
            onStreamEvent({ type: 'assistant' } as unknown as AgentStreamEvent);
            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase: 'responding', accumulatedText: 'Hello',
            }));
        });

        it('still treats a text block with empty text as thinking (a context-less thinking transition generates nothing; responding would)', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'text', text: '' }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(mockGenerator.generateSynopsis).not.toHaveBeenCalled();
            // …and it WAS a thinking transition: a following responding frame is a phase change.
            onStreamEvent({ type: 'assistant', delta: { text: 'Hi' } } as unknown as AgentStreamEvent);
            await flushPromises();
            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({ phase: 'responding' }));
        });
    });

    describe('dropped guards and unobservable-fallback coverage', () => {
        it('passes accumulatedText: undefined (not empty string) to a using_tool synopsis when no prior response text has accumulated', () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase: 'using_tool', accumulatedText: undefined,
            }));
        });

        it('carries the latest sub-agent summary into a using_tool synopsis without an intervening result', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'sub-agent said this',
            } as unknown as AgentStreamEvent);
            await flushPromises();
            (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase: 'using_tool', subagentSummary: 'sub-agent said this',
            }));
        });

        it('carries the latest sub-agent summary into a responding synopsis without an intervening result', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'sub-agent said this',
            } as unknown as AgentStreamEvent);
            await flushPromises();
            (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

            onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as unknown as AgentStreamEvent);

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase: 'responding', subagentSummary: 'sub-agent said this',
            }));
        });

        it('captures an isolated snapshot of recentToolCalls for live thinking regeneration, unaffected by a later tool call', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();
            (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

            onStreamEvent({ type: 'assistant', message: { content: [] } } as unknown as AgentStreamEvent);
            const thinkingCallArgs = (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mock.calls[0][0] as { recentToolCalls?: string[] };

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool2', name: 'Bash', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(thinkingCallArgs.recentToolCalls).toEqual(['Read']);
        });

        it('carries the latest sub-agent summary into a live thinking regeneration synopsis', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'sub-agent said this',
            } as unknown as AgentStreamEvent);
            await flushPromises();
            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();
            (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

            onStreamEvent({ type: 'assistant', message: { content: [] } } as unknown as AgentStreamEvent);

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase: 'thinking', subagentSummary: 'sub-agent said this',
            }));
        });

        it('concatenates accumulated thinking content across multiple thinking blocks instead of overwriting it', () => {
            const capturedUpdates: string[] = [];
            const { onStreamEvent } = createSynopsisStreamHandler({
                ...baseDeps,
                onThinkingContentUpdate: (content) => {
                    capturedUpdates.push(content);
                },
            });

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'first part ' }] },
            } as unknown as AgentStreamEvent);
            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'second part' }] },
            } as unknown as AgentStreamEvent);

            expect(capturedUpdates.at(-1)).toBe('first part second part');
        });

        it('accumulates a text block by its own .text field even when a stray .thinking property is also present', () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type:    'assistant',
                message: { content: [{ type: 'text', text: 'the real reply', thinking: 'stray field' }] },
            } as unknown as AgentStreamEvent);

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                phase: 'responding', accumulatedText: 'the real reply',
            }));
        });

        it('passes thinkingContent: undefined (not empty string) to a task_progress synopsis with no accumulated thinking yet', () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'still working',
            } as unknown as AgentStreamEvent);

            expect(mockGenerator.generateSynopsis).toHaveBeenCalledWith(expect.objectContaining({
                thinkingContent: undefined,
            }));
        });

        it('captures an isolated snapshot of recentToolCalls in a task_progress synopsis, unaffected by a later tool call', async () => {
            const { onStreamEvent } = createSynopsisStreamHandler(baseDeps);

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();
            (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

            onStreamEvent({
                type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'still working',
            } as unknown as AgentStreamEvent);
            const taskProgressArgs = (mockGenerator.generateSynopsis as ReturnType<typeof mock>).mock.calls[0][0] as { recentToolCalls?: string[] };

            onStreamEvent({
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool2', name: 'Bash', input: {} }] },
            } as unknown as AgentStreamEvent);
            await flushPromises();

            expect(taskProgressArgs.recentToolCalls).toEqual(['Read']);
        });
    });
});
