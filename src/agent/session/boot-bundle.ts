/**
 * Boot bundle composer for the long-lived session core.
 *
 * Assembles the single envelope text (via `buildBootEnvelope`, ./envelope.ts) delivered as the
 * first turn of a session and again after a compaction/restart reset. Two variants share one
 * builder: `conversation` re-seeds identity, current focus, recent events, the task list, the
 * channel list, who was recently talked to and what background work is still running;
 * `perch` re-seeds identity, the task list and `ContextBuilder.buildPerchContext`'s own block
 * verbatim (it already carries a time header, top state and recent events, so those sections
 * are not rendered separately for perch, and there is no channel list).
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

/** Inputs to {@link createBootBundleBuilder}. */
export interface CreateBootBundleBuilderParams {
    role:                 'conversation' | 'perch'
    identityCache:        IdentitySource
    contextBuilder:       BootContextSource
    taskListReader:       TaskListSource
    /** Optional channel-list text provider; never invoked for the perch variant. */
    channelListProvider?: () => Promise<string | undefined>
    /** Millisecond clock, e.g. `() => clock.now()`. */
    now:                  () => number
    /** Rolling window for the conversation "Events (last 24h)" section. Defaults to 24h. */
    bootEventsWindowMs?:  number
    /** Max events fetched for that section. Defaults to 50. */
    bootEventsLimit?:     number
}

/** Ledger/journal-derived facts supplied at build time (not known to the builder itself). */
export interface BuildBootBundleInput {
    /** Background task descriptions lost when the process last restarted. */
    lostTasks:   string[]
    /** Envelope descriptions submitted but never followed by a delivered response. */
    undelivered: string[]
    /** Who Izzy was recently talking to, most relevant first. */
    recentUsers: string[]
    /** The live background-task set from the ledger, still running right now. */
    activeTasks: string[]
    /** True when this bundle follows a compaction or a process restart. */
    resetNotice: boolean
}

/** A boot bundle builder for one session role. */
export interface BootBundleBuilder {
    build: (input: BuildBootBundleInput) => Promise<string>
}

/** Already-gathered pieces {@link formatBootBundle} renders, in role-dependent order. */
export interface BootBundleParts {
    role:             'conversation' | 'perch'
    resetNotice:      boolean
    identity:         string
    /** Conversation only. */
    currentFocus?:    string
    /** Conversation only; omitted (section not rendered) when there is nothing to show. */
    events?:          string
    taskListSummary?: string
    /** Conversation only. */
    channelList?:     string
    /** Perch only: `ContextBuilder.buildPerchContext`'s block, rendered verbatim (no added header). */
    perchContext?:    string
    /** Conversation only. */
    recentUsers:      string[]
    lostTasks:        string[]
    undelivered:      string[]
    /** Conversation only. */
    activeTasks:      string[]
}

/** Renders a `## Heading` section, or `undefined` when there is nothing to show. */
function renderHeadingSection(heading: string, body: string | undefined): string | undefined {
    return body ? `## ${heading}\n${body}` : undefined;
}

/** Renders a `## Heading` section from a list, or `undefined` when the list is empty. */
function renderListSection(heading: string, items: string[]): string | undefined {
    return items.length > 0 ? `## ${heading}\n${items.join('\n')}` : undefined;
}

/** The perch-only middle section: task list, then the perch context block verbatim. */
function renderPerchMiddle(parts: BootBundleParts): (string | undefined)[] {
    return [
        renderHeadingSection('Task list', parts.taskListSummary),
        parts.perchContext,
    ];
}

/** The conversation-only middle section: current focus, events, task list, channels, active tasks, recently-talking-to. */
function renderConversationMiddle(parts: BootBundleParts): (string | undefined)[] {
    return [
        renderHeadingSection('Current focus', parts.currentFocus),
        renderHeadingSection('Events (last 24h)', parts.events),
        renderHeadingSection('Task list', parts.taskListSummary),
        renderHeadingSection('Channels', parts.channelList),
        renderListSection('Background tasks', parts.activeTasks),
        renderListSection('Recently talking to', parts.recentUsers),
    ];
}

/** The tail shared by both roles: lost tasks, then undelivered envelopes. */
function renderSharedTail(parts: BootBundleParts): (string | undefined)[] {
    return [
        renderListSection('Background tasks lost at restart', parts.lostTasks),
        renderListSection('Envelopes without a delivered response', parts.undelivered),
    ];
}

/**
 * Pure formatter: renders {@link BootBundleParts} into the boot bundle's envelope text.
 * @param parts Already-gathered boot bundle pieces
 * @returns The full boot bundle text
 */
export function formatBootBundle(parts: BootBundleParts): string {
    const sections: (string | undefined)[] = [
        `[BOOT BUNDLE · ${parts.role}]`,
        parts.resetNotice ? 'Working memory was reset (compaction or restart); this bundle re-seeds it.' : undefined,
        `## Identity\n${parts.identity}`,
        ...(parts.role === 'perch' ? renderPerchMiddle(parts) : renderConversationMiddle(parts)),
        ...renderSharedTail(parts),
    ];

    return sections.filter(Boolean).join('\n\n');
}

/**
 * Creates a boot bundle builder bound to one session role.
 * @param params Role and dependencies
 * @returns A builder whose `build()` gathers the role-appropriate sections and formats them
 */
export function createBootBundleBuilder(params: CreateBootBundleBuilderParams): BootBundleBuilder {
    const {
        role, identityCache, contextBuilder, taskListReader, channelListProvider, now,
        bootEventsWindowMs = 24 * 60 * 60 * 1000, bootEventsLimit = 50,
    } = params;

    return {
        async build(input: BuildBootBundleInput): Promise<string> {
            if(role === 'perch') {
                // Independent fetches (identity/task-list/perch-context depend on none of each
                // other) run concurrently rather than as three sequential round trips.
                const [identity, taskListSummary, perchContext] = await Promise.all([
                    identityCache.get(),
                    taskListReader.buildTaskListSummary(),
                    contextBuilder.buildPerchContext(new Date(now())),
                ]);

                return formatBootBundle({
                    role:        'perch',
                    resetNotice: input.resetNotice,
                    identity,
                    taskListSummary,
                    perchContext,
                    recentUsers: input.recentUsers,
                    lostTasks:   input.lostTasks,
                    undelivered: input.undelivered,
                    activeTasks: input.activeTasks,
                });
            }

            // Same reasoning: identity/task-list/hot-state/events/channel-list are five
            // independent round trips, gathered concurrently instead of in sequence.
            const [identity, taskListSummary, currentFocus, eventItems, channelList] = await Promise.all([
                identityCache.get(),
                taskListReader.buildTaskListSummary(),
                contextBuilder.loadHotState(new Date(now())),
                contextBuilder.loadRecentEventsSince(bootEventsWindowMs, bootEventsLimit, new Date(now())),
                channelListProvider ? channelListProvider() : Promise.resolve(undefined),
            ]);
            const events = eventItems.length > 0
                ? eventItems.map(item => formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, new Date(now()))).join('\n')
                : undefined;

            return formatBootBundle({
                role:        'conversation',
                resetNotice: input.resetNotice,
                identity,
                currentFocus,
                events,
                taskListSummary,
                channelList,
                recentUsers: input.recentUsers,
                lostTasks:   input.lostTasks,
                undelivered: input.undelivered,
                activeTasks: input.activeTasks,
            });
        },
    };
}
