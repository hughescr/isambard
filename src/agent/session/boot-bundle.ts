/**
 * Boot bundle composer for the long-lived session core.
 *
 * Assembles the single envelope text (via `buildBootEnvelope`, ./envelope.ts) delivered as
 * `additionalContext` on a `SessionStart` hook. R1 re-seeds by boot KIND rather than always
 * injecting the same full bundle:
 *
 * - `fresh` (a cold process start): the full re-seed — identity, current focus/state, events
 *   (the rolling `bootEventsWindowMs` window, or `eventsSinceMs` when the caller has a better
 *   boundary), the task list, the channel list, who was recently talked to, background tasks
 *   lost at restart, undelivered envelopes, and the live active-task set.
 * - `compact` (working memory was just reset by a compaction): identity, current focus/state,
 *   events since the mark, the task list, and the active-task set — NO channel list, recent
 *   users, lost tasks or undelivered envelopes, because nothing was lost across a compaction
 *   (Discord turns are held by the conductor for the duration; see `conductor.ts`).
 * - `resume` (the transcript survived — a process restart resuming an existing session): ONLY
 *   what happened while offline — events since the last journaled turn, lost tasks, undelivered
 *   envelopes, and the active-task set — no identity/state/task-list/channels, since none of
 *   that was lost. `build()` returns `''` (and the hook then adds no `additionalContext` at
 *   all — see `../hooks/boot-bundle.ts`) when every one of those sections is empty.
 *
 * Two role variants share one builder: `conversation` re-seeds the sections above; `perch`
 * re-seeds identity, the task list and `ContextBuilder.buildPerchContext`'s own block verbatim
 * for `fresh`/`compact` (it already carries a time header, top state and recent events, so
 * those sections are not rendered separately for perch, and there is no channel list) and, for
 * `resume`, only lost tasks/undelivered/active tasks — no identity, task list or perch context
 * fetch at all.
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

/** The subset of `IdentityCache` this builder depends on. */
export interface IdentitySource {
    get: () => Promise<string>
}

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
 * Which SessionStart trigger a boot bundle is re-seeding for — see the module doc for what each
 * kind injects.
 */
export type BootKind = 'fresh' | 'resume' | 'compact';

/** Inputs to {@link createBootBundleBuilder}. */
export interface CreateBootBundleBuilderParams {
    role:                 'conversation' | 'perch'
    identityCache:        IdentitySource
    contextBuilder:       BootContextSource
    taskListReader:       TaskListSource
    /** Optional channel-list text provider; never invoked for the perch variant, nor for any non-`fresh` kind. */
    channelListProvider?: () => Promise<string | undefined>
    /** Millisecond clock, e.g. `() => clock.now()`. */
    now:                  () => number
    /** Rolling window for the `fresh` conversation "Events" section when `eventsSinceMs` is not given. Defaults to 24h. */
    bootEventsWindowMs?:  number
    /** Max events fetched for that section. Defaults to 50. */
    bootEventsLimit?:     number
}

/** Ledger/journal-derived facts supplied at build time (not known to the builder itself). */
export interface BuildBootBundleInput {
    /** Which SessionStart trigger this bundle is re-seeding for. */
    kind:           BootKind
    /**
     * Absolute epoch ms events high-water mark (e.g. `ContextPolicy.eventsSinceMs()` or a
     * journal-derived `lastKnownAt`). When given, the events section covers `now - eventsSinceMs`
     * regardless of kind. When omitted: `fresh` falls back to `bootEventsWindowMs`; `resume`/
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
    kind:             BootKind
    /** Conversation: fresh/compact only. Perch: fresh/compact only. Omitted (no `## Identity` section) for `resume` on either role. */
    identity?:        string
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
    /** Conversation: every kind. Perch: `resume` only (fresh/compact never rendered it). */
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
 * labelled that way. `compact`/`resume` always render an arbitrary since-the-mark span (whatever
 * `eventsSinceMs` the caller supplied — minutes after a fast compaction, days after an outage),
 * so a literal "last 24h" would misrepresent the window and could lead Izzy to assume the rest of
 * the day is already covered when it is not.
 */
function eventsHeading(kind: BootKind): string {
    return kind === 'fresh' ? 'Events (last 24h)' : 'Events since you last knew';
}

/** The `conversation` role's sections, selected by `parts.kind` — see the module doc for what each kind carries. */
function conversationSections(parts: BootBundleParts): (string | undefined)[] {
    if(parts.kind === 'resume') {
        return [
            renderHeadingSection(eventsHeading(parts.kind), parts.events),
            renderListSection('Background tasks lost at restart', parts.lostTasks),
            renderListSection('Envelopes without a delivered response', parts.undelivered),
            renderListSection('Background tasks', parts.activeTasks),
        ];
    }
    if(parts.kind === 'compact') {
        return [
            renderHeadingSection('Identity', parts.identity),
            renderHeadingSection('Current focus', parts.currentFocus),
            renderHeadingSection(eventsHeading(parts.kind), parts.events),
            renderHeadingSection('Task list', parts.taskListSummary),
            renderListSection('Background tasks', parts.activeTasks),
        ];
    }
    return [
        renderHeadingSection('Identity', parts.identity),
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
    if(parts.kind === 'resume') {
        return [
            renderListSection('Background tasks lost at restart', parts.lostTasks),
            renderListSection('Envelopes without a delivered response', parts.undelivered),
            renderListSection('Background tasks', parts.activeTasks),
        ];
    }
    return [
        renderHeadingSection('Identity', parts.identity),
        renderHeadingSection('Task list', parts.taskListSummary),
        parts.perchContext,
        renderListSection('Background tasks lost at restart', parts.lostTasks),
        renderListSection('Envelopes without a delivered response', parts.undelivered),
    ];
}

/**
 * Pure formatter: renders {@link BootBundleParts} into the boot bundle's envelope text, or `''`
 * for a `resume` bundle whose sections are all empty (nothing happened while offline).
 * @param parts Already-gathered boot bundle pieces
 * @returns The full boot bundle text, or `''` for an empty resume
 */
export function formatBootBundle(parts: BootBundleParts): string {
    const bodySections = parts.role === 'perch' ? perchSections(parts) : conversationSections(parts);

    if(parts.kind === 'resume' && bodySections.every(section => !section)) {
        return '';
    }

    const sections: (string | undefined)[] = [
        `[BOOT BUNDLE · ${parts.role} · ${parts.kind}]`,
        parts.kind === 'resume' ? undefined : RESET_NOTICE,
        ...bodySections,
    ];

    return sections.filter(Boolean).join('\n\n');
}

/**
 * Resolves the events section for one `build()` call: `eventsSinceMs` (when given) always wins
 * and is used for every kind; absent that, only `fresh` falls back to `bootEventsWindowMs` — a
 * `resume`/`compact` bundle with no mark renders (and fetches) no events section at all.
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
    // Stryker disable next-line ConditionalExpression,EqualityOperator: forcing the zero-items
    // branch to always take the truthy path (or `length >= 0`, always true) makes `items.map(...)`
    // run over `[]`, so `.join('\n')` still yields `''` — every caller (`build()` above) feeds this
    // return value straight into `formatBootBundle`'s `parts.events`, which only ever reaches
    // `renderHeadingSection(heading, parts.events)`; that treats `''` and `undefined` identically
    // (`body ? ... : undefined`), so there is no test that can observe a difference.
    return items.length > 0
        ? items.map(item => formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, nowDate)).join('\n')
        : undefined;
}

/**
 * Creates a boot bundle builder bound to one session role.
 * @param params Role and dependencies
 * @returns A builder whose `build()` gathers the kind-appropriate sections and formats them
 */
export function createBootBundleBuilder(params: CreateBootBundleBuilderParams): BootBundleBuilder {
    const {
        role, identityCache, contextBuilder, taskListReader, channelListProvider, now,
        bootEventsWindowMs = 24 * 60 * 60 * 1000, bootEventsLimit = 50,
    } = params;

    return {
        async build(input: BuildBootBundleInput): Promise<string> {
            const { kind, eventsSinceMs, lostTasks, undelivered, recentUsers, activeTasks } = input;

            if(role === 'perch') {
                if(kind === 'resume') {
                    // No identity/task-list/perch-context fetch at all for a perch resume --
                    // none of it is rendered, so there is nothing worth the round trip.
                    return formatBootBundle({ role: 'perch', kind, recentUsers, lostTasks, undelivered, activeTasks });
                }

                // Independent fetches (identity/task-list/perch-context depend on none of each
                // other) run concurrently rather than as three sequential round trips.
                const [identity, taskListSummary, perchContext] = await Promise.all([
                    identityCache.get(),
                    taskListReader.buildTaskListSummary(),
                    contextBuilder.buildPerchContext(new Date(now())),
                ]);

                return formatBootBundle({
                    role: 'perch', kind, identity, taskListSummary, perchContext, recentUsers, lostTasks, undelivered, activeTasks,
                });
            }

            if(kind === 'resume') {
                // Only the events section needs a fetch for a conversation resume; identity,
                // state and the task list were not lost, so they are not re-fetched.
                const events = await loadEventsSection(contextBuilder, kind, eventsSinceMs, bootEventsWindowMs, bootEventsLimit, now);
                return formatBootBundle({ role: 'conversation', kind, events, recentUsers, lostTasks, undelivered, activeTasks });
            }

            // Same reasoning as the perch branch: five independent round trips, gathered
            // concurrently instead of in sequence. The channel list is only ever rendered for
            // `fresh`, so it is only ever fetched for `fresh`.
            const [identity, taskListSummary, currentFocus, events, channelList] = await Promise.all([
                identityCache.get(),
                taskListReader.buildTaskListSummary(),
                contextBuilder.loadHotState(new Date(now())),
                loadEventsSection(contextBuilder, kind, eventsSinceMs, bootEventsWindowMs, bootEventsLimit, now),
                kind === 'fresh' && channelListProvider ? channelListProvider() : Promise.resolve(undefined),
            ]);

            return formatBootBundle({
                role: 'conversation', kind, identity, currentFocus, events, taskListSummary, channelList, recentUsers, lostTasks, undelivered, activeTasks,
            });
        },
    };
}
