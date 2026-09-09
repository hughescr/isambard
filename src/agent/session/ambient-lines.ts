/**
 * The per-turn ambient lines (docs/plans/session-peers-and-quota.md, block 4).
 *
 * Two facts every turn of either session should carry without asking for them:
 *
 * 1. **What the other session is doing** — `Perch: slot "reflection" until 15:00, working on
 *    drafting the note, 1 workflow running`, or `Conversation: idle since 14:02`. Composed from
 *    the OTHER role's ledger: its open turn, that turn's phase (and the LLM-generated phase
 *    digest riding on it), its running tasks, and — for a live perch slot turn — the slot fields
 *    the perch envelope's {@link import('./types').EnvelopeMeta} put on `Ledger.perch`.
 * 2. **How much of the Claude Max subscription is spent** — `Quota: 5-hour 42% (resets 14:00) ·
 *    week 61% (resets Thu 09:00)`, from `Ledger.quota` (block 3: SDK `rate_limit_event` frames
 *    primarily, the usage poller secondarily), merged PER WINDOW across both ledgers by their
 *    `quota.at` stamps — see {@link freshestWindow}. Omitted entirely while nothing is known.
 *
 * Both functions here are PURE: no clock, no I/O, no state. `now` is passed in the same way every
 * envelope builder takes it, and the once-after-boot "shared with Craig's own sessions" note is a
 * caller-owned flag ({@link ComposeAmbientLinesParams.sharedQuotaNote}) rather than a module-level
 * latch — the composition root (`src/app/sessions.ts`) owns that flag per role, so each session
 * sees the note exactly once, on the first turn where a quota line actually renders.
 * `src/utils/time.ts`'s `formatTimeHeader` stays pure and ledger-unaware for the same reason:
 * {@link withAmbientLines} is what joins the two.
 *
 * @module agent/session/ambient-lines
 */
import { DateTime } from 'luxon';
import type { ActivityPhase } from './activity-phase';
import type { Ledger, LedgerQuota, LedgerTask, QuotaWindow } from './ledger';
import type { SessionRole } from './types';

/**
 * How a producer of the per-turn time header asks for one: the optional argument is the same
 * user timezone `formatTimeHeader` itself takes (omitted where the producer has no user, e.g.
 * the boot catch-up envelopes), so a provider is a drop-in for `formatTimeHeader`.
 */
export type TimeHeaderProvider = (userTimezone?: string) => string;

/** Every rendered quota line starts with this; the composition root keys its once-note off it. */
export const QUOTA_LINE_PREFIX = 'Quota: ';

/** Parameters for {@link composeAmbientLines}. */
export interface ComposeAmbientLinesParams {
    /** The ledger of the session the header is being built for. */
    self:             Ledger
    /** The other role's ledger, when this process has one (perch is optional). */
    other?:           Ledger
    /** Stamped by the caller from its own {@link import('./types').Clock}; never read here. */
    now:              Date
    /** IANA zone every rendered wall-clock stamp is expressed in. */
    timezone:         string
    /** True to append the shared-subscription note to the quota line — see the module doc. */
    sharedQuotaNote?: boolean
}

/** The label each role is announced under in the other-session line. */
const ROLE_LABEL: Record<SessionRole, string> = { conversation: 'Conversation', perch: 'Perch' };

/**
 * A wall-clock stamp in `timezone`: bare `HH:mm` for a time on the same local day as `now`,
 * prefixed with the weekday (`Thu 09:00`) otherwise — so a weekly quota reset days out reads
 * unambiguously while today's five-hour reset stays terse.
 */
function formatStamp(when: Date, now: Date, timezone: string): string {
    const at = DateTime.fromJSDate(when).setZone(timezone);
    const today = DateTime.fromJSDate(now).setZone(timezone);
    return at.hasSame(today, 'day') ? at.toFormat('HH:mm') : at.toFormat('ccc HH:mm');
}

/** The phase digest (`generatedStatus`) when the phase carries one — `compacting` never does. */
function phaseDigest(phase: ActivityPhase | null): string | undefined {
    if(phase === null || !('generatedStatus' in phase)) {
        return undefined;
    }
    return phase.generatedStatus;
}

/** One verb per {@link ActivityPhase} type, for a turn that is not a perch slot turn. */
function phaseVerb(phase: ActivityPhase | null): string {
    if(phase === null) {
        return 'working';
    }
    switch(phase.type) {
        case 'thinking': {
            return 'thinking';
        }
        case 'using_tool': {
            return `using ${phase.toolName}`;
        }
        case 'responding': {
            return 'replying';
        }
        case 'compacting': {
            return 'compacting';
        }
    }
}

/**
 * The leading clause of the other-session line: the perch slot for a live perch slot turn, the
 * phase verb for any other open turn, and `idle since <stamp>` (or a bare `idle`, before this
 * process has ever closed a turn on that session) when nothing is running. `ledger.perch` is
 * sticky — it survives the turn that set it — so the slot is only rendered while a `perch`-kind
 * turn is actually open, never afterwards and never for a Discord turn on the perch session.
 */
function describeActivity(ledger: Ledger, now: Date, timezone: string): string {
    const { turn } = ledger;
    if(turn === null) {
        return ledger.lastTurnEndedAt === undefined
            ? 'idle'
            : `idle since ${formatStamp(ledger.lastTurnEndedAt, now, timezone)}`;
    }
    if(turn.kind === 'perch' && ledger.perch.slot !== undefined) {
        const until = ledger.perch.endsAt === undefined ? '' : ` until ${formatStamp(ledger.perch.endsAt, now, timezone)}`;
        return `slot "${ledger.perch.slot}"${until}`;
    }
    return phaseVerb(turn.phase);
}

/** `n` with `noun` pluralised the English way — the counts here are small and always concrete. */
function plural(n: number, noun: string): string {
    return n === 1 ? `${n} ${noun}` : `${n} ${noun}s`;
}

/** Running-task clauses: workflows counted on their own, everything else lumped as "tasks". */
function taskClauses(tasks: readonly LedgerTask[]): string[] {
    const workflows = tasks.filter(entry => entry.kind === 'workflow').length;
    const others = tasks.length - workflows;
    const clauses: string[] = [];
    if(workflows > 0) {
        clauses.push(`${plural(workflows, 'workflow')} running`);
    }
    if(others > 0) {
        clauses.push(`${plural(others, 'task')} running`);
    }
    return clauses;
}

/** `<Label>: <activity>[, working on <digest>][, <n> workflows running][, <n> tasks running]`. */
function otherSessionLine(other: Ledger, now: Date, timezone: string): string {
    const digest = phaseDigest(other.turn?.phase ?? null);
    const clauses = [
        describeActivity(other, now, timezone),
        ...digest === undefined ? [] : [`working on ${digest}`],
        ...taskClauses(other.tasks),
    ];
    return `${ROLE_LABEL[other.role]}: ${clauses.join(', ')}`;
}

/** `42%`, or `42% (resets 14:00)` when the source told us when the window rolls over. */
function renderWindow(window: QuotaWindow, now: Date, timezone: string): string {
    const percent = `${Math.round(window.utilization)}%`;
    return window.resetsAt === undefined ? percent : `${percent} (resets ${formatStamp(window.resetsAt, now, timezone)})`;
}

/** The two unified windows either session paces itself against; per-model windows are not rendered. */
type UnifiedWindowName = 'fiveHour' | 'sevenDay';

/** One ledger's reading of one window, carrying the `quota.at` stamp that dates it. */
interface DatedWindow {
    window: QuotaWindow
    at:     Date
}

/** `quota`'s reading of `name`, dated by `quota.at`, or undefined when that ledger knows no such window. */
function datedWindow(quota: LedgerQuota | undefined, name: UnifiedWindowName): DatedWindow | undefined {
    if(quota === undefined) {
        return undefined;
    }
    const window = quota[name];
    return window === undefined ? undefined : { window, at: quota.at };
}

/**
 * The freshest known reading of ONE unified window across both ledgers.
 *
 * The subscription is one account, so either ledger describes the same windows — but they are
 * refreshed independently: a `rate_limit_event` frame folds only into the emitting role's ledger,
 * emission is change-driven rather than per-turn, and the usage poller (the only path that writes
 * both at once) targets an endpoint whose shape is UNVERIFIED. So neither ledger is reliably the
 * fresher one, and a ledger can legitimately know a window the other does not (a frame with no
 * `unifiedWindows` files only the window that tripped the emit). Per window, then: the reading
 * stamped with the later `quota.at` wins, a ledger carrying no such window never wins, and a tie
 * goes to `self` — the session actually about to spend.
 */
function freshestWindow(name: UnifiedWindowName, self: LedgerQuota | undefined, other: LedgerQuota | undefined): QuotaWindow | undefined {
    const mine = datedWindow(self, name);
    const theirs = datedWindow(other, name);
    if(mine === undefined) {
        return theirs?.window;
    }
    if(theirs === undefined) {
        return mine.window;
    }
    return theirs.at.getTime() > mine.at.getTime() ? theirs.window : mine.window;
}

/**
 * The quota line, or undefined when neither unified window is known — a `quota` carrying only
 * per-model weekly windows renders nothing, since those are not what either session is pacing
 * itself against.
 */
function quotaLine(self: LedgerQuota | undefined, other: LedgerQuota | undefined, now: Date, timezone: string, sharedNote: boolean): string | undefined {
    const fiveHour = freshestWindow('fiveHour', self, other);
    const sevenDay = freshestWindow('sevenDay', self, other);
    const segments = [
        ...fiveHour === undefined ? [] : [`5-hour ${renderWindow(fiveHour, now, timezone)}`],
        ...sevenDay === undefined ? [] : [`week ${renderWindow(sevenDay, now, timezone)}`],
    ];
    if(segments.length === 0) {
        return undefined;
    }
    const note = sharedNote ? ' · shared with Craig\'s own sessions' : '';
    return `${QUOTA_LINE_PREFIX}${segments.join(' · ')}${note}`;
}

/**
 * Composes the ambient lines for one session's next turn — at most one other-session line and
 * at most one quota line, in that order. See the module doc for the shapes and for why this is
 * pure.
 * @param params See {@link ComposeAmbientLinesParams}.
 * @returns Zero to two lines, ready for {@link withAmbientLines}.
 */
export function composeAmbientLines(params: ComposeAmbientLinesParams): string[] {
    const { self, other, now, timezone, sharedQuotaNote = false } = params;
    // Merged per window from both ledgers rather than taken from one of them — see freshestWindow.
    const quota = quotaLine(self.quota, other?.quota, now, timezone, sharedQuotaNote);
    return [
        ...other === undefined ? [] : [otherSessionLine(other, now, timezone)],
        ...quota === undefined ? [] : [quota],
    ];
}

/**
 * Appends `lines` to an already-formatted time header as further bullets of its list, so the
 * ambient facts arrive inside the block the model already reads for "where am I in time" rather
 * than as a second stanza it has to correlate. An empty `lines` needs no special case: joining a
 * one-element array yields `timeHeader` itself, unchanged.
 * @param timeHeader The header `formatTimeHeader` produced
 * @param lines The output of {@link composeAmbientLines}
 * @returns The header, with one `- ` bullet appended per line
 */
export function withAmbientLines(timeHeader: string, lines: readonly string[]): string {
    return [timeHeader, ...lines.map(line => `- ${line}`)].join('\n');
}
