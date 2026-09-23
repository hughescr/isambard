/**
 * Boot bundle composer for the long-lived session core.
 *
 * Assembles the boot bundle text. Delivery depends on the kind (#98): `fresh` and
 * `restart_resume` travel in the conductor's opening `[BOOT]` handshake (its `buildBootBundle`,
 * pushed via `buildBootEnvelope`, ./envelope.ts), because the real SDK never fires an
 * SDK-callback `SessionStart` hook for `startup`/`resume` in a streaming-input session
 * (anthropics/claude-agent-sdk-typescript#465); `compact` is `additionalContext` on the
 * `SessionStart` callback, which the SDK does fire for compaction; and `reopen` is never built by
 * anyone (the conductor skips the build for a reopen that resumes). R1 re-seeds by boot KIND
 * rather than always injecting the same full bundle:
 *
 * - `fresh` (a cold process start): the full re-seed — current focus/state, events
 *   (the rolling `bootEventsWindowMs` window, or `eventsSinceMs` when the caller has a better
 *   boundary), the task list, the channel list, who was recently talked to, background tasks
 *   lost at restart, undelivered envelopes, and the live active-task set.
 * - `compact` (working memory was just reset by a compaction): current focus/state,
 *   events since the mark, the task list, and the active-task set — NO channel list, recent
 *   users, lost tasks or undelivered envelopes, because nothing was lost across a compaction
 *   (Discord turns are held by the conductor for the duration; see `conductor.ts`).
 * - `restart_resume` (the transcript survived a PROCESS restart — the host process was down, and
 *   the new process resumed the stored session): ONLY what happened while offline — events since
 *   the last journaled turn, lost tasks, undelivered envelopes, and the active-task set — no
 *   state/task-list/channels, since none of that was lost. `build()` returns `''` (and the
 *   conductor then pushes its bare `[BOOT] Session resumed` marker instead) when every one of
 *   those sections is empty — normally so for conversation, whose ledger is new at boot and whose
 *   lost tasks the Discord catch-up owns.
 * - `reopen` (the transcript survived an IN-PROCESS reopen — the conductor replaced a crashed
 *   session, or closed and resumed it on request, e.g. after an identity change, while the host
 *   process kept running): ALWAYS `''`, returned before the time header or any fetch. Nothing
 *   was offline: the conductor held its queue across the reopen and re-delivers whatever the dead
 *   session never read (see `reopenReplacementSession` in `conductor.ts`). The one thing a reopen
 *   can lose — background tasks the old session process was running — is named in the
 *   conductor's own reopen `[BOOT]` handshake instead, which is the first thing the replacement
 *   reads whether its resume succeeds or falls back to a fresh session. Since #98 no caller asks
 *   for this kind (the conductor simply skips the build for a reopen that resumes); the early
 *   return stays as a guard.
 *
 * The conductor names the kind for each open attempt it builds: `restart_resume` for a boot open
 * resuming its stored session, `fresh` for a fresh boot open or the fallback after that resume
 * failed, and nothing at all for an in-process reopen that resumes. A reopen whose resume fails
 * falls back to a fresh session (`fresh`, with the reopen's cause): it gets the full re-seed,
 * appended to that reopen's own handshake, minus the old session's tasks and recovery, which the
 * handshake already covers. When a build fails or times out, the conductor can render
 * {@link formatRecoveryOnlyBootBundle} instead.
 *
 * Two role variants share one builder: `conversation` re-seeds the sections above; `perch`
 * re-seeds the task list and `ContextBuilder.buildPerchContext`'s own block verbatim
 * for `fresh`/`compact` (it already carries a time header, top state and recent events, so
 * those sections are not rendered separately for perch, and there is no channel list) and, for
 * `restart_resume`, only lost tasks/undelivered/active tasks — no task list or perch context
 * fetch at all.
 *
 * NO bundle of any kind carries an `## Identity` section (WP4a): identity is rendered into the
 * session's own SDK `systemPrompt` instead, and a change to it drives a controlled
 * close-and-resume (`Conductor.requestReopen`, a `reopen` kind) rather than a fresh boot bundle
 * — so re-seeding it here as USER-turn text would only duplicate, in every fresh/compact bundle,
 * what the system prompt already states once and caches.
 *
 * Session-peers block 4: every non-empty bundle opens with the role's ambient time header (the
 * injected `timeHeader` provider — `ambience.timeHeaderFor(role)` at the composition root), so a
 * boot turn carries the same time / other-session / quota block every other envelope does. It is
 * rendered ahead of the body but is NOT one of the sections the empty-`restart_resume` test consults, so
 * a restart_resume with nothing to report still renders `''` rather than waking the session with a clock.
 * The perch `fresh`/`compact` bundle consequently carries the header twice — once ambient, once
 * as the bare `formatTimeHeader()` that leads `buildPerchContext`'s own block — exactly as the
 * perch SLOT envelope already does; `buildPerchContext` stays ledger-unaware by design.
 *
 * Design decision (folded gap, "cross-platform history has no home"): the boot bundle does NOT
 * carry a cross-platform-history section. History is tool-only in the long-lived session —
 * `getPersonContext` covers it on demand, so there is nothing for the bundle to pre-seed.
 *
 * `formatBootBundle` is a pure function over already-gathered {@link BootBundleParts}, exported
 * and unit-tested independently of the async gathering `createBootBundleBuilder` performs.
 *
 * @module agent/session/boot-bundle
 */
import { formatMemoryPreview, type ContextBuilder } from '../context-builder';

/** The subset of `ContextBuilder` this builder depends on. */
export type BootContextSource = Pick<ContextBuilder, 'loadHotState' | 'loadRecentEventsSince' | 'buildPerchContext'>;

/**
 * Structurally matches `TaskListReader` (src/agent/task-list-reader.ts), which is not exported
 * from that module — any real `TaskListReader` value satisfies this by TypeScript's structural
 * typing.
 */
export interface TaskListSource {
    buildTaskListSummary: () => Promise<string | undefined>
}

/**
 * Which kind of session start a boot bundle is re-seeding for — see the module doc for what each
 * kind injects and how each is delivered.
 */
export type BootKind = 'fresh' | 'restart_resume' | 'reopen' | 'compact';

/** Inputs to {@link createBootBundleBuilder}. */
export interface CreateBootBundleBuilderParams {
    role:                 'conversation' | 'perch'
    contextBuilder:       BootContextSource
    taskListReader:       TaskListSource
    /** Optional channel-list text provider; never invoked for the perch variant, nor for any non-`fresh` kind. */
    channelListProvider?: () => Promise<string | undefined>
    /** Millisecond clock, e.g. `() => clock.now()`. */
    now:                  () => number
    /**
     * Session-peers block 4: the role's ambient time-header provider
     * (`ambience.timeHeaderFor(role)`, already bound to the session's timezone by the composition
     * root). Called once per `build()`, so a boot bundle opens with the same "where am I in time,
     * what is the other session doing, how much quota is left" block every other envelope carries.
     * Omitted leaves the bundle with no header at all, exactly as before block 4.
     */
    timeHeader?:          () => string
    /** Rolling window for the `fresh` conversation "Events" section when `eventsSinceMs` is not given. Defaults to 24h. */
    bootEventsWindowMs?:  number
    /** Max events fetched for that section. Defaults to 50. */
    bootEventsLimit?:     number
}

/** Ledger/journal-derived facts supplied at build time (not known to the builder itself). */
export interface BuildBootBundleInput {
    /** Which kind of session start this bundle is re-seeding for; a `reopen` renders `''` whatever else is given. */
    kind:           BootKind
    /**
     * Absolute epoch ms events high-water mark (e.g. `ContextPolicy.eventsSinceMs()` or a
     * journal-derived `lastKnownAt`). When given, the events section covers `now - eventsSinceMs`
     * regardless of kind. When omitted: `fresh` falls back to `bootEventsWindowMs`; `restart_resume`/
     * `compact` render no events section at all (and fetch nothing).
     */
    eventsSinceMs?: number
    /** Background task descriptions lost when the process last restarted. */
    lostTasks:      string[]
    /** Envelope descriptions submitted but never followed by a delivered response. */
    undelivered:    string[]
    /** Who Izzy was recently talking to, most relevant first. Rendered for `fresh` only. */
    recentUsers:    string[]
    /** The live background-task set from the ledger, still running right now. */
    activeTasks:    string[]
}

/** A boot bundle builder for one session role. */
export interface BootBundleBuilder {
    build: (input: BuildBootBundleInput) => Promise<string>
}

/** Already-gathered pieces {@link formatBootBundle} renders, in role-and-kind-dependent order. */
export interface BootBundleParts {
    role:             'conversation' | 'perch'
    /** Never `reopen`: {@link BootBundleBuilder.build} returns `''` for a reopen before gathering any parts. */
    kind:             Exclude<BootKind, 'reopen'>
    /**
     * The ambient time header (session-peers block 4), rendered verbatim ahead of every other
     * section. Deliberately NOT one of the sections the empty-`restart_resume` check consults: a header
     * is true of every moment, so a restart_resume with nothing else to say still renders `''`.
     */
    timeHeader?:      string
    /** Conversation only; fresh/compact only. */
    currentFocus?:    string
    /** Conversation only; omitted (section not rendered) when there is nothing to show, or when the kind doesn't render events. */
    events?:          string
    /** Conversation: fresh/compact only. Perch: fresh/compact only. */
    taskListSummary?: string
    /** Conversation only; fresh only. */
    channelList?:     string
    /** Perch only: `ContextBuilder.buildPerchContext`'s block, rendered verbatim (no added header); fresh/compact only. */
    perchContext?:    string
    /** Conversation only; fresh only. */
    recentUsers:      string[]
    /** Rendered for every kind except `compact` (nothing was lost across a compaction). */
    lostTasks:        string[]
    /** Rendered for every kind except `compact`. */
    undelivered:      string[]
    /** Conversation: every kind. Perch: `restart_resume` only (fresh/compact never rendered it). */
    activeTasks:      string[]
}

const RESET_NOTICE = 'Working memory was reset (compaction or restart); this bundle re-seeds it.';

/** Renders a `## Heading` section, or `undefined` when there is nothing to show. */
function renderHeadingSection(heading: string, body: string | undefined): string | undefined {
    return body ? `## ${heading}\n${body}` : undefined;
}

/** Renders a `## Heading` section from a list, or `undefined` when the list is empty. */
function renderListSection(heading: string, items: string[]): string | undefined {
    return items.length > 0 ? `## ${heading}\n${items.join('\n')}` : undefined;
}

/**
 * The events section's heading: only `fresh` actually covers a fixed `bootEventsWindowMs`
 * (default 24h) rolling window when no `eventsSinceMs` override is given, so only `fresh` is
 * labelled that way. `compact`/`restart_resume` always render an arbitrary since-the-mark span (whatever
 * `eventsSinceMs` the caller supplied — minutes after a fast compaction, days after an outage),
 * so a literal "last 24h" would misrepresent the window and could lead Izzy to assume the rest of
 * the day is already covered when it is not.
 */
function eventsHeading(kind: BootKind): string {
    return kind === 'fresh' ? 'Events (last 24h)' : 'Events since you last knew';
}

/** The `conversation` role's sections, selected by `parts.kind` — see the module doc for what each kind carries. */
function conversationSections(parts: BootBundleParts): (string | undefined)[] {
    if(parts.kind === 'restart_resume') {
        return [
            renderHeadingSection(eventsHeading(parts.kind), parts.events),
            renderListSection('Background tasks lost at restart', parts.lostTasks),
            renderListSection('Envelopes without a delivered response', parts.undelivered),
            renderListSection('Background tasks', parts.activeTasks),
        ];
    }
    if(parts.kind === 'compact') {
        return [
            renderHeadingSection('Current focus', parts.currentFocus),
            renderHeadingSection(eventsHeading(parts.kind), parts.events),
            renderHeadingSection('Task list', parts.taskListSummary),
            renderListSection('Background tasks', parts.activeTasks),
        ];
    }
    return [
        renderHeadingSection('Current focus', parts.currentFocus),
        renderHeadingSection(eventsHeading(parts.kind), parts.events),
        renderHeadingSection('Task list', parts.taskListSummary),
        renderHeadingSection('Channels', parts.channelList),
        renderListSection('Background tasks', parts.activeTasks),
        renderListSection('Recently talking to', parts.recentUsers),
        renderListSection('Background tasks lost at restart', parts.lostTasks),
        renderListSection('Envelopes without a delivered response', parts.undelivered),
    ];
}

/** The `perch` role's sections, selected by `parts.kind` — see the module doc for what each kind carries. */
function perchSections(parts: BootBundleParts): (string | undefined)[] {
    if(parts.kind === 'restart_resume') {
        return [
            renderListSection('Background tasks lost at restart', parts.lostTasks),
            renderListSection('Envelopes without a delivered response', parts.undelivered),
            renderListSection('Background tasks', parts.activeTasks),
        ];
    }
    return [
        renderHeadingSection('Task list', parts.taskListSummary),
        parts.perchContext,
        renderListSection('Background tasks lost at restart', parts.lostTasks),
        renderListSection('Envelopes without a delivered response', parts.undelivered),
    ];
}

/**
 * Pure formatter: renders {@link BootBundleParts} into the boot bundle's envelope text, or `''`
 * for a `restart_resume` bundle whose sections are all empty (nothing happened while offline).
 * @param parts Already-gathered boot bundle pieces
 * @returns The full boot bundle text, or `''` for an empty restart_resume
 */
export function formatBootBundle(parts: BootBundleParts): string {
    const bodySections = parts.role === 'perch' ? perchSections(parts) : conversationSections(parts);

    if(parts.kind === 'restart_resume' && bodySections.every(section => !section)) {
        return '';
    }

    const sections: (string | undefined)[] = [
        `[BOOT BUNDLE · ${parts.role} · ${parts.kind}]`,
        parts.kind === 'restart_resume' ? undefined : RESET_NOTICE,
        parts.timeHeader,
        ...bodySections,
    ];

    return sections.filter(Boolean).join('\n\n');
}

const RECOVERY_ONLY_NOTICE = 'The rest of this boot context could not be loaded in time, so only what was lost at restart is listed here. Use your tools to look up anything else you need.';

/**
 * Pure, synchronous recovery-only bundle (#98): the conductor's fallback when a full `build()`
 * for its `[BOOT]` handshake rejects or times out. By then the conductor has already journaled
 * each lost task as `task_lost`, so no later recovery read will report it again; rendering the
 * already-captured lists here, with no fetch, keeps a failed context read from losing them.
 * @param input The role and kind being opened, and the recovered descriptions
 * @returns The recovery-only bundle, or `''` when there is nothing recovered to report
 */
export function formatRecoveryOnlyBootBundle(input: {
    role:        BootBundleParts['role']
    kind:        'fresh' | 'restart_resume'
    lostTasks:   string[]
    undelivered: string[]
}): string {
    const sections = [
        renderListSection('Background tasks lost at restart', input.lostTasks),
        renderListSection('Envelopes without a delivered response', input.undelivered),
    ].filter(section => section !== undefined);
    if(sections.length === 0) {
        return '';
    }
    return [`[BOOT BUNDLE · ${input.role} · ${input.kind} · recovery only]`, RECOVERY_ONLY_NOTICE, ...sections].join('\n\n');
}

/**
 * Resolves the events section for one `build()` call: `eventsSinceMs` (when given) always wins
 * and is used for every kind; absent that, only `fresh` falls back to `bootEventsWindowMs` — a
 * `restart_resume`/`compact` bundle with no mark renders (and fetches) no events section at all.
 */
async function loadEventsSection(
    contextBuilder: BootContextSource, kind: BootKind, eventsSinceMs: number | undefined,
    bootEventsWindowMs: number, bootEventsLimit: number, now: () => number
): Promise<string | undefined> {
    let windowMs: number | undefined;
    if(eventsSinceMs !== undefined) {
        windowMs = now() - eventsSinceMs;
    } else if(kind === 'fresh') {
        windowMs = bootEventsWindowMs;
    }
    if(windowMs === undefined) {
        return undefined;
    }

    const nowDate = new Date(now());
    const items = await contextBuilder.loadRecentEventsSince(windowMs, bootEventsLimit, nowDate);
    return items.map(item => formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, nowDate)).join('\n') || undefined;
}

/**
 * Creates a boot bundle builder bound to one session role.
 * @param params Role and dependencies
 * @returns A builder whose `build()` gathers the kind-appropriate sections and formats them
 */
export function createBootBundleBuilder(params: CreateBootBundleBuilderParams): BootBundleBuilder {
    const {
        role, contextBuilder, taskListReader, channelListProvider, now, timeHeader,
        bootEventsWindowMs = 24 * 60 * 60 * 1000, bootEventsLimit = 50,
    } = params;

    return {
        async build(input: BuildBootBundleInput): Promise<string> {
            const { kind, eventsSinceMs, lostTasks, undelivered, recentUsers, activeTasks } = input;
            if(kind === 'reopen') {
                // Nothing to re-seed and nothing worth a fetch — not even the clock: the
                // transcript survived and the host kept the queue, and the conductor's own reopen
                // handshake already names the background tasks the reopen may have cut off.
                return '';
            }
            // Read once per build, before any await, so every branch renders the same stamp and
            // the ambient lines describe the moment the bundle was composed.
            const header = timeHeader?.();

            // Stryker disable next-line llm: role is the primitive union 'conversation' | 'perch', so loose and strict equality are indistinguishable
            if(role === 'perch') {
                if(kind === 'restart_resume') {
                    // No task-list/perch-context fetch at all for a perch restart_resume -- neither is
                    // rendered, so there is nothing worth the round trip.
                    return formatBootBundle({ role: 'perch', kind, timeHeader: header, recentUsers, lostTasks, undelivered, activeTasks });
                }

                // Independent fetches (task-list/perch-context depend on neither each other)
                // run concurrently rather than as two sequential round trips.
                const [taskListSummary, perchContext] = await Promise.all([
                    taskListReader.buildTaskListSummary(),
                    contextBuilder.buildPerchContext(new Date(now())),
                ]);

                return formatBootBundle({
                    role: 'perch', kind, timeHeader: header, taskListSummary, perchContext, recentUsers, lostTasks, undelivered, activeTasks,
                });
            }

            if(kind === 'restart_resume') {
                // Only the events section needs a fetch for a conversation restart_resume; state and the
                // task list were not lost, so they are not re-fetched.
                const events = await loadEventsSection(contextBuilder, kind, eventsSinceMs, bootEventsWindowMs, bootEventsLimit, now);
                return formatBootBundle({ role: 'conversation', kind, timeHeader: header, events, recentUsers, lostTasks, undelivered, activeTasks });
            }

            // Same reasoning as the perch branch: four independent round trips, gathered
            // concurrently instead of in sequence. The channel list is only ever rendered for
            // `fresh`, so it is only ever fetched for `fresh`.
            const [taskListSummary, currentFocus, events, channelList] = await Promise.all([
                taskListReader.buildTaskListSummary(),
                contextBuilder.loadHotState(new Date(now())),
                loadEventsSection(contextBuilder, kind, eventsSinceMs, bootEventsWindowMs, bootEventsLimit, now),
                kind === 'fresh' && channelListProvider ? channelListProvider() : Promise.resolve(undefined),
            ]);

            return formatBootBundle({
                role: 'conversation', kind, timeHeader: header, currentFocus, events, taskListSummary, channelList, recentUsers, lostTasks, undelivered, activeTasks,
            });
        },
    };
}
