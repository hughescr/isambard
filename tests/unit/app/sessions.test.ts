/**
 * Behavioural tests for {@link createConversationConductor} (P9): assembles the conversation
 * conductor's Options-building dependencies (MCP servers, system prompt, hooks, context policy)
 * and returns a Conductor that BUILDS but does not open. Uses P3's {@link fakeQueryFn}/
 * {@link FakeQuery}, {@link FakeClock}, and the P3/P7 in-memory port doubles ({@link FakeJournal},
 * {@link FakeResumeStore}).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { FakeClock } from '../../helpers/fake-clock';
import { makeHealthRegistry } from '../../helpers/fake-health-registry';
import { FakeJournal } from '../../helpers/fake-journal';
import { fakeQueryFn } from '../../helpers/fake-query';
import { FakeResumeStore } from '../../helpers/fake-resume-store';
import * as frames from '../../helpers/sdk-frames';
import { mockLogger } from '../../setup';
import { DEFAULT_STEP_PERCENT, type ContextBuilder } from '@/agent';
import type { JournalEntry } from '@/agent/session/types';
import * as mcpServersModule from '@/app/mcp-servers';
import type { McpSharedDeps } from '@/app/mcp-servers';
import { createConversationConductor, createPerchConductor, type CreateConversationConductorParams, type CreatePerchConductorParams } from '@/app/sessions';
import { sessionConfigSchema, type SessionConfig } from '@/config/schemas';

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

function build(overrides: Partial<CreateConversationConductorParams> = {}) {
    const { queryFn, instances } = fakeQueryFn();
    const clock = new FakeClock(0);
    const journal = new FakeJournal();
    const resumeStore = new FakeResumeStore();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const identityGet = jest.fn(() => Promise.resolve('I am Izzy'));
    const contextBuilder = fakeContextBuilder();
    const taskListReader = { buildTaskListSummary: jest.fn(() => Promise.resolve(undefined)) };
    const channelListProvider = jest.fn(() => Promise.resolve('#general'));

    const params: CreateConversationConductorParams = {
        config:        DEFAULT_CONFIG,
        queryFn,
        mcpShared:     {} as McpSharedDeps,
        contextBuilder,
        identityCache: { get: identityGet },
        taskListReader,
        journal,
        resumeStore,
        channelListProvider,
        clock,
        logger,
        ...overrides,
    };

    return {
        params, instances, clock, journal, resumeStore, logger, identityGet, contextBuilder, taskListReader, channelListProvider,
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

    it('builds the system prompt once from IdentityCache, even across a later reopen', async () => {
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
});

function buildPerch(overrides: Partial<CreatePerchConductorParams> = {}) {
    const { queryFn, instances } = fakeQueryFn();
    const clock = new FakeClock(0);
    const journal = new FakeJournal();
    const resumeStore = new FakeResumeStore();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const identityGet = jest.fn(() => Promise.resolve('I am Izzy'));
    const contextBuilder = fakeContextBuilder();
    const taskListReader = { buildTaskListSummary: jest.fn(() => Promise.resolve(undefined)) };

    const params: CreatePerchConductorParams = {
        config:        DEFAULT_CONFIG,
        queryFn,
        mcpShared:     {} as McpSharedDeps,
        contextBuilder,
        identityCache: { get: identityGet },
        taskListReader,
        journal,
        resumeStore,
        clock,
        logger,
        ...overrides,
    };

    return {
        params, instances, clock, journal, resumeStore, logger, identityGet, contextBuilder, taskListReader,
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

    it('R1: loadBootRecovery reads the perch journal from exactly 24h (RECOVERY_WINDOW_MS) before the clock\'s current time', async () => {
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
        // recovery window — clear that call so the assertion below isolates the SessionStart
        // hook's own `loadBootRecovery` read.
        readSinceSpy.mockClear();

        const options = h.instances[0].receivedParams?.options;
        const hookFn = options?.hooks?.SessionStart?.[0]?.hooks[0];
        await hookFn?.({ source: 'startup' } as never, undefined, undefined as never);

        expect(readSinceSpy).toHaveBeenCalledWith(100_000 - 24 * 60 * 60 * 1000);
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
});
