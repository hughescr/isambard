/**
 * Behavioural tests for {@link createConversationConductor} (P9): assembles the conversation
 * conductor's Options-building dependencies (MCP servers, system prompt, hooks, context policy)
 * and returns a Conductor that BUILDS but does not open. Uses P3's {@link fakeQueryFn}/
 * {@link FakeQuery}, {@link FakeClock}, and the P3/P7 in-memory port doubles ({@link FakeJournal},
 * {@link FakeResumeStore}).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { FakeClock } from '../../helpers/fake-clock';
import { FakeJournal } from '../../helpers/fake-journal';
import { fakeQueryFn } from '../../helpers/fake-query';
import { FakeResumeStore } from '../../helpers/fake-resume-store';
import * as frames from '../../helpers/sdk-frames';
import { mockLogger } from '../../setup';
import type { ContextBuilder } from '@/agent';
import * as mcpServersModule from '@/app/mcp-servers';
import type { McpSharedDeps } from '@/app/mcp-servers';
import { createConversationConductor, type CreateConversationConductorParams } from '@/app/sessions';
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

/** All eleven server slots populated, each with a distinguishable value, for asserting the exact key mapping onto `SessionMcpServers`. */
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
};

const DEFAULT_CONFIG: SessionConfig = sessionConfigSchema.parse({});

function fakeContextBuilder(overrides: Partial<ContextBuilder> = {}): Pick<ContextBuilder, 'loadHotState' | 'loadRecentEventsSince' | 'buildPerchContext'> {
    return {
        loadHotState:          jest.fn(() => Promise.resolve('')),
        loadRecentEventsSince: jest.fn(() => Promise.resolve([])),
        buildPerchContext:     jest.fn(() => Promise.resolve('')),
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

    it('merges a SessionStart boot-bundle hook that fires for both \'startup\' and \'compact\' sources, carrying activeTasks and recentUsers', async () => {
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
        expect(startupContext).toContain('user-42');

        const compactResult = await hookFn?.({ source: 'compact' } as never, undefined, undefined as never);
        const compactContext = (compactResult as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
        expect(compactContext).toContain('user-42');
    });

    it('PreCompact dispatches compaction_started onto the ledger; PostCompact resets the context policy and records the compaction summary', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const { conductor, ledgerStore, contextPolicy } = await createConversationConductor(h.params);
        const openPromise = conductor.open();
        await flush();
        h.instances[0].emit(frames.init('sess-1'));
        await openPromise;

        contextPolicy.markInjected('user-1');
        expect(contextPolicy.shouldInjectUserMemory('user-1')).toBe(false);

        const options = h.instances[0].receivedParams?.options;
        const preCompact = options?.hooks?.PreCompact?.[0]?.hooks[0];
        const postCompact = options?.hooks?.PostCompact?.[0]?.hooks[0];
        expect(preCompact).toBeDefined();
        expect(postCompact).toBeDefined();

        await preCompact?.({ trigger: 'auto', session_id: 'sess-1', hook_event_name: 'PreCompact' } as never, undefined, undefined as never);
        expect(ledgerStore.get().compaction).toBe('compacting');

        await postCompact?.({ compact_summary: 'summary text', session_id: 'sess-1', hook_event_name: 'PostCompact' } as never, undefined, undefined as never);

        expect(contextPolicy.shouldInjectUserMemory('user-1')).toBe(true);
    });

    it('returns a Conductor, a LedgerStore for role \'conversation\', and a ContextPolicy', async () => {
        const h = build();
        jest.spyOn(mcpServersModule, 'createMcpServerInstances').mockReturnValue(FAKE_MCP_SERVERS);

        const result = await createConversationConductor(h.params);

        expect(result.ledgerStore.get().role).toBe('conversation');
        expect(typeof result.conductor.submit).toBe('function');
        expect(typeof result.contextPolicy.resetAll).toBe('function');
    });

    it('wires all eleven MCP server instances into the session\'s SDK options, correctly keyed', async () => {
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
