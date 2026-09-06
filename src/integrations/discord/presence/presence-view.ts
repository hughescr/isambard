/**
 * Presence composed from ledgers.
 *
 * A pure composer over the conversation and perch session ledgers that renders design doc
 * section 8's presence text: `((💬🦉){1,2}|💤) • 2 🔬 1 🪾 1 ⌚ • <haiku digest>`. The prefix —
 * session indicators, task/workflow/monitor counts (zeros omitted), and a compacting marker —
 * is a fixed prefix that is NEVER truncated; the digest fills the remaining budget of Discord's
 * 128-code-unit custom-status limit, cut at a word boundary and dropped when fewer than 12
 * characters remain.
 *
 * Every export here is pure over its inputs (or an injected clock): no `Date.now()`, no I/O.
 * These are the units that carry the 100% mutation requirement for this package.
 *
 * @module integrations/discord/presence/presence-view
 */
import type { PresencePhase } from './types.js';
import type { ActivityPhase, Ledger } from '@/agent';
import { truncateToWordBoundary } from '@/utils';

/** Discord's custom-status length limit, in UTF-16 code units (`.length`). */
const PRESENCE_BUDGET = 128;

/** The digest is dropped entirely once fewer than this many code units remain for it. */
const MIN_DIGEST_LENGTH = 12;

/** Joins prefix segments and the digest. */
const SEPARATOR = ' • ';

/** Literal marker inserted between the prefix and the digest while either ledger is compacting. */
const COMPACTING_MARKER = 'compacting';

/** Which session ledgers can be "live" (carrying an open turn), in composePresence's fixed order. */
export type PresenceRole = 'conversation' | 'perch';

const LIVE_EMOJI: Record<PresenceRole, string> = { conversation: '💬', perch: '🦉' };
const IDLE_EMOJI = '💤';

/** Emoji for each recognised {@link Ledger}`.tasks[].kind`, in the order counts are rendered. */
const TASK_KIND_EMOJI: readonly (readonly [string, string])[] = [
    ['subagent', '🔬'],
    ['workflow', '🪾'],
    ['monitor', '⌚'],
];

/**
 * A sentinel `since` for the synthesized idle phase `composePresence` returns when no ledger has
 * an open turn. Nothing reads `since` on this path — idle presence is driven by `view.prefix`
 * and the idle status generator, not by this phase — so the value itself is inert.
 */
const IDLE_SINCE_SENTINEL = new Date(0);

/**
 * The result of composing presence from the conversation and perch ledgers: everything
 * {@link renderPresenceText} and the presence manager need, with no further ledger access.
 */
export interface PresenceView {
    /** Which roles currently have an open turn, conversation first. */
    readonly live:       readonly PresenceRole[]
    /** Session indicators + task counts, e.g. `'💬🦉 • 2 🔬 1 ⌚'` or `'💤 • 1 🪾'`. Never truncated. */
    readonly prefix:     string
    /** True when either ledger's `compaction` is `'compacting'`. */
    readonly compacting: boolean
    /** The winning turn's phase (conversation first), or `{ type: 'idle' }` when neither is live. */
    readonly phase:      PresencePhase
    /** Which role's phase won, or `null` when idle. */
    readonly activeRole: PresenceRole | null
}

/** Counts tasks by `kind` across every ledger, rendered in {@link TASK_KIND_EMOJI} order, zeros omitted. */
function renderTaskCounts(ledgers: readonly Ledger[]): string {
    const counts = new Map<string, number>();
    for(const ledger of ledgers) {
        for(const task of ledger.tasks) {
            counts.set(task.kind, (counts.get(task.kind) ?? 0) + 1);
        }
    }
    return TASK_KIND_EMOJI
        .filter(([kind]) => (counts.get(kind) ?? 0) > 0)
        .map(([kind, emoji]) => `${counts.get(kind)} ${emoji}`)
        .join(' ');
}

/**
 * A ledger's current phase for presence purposes: `null` when no turn is open; the turn's own
 * phase when set; otherwise (a turn just opened, before its first SDK frame) a synthesized
 * `'thinking'` phase stamped with the turn's own `startedAt`, since an open turn with no phase
 * yet is, from a presence standpoint, indistinguishable from having just started thinking.
 */
/** Normalizes a ledger's open turn to `null` (never `undefined`), whether or not `ledger` itself is given. */
function turnOf(ledger: Ledger | undefined): Ledger['turn'] {
    return ledger?.turn ?? null;
}

function phaseOfLedger(ledger: Ledger | undefined): ActivityPhase | null {
    const turn = turnOf(ledger);
    if(turn === null) {
        return null;
    }
    return turn.phase ?? { type: 'thinking', startedAt: turn.startedAt };
}

/** Whichever of `conversationPhase`/`perchPhase` is non-null wins, conversation first. */
function resolveActiveRole(conversationPhase: ActivityPhase | null, perchPhase: ActivityPhase | null): PresenceRole | null {
    if(conversationPhase !== null) {
        return 'conversation';
    }
    if(perchPhase !== null) {
        return 'perch';
    }
    return null;
}

/**
 * Composes a {@link PresenceView} from the session ledgers: index 0 is the conversation ledger,
 * index 1 is the perch ledger. The conversation's phase wins when both are live; counts are the
 * union of both ledgers' tasks (shell tasks are never rendered).
 */
export function composePresence(ledgers: readonly Ledger[]): PresenceView {
    const [conversation, perch] = ledgers;

    const live: PresenceRole[] = [];
    if(turnOf(conversation) !== null) {
        live.push('conversation');
    }
    if(turnOf(perch) !== null) {
        live.push('perch');
    }

    const indicator = live.length === 0 ? IDLE_EMOJI : live.map(role => LIVE_EMOJI[role]).join('');
    const counts = renderTaskCounts(ledgers);
    const prefix = counts.length === 0 ? indicator : `${indicator}${SEPARATOR}${counts}`;

    const compacting = ledgers.some(ledger => ledger.compaction === 'compacting');

    const conversationPhase = phaseOfLedger(conversation);
    const perchPhase = phaseOfLedger(perch);
    const activeRole: PresenceRole | null = resolveActiveRole(conversationPhase, perchPhase);
    const phase: PresencePhase = conversationPhase ?? perchPhase ?? { type: 'idle', since: IDLE_SINCE_SENTINEL };

    return { live, prefix, compacting, phase, activeRole };
}

/**
 * The rendered `name` (`prefix [• compacting] [• digest]`) plus, when the digest was not dropped
 * for lack of budget, the `digestText` actually shown (word-boundary-truncated) — a caller that
 * needs to persist "the text last shown" (the idle generator's anti-rut block) reads this instead
 * of re-deriving it from `name`.
 */
export interface RenderedPrefixedText {
    readonly name:        string
    readonly digestText?: string
}

/**
 * Renders a prefix (session indicators + task counts) plus an optional digest into Discord
 * custom-status text: `prefix [• compacting] [• digest]`, capped at Discord's 128-code-unit
 * limit. The prefix (including the compacting marker) is never truncated; the digest is
 * truncated to a word boundary to fit whatever budget remains, and dropped entirely when fewer
 * than {@link MIN_DIGEST_LENGTH} code units remain for it. Shared by {@link renderPresenceText}
 * (the active-phase path) and `status-generator-idle.ts`'s composed-prefix idle path — both apply
 * the exact same budget/separator/compacting-marker/truncation rules over the exact same 3 inputs.
 */
export function renderPrefixedText(prefix: string, compacting: boolean, digest: string | undefined): RenderedPrefixedText {
    const base = compacting ? `${prefix}${SEPARATOR}${COMPACTING_MARKER}` : prefix;

    if(digest === undefined) {
        return { name: base };
    }

    const remaining = PRESENCE_BUDGET - base.length - SEPARATOR.length;
    if(remaining < MIN_DIGEST_LENGTH) {
        return { name: base };
    }

    const digestText = truncateToWordBoundary(digest, remaining);
    return { name: `${base}${SEPARATOR}${digestText}`, digestText };
}

/**
 * Renders a {@link PresenceView} plus an optional digest into Discord custom-status text:
 * `prefix [• compacting] [• digest]`, capped at Discord's 128-code-unit limit. The prefix
 * (including the compacting marker) is never truncated; the digest is truncated to a word
 * boundary to fit whatever budget remains, and dropped entirely when fewer than
 * {@link MIN_DIGEST_LENGTH} code units remain for it.
 */
export function renderPresenceText(view: PresenceView, digest: string | undefined): string {
    return renderPrefixedText(view.prefix, view.compacting, digest).name;
}

/** A leading-edge throttle gate: `shouldUpdate()` peeks, `record()` commits. */
export interface PresenceThrottle {
    /** True when at least `throttleMs` have passed since the last `record()` (or none yet). */
    shouldUpdate: () => boolean
    /** Marks "now" as the last applied update, for future `shouldUpdate()` checks. */
    record:       () => void
}

/**
 * Creates a {@link PresenceThrottle} over an injected clock: `now()` returns milliseconds, and
 * `shouldUpdate()` is true until the first `record()`, then again once `throttleMs` have elapsed
 * since the most recent `record()`.
 */
// eslint-disable-next-line @typescript-eslint/default-param-last -- pinned signature (P11 brief): createPresenceThrottle(throttleMs = 12_000, now)
export function createPresenceThrottle(throttleMs = 12_000, now: () => number): PresenceThrottle {
    let lastRecordedAt: number | null = null;

    return {
        shouldUpdate(): boolean {
            return lastRecordedAt === null || now() - lastRecordedAt >= throttleMs;
        },
        record(): void {
            lastRecordedAt = now();
        },
    };
}

/**
 * The outcome of {@link planPresenceUpdate}: apply immediately (`'idle'`), apply the given view
 * (`'active'`), or do nothing (`null`, the active view was throttled).
 */
export type PresencePlan
    = | { kind: 'idle' }
      | { kind: 'active', view: PresenceView }
      | null;

/**
 * Decides whether a composed {@link PresenceView} should be applied right now. Idle views always
 * apply — and always record, so a subsequent active view starts its own fresh throttle window —
 * bypassing the throttle entirely, since going idle marks the end of work and must never lag.
 * Active (non-idle) views apply only when `throttle.shouldUpdate()`, and record only when applied.
 */
export function planPresenceUpdate(view: PresenceView, throttle: PresenceThrottle): PresencePlan {
    if(view.phase.type === 'idle') {
        throttle.record();
        return { kind: 'idle' };
    }

    if(!throttle.shouldUpdate()) {
        return null;
    }

    throttle.record();
    return { kind: 'active', view };
}
