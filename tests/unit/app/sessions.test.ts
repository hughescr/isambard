/**
 * Behavioural tests for {@link createConversationConductor} (P9): assembles the conversation
 * conductor's Options-building dependencies (MCP servers, system prompt, hooks, context policy)
 * and returns a Conductor that BUILDS but does not open. Uses P3's {@link fakeQueryFn}/
 * {@link FakeQuery}, {@link FakeClock}, and the P3/P7 in-memory port doubles ({@link FakeJournal},
 * {@link FakeResumeStore}).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { PostToolUseHookInput, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import { FakeClock } from '../../helpers/fake-clock';
import { makeHealthRegistry } from '../../helpers/fake-health-registry';
import { FakeJournal } from '../../helpers/fake-journal';
import { fakeQueryFn, type FakeQuery } from '../../helpers/fake-query';
import { FakeResumeStore } from '../../helpers/fake-resume-store';
import * as frames from '../../helpers/sdk-frames';
import { mockLogger } from '../../setup';
import { DEFAULT_STEP_PERCENT, createLedgerStore, type ContextBuilder, type Envelope, type QuotaFetch, type QuotaFetchResponse, type TimeHeaderProvider } from '@/agent';
import type { JournalEntry } from '@/agent/session/types';
import * as mcpServersModule from '@/app/mcp-servers';
import type { McpSharedDeps } from '@/app/mcp-servers';
import { createConversationConductor, createPerchConductor, createSessionAmbience, type CreateConversationConductorParams, type CreatePerchConductorParams, type SessionAmbience } from '@/app/sessions';
import { sessionConfigSchema, type SessionConfig } from '@/config/schemas';
import { formatTimeHeader } from '@/utils';

type MCPServers = ReturnType<typeof mcpServersModule.createMcpServerInstances>;

/** Flushes enough microtask ticks for promise chains to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

const FAKE_MCP_SERVERS: MCPServers = {
    memoryMcpServer:    { name: 'memory' } as unknown as MCPServers['memoryMcpServer'],
    discordMcpServer:   { name: 'discord' } as unknown as MCPServers['discordMcpServer'],
    inboxMcpServer:     { name: 'inbox' } as unknown as MCPServers['inboxMcpServer'],
    wikipediaMcpServer: { name: 'wikipedia' } as unknown as MCPServers['wikipediaMcpServer'],
    mediaMcpServer:     { name: 'media' } as unknown as MCPServers['mediaMcpServer'],
};

type FakeMcpServerConfig = MCPServers['memoryMcpServer'];

/** All twelve server slots populated, each with a distinguishable value, for asserting the exact key mapping onto `SessionMcpServers`. */
const FULL_MCP_SERVERS: Required<MCPServers> = {
    memoryMcpServer:      { name: 'memory' } as unknown as FakeMcpServerConfig,
    discordMcpServer:     { name: 'discord' } as unknown as FakeMcpServerConfig,
    inboxMcpServer:       { name: 'inbox' } as unknown as FakeMcpServerConfig,
    bskyMcpServer:        { name: 'bsky' } as unknown as FakeMcpServerConfig,
    caldavMcpServer:      { name: 'caldav' } as unknown as FakeMcpServerConfig,
    wikipediaMcpServer:   { name: 'wikipedia' } as unknown as FakeMcpServerConfig,
    contactsMcpServer:    { name: 'contacts' } as unknown as FakeMcpServerConfig,
    userContextMcpServer: { name: 'user-context' } as unknown as FakeMcpServerConfig,
    mediaMcpServer:       { name: 'media' } as unknown as FakeMcpServerConfig,
    browserMcpServer:     { name: 'browser' } as unknown as FakeMcpServerConfig,
    emailMcpServer:       { name: 'email' } as unknown as FakeMcpServerConfig,
    healthMcpServer:      { name: 'health' } as unknown as FakeMcpServerConfig,
};

const DEFAULT_CONFIG: SessionConfig = sessionConfigSchema.parse({});

function fakeContextBuilder(overrides: Partial<ContextBuilder> = {}): Pick<ContextBuilder, 'loadHotState' | 'loadRecentEventsSince' | 'loadStateTopSet' | 'buildPerchContext' | 'loadCalendarAgenda'> {
    return {
        loadHotState:          jest.fn(() => Promise.resolve('')),
        loadRecentEventsSince: jest.fn(() => Promise.resolve([])),
        loadStateTopSet:       jest.fn(() => Promise.resolve([])),
        buildPerchContext:     jest.fn(() => Promise.resolve('')),
        loadCalendarAgenda:    jest.fn(() => Promise.resolve([])),
        ...overrides,
    };
}

/**
 * The `IdentitySource` half of a fake `IdentityCache`: change listeners, a revision counter, and a
 * `fireIdentityChange()` that models an identity write (bump the revision, then notify), plus a
 * `setRevision` for tests that need to move the revision from INSIDE a `get()` — the shape of a
 * second write landing mid-load.
 */
function fakeIdentitySource(): {
    onChange:           ReturnType<typeof jest.fn>
    revision:           ReturnType<typeof jest.fn>
    fireIdentityChange: () => void
    setRevision:        (value: number) => void
} {
    const listeners: (() => void)[] = [];
    let revisionValue = 0;
    return {
        onChange: jest.fn((listener: () => void) => {
            listeners.push(listener);
            return () => {
                listeners.splice(listeners.indexOf(listener), 1);
            };
        }),
        revision:           jest.fn(() => revisionValue),
        fireIdentityChange: () => {
            revisionValue += 1;
            for(const listener of listeners) {
                listener();
            }
        },
        setRevision: (value: number) => { revisionValue = value; },
    };
}

function build(overrides: Partial<CreateConversationConductorParams> = {}) {
    const { queryFn, instances } = fakeQueryFn();
    const clock = new FakeClock(0);
    const journal = new FakeJournal();
    const resumeStore = new FakeResumeStore();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const identityGet = jest.fn(() => Promise.resolve('I am Izzy'));
    const identitySource = fakeIdentitySource();
    const { onChange: identityOnChange, revision: identityRevision, fireIdentityChange } = identitySource;
    const contextBuilder = fakeContextBuilder();
    const taskListReader = { buildTaskListSummary: jest.fn(() => Promise.resolve(undefined)) };
    const channelListProvider = jest.fn(() => Promise.resolve('#general'));

    const params: CreateConversationConductorParams = {
        config:        DEFAULT_CONFIG,
        queryFn,
        mcpShared:     {} as McpSharedDeps,
        contextBuilder,
        identityCache: { get: identityGet, onChange: identityOnChange, revision: identityRevision },
        taskListReader,
        journal,
        resumeStore,
        channelListProvider,
        clock,
        logger,
        ...overrides,
    };

    return {
        params, instances, clock, journal, resumeStore, logger, identityGet, identityOnChange, identityRevision, fireIdentityChange,
        setIdentityRevision: identitySource.setRevision,
        contextBuilder, taskListReader, channelListProvider,
    };
}

describe('createConversationConductor', () => {
    let createInstancesSpy: ReturnType<typeof jest.spyOn>;

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('builds MCP server instances exactly once, with role \'conversation\' and the given emailServerFactory', async () => {
        const h = build();
        createInstancesSpy = jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const emailServerFactory = jest.fn();

        await createConversationConductor({ ...h.params, emailServerFactory });

        expect(createInstancesSpy).toHaveBeenCalledTimes(1);
        expect(createInstancesSpy).toHaveBeenCalledWith(h.params.mcpShared, { role: 'conversation', emailServerFactory });
    });

    it('builds the system prompt once at construction, and not again per open', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        expect(h.identityGet).toHaveBeenCalledTimes(1);

        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        expect(h.identityGet).toHaveBeenCalledTimes(1);
        expect(h.instances[0].receivedParams?.options.systemPrompt).toContain('I am Izzy');
        expect(h.instances[0].receivedParams?.options.model).toBe('sonnet');
    });

    it('rebuilds the system prompt and reopens the session when the identity changes', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        h.identityGet.mockResolvedValue('I am Izzy, revised');
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(2);
        expect(h.instances[1].receivedParams?.options.systemPrompt).toContain('I am Izzy, revised');
        // The dead session keeps the prompt it was born with — the SDK fixes it at query() time.
        expect(h.instances[0].receivedParams?.options.systemPrompt).not.toContain('revised');
        expect(h.journal.byKind('session_reopen_requested').at(-1)).toMatchObject({ reason: 'an identity change' });
    });

    it('the refreshed identity reaches the effort sub-agent definitions too', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        h.identityGet.mockResolvedValue('I am Izzy, revised');
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances[1].receivedParams?.options.agents?.high.prompt).toContain('I am Izzy, revised');
    });

    it('an identity change that renders the same prompt reopens nothing', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        // Not every identity-layer write changes what loadCoreIdentity renders.
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(1);
    });

    it('a failing identity reload is logged and reopens nothing', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        h.identityGet.mockRejectedValue(new Error('DynamoDB throttled'));
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(1);
        expect(h.logger.error).toHaveBeenCalledWith(
            { error: expect.any(Error) }, 'Rebuilding the conversation system prompt after an identity change failed'
        );
    });

    it('two identity changes in a row rebuild in order; the reopened session carries the last', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        h.identityGet.mockResolvedValue('identity one');
        h.fireIdentityChange();
        h.identityGet.mockResolvedValue('identity two');
        h.fireIdentityChange();
        await flush();
        await flush();
        h.instances[1].emit(frames.init('sess-1'));
        await flush();
        await flush();

        expect(h.instances.at(-1)?.receivedParams?.options.systemPrompt).toContain('identity two');
    });

    it('a load superseded mid-flight is discarded — its stale text never reaches a prompt', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        // The revision moves DURING the get(), exactly as a second write landing mid-load would:
        // this value is already superseded, and the newer change queues its own refresh.
        h.identityGet.mockImplementation(() => {
            h.setIdentityRevision(99);
            return Promise.resolve('stale identity');
        });
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(1);
    });

    it('an identity write landing between the startup read and the subscription is still picked up', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        // The revision the factory captured before its own await no longer matches by the time it
        // subscribes — a write landed in that window and fired no listener anybody had registered.
        h.identityGet.mockImplementation(() => {
            h.setIdentityRevision(7);
            return Promise.resolve('I am Izzy');
        });

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        expect(h.identityGet.mock.calls.length).toBeGreaterThan(1);
    });

    it('registers the effort sub-agent tiers, each carrying the Isambard sub-agent prompt built from the same identity', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const agents = h.instances[0].receivedParams?.options.agents;
        expect(Object.keys(agents ?? {})).toEqual(expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'general-purpose', 'luna-medium', 'deepseek-flash-low']));
        expect(agents?.high.prompt).toContain('I am Izzy');
        expect(agents?.high.prompt).toContain('sub-agent of Isambard');
        // One identity read feeds both prompts — the sub-agent prompt is not a second load.
        expect(h.identityGet).toHaveBeenCalledTimes(1);
    });

    it('passes the stored resume id through to the SDK options on open()', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        await h.resumeStore.save('conversation', 'sess-stored');

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-stored'));
        await openPromise;

        expect(h.instances[0].receivedParams?.options.resume).toBe('sess-stored');
    });

    it('does not invoke channelListProvider at build time — only lazily, at hook time', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        await createConversationConductor(h.params);

        expect(h.channelListProvider).not.toHaveBeenCalled();
    });

    it('merges a SessionStart boot-bundle hook that fires for both \'startup\' (mapped to \'fresh\') and \'compact\' sources — only \'fresh\' carries recentUsers, per R1\'s per-kind section set', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        // Submit a discord envelope so recordRecentAuthor has something to report, then let its
        // turn finish so a subsequent hook fire can observe the ledger's live task afterward.
        const submitPromise = conductor.submit(
            {
                id: 'env-1', kind: 'discord', text: 'hi', channelId: 'chan-1', authorId: 'user-42', origin: { kind: 'human' }, hostPriority: 'human', shouldQuery: true, createdAt: new Date(0),
            },
            { priority: 'human', requestingChannelId: 'chan-1' }
        );
        await flush();
        h.instances[0].emit(frames.resultSuccess());
        await submitPromise;

        const options = h.instances[0].receivedParams?.options;
        const startHooks = options?.hooks?.SessionStart;
        expect(startHooks).toBeDefined();
        const hookFn = startHooks?.[0]?.hooks[0];
        expect(hookFn).toBeDefined();

        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
        expect(startupContext).toContain('[BOOT BUNDLE · conversation · fresh]');
        expect(startupContext).toContain('user-42');

        // 'compact' renders no recentUsers section at all (R1's per-kind contract) — nothing was
        // lost across a compaction, so who Izzy was recently talking to is not re-seeded here.
        const compactResult = await hookFn?.({ source: 'compact' } as never, undefined, undefined as never);
        const compactContext = (compactResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
        expect(compactContext).toContain('[BOOT BUNDLE · conversation · compact]');
        expect(compactContext).not.toContain('user-42');
    });

    it('PreCompact dispatches compaction_started onto the ledger; PostCompact resets the context policy and records the compaction summary', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore, contextPolicy } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        contextPolicy.markInjected('user-1', 'block text');
        expect(contextPolicy.shouldInjectUserMemory('user-1', 'block text')).toBe(false);

        const options = h.instances[0].receivedParams?.options;
        const preCompact = options?.hooks?.PreCompact?.[0]?.hooks[0];
        const postCompact = options?.hooks?.PostCompact?.[0]?.hooks[0];
        expect(preCompact).toBeDefined();
        expect(postCompact).toBeDefined();

        await preCompact?.({ trigger: 'auto', session_id: 'sess-1', hook_event_name: 'PreCompact' } as never, undefined, undefined as never);
        expect(ledgerStore.get().compaction).toBe('compacting');

        await postCompact?.({ compact_summary: 'summary text', session_id: 'sess-1', hook_event_name: 'PostCompact' } as never, undefined, undefined as never);

        expect(contextPolicy.shouldInjectUserMemory('user-1', 'block text')).toBe(true);
    });

    it('R1: a \'resume\' SessionStart source maps to the \'resume\' BootKind and renders NO lost-task/undelivered content — that content is the merged Discord boot envelope\'s exclusive responsibility (sourced instead from the returned bootLostTasks)', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        h.journal.scriptReadSince([
            { type: 'task_started', at: new Date(0), taskId: 'task-orphan', description: 'Summarize last week' },
        ]);

        const { conductor, bootLostTasks } = await createConversationConductor(h.params);
        expect(bootLostTasks).toEqual(['Summarize last week']);

        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const resumeResult = await hookFn?.({ source: 'resume' } as never, undefined, undefined as never);
        const resumeContext = (resumeResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        // Every resume section is empty (fresh/resume always pass lostTasks/undelivered as `[]`
        // to the boot-bundle builder — see buildBootBundleText's own doc), so the bundle text is
        // `''` and the hook adds no additionalContext at all.
        expect(resumeContext).toBe('');
    });

    it('R1: degrades to an empty recovery section (and logs a warning) when the journal readSince read fails', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        h.journal.scriptReadSinceRejection(new Error('DynamoDB unavailable'));

        const { conductor, bootLostTasks } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(startupContext).toContain('[BOOT BUNDLE · conversation · fresh]');
        expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Conversation boot-bundle recovery read failed; continuing with an empty recovery section');
        // Pins the catch branch's degrade-to-empty return value exactly — not some other
        // "falsy-looking" placeholder a mutant could substitute.
        expect(bootLostTasks).toEqual([]);
    });

    it('R1: loadBootRecovery reads the journal from exactly 24h (RECOVERY_WINDOW_MS) before the clock\'s current time', async () => {
        const h = build();
        h.clock.advance(100_000);
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const readSinceSpy = jest.spyOn(h.journal, 'readSince');

        await createConversationConductor(h.params);

        expect(readSinceSpy).toHaveBeenCalledWith(100_000 - 24 * 60 * 60 * 1000);
    });

    it('R1: a "compact" boot bundle falls back to the 24h default window (DEFAULT_BOOT_EVENTS_WINDOW_MS) when no events mark has ever been seeded', async () => {
        const h = build();
        h.clock.advance(5000);
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        await hookFn?.({ source: 'compact' } as never, undefined, undefined as never);

        expect(h.contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(24 * 60 * 60 * 1000, expect.any(Number), new Date(5000));
    });

    it('R1: markEventsSeen is never called for a non-compact boot kind', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, contextPolicy } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const markEventsSeenSpy = jest.spyOn(contextPolicy, 'markEventsSeen');
        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];

        await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        await hookFn?.({ source: 'resume' } as never, undefined, undefined as never);

        expect(markEventsSeenSpy).not.toHaveBeenCalled();
    });

    it('R1: a \'compact\' boot bundle renders events since the context policy\'s current mark, then advances the mark once the bundle is built', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        h.clock.advance(10_000);
        (h.contextBuilder.loadRecentEventsSince as ReturnType<typeof jest.fn>).mockResolvedValue([
            { path: 'state/foo.md', content: 'Foo happened', contentPreview: 'Foo happened', updatedAt: new Date(9000) },
        ]);

        const { conductor, contextPolicy } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        contextPolicy.markEventsSeenAt(5000);
        expect(contextPolicy.eventsSinceMs()).toBe(5000);

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const compactResult = await hookFn?.({ source: 'compact' } as never, undefined, undefined as never);
        const compactContext = (compactResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(h.contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(10_000 - 5000, expect.any(Number), new Date(10_000));
        expect(compactContext).toContain('Foo happened');
        // The mark has advanced to the clock's current time (10_000), not the pre-build 5_000 —
        // a later compaction's window starts from here rather than replaying this same event.
        expect(contextPolicy.eventsSinceMs()).toBe(10_000);
    });

    it('R1: mutation guard — a \'resume\' boot bundle never queries events, even when the context policy already carries an events mark (only \'compact\' reads the mark)', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, contextPolicy } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        // A mark left over from an earlier compaction — if the `kind === 'compact'` guard were
        // ever weakened (e.g. mutated to `true`), a 'resume' bundle would start reading events
        // against this mark instead of rendering none at all.
        contextPolicy.markEventsSeenAt(5000);
        (h.contextBuilder.loadRecentEventsSince as ReturnType<typeof jest.fn>).mockClear();

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        await hookFn?.({ source: 'resume' } as never, undefined, undefined as never);

        expect(h.contextBuilder.loadRecentEventsSince).not.toHaveBeenCalled();
    });

    it('returns a Conductor, a LedgerStore for role \'conversation\', and a ContextPolicy', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const result = await createConversationConductor(h.params);

        expect(result.ledgerStore.get().role).toBe('conversation');
        expect(typeof result.conductor.submit).toBe('function');
        expect(typeof result.contextPolicy.resetAll).toBe('function');
    });

    it('Q12: threads a supplied healthRegistry into the context policy\'s healthNote gate', async () => {
        const healthRegistry = makeHealthRegistry({ summary: 'Email is degraded.' });
        const h = build({ healthRegistry });
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { contextPolicy } = await createConversationConductor(h.params);

        expect(contextPolicy.healthNote()).toBe('Email is degraded.');
    });

    it('Q12: healthNote() always returns undefined when no healthRegistry is supplied', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { contextPolicy } = await createConversationConductor(h.params);

        expect(contextPolicy.healthNote()).toBeUndefined();
    });

    it('returns a compactionTelemetry subscribed to the ledgerStore, recording a compaction_started/compact_boundary pair as one completed record', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { ledgerStore, compactionTelemetry } = await createConversationConductor(h.params);

        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(5) });
        ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.compactBoundary(), at: new Date(10) });

        expect(compactionTelemetry.getRecords()).toEqual([
            { startedAt: new Date(5), thresholdAtStart: DEFAULT_CONFIG.compactThresholdPercent, finishedAt: new Date(10) },
        ]);
    });

    it('compactionTelemetry reads the conductor\'s live threshold at each compaction_started, not a value cached at construction', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore, compactionTelemetry } = await createConversationConductor(h.params);
        conductor.setCompactionThresholdPercent(77);

        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(0) });

        expect(compactionTelemetry.getRecords()).toHaveLength(1);
        expect(compactionTelemetry.getRecords()[0].thresholdAtStart).toBe(77);
    });

    // Q11: createConversationConductor wires createCompactionThresholdTuner to the ledgerStore
    // (and Q4's compactionTelemetry), so observed compaction intervals move the guard's live
    // threshold once a band is configured -- and the wrapped conductor object (the `submit`
    // spread wrapper) still exposes the change through its own getCompactionThresholdPercent.
    it('constructs a compaction threshold tuner that adjusts the wrapped conductor\'s threshold once a band is configured', async () => {
        const h = build({
            config: {
                ...DEFAULT_CONFIG,
                compactThresholdMinPercent: 10,
                compactThresholdMaxPercent: 90,
                compactTargetIntervalMs:    100,
            },
        });
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore } = await createConversationConductor(h.params);
        expect(conductor.getCompactionThresholdPercent()).toBe(DEFAULT_CONFIG.compactThresholdPercent);

        // Three compaction cycles 1000ms apart -- far longer than the 100ms target -- give the
        // tuner two observed intervals, enough to take one bounded step down.
        for(let i = 0; i < 3; i += 1) {
            ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(i * 1000) });
            ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.compactBoundary(), at: new Date(i * 1000 + 500) });
        }

        expect(conductor.getCompactionThresholdPercent()).toBe(DEFAULT_CONFIG.compactThresholdPercent - DEFAULT_STEP_PERCENT);
    });

    it('with all three tuner band fields unset, the guard threshold never leaves compactThresholdPercent across many observed compactions', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore } = await createConversationConductor(h.params);

        for(let i = 0; i < 5; i += 1) {
            ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(i * 1000) });
            ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.compactBoundary(), at: new Date(i * 1000 + 1) });
        }

        expect(conductor.getCompactionThresholdPercent()).toBe(DEFAULT_CONFIG.compactThresholdPercent);
    });

    it('wires all twelve MCP server instances into the session\'s SDK options, correctly keyed', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FULL_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        expect(h.instances[0].receivedParams?.options.mcpServers).toEqual({
            memory:         FULL_MCP_SERVERS.memoryMcpServer,
            discord:        FULL_MCP_SERVERS.discordMcpServer,
            inbox:          FULL_MCP_SERVERS.inboxMcpServer,
            bsky:           FULL_MCP_SERVERS.bskyMcpServer,
            caldav:         FULL_MCP_SERVERS.caldavMcpServer,
            wikipedia:      FULL_MCP_SERVERS.wikipediaMcpServer,
            contacts:       FULL_MCP_SERVERS.contactsMcpServer,
            'user-context': FULL_MCP_SERVERS.userContextMcpServer,
            media:          FULL_MCP_SERVERS.mediaMcpServer,
            browser:        FULL_MCP_SERVERS.browserMcpServer,
            email:          FULL_MCP_SERVERS.emailMcpServer,
            health:         FULL_MCP_SERVERS.healthMcpServer,
        });
    });

    it('carries the ledger\'s live task descriptions as activeTasks in the boot bundle', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        ledgerStore.dispatch({
            type: 'sdk_frame', frame: frames.taskStarted({ task_id: 'task-1', description: 'Refactor the widget' }), at: new Date(0),
        });
        expect(ledgerStore.get().tasks.map(task => task.description)).toContain('Refactor the widget');

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(startupContext).toContain('Refactor the widget');
    });

    it('dedupes, caps at 10 and ignores non-discord/undefined authors when building recentUsers', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        async function submitDiscord(authorId: string | undefined, envelopeId: string): Promise<void> {
            const submitPromise = conductor.submit(
                {
                    id: envelopeId, kind: 'discord', text: 'hi', channelId: 'chan-1', authorId, origin: { kind: 'human' }, hostPriority: 'human', shouldQuery: true, createdAt: new Date(0),
                },
                { priority: 'human', requestingChannelId: 'chan-1' }
            );
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await submitPromise;
        }

        async function submitNonDiscord(envelopeId: string): Promise<void> {
            const submitPromise = conductor.submit(
                {
                    id: envelopeId, kind: 'notification', text: 'note', hostPriority: 'accumulate', shouldQuery: true, createdAt: new Date(0),
                },
                { priority: 'other' }
            );
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await submitPromise;
        }

        // 'user-A' appears twice — dedupe should keep it once, most recent.
        await submitDiscord('user-A', 'env-A1');
        await submitDiscord('user-B', 'env-B1');
        await submitDiscord('user-A', 'env-A2');
        // A non-discord envelope must not be recorded as a recent author.
        await submitNonDiscord('env-notify-1');
        // An undefined authorId must not blow up or be recorded.
        await submitDiscord(undefined, 'env-anon');
        // Fill past the 10-entry cap.
        for(let i = 0; i < 10; i += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential submits against one fake session, deliberately serialised
            await submitDiscord(`user-${i}`, `env-${i}`);
        }

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        // Most-recent-first, deduped, capped at 10 — 'user-B' and 'user-A' (both submitted before
        // the fill loop) have been pushed out by the 10 later authors.
        expect(startupContext).toContain('user-9');
        expect(startupContext).toContain('user-0');
        expect(startupContext).not.toContain('user-A');
        expect(startupContext).not.toContain('user-B');
    });

    it('classifies the SDK\'s "Operation aborted" stderr as an error, never debug — the session has no per-open interrupt flag threaded into isInterrupting', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();

        const { conductor } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        options?.stderr?.('Operation aborted\nstack trace...');

        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    describe('R2: background-work wake-turn delivery wiring', () => {
        const BASE_HOOK_FIELDS = { session_id: 'sess-1', transcript_path: '/tmp/transcript', cwd: '/tmp' };

        function discordEnvelope(overrides: Partial<Envelope> = {}): Envelope {
            return {
                id: 'discord-1', kind: 'discord', text: 'hello', channelId: 'chan-C', authorId: 'user-U', origin: { kind: 'human' }, hostPriority: 'human', shouldQuery: true, createdAt: new Date(0), ...overrides,
            };
        }

        function postToolUseInput(overrides: Partial<PostToolUseHookInput> = {}): PostToolUseHookInput {
            return {
                ...BASE_HOOK_FIELDS, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'run a background thing' }, tool_response: { agentId: 'agent-X', status: 'async_launched' }, tool_use_id: 'tool-T', ...overrides,
            };
        }

        function userPromptSubmitInput(overrides: Partial<UserPromptSubmitHookInput> = {}): UserPromptSubmitHookInput {
            return {
                ...BASE_HOOK_FIELDS, hook_event_name: 'UserPromptSubmit', prompt: '<task-notification><task-id>agent-X</task-id><tool-use-id>tool-T</tool-use-id><output-file></output-file>done here</task-notification>', ...overrides,
            };
        }

        it('merges createTaskLaunchHooks with the live conductor/registry: a PostToolUse launch recorded during a real discord turn is adopted by its UserPromptSubmit wake, opening a channel-addressed task turn, and warns-and-drops before setWakeTurnDelivery is attached', async () => {
            const h = build();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

            const { conductor } = await createConversationConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            const options = h.instances[0].receivedParams?.options;
            const postToolUseHook = options?.hooks?.PostToolUse?.[0]?.hooks[0];
            const userPromptSubmitHook = options?.hooks?.UserPromptSubmit?.[0]?.hooks[0];
            expect(postToolUseHook).toBeDefined();
            expect(userPromptSubmitHook).toBeDefined();

            const discordResult = conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-C' });
            await flush();

            await postToolUseHook?.(postToolUseInput(), undefined, { signal: new AbortController().signal });

            h.instances[0].emit(frames.resultSuccess({ result: 'LAUNCHED' }));
            await discordResult;
            await flush();

            expect(h.journal.byKind('task_launched')).toEqual([
                expect.objectContaining({ taskId: 'agent-X', toolUseId: 'tool-T', channelId: 'chan-C', authorId: 'user-U' }),
            ]);

            await userPromptSubmitHook?.(userPromptSubmitInput(), undefined, { signal: new AbortController().signal });
            h.instances[0].emit(frames.assistantText('done here'));
            await flush();

            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'task', channelId: 'chan-C' });

            h.instances[0].emit(frames.resultSuccess({ result: 'done here' }));
            await flush();

            expect(h.journal.byKind('turn_completed').at(-1)).toMatchObject({ kind: 'task', responseText: 'done here' });
            expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: expect.any(String) }), 'wake turn settled before delivery was attached');
        });

        it('seeds the task-launch registry from task_launched rows read at boot, so a wake for a launch recorded by a PRIOR process still resolves its channel/author', async () => {
            const h = build();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
            h.journal.scriptReadSince([
                { type: 'task_launched', at: new Date(0), taskId: 'seed-task', toolUseId: 'seed-tool', toolName: 'Agent', envelopeId: 'seed-env', kind: 'discord', channelId: 'seeded-chan', authorId: 'seeded-user' },
            ]);

            const { conductor } = await createConversationConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            conductor.adoptWakeTurn({ taskId: 'seed-task', toolUseId: 'seed-tool', summary: 'seeded summary' });
            h.instances[0].emit(frames.assistantText('seeded summary'));
            await flush();

            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'task', channelId: 'seeded-chan' });
        });

        it('setWakeTurnDelivery(fn) delivers a settled wake turn to the attached function instead of warning', async () => {
            const h = build();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

            const { conductor, setWakeTurnDelivery } = await createConversationConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            const delivery = jest.fn(async () => undefined);
            setWakeTurnDelivery(delivery);

            conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'summary text' });
            h.instances[0].emit(frames.assistantText('summary text'));
            await flush();
            h.instances[0].emit(frames.resultSuccess({ result: 'summary text' }));
            await flush();

            expect(delivery).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task', text: 'summary text' }), expect.objectContaining({ response: 'summary text' }));
            expect(h.logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'wake turn settled before delivery was attached');
        });
    });

    describe('session-peers block 2: peer-message hook wiring', () => {
        const PEER_PROMPT = '<cross-session-message from="uds:/tmp/cc-socks/94548.sock" from-name="Izzy-perch" from-mode="bypass">\nhow is the PR going?\n</cross-session-message>';

        it('registers createPeerMessageHooks alongside the task-launch UserPromptSubmit hook: a cross-session message opens a real peer turn on the live conductor', async () => {
            const h = build();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

            const { conductor } = await createConversationConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            const matchers = h.instances[0].receivedParams?.options.hooks?.UserPromptSubmit;
            expect(matchers).toHaveLength(2);
            const peerHook = matchers?.[1]?.hooks[0];

            await peerHook?.({
                session_id: 'sess-1', transcript_path: '/tmp/transcript', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt: PEER_PROMPT,
            }, undefined, { signal: new AbortController().signal });
            h.instances[0].emit(frames.assistantText('going well'));
            await flush();

            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'peer' });

            h.instances[0].emit(frames.resultSuccess({ result: 'going well' }));
            await flush();

            expect(h.journal.byKind('turn_completed').at(-1)).toMatchObject({ kind: 'peer', responseText: 'going well' });
        });
    });
});

function buildPerch(overrides: Partial<CreatePerchConductorParams> = {}) {
    const { queryFn, instances } = fakeQueryFn();
    const clock = new FakeClock(0);
    const journal = new FakeJournal();
    const resumeStore = new FakeResumeStore();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const identityGet = jest.fn(() => Promise.resolve('I am Izzy'));
    const identitySource = fakeIdentitySource();
    const { onChange: identityOnChange, revision: identityRevision, fireIdentityChange } = identitySource;
    const contextBuilder = fakeContextBuilder();
    const taskListReader = { buildTaskListSummary: jest.fn(() => Promise.resolve(undefined)) };

    const params: CreatePerchConductorParams = {
        config:        DEFAULT_CONFIG,
        queryFn,
        mcpShared:     {} as McpSharedDeps,
        contextBuilder,
        identityCache: { get: identityGet, onChange: identityOnChange, revision: identityRevision },
        taskListReader,
        journal,
        resumeStore,
        clock,
        logger,
        ...overrides,
    };

    return {
        params, instances, clock, journal, resumeStore, logger, identityGet, identityOnChange, identityRevision, fireIdentityChange,
        setIdentityRevision: identitySource.setRevision,
        contextBuilder, taskListReader,
    };
}

describe('createPerchConductor', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('builds MCP server instances exactly once, with role \'perch\' — distinct from conversation\'s \'conversation\' role', async () => {
        const h = buildPerch();
        const createInstancesSpy = jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        await createPerchConductor(h.params);

        expect(createInstancesSpy).toHaveBeenCalledTimes(1);
        expect(createInstancesSpy).toHaveBeenCalledWith(h.params.mcpShared, { role: 'perch' });
    });

    it('gets its own MCP server instance set, distinct from a conversation conductor built alongside it', async () => {
        const createInstancesSpy = jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const conversation = build();
        const perch = buildPerch();

        await createConversationConductor(conversation.params);
        await createPerchConductor(perch.params);

        expect(createInstancesSpy).toHaveBeenCalledTimes(2);
        expect(createInstancesSpy).toHaveBeenNthCalledWith(1, conversation.params.mcpShared, { role: 'conversation' });
        expect(createInstancesSpy).toHaveBeenNthCalledWith(2, perch.params.mcpShared, { role: 'perch' });
    });

    it('passes the given emailServerFactory through to the perch instance set (unified tool set: perch triages the inbox too)', async () => {
        const h = buildPerch();
        const createInstancesSpy = jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FULL_MCP_SERVERS);
        const emailServerFactory = jest.fn();

        const { conductor } = await createPerchConductor({ ...h.params, emailServerFactory });
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        expect(createInstancesSpy).toHaveBeenCalledWith(h.params.mcpShared, { role: 'perch', emailServerFactory });
        const mcpServersOption = h.instances[0].receivedParams?.options.mcpServers as Record<string, unknown>;
        expect(mcpServersOption.email).toBe(FULL_MCP_SERVERS.emailMcpServer);
        expect(h.instances[0].receivedParams?.options.allowedTools).toContain('mcp__email__*');
    });

    it('wires no browser MCP server for perch (the single WebView belongs to conversation), but does wire email and health', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FULL_MCP_SERVERS);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const mcpServersOption = h.instances[0].receivedParams?.options.mcpServers as Record<string, unknown>;
        expect(mcpServersOption.browser).toBeUndefined();
        expect(mcpServersOption.email).toBe(FULL_MCP_SERVERS.emailMcpServer);
        expect(mcpServersOption.memory).toBe(FULL_MCP_SERVERS.memoryMcpServer);
        expect(mcpServersOption.wikipedia).toBe(FULL_MCP_SERVERS.wikipediaMcpServer);
        expect(mcpServersOption.health).toBe(FULL_MCP_SERVERS.healthMcpServer);
    });

    it('defers an identity reopen until the open perch slot ends', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, slotHooks } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        slotHooks.onSlotStart();
        h.identityGet.mockResolvedValue('I am Izzy, revised');
        h.fireIdentityChange();
        await flush();
        await flush();

        // Mid-slot: the perch is thinking out loud on a clock, and a reopen would cut it off.
        expect(h.instances).toHaveLength(1);

        slotHooks.onSlotEnd();
        await flush();

        expect(h.instances).toHaveLength(2);
        expect(h.instances[1].receivedParams?.options.systemPrompt).toContain('I am Izzy, revised');
    });

    it('reopens immediately when no slot is open', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        h.identityGet.mockResolvedValue('I am Izzy, revised');
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(2);
        expect(h.journal.byKind('session_reopen_requested').at(-1)).toMatchObject({ reason: 'an identity change' });
    });

    it('an identity change that renders the same prompt reopens nothing (perch)', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        // Not every identity-layer write changes what loadCoreIdentity renders.
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(1);
    });

    it('a failing perch identity reload is logged, reopens nothing, and leaves the previous prompt in place', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        h.identityGet.mockRejectedValue(new Error('DynamoDB throttled'));
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(1);
        expect(h.journal.byKind('session_reopen_requested')).toHaveLength(0);
        expect(h.logger.error).toHaveBeenCalledWith(
            { error: expect.any(Error) }, 'Rebuilding the perch system prompt after an identity change failed'
        );

        // The half-finished rebuild must not have left a torn prompt behind: whatever opens next
        // (here a crash reopen) still carries the identity the failed reload never replaced.
        h.instances[0].fail(new Error('worker crashed'));
        await flush();

        expect(h.instances[1].receivedParams?.options.systemPrompt).toContain('I am Izzy');
    });

    it('a load superseded mid-flight is discarded — its stale text never reaches a perch prompt', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        // The revision moves DURING the get(), exactly as a second write landing mid-load would:
        // this value is already superseded, and the newer change queues its own refresh.
        h.identityGet.mockImplementation(() => {
            h.setIdentityRevision(99);
            return Promise.resolve('stale identity');
        });
        h.fireIdentityChange();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(1);
    });

    it('a perch identity write landing between the startup read and the subscription is still picked up', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        // The revision the factory captured before its own await no longer matches by the time it
        // subscribes — a write landed in that window and fired no listener anybody had registered.
        h.identityGet.mockImplementation(() => {
            h.setIdentityRevision(7);
            return Promise.resolve('I am Izzy');
        });

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        expect(h.identityGet.mock.calls.length).toBeGreaterThan(1);
    });

    it('two identity changes during one slot yield a single reopen at slot end', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, slotHooks } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        slotHooks.onSlotStart();
        h.identityGet.mockResolvedValue('identity one');
        h.fireIdentityChange();
        await flush();
        h.identityGet.mockResolvedValue('identity two');
        h.fireIdentityChange();
        await flush();
        await flush();

        slotHooks.onSlotEnd();
        await flush();

        expect(h.instances).toHaveLength(2);
        expect(h.instances[1].receivedParams?.options.systemPrompt).toContain('identity two');

        // The pending flag must have been cleared by that reopen: a later slot with no new
        // identity change must not fire a redundant second reopen.
        slotHooks.onSlotStart();
        slotHooks.onSlotEnd();
        await flush();

        expect(h.instances).toHaveLength(2);
    });

    it('the deferred reopen is asked for exactly once, even after the reopen it fired has completed', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, slotHooks } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        slotHooks.onSlotStart();
        h.identityGet.mockResolvedValue('I am Izzy, revised');
        h.fireIdentityChange();
        await flush();
        await flush();

        slotHooks.onSlotEnd();
        await flush();
        expect(h.journal.byKind('session_reopen_requested')).toHaveLength(1);

        // Let the replacement finish opening. Until it does, the conductor swallows any further
        // request as "already reopening", which would hide a pending flag that was never cleared.
        h.instances[1].emit(frames.init('sess-2'));
        await flush();
        await flush();

        slotHooks.onSlotStart();
        slotHooks.onSlotEnd();
        await flush();

        // Nothing new has changed identity, so the second slot must ask for no reopen at all —
        // a still-set pending flag would journal a second request and churn the session.
        expect(h.journal.byKind('session_reopen_requested')).toHaveLength(1);
        expect(h.instances).toHaveLength(2);
    });

    it('a slot ending with no identity change pending reopens nothing', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, slotHooks } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;
        await flush();

        slotHooks.onSlotStart();
        slotHooks.onSlotEnd();
        await flush();
        await flush();

        expect(h.instances).toHaveLength(1);
    });

    it('builds the perch system prompt once from IdentityCache', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createPerchConductor(h.params);
        expect(h.identityGet).toHaveBeenCalledTimes(1);

        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        expect(h.instances[0].receivedParams?.options.systemPrompt).toContain('I am Izzy');
        expect(h.instances[0].receivedParams?.options.systemPrompt).toContain('This session: perch');
        expect(h.instances[0].receivedParams?.options.model).toBe('sonnet');
    });

    it('registers the effort sub-agent tiers for perch too, carrying the Isambard sub-agent prompt', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const agents = h.instances[0].receivedParams?.options.agents;
        expect(Object.keys(agents ?? {})).toEqual(expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'general-purpose', 'luna-medium', 'deepseek-flash-low']));
        expect(agents?.high.prompt).toContain('I am Izzy');
        expect(agents?.high.prompt).toContain('sub-agent of Isambard');
    });

    it('passes the stored resume id through to the SDK options on open() — a distinct role-keyed resume store from conversation', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        await h.resumeStore.save('perch', 'sess-stored-perch');

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-stored-perch'));
        await openPromise;

        expect(h.instances[0].receivedParams?.options.resume).toBe('sess-stored-perch');
    });

    it('returns a Conductor and a LedgerStore for role \'perch\'', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const result = await createPerchConductor(h.params);

        expect(result.ledgerStore.get().role).toBe('perch');
        expect(typeof result.conductor.submit).toBe('function');
    });

    it('returns a compactionTelemetry subscribed to the ledgerStore, recording a compaction_started/compact_boundary pair as one completed record', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { ledgerStore, compactionTelemetry } = await createPerchConductor(h.params);

        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(5) });
        ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.compactBoundary(), at: new Date(10) });

        expect(compactionTelemetry.getRecords()).toEqual([
            { startedAt: new Date(5), thresholdAtStart: DEFAULT_CONFIG.compactThresholdPercent, finishedAt: new Date(10) },
        ]);
    });

    it('compactionTelemetry reads the conductor\'s live threshold at each compaction_started, not a value cached at construction', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore, compactionTelemetry } = await createPerchConductor(h.params);
        conductor.setCompactionThresholdPercent(88);

        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(0) });

        expect(compactionTelemetry.getRecords()).toHaveLength(1);
        expect(compactionTelemetry.getRecords()[0].thresholdAtStart).toBe(88);
    });

    // Q11: createPerchConductor also wires createCompactionThresholdTuner (see the identical
    // createConversationConductor tests above for the reasoning).
    it('constructs a compaction threshold tuner that adjusts the conductor\'s threshold once a band is configured', async () => {
        const h = buildPerch({
            config: {
                ...DEFAULT_CONFIG,
                compactThresholdMinPercent: 10,
                compactThresholdMaxPercent: 90,
                compactTargetIntervalMs:    100,
            },
        });
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore } = await createPerchConductor(h.params);
        expect(conductor.getCompactionThresholdPercent()).toBe(DEFAULT_CONFIG.compactThresholdPercent);

        for(let i = 0; i < 3; i += 1) {
            ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(i * 1000) });
            ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.compactBoundary(), at: new Date(i * 1000 + 500) });
        }

        expect(conductor.getCompactionThresholdPercent()).toBe(DEFAULT_CONFIG.compactThresholdPercent - DEFAULT_STEP_PERCENT);
    });

    it('with all three tuner band fields unset, the guard threshold never leaves compactThresholdPercent across many observed compactions', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore } = await createPerchConductor(h.params);

        for(let i = 0; i < 5; i += 1) {
            ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(i * 1000) });
            ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.compactBoundary(), at: new Date(i * 1000 + 1) });
        }

        expect(conductor.getCompactionThresholdPercent()).toBe(DEFAULT_CONFIG.compactThresholdPercent);
    });

    it('merges a SessionStart boot-bundle hook (perch variant) carrying the task list and perch context', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        (h.contextBuilder.buildPerchContext as ReturnType<typeof jest.fn>).mockResolvedValue('## Perch context\nQuiet night.');

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        expect(hookFn).toBeDefined();

        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(startupContext).toContain('[BOOT BUNDLE · perch · fresh]');
        expect(startupContext).toContain('Quiet night.');
    });

    it('reports lost perch-started background tasks (recovery from the perch journal) in its boot bundle', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        h.journal.scriptReadSince([
            { type: 'task_started', at: new Date(0), taskId: 'task-orphan', description: 'Summarize last week' },
        ]);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(startupContext).toContain('Summarize last week');
    });

    it('falls back to the taskId when a lost task has no description', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        h.journal.scriptReadSince([
            // A `task_started` row missing `description` cannot be constructed as a well-typed
            // `JournalEntry` (the field is required there) — this simulates real-world data that
            // predates the field or was written by a misbehaving caller, at the deserialization
            // boundary `readSince` actually returns through.
            { type: 'task_started', at: new Date(0), taskId: 'task-no-description' } as unknown as JournalEntry,
        ]);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(startupContext).toContain('task-no-description');
    });

    it('falls back to "<kind> envelope <id>" when an undelivered envelope has no completed response text', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        h.journal.scriptReadSince([
            { type: 'envelope_submitted', at: new Date(0), envelopeId: 'env-no-text', kind: 'discord' },
            { type: 'turn_completed', at: new Date(1), envelopeId: 'env-no-text', kind: 'discord' },
        ]);

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(startupContext).toContain('discord envelope env-no-text');
    });

    it('R1: loadBootRecovery reads the perch journal from exactly 24h (RECOVERY_WINDOW_MS) before the clock\'s current time, at construction', async () => {
        const h = buildPerch();
        h.clock.advance(100_000);
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const readSinceSpy = jest.spyOn(h.journal, 'readSince');

        await createPerchConductor(h.params);

        expect(readSinceSpy).toHaveBeenCalledWith(100_000 - 24 * 60 * 60 * 1000);
    });

    it('R2: the boot-bundle hook\'s FIRST SessionStart call reuses the construction-time recovery read instead of issuing a duplicate query; a LATER SessionStart (e.g. a compaction) reads fresh, from the clock\'s current time at that point', async () => {
        const h = buildPerch();
        h.clock.advance(100_000);
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const readSinceSpy = jest.spyOn(h.journal, 'readSince');

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        // `conductor.open()` itself independently reads the journal over its own (unrelated)
        // recovery window, on top of the construction-time read above — clear both so the
        // assertions below isolate the SessionStart hook's own `loadBootRecovery` reads.
        readSinceSpy.mockClear();

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];

        await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        expect(readSinceSpy).not.toHaveBeenCalled();

        h.clock.advance(5000);
        await hookFn?.({ source: 'compact' } as never, undefined, undefined as never);
        expect(readSinceSpy).toHaveBeenCalledWith(105_000 - 24 * 60 * 60 * 1000);
    });

    it('degrades to an empty recovery section (and logs a warning) when the journal readSince read fails', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        h.journal.scriptReadSinceRejection(new Error('DynamoDB unavailable'));

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await expect(openPromise).resolves.toBeDefined();

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        const startupResult = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        const startupContext = (startupResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

        expect(startupContext).toContain('[BOOT BUNDLE · perch · fresh]');
        expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Perch boot-bundle recovery read failed; continuing with an empty recovery section');
        // Pins the catch branch's degrade-to-empty return value exactly (both `lostTasks` and
        // `undelivered`) — not just that the log fired: neither section header renders when both
        // lists are actually `[]`, catching an ArrayDeclaration mutant on either literal.
        expect(startupContext).not.toContain('Background tasks lost at restart');
        expect(startupContext).not.toContain('Envelopes without a delivered response');
    });

    it('PreCompact dispatches compaction_started onto the ledger; PostCompact records the compaction summary', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        const preCompact = options?.hooks?.PreCompact?.[0]?.hooks[0];
        const postCompact = options?.hooks?.PostCompact?.[0]?.hooks[0];
        expect(preCompact).toBeDefined();
        expect(postCompact).toBeDefined();

        await preCompact?.({ trigger: 'auto', session_id: 'sess-1', hook_event_name: 'PreCompact' } as never, undefined, undefined as never);
        expect(ledgerStore.get().compaction).toBe('compacting');

        // PostCompact's own hook does nothing beyond the ledger dispatch — the ledger's
        // `compaction` field returns to 'none' only on an actual `compact_boundary` SDK frame
        // (ledger.ts's own reducer), which this test never emits; asserting the hook resolves
        // without throwing is the meaningful behaviour to pin here (no ContextPolicy to reset).
        await expect(postCompact?.({ compact_summary: 'summary text', session_id: 'sess-1', hook_event_name: 'PostCompact' } as never, undefined, undefined as never)).resolves.toBeDefined();
        expect(ledgerStore.get().compaction).toBe('compacting');
    });

    it('classifies the SDK\'s "Operation aborted" stderr as an error, never debug — like conversation, perch has no per-open interrupt flag threaded into isInterrupting', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();

        const { conductor } = await createPerchConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const options = h.instances[0].receivedParams?.options;
        options?.stderr?.('Operation aborted\nstack trace...');

        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    describe('R2: background-work wake-turn delivery wiring', () => {
        const PERCH_BASE_HOOK_FIELDS = { session_id: 'sess-1', transcript_path: '/tmp/transcript', cwd: '/tmp' };

        function perchPostToolUseInput(overrides: Partial<PostToolUseHookInput> = {}): PostToolUseHookInput {
            return {
                ...PERCH_BASE_HOOK_FIELDS, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'run a background thing' }, tool_response: { agentId: 'agent-X', status: 'async_launched' }, tool_use_id: 'tool-T', ...overrides,
            };
        }

        function perchUserPromptSubmitInput(overrides: Partial<UserPromptSubmitHookInput> = {}): UserPromptSubmitHookInput {
            return {
                ...PERCH_BASE_HOOK_FIELDS, hook_event_name: 'UserPromptSubmit', prompt: '<task-notification><task-id>agent-X</task-id><tool-use-id>tool-T</tool-use-id><output-file></output-file>done here</task-notification>', ...overrides,
            };
        }

        it('merges createTaskLaunchHooks with the LIVE perch conductor (not just the registry): a PostToolUse launch recorded during a real perch turn is looked up and adopted through the actual captured hook callbacks, proving taskLaunchConductor\'s status()/adoptWakeTurn() pass-through actually reaches the real conductor', async () => {
            const h = buildPerch();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

            const { conductor } = await createPerchConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            const options = h.instances[0].receivedParams?.options;
            const postToolUseHook = options?.hooks?.PostToolUse?.[0]?.hooks[0];
            const userPromptSubmitHook = options?.hooks?.UserPromptSubmit?.[0]?.hooks[0];
            expect(postToolUseHook).toBeDefined();
            expect(userPromptSubmitHook).toBeDefined();

            const perchEnvelope: Envelope = {
                id: 'perch-1', kind: 'perch', text: 'perch turn', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0),
            };
            const perchResultPromise = conductor.submit(perchEnvelope, { priority: 'other' });
            await flush();

            await postToolUseHook?.(perchPostToolUseInput(), undefined, { signal: new AbortController().signal });

            h.instances[0].emit(frames.resultSuccess({ result: 'LAUNCHED' }));
            await perchResultPromise;
            await flush();

            // taskLaunchConductor.status() only sees this launching turn's envelopeId/kind when
            // its call actually reaches the real, already-assigned conductor — the module doc's
            // "narrow window before conductorRef is assigned" fallback is never taken here.
            expect(h.journal.byKind('task_launched')).toEqual([
                expect.objectContaining({ taskId: 'agent-X', toolUseId: 'tool-T', kind: 'perch' }),
            ]);

            await userPromptSubmitHook?.(perchUserPromptSubmitInput(), undefined, { signal: new AbortController().signal });
            h.instances[0].emit(frames.assistantText('done here'));
            await flush();

            // taskLaunchConductor.adoptWakeTurn() likewise reached the real conductor: the wake
            // opened a genuine task turn, not a no-op.
            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'task' });

            h.instances[0].emit(frames.resultSuccess({ result: 'done here' }));
            await flush();
        });

        it('seeds the task-launch registry from task_launched rows read at boot, merges createTaskLaunchHooks, and rewrites the settled envelope\'s kind to \'perch\' before calling the attached delivery function', async () => {
            const h = buildPerch();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
            h.journal.scriptReadSince([
                {
                    type: 'task_launched', at: new Date(0), taskId: 'seed-task', toolUseId: 'seed-tool', toolName: 'Agent', envelopeId: 'seed-env', kind: 'perch', channelId: 'seeded-chan', authorId: 'seeded-user',
                },
            ]);

            const { conductor, setWakeTurnDelivery } = await createPerchConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            const options = h.instances[0].receivedParams?.options;
            expect(options?.hooks?.PostToolUse?.[0]?.hooks[0]).toBeDefined();
            expect(options?.hooks?.UserPromptSubmit?.[0]?.hooks[0]).toBeDefined();

            const delivery = jest.fn(async () => undefined);
            setWakeTurnDelivery(delivery);

            conductor.adoptWakeTurn({ taskId: 'seed-task', toolUseId: 'seed-tool', summary: 'perch task done' });
            h.instances[0].emit(frames.assistantText('perch task done'));
            await flush();
            h.instances[0].emit(frames.resultSuccess({ result: 'perch task done' }));
            await flush();

            // channelId/authorId prove the boot-time seed (not merely adoptWakeTurn/kind-rewrite)
            // actually populated the registry — an unseeded lookup would carry neither.
            expect(delivery).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'perch', text: 'perch task done', channelId: 'seeded-chan', authorId: 'seeded-user',
                }),
                expect.objectContaining({ response: 'perch task done' })
            );
        });

        it('warns and drops a settled wake turn before setWakeTurnDelivery is attached', async () => {
            const h = buildPerch();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

            const { conductor } = await createPerchConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'summary text' });
            h.instances[0].emit(frames.assistantText('summary text'));
            await flush();
            h.instances[0].emit(frames.resultSuccess({ result: 'summary text' }));
            await flush();

            expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: expect.any(String) }), 'wake turn settled before delivery was attached');
        });
    });

    describe('session-peers block 2: peer-message hook wiring', () => {
        const PEER_PROMPT = '<cross-session-message from="uds:/tmp/cc-socks/94548.sock" from-name="Izzy-main" from-mode="bypass">\nanything worth surfacing?\n</cross-session-message>';

        it('registers createPeerMessageHooks on the perch role too: a cross-session message opens a real peer turn on the live perch conductor', async () => {
            const h = buildPerch();
            jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

            const { conductor } = await createPerchConductor(h.params);
            const openPromise = conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;

            const matchers = h.instances[0].receivedParams?.options.hooks?.UserPromptSubmit;
            expect(matchers).toHaveLength(2);
            const peerHook = matchers?.[1]?.hooks[0];

            await peerHook?.({
                session_id: 'sess-1', transcript_path: '/tmp/transcript', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt: PEER_PROMPT,
            }, undefined, { signal: new AbortController().signal });
            h.instances[0].emit(frames.assistantText('nothing yet'));
            await flush();

            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'peer' });

            h.instances[0].emit(frames.resultSuccess({ result: 'nothing yet' }));
            await flush();

            expect(h.journal.byKind('turn_completed').at(-1)).toMatchObject({ kind: 'peer', responseText: 'nothing yet' });
        });
    });
});

/**
 * Block 4 (docs/plans/session-peers-and-quota.md): the composition root's ambient-line wiring —
 * ONE quota poller subscribed to both ledgers, and one memoized time-header provider per role
 * that appends the ambient lines composed from its own ledger and the other role's.
 */
describe('createSessionAmbience', () => {
    const TIMEZONE = 'America/Los_Angeles';
    /** The shape the poller's parser is built against (block 3's own `unifiedWindows`). */
    const USAGE_BODY = { five_hour: { utilization: 42 }, seven_day: { utilization: 61 } };

    function okResponse(body: unknown): QuotaFetchResponse {
        return { ok: true, status: 200, json: async () => body };
    }

    function ambienceHarness(overrides: { fetch?: QuotaFetch } = {}) {
        const clock = new FakeClock(0);
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        const fetch = jest.fn<QuotaFetch>(overrides.fetch ?? (async () => okResponse(USAGE_BODY)));
        const ambience = createSessionAmbience({ timezone: TIMEZONE, clock, logger, quota: { fetch, preferProviderReport: false } });
        const conversation = createLedgerStore('conversation', { logger });
        const perch = createLedgerStore('perch', { logger });
        return { clock, logger, fetch, ambience, conversation, perch };
    }

    // formatTimeHeader reads the real clock at millisecond precision, and these tests compare
    // whole rendered headers — so the system time is pinned rather than raced.
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-09T22:07:00Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('dispatches one poll\'s quota into every registered ledger, including one registered after construction', async () => {
        const h = ambienceHarness();
        h.ambience.quotaPoller.start();
        h.ambience.register(h.conversation);
        h.ambience.register(h.perch);

        await h.ambience.quotaPoller.poll();

        expect(h.conversation.get().quota).toMatchObject({ fiveHour: { utilization: 42 }, sevenDay: { utilization: 61 }, source: 'poll' });
        expect(h.perch.get().quota).toMatchObject({ fiveHour: { utilization: 42 }, source: 'poll' });
    });

    it('polls once when a registered ledger sees a result frame', async () => {
        const h = ambienceHarness();
        // app.start() arms the poller before any session takes a turn; a stopped poller
        // deliberately ignores result frames.
        h.ambience.quotaPoller.start();
        h.ambience.register(h.conversation);

        h.conversation.dispatch({ type: 'turn_submitted', envelope: { id: 'e1', kind: 'discord', queuedAt: new Date(0) }, at: new Date(0) });
        h.conversation.dispatch({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.01 }), at: new Date(0) });
        await flush();

        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not poll for a non-result SDK frame, nor for a non-frame ledger event', async () => {
        const h = ambienceHarness();
        h.ambience.register(h.conversation);

        h.conversation.dispatch({ type: 'turn_submitted', envelope: { id: 'e1', kind: 'discord', queuedAt: new Date(0) }, at: new Date(0) });
        h.conversation.dispatch({ type: 'sdk_frame', frame: frames.assistantText('hello'), at: new Date(0) });
        await flush();

        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('returns the plain time header for a role whose ledger has not been registered', () => {
        const h = ambienceHarness();

        expect(h.ambience.timeHeaderFor('conversation')()).toBe(formatTimeHeader());
    });

    it('passes the caller\'s user timezone straight through to formatTimeHeader', () => {
        const h = ambienceHarness();

        expect(h.ambience.timeHeaderFor('conversation')('Europe/London')).toBe(formatTimeHeader('Europe/London'));
    });

    it('appends the other role\'s ambient line to the header, from the other role\'s ledger', () => {
        const h = ambienceHarness();
        h.ambience.register(h.conversation);
        h.ambience.register(h.perch);

        expect(h.ambience.timeHeaderFor('conversation')()).toBe(`${formatTimeHeader()}\n- Perch: idle`);
        expect(h.ambience.timeHeaderFor('perch')()).toBe(`${formatTimeHeader()}\n- Conversation: idle`);
    });

    it('appends the quota line, with the shared-subscription note only on the first header that carries one', async () => {
        const h = ambienceHarness();
        h.ambience.quotaPoller.start();
        h.ambience.register(h.conversation);
        await h.ambience.quotaPoller.poll();

        const first = h.ambience.timeHeaderFor('conversation')();
        const second = h.ambience.timeHeaderFor('conversation')();

        expect(first).toContain('- Quota: \n```json');
        expect(first).toContain('"source": "direct_anthropic"');
        expect(first).toContain('Subscription quotas are shared; provider balances are separate.');
        expect(second).toContain('- Quota: \n```json');
        expect(second).toContain('"source": "direct_anthropic"');
        expect(second).not.toContain('Subscription quotas are shared; provider balances are separate.');
    });

    it('does not spend the one-time note on a header rendered before any quota is known', async () => {
        const h = ambienceHarness();
        h.ambience.quotaPoller.start();
        h.ambience.register(h.conversation);

        expect(h.ambience.timeHeaderFor('conversation')()).not.toContain('Subscription quotas are shared; provider balances are separate.');

        await h.ambience.quotaPoller.poll();

        expect(h.ambience.timeHeaderFor('conversation')()).toContain('Subscription quotas are shared; provider balances are separate.');
    });

    it('returns the same provider instance for a role every time, so the one-time note is per session, not per producer', () => {
        const h = ambienceHarness();

        expect(h.ambience.timeHeaderFor('conversation')).toBe(h.ambience.timeHeaderFor('conversation'));
        expect(h.ambience.timeHeaderFor('perch')).not.toBe(h.ambience.timeHeaderFor('conversation'));
    });
});

describe('ambient-line wiring on the conductors', () => {
    function fakeAmbience(): { ambience: SessionAmbience, provider: ReturnType<typeof jest.fn> } {
        const provider = jest.fn(() => '## Current Time\n- Perch: idle');
        const ambience: SessionAmbience = {
            register:      jest.fn(),
            timeHeaderFor: jest.fn(() => provider as TimeHeaderProvider),
            quotaPoller:   { start: jest.fn(), stop: jest.fn(), noteResult: jest.fn(), poll: jest.fn(async () => undefined) },
        };
        return { ambience, provider };
    }

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('registers the conversation ledger and takes its peer-message time header from the conversation provider', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const { ambience, provider } = fakeAmbience();

        const result = await createConversationConductor({ ...h.params, ambience });

        expect(ambience.register).toHaveBeenCalledWith(result.ledgerStore);
        expect(ambience.timeHeaderFor).toHaveBeenCalledWith('conversation');

        // The peer hook asks the provider for a fresh header per message, in the session's own timezone.
        const openPromise = result.conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const matchers = h.instances[0].receivedParams?.options.hooks?.UserPromptSubmit;
        await matchers?.[1]?.hooks[0]?.({
            session_id:      'sess-1', transcript_path: '/tmp/t', cwd:             '/tmp', hook_event_name: 'UserPromptSubmit',
            prompt:          '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="Izzy-perch" from-mode="bypass">\nping\n</cross-session-message>',
        }, undefined, { signal: new AbortController().signal });

        expect(provider).toHaveBeenCalledWith(DEFAULT_CONFIG.timezone);
    });

    it('registers the perch ledger and asks for the perch provider', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const { ambience } = fakeAmbience();

        const result = await createPerchConductor({ ...h.params, ambience });

        expect(ambience.register).toHaveBeenCalledWith(result.ledgerStore);
        expect(ambience.timeHeaderFor).toHaveBeenCalledWith('perch');
    });

    /** Opens the conductor and fires its SessionStart boot-bundle hook, returning the bundle text. */
    async function bootBundleText(conductor: { open: () => Promise<unknown> }, instances: FakeQuery[]): Promise<string> {
        const openPromise = conductor.open();
        await flush();
        instances[0].emit(frames.init('sess-1'));
        await openPromise;

        const hookFn = instances[0].receivedParams?.options.hooks?.SessionStart?.[0]?.hooks[0];
        const result = await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);
        return (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
    }

    it('opens the conversation boot bundle with the ambient header, in the session\'s own timezone', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const { ambience, provider } = fakeAmbience();

        const { conductor } = await createConversationConductor({ ...h.params, ambience });
        const text = await bootBundleText(conductor, h.instances);

        expect(text).toContain('## Current Time\n- Perch: idle');
        expect(provider).toHaveBeenCalledWith(DEFAULT_CONFIG.timezone);
    });

    it('opens the perch boot bundle with the ambient header, in the session\'s own timezone', async () => {
        const h = buildPerch();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);
        const { ambience, provider } = fakeAmbience();

        const { conductor } = await createPerchConductor({ ...h.params, ambience });
        const text = await bootBundleText(conductor, h.instances);

        expect(text).toContain('## Current Time\n- Perch: idle');
        expect(provider).toHaveBeenCalledWith(DEFAULT_CONFIG.timezone);
    });

    it('falls back to the bare time header in the boot bundle when no ambience is wired', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor } = await createConversationConductor(h.params);
        const text = await bootBundleText(conductor, h.instances);

        // Compared structurally rather than against a fresh formatTimeHeader() call: that reads
        // the real clock at millisecond precision (see the note above createSessionAmbience's
        // tests), so an exact-text comparison races the header the bundle already rendered.
        const sections = text.split('\n\n');
        expect(sections[2]?.startsWith('## Current Time\n- UTC: ')).toBe(true);
        expect(sections[2]).not.toContain('\n- Perch:');
    });
});
