/**
 * Assembles the long-lived conversation conductor (P9, design section 6): the conductor's own
 * MCP server instance set (role `'conversation'`), its once-per-process system prompt (identity
 * loaded from `IdentityCache`), and the merged hook map a session's Agent SDK `Options` need
 * (SessionStart boot bundle for `startup`/`compact`, PreCompact/PostCompact -> ledger +
 * `ContextPolicy.resetAll()`, Stop/StopFailure lifecycle
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
    createCompactionThresholdTuner,
    createConductor,
    createContextPolicy,
    createLedgerStore,
    createSessionLifecycleHooks,
    createTaskLaunchHooks,
    createTaskLaunchRegistry,
    createTaskTrackingHooks,
    mergeHookMaps,
    taskLaunchEntries,
    type BootKind,
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
    type StateTopSetSource,
    type TurnResult,
    type CalendarAgendaSource
} from '@/agent';
import { type SessionConfig, loadRetryConfig  } from '@/config';
import type { ServiceHealthRegistry } from '@/services';

/** The subset of `IdentityCache` the system prompt and boot bundle depend on. */
type IdentitySource = CreateBootBundleBuilderParams['identityCache'];

/** The subset of `ContextBuilder` the boot bundle and context policy depend on. */
type BootContextSource = CreateBootBundleBuilderParams['contextBuilder'];

/** Structurally matches `TaskListReader` — see `CreateBootBundleBuilderParams`'s own note. */
type TaskListSource = CreateBootBundleBuilderParams['taskListReader'];

/** How many distinct recently-submitted Discord authors the boot bundle's `recentUsers` section reports, most recent first. */
const RECENT_AUTHORS_LIMIT = 10;

/**
 * How far back a boot-bundle hook re-derives crash recovery from its own role's journal (P8) —
 * a second, independent read of the SAME journal `Conductor.open()` already scanned internally
 * on this process's boot, matching `conductor.ts`'s own (private) `RECOVERY_WINDOW_MS` and
 * `catchup-setup.ts`'s copy. Shared by both {@link createConversationConductor} (its own
 * pre-open `bootLostTasks` snapshot — see {@link ConversationConductorResult}'s doc for why the
 * conversation SessionStart hook itself no longer calls this) and {@link createPerchConductor}
 * (perch's boot-bundle hook still calls this directly — perch has no merged Discord catch-up
 * envelope to defer to).
 */
// Stryker disable next-line ArithmeticOperator: module-level constant — evaluated at load, before the mutant switch is set, so the runner cannot observe the mutation; the 24h value is pinned by tests/unit/app/sessions.test.ts
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Fallback lookback window for a `compact` boot bundle's events section when
 * `contextPolicy.eventsSinceMs()` has no mark yet (R1: e.g. a compaction firing before any
 * Discord turn or boot envelope has ever called `markEventsSeenAt`/`markEventsSeen`). Without
 * this fallback, such a compaction would render NO events section at all — strictly less context
 * than the pre-R1 bundle, which always injected a 24h window. Matches
 * `sessionConfigSchema`'s own `bootEventsWindowMs` default and `catchup-setup.ts`'s identically-named
 * constant.
 */
// Stryker disable next-line ArithmeticOperator: module-level constant — evaluated at load, before the mutant switch is set, so the runner cannot observe the mutation; the 24h value is pinned by tests/unit/app/sessions.test.ts
const DEFAULT_BOOT_EVENTS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The Agent SDK's SessionStart sources a boot bundle is actually built for — mirrors `hooks/boot-bundle.ts`'s own (unexported) `BootBundleSource`. */
type BootStartSource = 'startup' | 'resume' | 'compact';

/**
 * Maps the Agent SDK's SessionStart `source` onto this module's {@link BootKind} (R1): `'startup'`
 * (a cold process start) becomes `'fresh'`; `'resume'`/`'compact'` map onto themselves.
 */
function bootKindFromSource(source: BootStartSource): BootKind {
    return source === 'startup' ? 'fresh' : source;
}

/**
 * Re-derives crash recovery from `journal` over {@link RECOVERY_WINDOW_MS} and formats it for a
 * boot-bundle build (lost-task/undelivered description lists), alongside the raw `task_launched`
 * rows in the same window (R2) — the boot-time seed for each role's own
 * `TaskLaunchRegistry`, so a launch recorded just before a crash still resolves its
 * channel/author if the wake arrives after restart. Never rejects: a `readSince` failure degrades
 * to an empty recovery section (and no seed rows) rather than blocking the boot-bundle hook,
 * logged as `'${roleLabel} boot-bundle recovery read failed; continuing with an empty recovery
 * section'`. Shared by both session roles so the recovery-read/format/degrade behaviour cannot
 * drift between them.
 */
async function loadBootRecovery(
    journal: SessionJournal, clock: Clock, logger: Pick<Logger, 'warn'>, roleLabel: 'Conversation' | 'Perch'
): Promise<{ lostTasks: string[], undelivered: string[], taskLaunches: ReturnType<typeof taskLaunchEntries> }> {
    try {
        const entries = await journal.readSince(clock.now() - RECOVERY_WINDOW_MS);
        const recovery = computeRecovery(entries);
        return {
            lostTasks:    recovery.lostTasks.map(task => task.description ?? task.taskId),
            undelivered:  recovery.undelivered.map(envelope => envelope.responseText ?? `${envelope.envelopeKind} envelope ${envelope.envelopeId}`),
            taskLaunches: taskLaunchEntries(entries),
        };
    } catch (err) {
        logger.warn({ err }, `${roleLabel} boot-bundle recovery read failed; continuing with an empty recovery section`);
        return { lostTasks: [], undelivered: [], taskLaunches: [] };
    }
}

/** Dependencies and configuration for {@link createConversationConductor}. */
export interface CreateConversationConductorParams {
    config:              SessionConfig
    queryFn:             SessionQueryFn
    /** Shared MCP dependencies (P2's `createMcpSharedDeps`); this module builds its own instance set from it, once. */
    mcpShared:           McpSharedDeps
    /** Optional email MCP server factory (see `CreateMcpServerInstancesOptions`). */
    emailServerFactory?: () => McpServerConfig
    plugins?:            SdkPluginConfig[]
    /** Widened past the boot bundle's own `BootContextSource` to also cover `contextPolicy`'s `stateTopSetDelta`/`markStateTopSetSeen` gate (Q9) and `calendarDelta` gate (Q12) — perch's `CreatePerchConductorParams` stays at the narrower `BootContextSource` since it has no `ContextPolicy`. */
    contextBuilder:      BootContextSource & StateTopSetSource & CalendarAgendaSource
    /** Q12: drives `contextPolicy.healthNote()`/`markHealthSeen()` — the `[Service health]` envelope section pushed on change. Omit to leave the gate permanently disabled (`healthNote()` always returns `undefined`), exactly like omitting `healthRegistry` from `CreateContextPolicyParams` itself. `getAll` feeds the non-volatile change-detection fingerprint; `buildStatusSummary` renders the body. */
    healthRegistry?:     Pick<ServiceHealthRegistry, 'buildStatusSummary' | 'getAll'>
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
    /**
     * R1: background-task descriptions lost at restart, captured by reading `journal` HERE —
     * before this function returns, and therefore necessarily before the caller ever calls the
     * returned `conductor.open()` — for the merged Discord boot envelope
     * (`catchup-setup.ts`'s `runConductorInboxInit`/`submitMergedBootEnvelope`) to render.
     *
     * This timing is load-bearing, not incidental: `Conductor.open()`'s own boot recovery
     * (`runBootRecovery`) journals a `task_lost` entry for each of these same tasks via a
     * fire-and-forget `journal.append` (write-through, not awaited — see `journal.ts`'s module
     * doc). A read of the journal AFTER `open()` has run — as `runConductorInboxInit` used to do,
     * recomputing recovery on its own — races that write; in production, with the channel
     * registry hydration and other boot work that runs between `open()` and
     * `runConductorInboxInit` in `bot.ts`'s `clientReady`, that write reliably lands first, and
     * `computeRecovery` treats a task with its own `task_lost` entry as already resolved — so the
     * post-open read would see NO lost tasks at all, even when this boot genuinely lost one.
     * Reading here, before `open()` is even called, cannot race that write.
     */
    bootLostTasks:       string[]
    /**
     * Late-binds the delivery function for a settled background-work wake turn (R2) — the
     * Discord client/responseRouter this needs do not exist yet when this function returns, so
     * the caller (`bot.ts`'s `clientReady`, once it has built them) calls this once. Before it is
     * called, a settled wake turn logs `'wake turn settled before delivery was attached'` and is
     * dropped rather than silently discarded with no trace.
     */
    setWakeTurnDelivery: (fn: (envelope: Envelope, result: TurnResult) => Promise<void>) => void
}

/**
 * Builds the conversation conductor's MCP server set, system prompt, hooks, ledger and context
 * policy, and returns a {@link Conductor} that has NOT been opened. The caller is responsible for
 * calling `conductor.open()` when it decides opening is safe.
 * @param params See {@link CreateConversationConductorParams}.
 * @returns `{ conductor, ledgerStore, contextPolicy, compactionTelemetry, bootLostTasks }` — see {@link ConversationConductorResult}.
 */
export async function createConversationConductor(params: CreateConversationConductorParams): Promise<ConversationConductorResult> {
    const {
        config, queryFn, mcpShared, emailServerFactory, plugins, contextBuilder, healthRegistry,
        identityCache, taskListReader, journal, resumeStore, channelListProvider, clock, logger,
    } = params;

    // R1: see ConversationConductorResult.bootLostTasks's own doc for why this MUST be read here
    // — before conductor.open() is ever called by this function's caller — rather than lazily
    // inside the SessionStart hook below (which no longer renders lost tasks at all; see
    // buildBootBundleText's own doc) or from `catchup-setup.ts` after open() has run.
    const { lostTasks: bootLostTasks, taskLaunches: bootTaskLaunches } = await loadBootRecovery(journal, clock, logger, 'Conversation');

    // R2: seeded here (before open()) for the same reason bootLostTasks is read here — a launch
    // recorded just before a crash must resolve its channel/author if the wake arrives on this
    // fresh process, and the registry needs to be ready before any hook can possibly fire.
    const taskLaunchRegistry = createTaskLaunchRegistry({ journal });
    taskLaunchRegistry.seed(bootTaskLaunches);

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
        now: () => clock.now(),
        contextBuilder,
        healthRegistry,
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

    /**
     * Maps the SessionStart `source` onto a {@link BootKind} (R1). Deliberately renders NEITHER
     * lost tasks NOR undelivered envelopes for `fresh`/`resume` (always `[]`, so `boot-bundle.ts`
     * omits those sections entirely — its own `renderListSection` renders nothing for an empty
     * list): that content is the exclusive responsibility of the merged Discord boot envelope
     * (`catchup-setup.ts`'s `runConductorInboxInit`/`submitMergedBootEnvelope`), which fires in
     * the SAME boot sequence moments after this hook's `fresh`/`resume` SessionStart — see design
     * decision 2, "the boot bundle and the Discord catch-up merge into ONE boot envelope". Feeding
     * the same journal-derived recovery into both would inject the same "lost tasks"/"undelivered
     * replies" content twice on every restart (a `resume` boot — the common case — otherwise
     * duplicated it on every single restart). Perch has no such merged envelope, so its own
     * boot-bundle hook (below) keeps calling {@link loadBootRecovery} directly for every kind.
     *
     * `compact` renders "events since the mark" via `contextPolicy.eventsSinceMs()` (the mark
     * survives `resetAll()` — see context-policy.ts's own module doc), falling back to
     * {@link DEFAULT_BOOT_EVENTS_WINDOW_MS} when no mark has been seeded yet (e.g. perch's
     * `testMode.triggerOnStartup` suppresses the boot envelope that would normally seed it, and a
     * compaction fires before any Discord turn seeds it either) so a compaction re-seed never
     * renders zero events purely because nothing has called `markEventsSeenAt`/`markEventsSeen`
     * yet — strictly less context than the pre-R1 bundle would be a regression, not an
     * improvement. The mark advances via `markEventsSeen()` once the bundle has actually been
     * built, so a later compaction's window starts from here rather than replaying the same
     * events again.
     */
    async function buildBootBundleText(source: BootStartSource): Promise<string> {
        const kind = bootKindFromSource(source);
        const eventsSinceMs = kind === 'compact'
            ? contextPolicy.eventsSinceMs() ?? (clock.now() - DEFAULT_BOOT_EVENTS_WINDOW_MS)
            : undefined;

        const text = await bootBundleBuilder.build({
            kind,
            eventsSinceMs,
            lostTasks:   [],
            undelivered: [],
            recentUsers: recentAuthors,
            activeTasks: ledgerStore.get().tasks.map(task => task.description),
        });

        if(kind === 'compact') {
            contextPolicy.markEventsSeen();
        }

        return text;
    }

    // Late-bound: the compaction telemetry (built before the conductor exists, since it feeds into
    // buildOptions -> createConductor) reads the live threshold from the conductor. Assigned once,
    // right after createConductor returns, below — eslint's prefer-const cannot see that the
    // assignment below must happen after this closure is already captured.
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
        onCompactionEnd: () => {
            // Gap: re-arm both context-policy gates (per-user memory, events delta) as if this
            // were a cold start, so the next turn re-injects rather than assuming the compacted
            // transcript still remembers what was already shown. The summary itself is not
            // persisted (see conductor.ts's module doc).
            contextPolicy.resetAll();
        },
    };

    // R2: the same late-bound-conductor pattern as compactionTelemetry above — createTaskLaunchHooks
    // needs a live Conductor's `status`/`adoptWakeTurn`, but hooks are built before createConductor
    // returns one. The `status()` fallback below can only be observed in the narrow window before
    // conductorRef is assigned (a few lines down, still before this function returns) — no hook
    // ever fires that early, since firing requires a live turn, which requires open().
    const taskLaunchConductor: Pick<Conductor, 'status' | 'adoptWakeTurn'> = {
        // Stryker disable next-line ObjectLiteral,OptionalChaining,StringLiteral,BooleanLiteral: the `?? {...}` fallback is unreachable by construction — see the comment above: conductorRef is assigned synchronously below, with no `await` in between, and no hook (the only caller of this `status()`) can fire before this function has already returned that assignment complete.
        status:        () => conductorRef?.status() ?? { role: 'conversation', sessionId: undefined, opened: false, shuttingDown: false, queueLength: 0, turn: null },
        adoptWakeTurn: (input) => { conductorRef?.adoptWakeTurn(input); },
    };

    // R2: late-bound the same way — the Discord client/responseRouter a delivery function needs
    // do not exist until `bot.ts`'s `clientReady` calls the returned `setWakeTurnDelivery`. Before
    // that, a settled wake turn is logged and dropped rather than silently lost with no trace.
    let wakeTurnDelivery: ((envelope: Envelope, result: TurnResult) => Promise<void>) | undefined;
    async function onWakeTurnSettled(envelope: Envelope, result: TurnResult): Promise<void> {
        if(wakeTurnDelivery === undefined) {
            logger.warn({ envelopeId: envelope.id }, 'wake turn settled before delivery was attached');
            return;
        }
        await wakeTurnDelivery(envelope, result);
    }
    function setWakeTurnDelivery(fn: (envelope: Envelope, result: TurnResult) => Promise<void>): void {
        wakeTurnDelivery = fn;
    }

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = mergeHookMaps(
        createBootBundleHooks(async source => buildBootBundleText(source)),
        createCompactionHooks(compactionSink),
        createSessionLifecycleHooks({}),
        createTaskTrackingHooks(),
        createTaskLaunchHooks({ registry: taskLaunchRegistry, conductor: taskLaunchConductor, logger, clock })
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
        role:         'conversation',
        queryFn,
        buildOptions,
        clock,
        readRss:      () => process.memoryUsage().rss,
        ledgerStore,
        config,
        retryPolicy,
        journal,
        resumeStore,
        logger,
        taskLaunches: taskLaunchRegistry,
        onWakeTurnSettled,
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

    // Q11: nudges the guard's live threshold toward config.compactTargetIntervalMs, clamped to
    // [compactThresholdMinPercent, compactThresholdMaxPercent] — both default to
    // compactThresholdPercent, so with none of the three set this is a permanent no-op (see
    // compaction-tuner.ts's module doc). Fire-and-forget for process lifetime, matching
    // src/index.ts's own health-registry/cost-ceiling subscribers — no disposal path exists for
    // any conductor-scoped ledgerStore subscription today.
    createCompactionThresholdTuner({
        ledgerStore,
        telemetry:           compactionTelemetry,
        config,
        getThresholdPercent: () => conductor.getCompactionThresholdPercent(),
        setThresholdPercent: (percent) => { conductor.setCompactionThresholdPercent(percent); },
        clock,
        logger,
    });

    return {
        conductor, ledgerStore, contextPolicy, compactionTelemetry, bootLostTasks, setWakeTurnDelivery,
    };
}

/** Dependencies and configuration for {@link createPerchConductor}. */
export interface CreatePerchConductorParams {
    config:              SessionConfig
    queryFn:             SessionQueryFn
    /** Shared MCP dependencies (P2's `createMcpSharedDeps`); this module builds its OWN instance set from it — a second, distinct set from the conversation conductor's own (a shared instance cannot serve two concurrent sessions). */
    mcpShared:           McpSharedDeps
    /** Optional email MCP server factory (see `CreateMcpServerInstancesOptions`) — a fresh instance for this session, exactly as the conversation conductor gets. Perch turns triage the inbox, so they need the same email tools (unified tool set; first perch soak 2026-09-06 found them missing). */
    emailServerFactory?: () => McpServerConfig
    plugins?:            SdkPluginConfig[]
    contextBuilder:      BootContextSource
    identityCache:       IdentitySource
    taskListReader:      TaskListSource
    journal:             SessionJournal
    resumeStore:         ResumeStore
    clock:               Clock
    logger:              Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

/** What {@link createPerchConductor} returns. */
export interface PerchConductorResult {
    conductor:           Conductor
    ledgerStore:         LedgerStore
    compactionTelemetry: CompactionTelemetry
    /**
     * Late-binds the delivery function for a settled background-work wake turn (R2) — see
     * {@link ConversationConductorResult.setWakeTurnDelivery}'s identical doc. The envelope
     * `fn` receives always has `kind: 'perch'` (rewritten here from the conductor's own
     * synthesized `'task'` kind) so `ResponseRouter`'s existing well-known-channel mapping routes
     * it to `perch-time` — see this module's own Q12 perch-decision doc above for why perch has
     * no origin channel of its own to fall back to instead.
     */
    setWakeTurnDelivery: (fn: (envelope: Envelope, result: TurnResult) => Promise<void>) => void
}

/**
 * Builds the perch conductor's OWN MCP server set (role `'perch'` — no browser, since the single
 * Bun.WebView belongs to the conversation session; every other server, email included, is the
 * unified set — see `createMcpServerInstances`'s own role-gating doc), system prompt, hooks, and
 * ledger, and
 * returns a {@link Conductor} that has NOT been opened — mirrors
 * {@link createConversationConductor}'s own build-only contract exactly; the caller
 * (`src/index.ts`/`bot.ts`'s `clientReady`) decides when opening is safe and degrades to the
 * legacy perch scheduler/runner if `open()` rejects.
 *
 * Unlike the conversation conductor, perch's boot-bundle SessionStart hook re-derives crash
 * recovery itself, independent of the recovery `Conductor.open()` already scans internally on
 * this process's boot (see {@link RECOVERY_WINDOW_MS}'s doc), so a background task a prior
 * process started but never finished, or a perch-channel Discord turn that finished but was
 * never confirmed delivered, is actually reported in the next boot-bundle text — the folded
 * "perch conductor boot" gap this package closes. Its FIRST call reuses the construction-time
 * read this function already did to seed the task-launch registry (R2's `pendingBootRecovery`,
 * below) rather than issuing a second duplicate 24h query; only a LATER SessionStart (a resume
 * long afterward, or a compaction) reads the journal again. Also unlike conversation,
 * there is no `ContextPolicy`: perch's boot bundle carries no per-user memory block to gate (see
 * `boot-bundle.ts`'s perch variant), so there is nothing for a compaction to reset.
 *
 * Q12 perch decision (pinned, deliberate): this is also why perch gets none of the Discord
 * conductor's memory-tuning deltas (Q9's `stateTopSetDelta`, Q12's `calendarDelta`/`healthNote`)
 * — with no `ContextPolicy` here, there is no mark/delta baseline to diff against. Perch turns
 * instead carry the FULL context every time (`buildPerchContext`: full agenda, full health, top-3
 * state — see `agent/perch/envelope.ts`'s own module doc for the fuller rationale), which is the
 * right tradeoff for a session that runs only a handful of turns per day rather than a wrong one
 * to fix later.
 * @param params See {@link CreatePerchConductorParams}.
 * @returns `{ conductor, ledgerStore, compactionTelemetry }` — see {@link PerchConductorResult}.
 */
export async function createPerchConductor(params: CreatePerchConductorParams): Promise<PerchConductorResult> {
    const {
        config, queryFn, mcpShared, emailServerFactory, plugins, contextBuilder, identityCache, taskListReader, journal, resumeStore, clock, logger,
    } = params;

    // R2: seeded here (before open()), for the same reason createConversationConductor's own
    // bootTaskLaunches read is — see that function's identical comment. Also reused by
    // buildBootBundleText's own FIRST call below (pendingBootRecovery) so a perch process start
    // issues exactly one 24h journal read rather than two.
    const initialBootRecovery = await loadBootRecovery(journal, clock, logger, 'Perch');
    const taskLaunchRegistry = createTaskLaunchRegistry({ journal });
    taskLaunchRegistry.seed(initialBootRecovery.taskLaunches);

    const mcpInstances = createMcpServerInstances(mcpShared, { role: 'perch', emailServerFactory });
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
        email:          mcpInstances.emailMcpServer,
        // No browser (single Bun.WebView — conversation only).
    };

    // Built once, here, from the injected IdentityCache — never rebuilt on a later reopen.
    const identity = await identityCache.get();
    const systemPrompt = buildSessionSystemPrompt({ role: 'perch', identity });

    const ledgerStore = createLedgerStore('perch', { logger });
    const bootBundleBuilder = createBootBundleBuilder({
        role: 'perch', identityCache, contextBuilder, taskListReader, now: () => clock.now(), bootEventsWindowMs: config.bootEventsWindowMs,
    });

    /**
     * R2: the construction-time {@link initialBootRecovery} read, consumed exactly once by
     * {@link buildBootBundleText}'s first call (the process's initial SessionStart) so a perch
     * process start issues one 24h journal read rather than two; cleared immediately after, so a
     * later SessionStart (a resume long afterward, or a compaction) re-reads the journal fresh
     * rather than replaying stale recovery data.
     */
    let pendingBootRecovery: { lostTasks: string[], undelivered: string[] } | undefined = {
        lostTasks: initialBootRecovery.lostTasks, undelivered: initialBootRecovery.undelivered,
    };

    /**
     * Maps the SessionStart `source` onto a {@link BootKind} (R1) and re-derives crash recovery
     * from the perch journal (see {@link loadBootRecovery}), feeding it, alongside the ledger's
     * own live task descriptions, into the perch boot-bundle variant. Never rejects: a
     * `readSince` failure degrades to an empty recovery section rather than blocking the
     * boot-bundle hook. The FIRST call reuses {@link pendingBootRecovery} instead of reading again
     * (R2) — see that field's own doc.
     */
    async function buildBootBundleText(source: BootStartSource): Promise<string> {
        const kind = bootKindFromSource(source);
        // Consumed (read then cleared) before the `await` below — never across it — so two
        // overlapping calls cannot race on a stale read of `pendingBootRecovery`.
        const cachedBootRecovery = pendingBootRecovery;
        pendingBootRecovery = undefined;
        const { lostTasks, undelivered } = cachedBootRecovery ?? await loadBootRecovery(journal, clock, logger, 'Perch');

        return bootBundleBuilder.build({
            kind,
            lostTasks,
            undelivered,
            recentUsers: [],
            activeTasks: ledgerStore.get().tasks.map(task => task.description),
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
        onCompactionEnd: () => {
            // No ContextPolicy to reset (perch injects no per-user memory block), and the summary
            // is not persisted (see conductor.ts's module doc): nothing to do here.
        },
    };

    // R2: see createConversationConductor's identical comment for why this pass-through exists.
    const taskLaunchConductor: Pick<Conductor, 'status' | 'adoptWakeTurn'> = {
        // Stryker disable next-line ObjectLiteral,OptionalChaining,StringLiteral,BooleanLiteral: the `?? {...}` fallback is unreachable by construction — see createConversationConductor's identical comment/disable above: conductorRef is assigned synchronously below with no `await` in between, and no hook can fire before that assignment completes.
        status:        () => conductorRef?.status() ?? { role: 'perch', sessionId: undefined, opened: false, shuttingDown: false, queueLength: 0, turn: null },
        adoptWakeTurn: (input) => { conductorRef?.adoptWakeTurn(input); },
    };

    // R2: late-bound the same way as createConversationConductor's own onWakeTurnSettled, with
    // one difference (the Q12 perch decision, see PerchConductorResult.setWakeTurnDelivery's own
    // doc): the envelope handed to `fn` always has `kind` rewritten to `'perch'`, so it routes to
    // the well-known perch-time channel via ResponseRouter's existing mapping regardless of
    // whether the launch record carried a channelId (a perch envelope never has one).
    let wakeTurnDelivery: ((envelope: Envelope, result: TurnResult) => Promise<void>) | undefined;
    async function onWakeTurnSettled(envelope: Envelope, result: TurnResult): Promise<void> {
        if(wakeTurnDelivery === undefined) {
            logger.warn({ envelopeId: envelope.id }, 'wake turn settled before delivery was attached');
            return;
        }
        await wakeTurnDelivery({ ...envelope, kind: 'perch' }, result);
    }
    function setWakeTurnDelivery(fn: (envelope: Envelope, result: TurnResult) => Promise<void>): void {
        wakeTurnDelivery = fn;
    }

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = mergeHookMaps(
        createBootBundleHooks(async source => buildBootBundleText(source)),
        createCompactionHooks(compactionSink),
        createSessionLifecycleHooks({}),
        createTaskTrackingHooks(),
        createTaskLaunchHooks({ registry: taskLaunchRegistry, conductor: taskLaunchConductor, logger, clock })
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
        role:         'perch',
        queryFn,
        buildOptions,
        clock,
        readRss:      () => process.memoryUsage().rss,
        ledgerStore,
        config,
        retryPolicy,
        journal,
        resumeStore,
        logger,
        taskLaunches: taskLaunchRegistry,
        onWakeTurnSettled,
    });
    conductorRef = conductor;

    // Q11: see createConversationConductor's identical wiring/comment above.
    createCompactionThresholdTuner({
        ledgerStore,
        telemetry:           compactionTelemetry,
        config,
        getThresholdPercent: () => conductor.getCompactionThresholdPercent(),
        setThresholdPercent: (percent) => { conductor.setCompactionThresholdPercent(percent); },
        clock,
        logger,
    });

    return {
        conductor, ledgerStore, compactionTelemetry, setWakeTurnDelivery,
    };
}
