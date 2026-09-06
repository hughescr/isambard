/**
 * Assembles the long-lived conversation conductor (P9, design section 6): the conductor's own
 * MCP server instance set (role `'conversation'`), its once-per-process system prompt (identity
 * loaded from `IdentityCache`), and the merged hook map a session's Agent SDK `Options` need
 * (SessionStart boot bundle for `startup`/`compact`, PreCompact/PostCompact -> ledger +
 * `ContextPolicy.resetAll()` + `Conductor.recordCompactionSummary`, Stop/StopFailure lifecycle
 * logging, task-tracking logging).
 *
 * `createConversationConductor` BUILDS but never OPENS the conductor — the caller (`src/index.ts`)
 * decides when opening is safe (after the guild cache and channel registry exist) and degrades to
 * the one-shot processor if `open()` rejects.
 *
 * Two completeness-critic gaps this module closes (see the work-package brief):
 *  - Post-compaction reset: the compaction sink calls `contextPolicy.resetAll()` on
 *    `PostCompact`, and the boot-bundle hook's callback feeds `activeTasks` from
 *    `ledgerStore.get().tasks` and `recentUsers` from the Discord authors of recently submitted
 *    `discord`-kind envelopes — tracked here (not on `Conductor`'s public interface, which has no
 *    concept of "recent author") by wrapping the conductor's own `submit()`.
 *  - Idle-status inputs (`addRecentMessage`, the activity-log write) are NOT this module's
 *    concern — they stay in the coordinator/processor layer per the brief.
 *
 * @module app/sessions
 */
import type { HookCallbackMatcher, HookEvent, McpServerConfig, Options, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';
import { createMcpServerInstances, type McpSharedDeps } from './mcp-servers';
import {
    buildSessionQueryOptions,
    buildSessionSystemPrompt,
    createBootBundleBuilder,
    createBootBundleHooks,
    createCompactionHooks,
    createConductor,
    createContextPolicy,
    createLedgerStore,
    createSessionLifecycleHooks,
    createTaskTrackingHooks,
    mergeHookMaps,
    type Clock,
    type CompactionSink,
    type Conductor,
    type ContextPolicy,
    type CreateBootBundleBuilderParams,
    type Envelope,
    type LedgerStore,
    type ResumeStore,
    type SessionJournal,
    type SessionMcpServers,
    type SessionQueryFn
} from '@/agent';
import { type SessionConfig, loadRetryConfig  } from '@/config';

/** The subset of `IdentityCache` the system prompt and boot bundle depend on. */
type IdentitySource = CreateBootBundleBuilderParams['identityCache'];

/** The subset of `ContextBuilder` the boot bundle and context policy depend on. */
type BootContextSource = CreateBootBundleBuilderParams['contextBuilder'];

/** Structurally matches `TaskListReader` — see `CreateBootBundleBuilderParams`'s own note. */
type TaskListSource = CreateBootBundleBuilderParams['taskListReader'];

/** How many distinct recently-submitted Discord authors the boot bundle's `recentUsers` section reports, most recent first. */
const RECENT_AUTHORS_LIMIT = 10;

/** Dependencies and configuration for {@link createConversationConductor}. */
export interface CreateConversationConductorParams {
    config:              SessionConfig
    queryFn:             SessionQueryFn
    /** Shared MCP dependencies (P2's `createMcpSharedDeps`); this module builds its own instance set from it, once. */
    mcpShared:           McpSharedDeps
    /** Optional email MCP server factory (see `CreateMcpServerInstancesOptions`). */
    emailServerFactory?: () => McpServerConfig
    plugins?:            SdkPluginConfig[]
    contextBuilder:      BootContextSource
    identityCache:       IdentitySource
    taskListReader:      TaskListSource
    journal:             SessionJournal
    resumeStore:         ResumeStore
    /** Builds the `[Channels]` boot-bundle section. Invoked lazily, only when a SessionStart hook actually fires — never at build time. */
    channelListProvider: () => Promise<string | undefined>
    clock:               Clock
    logger:              Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

/** What {@link createConversationConductor} returns. */
export interface ConversationConductorResult {
    conductor:     Conductor
    ledgerStore:   LedgerStore
    contextPolicy: ContextPolicy
}

/**
 * Builds the conversation conductor's MCP server set, system prompt, hooks, ledger and context
 * policy, and returns a {@link Conductor} that has NOT been opened. The caller is responsible for
 * calling `conductor.open()` when it decides opening is safe.
 * @param params See {@link CreateConversationConductorParams}.
 * @returns `{ conductor, ledgerStore, contextPolicy }` — see {@link ConversationConductorResult}.
 */
export async function createConversationConductor(params: CreateConversationConductorParams): Promise<ConversationConductorResult> {
    const {
        config, queryFn, mcpShared, emailServerFactory, plugins, contextBuilder,
        identityCache, taskListReader, journal, resumeStore, channelListProvider, clock, logger,
    } = params;

    const mcpInstances = createMcpServerInstances(mcpShared, { role: 'conversation', emailServerFactory });
    const sessionMcpServers: SessionMcpServers = {
        memory:         mcpInstances.memoryMcpServer,
        discord:        mcpInstances.discordMcpServer,
        inbox:          mcpInstances.inboxMcpServer,
        bsky:           mcpInstances.bskyMcpServer,
        caldav:         mcpInstances.caldavMcpServer,
        wikipedia:      mcpInstances.wikipediaMcpServer,
        contacts:       mcpInstances.contactsMcpServer,
        'user-context': mcpInstances.userContextMcpServer,
        media:          mcpInstances.mediaMcpServer,
        browser:        mcpInstances.browserMcpServer,
        email:          mcpInstances.emailMcpServer,
    };

    // Built once, here, from the injected IdentityCache — never rebuilt on a later reopen
    // (buildOptions, below, closes over this same string).
    const identity = await identityCache.get();
    const systemPrompt = buildSessionSystemPrompt({ role: 'conversation', identity });

    const ledgerStore = createLedgerStore('conversation', { logger });
    const contextPolicy = createContextPolicy({
        now:                () => clock.now(),
        userMemoryWindowMs: config.userMemoryWindowMs,
        contextBuilder,
    });
    const bootBundleBuilder = createBootBundleBuilder({
        role: 'conversation', identityCache, contextBuilder, taskListReader, channelListProvider, now: () => clock.now(), bootEventsWindowMs: config.bootEventsWindowMs,
    });

    // Bounded, most-recent-first, de-duplicated record of who Izzy has recently been talking to
    // on Discord — closed over here rather than exposed on Conductor's public interface (which
    // has no concept of "recent author"); the only observer of a submitted Envelope's authorId
    // is whoever calls submit(), so this module wraps the conductor's own submit() to capture it.
    let recentAuthors: string[] = [];
    function recordRecentAuthor(authorId: string | undefined): void {
        if(authorId === undefined) {
            return;
        }
        recentAuthors = [authorId, ...recentAuthors.filter(id => id !== authorId)].slice(0, RECENT_AUTHORS_LIMIT);
    }

    async function buildBootBundleText(): Promise<string> {
        return bootBundleBuilder.build({
            lostTasks:   [],
            undelivered: [],
            recentUsers: recentAuthors,
            activeTasks: ledgerStore.get().tasks.map(task => task.description),
            resetNotice: true,
        });
    }

    // Late-bound: the compaction sink (built before the conductor exists, since it feeds into
    // buildOptions -> createConductor) needs Conductor.recordCompactionSummary, the one public
    // entry point conductor.ts exposes for PostCompact hook wiring (see conductor.ts's module
    // doc). Assigned once, right after createConductor returns, below — eslint's prefer-const
    // cannot see that the assignment below must happen after this closure is already captured.
    // eslint-disable-next-line prefer-const -- assigned exactly once, but necessarily after compactionSink/hooks/buildOptions close over it (circular build order: buildOptions -> createConductor needs hooks -> compactionSink needs the Conductor this call produces)
    let conductorRef: Conductor | undefined;

    const compactionSink: CompactionSink = {
        onCompactionStart: (trigger) => {
            ledgerStore.dispatch({ type: 'compaction_started', trigger, at: new Date(clock.now()) });
        },
        onCompactionEnd: (summary) => {
            // Gap: re-arm both context-policy gates (per-user memory, events delta) as if this
            // were a cold start, so the next turn re-injects rather than assuming the compacted
            // transcript still remembers what was already shown.
            contextPolicy.resetAll();
            void conductorRef?.recordCompactionSummary(summary);
        },
    };

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = mergeHookMaps(
        createBootBundleHooks(async () => buildBootBundleText()),
        createCompactionHooks(compactionSink),
        createSessionLifecycleHooks({}),
        createTaskTrackingHooks()
    );

    function buildOptions(resume?: string): Options {
        return buildSessionQueryOptions({
            role:           'conversation',
            systemPrompt,
            mcpServers:     sessionMcpServers,
            plugins,
            hooks,
            resume,
            mainModel:      'sonnet',
            // The per-open InterruptFlag conductor.ts creates in openWithHandle() is private to
            // that module and not threaded into this callback's signature (only `resume` is), so
            // this session's SDK stderr classifier cannot distinguish an expected
            // interrupt-abort's stderr from a real error. A deliberate, low-risk simplification:
            // it only affects log level (debug vs error) for one specific stderr string, never
            // functional behaviour.
            isInterrupting: () => false,
        });
    }

    const retryPolicy = loadRetryConfig().claude;

    const innerConductor = createConductor({
        role:    'conversation',
        queryFn,
        buildOptions,
        clock,
        readRss: () => process.memoryUsage().rss,
        ledgerStore,
        config,
        retryPolicy,
        journal,
        resumeStore,
        logger,
    });
    conductorRef = innerConductor;

    // Thin wrapper: every method delegates to innerConductor unchanged except submit(), which
    // additionally records the envelope's author (see recordRecentAuthor above) before
    // delegating — transparent to any caller (e.g. the conductor processor), which sees an
    // ordinary Conductor.
    const conductor: Conductor = {
        ...innerConductor,
        submit: (envelope: Envelope, options) => {
            if(envelope.kind === 'discord') {
                recordRecentAuthor(envelope.authorId);
            }
            return innerConductor.submit(envelope, options);
        },
    };

    return { conductor, ledgerStore, contextPolicy };
}
