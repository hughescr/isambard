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
    computeRecovery,
    createBootBundleBuilder,
    createBootBundleHooks,
    createCompactionHooks,
    createCompactionTelemetry,
    createConductor,
    createContextPolicy,
    createLedgerStore,
    createSessionLifecycleHooks,
    createTaskTrackingHooks,
    mergeHookMaps,
    type Clock,
    type CompactionSink,
    type CompactionTelemetry,
    type Conductor,
    type ContextPolicy,
    type CreateBootBundleBuilderParams,
    type Envelope,
    type LedgerStore,
    type ResumeStore,
    type SessionJournal,
    type SessionMcpServers,
    type SessionQueryFn,
    type StateTopSetSource
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
    /** Widened past the boot bundle's own `BootContextSource` to also cover `contextPolicy`'s `stateTopSetDelta`/`markStateTopSetSeen` gate (Q9) — perch's `CreatePerchConductorParams` stays at the narrower `BootContextSource` since it has no `ContextPolicy`. */
    contextBuilder:      BootContextSource & StateTopSetSource
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
    conductor:           Conductor
    ledgerStore:         LedgerStore
    contextPolicy:       ContextPolicy
    compactionTelemetry: CompactionTelemetry
}

/**
 * Builds the conversation conductor's MCP server set, system prompt, hooks, ledger and context
 * policy, and returns a {@link Conductor} that has NOT been opened. The caller is responsible for
 * calling `conductor.open()` when it decides opening is safe.
 * @param params See {@link CreateConversationConductorParams}.
 * @returns `{ conductor, ledgerStore, contextPolicy, compactionTelemetry }` — see {@link ConversationConductorResult}.
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
        health:         mcpInstances.healthMcpServer,
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

    // Q4: structured per-compaction telemetry, fed only from this role's ledgerStore. Reads the
    // threshold fresh from the live conductor on every compaction_started (falling back to the
    // static config value for the narrow window before conductorRef is assigned below) so a
    // later setCompactionThresholdPercent() call is reflected in each subsequent record.
    const compactionTelemetry = createCompactionTelemetry({
        getThresholdPercent: () => conductorRef?.getCompactionThresholdPercent() ?? config.compactThresholdPercent,
    });
    ledgerStore.subscribe((_ledger, event) => compactionTelemetry.record(event));

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

    return {
        conductor, ledgerStore, contextPolicy, compactionTelemetry,
    };
}

/**
 * How far back {@link createPerchConductor}'s own boot-bundle hook re-derives crash recovery
 * from the perch journal — matches `conductor.ts`'s own (private) `RECOVERY_WINDOW_MS` and
 * `catchup-setup.ts`'s copy: a deliberate, documented duplication of one read-only computation
 * (see this module's own doc and `catchup-setup.ts`'s `runConductorInboxInit` for the same
 * pattern), not of the journal-write/delivery-guard-seeding work `Conductor.open()` itself
 * already does unconditionally on every open (P8).
 */
const PERCH_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Dependencies and configuration for {@link createPerchConductor}. */
export interface CreatePerchConductorParams {
    config:         SessionConfig
    queryFn:        SessionQueryFn
    /** Shared MCP dependencies (P2's `createMcpSharedDeps`); this module builds its OWN instance set from it — a second, distinct set from the conversation conductor's own (a shared instance cannot serve two concurrent sessions). */
    mcpShared:      McpSharedDeps
    plugins?:       SdkPluginConfig[]
    contextBuilder: BootContextSource
    identityCache:  IdentitySource
    taskListReader: TaskListSource
    journal:        SessionJournal
    resumeStore:    ResumeStore
    clock:          Clock
    logger:         Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

/** What {@link createPerchConductor} returns. */
export interface PerchConductorResult {
    conductor:           Conductor
    ledgerStore:         LedgerStore
    compactionTelemetry: CompactionTelemetry
}

/**
 * Builds the perch conductor's OWN MCP server set (role `'perch'` — no browser, no email; see
 * `createMcpServerInstances`'s own role-gating doc), system prompt, hooks, and ledger, and
 * returns a {@link Conductor} that has NOT been opened — mirrors
 * {@link createConversationConductor}'s own build-only contract exactly; the caller
 * (`src/index.ts`/`bot.ts`'s `clientReady`) decides when opening is safe and degrades to the
 * legacy perch scheduler/runner if `open()` rejects.
 *
 * Unlike the conversation conductor, perch's boot-bundle SessionStart hook re-derives crash
 * recovery itself (a second, independent read of the SAME journal `Conductor.open()` already
 * scanned internally on this process's boot — see {@link PERCH_RECOVERY_WINDOW_MS}'s doc) so a
 * background task a prior process started but never finished, or a perch-channel Discord turn
 * that finished but was never confirmed delivered, is actually reported in the next boot-bundle
 * text — the folded "perch conductor boot" gap this package closes. Also unlike conversation,
 * there is no `ContextPolicy`: perch's boot bundle carries no per-user memory block to gate (see
 * `boot-bundle.ts`'s perch variant), so there is nothing for a compaction to reset.
 * @param params See {@link CreatePerchConductorParams}.
 * @returns `{ conductor, ledgerStore, compactionTelemetry }` — see {@link PerchConductorResult}.
 */
export async function createPerchConductor(params: CreatePerchConductorParams): Promise<PerchConductorResult> {
    const {
        config, queryFn, mcpShared, plugins, contextBuilder, identityCache, taskListReader, journal, resumeStore, clock, logger,
    } = params;

    const mcpInstances = createMcpServerInstances(mcpShared, { role: 'perch' });
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
        health:         mcpInstances.healthMcpServer,
        // No browser (single Bun.WebView — conversation only) and no email server for perch.
    };

    // Built once, here, from the injected IdentityCache — never rebuilt on a later reopen.
    const identity = await identityCache.get();
    const systemPrompt = buildSessionSystemPrompt({ role: 'perch', identity });

    const ledgerStore = createLedgerStore('perch', { logger });
    const bootBundleBuilder = createBootBundleBuilder({
        role: 'perch', identityCache, contextBuilder, taskListReader, now: () => clock.now(), bootEventsWindowMs: config.bootEventsWindowMs,
    });

    /**
     * Re-derives crash recovery from the perch journal (see {@link PERCH_RECOVERY_WINDOW_MS}'s
     * doc) and feeds it, alongside the ledger's own live task descriptions, into the perch
     * boot-bundle variant. Never rejects: a `readSince` failure degrades to an empty recovery
     * section rather than blocking the boot-bundle hook.
     */
    async function buildBootBundleText(): Promise<string> {
        let lostTasks: string[] = [];
        let undelivered: string[] = [];
        try {
            const entries = await journal.readSince(clock.now() - PERCH_RECOVERY_WINDOW_MS);
            const recovery = computeRecovery(entries);
            lostTasks = recovery.lostTasks.map(task => task.description ?? task.taskId);
            undelivered = recovery.undelivered.map(envelope => envelope.responseText ?? `${envelope.envelopeKind} envelope ${envelope.envelopeId}`);
        } catch (err) {
            logger.warn({ err }, 'Perch boot-bundle recovery read failed; continuing with an empty recovery section');
        }

        return bootBundleBuilder.build({
            lostTasks,
            undelivered,
            recentUsers: [],
            activeTasks: ledgerStore.get().tasks.map(task => task.description),
            resetNotice: true,
        });
    }

    // Late-bound for the same reason as createConversationConductor's own conductorRef — see
    // that function's comment for the circular build order this resolves.
    // eslint-disable-next-line prefer-const -- assigned exactly once, but necessarily after compactionSink/hooks/buildOptions close over it
    let conductorRef: Conductor | undefined;

    // Q4: see createConversationConductor's identical comment for why the fallback exists.
    const compactionTelemetry = createCompactionTelemetry({
        getThresholdPercent: () => conductorRef?.getCompactionThresholdPercent() ?? config.compactThresholdPercent,
    });
    ledgerStore.subscribe((_ledger, event) => compactionTelemetry.record(event));

    const compactionSink: CompactionSink = {
        onCompactionStart: (trigger) => {
            ledgerStore.dispatch({ type: 'compaction_started', trigger, at: new Date(clock.now()) });
        },
        onCompactionEnd: (summary) => {
            // No ContextPolicy to reset (perch injects no per-user memory block) — just report
            // the summary, mirroring conversation's own PostCompact wiring otherwise.
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
            role:           'perch',
            systemPrompt,
            mcpServers:     sessionMcpServers,
            plugins,
            hooks,
            resume,
            mainModel:      'sonnet',
            // See createConversationConductor's identical comment: no per-open InterruptFlag is
            // threaded into this callback, so the stderr classifier cannot distinguish an
            // expected interrupt-abort's stderr from a real error — log-level only, no functional effect.
            isInterrupting: () => false,
        });
    }

    const retryPolicy = loadRetryConfig().claude;

    const conductor = createConductor({
        role:    'perch',
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
    conductorRef = conductor;

    return {
        conductor, ledgerStore, compactionTelemetry,
    };
}
