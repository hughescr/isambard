/**
 * Task board manager: the one stateful piece of the package.
 *
 * It owns the mapping from board key (`${channelId}:${turnId}`) to the Discord message showing
 * that board, and the throttle that keeps a fast-moving turn from spending its whole rate-limit
 * budget on embed edits. Everything it renders comes from the pure `renderTaskBoardEmbed`, so
 * "has anything changed?" is a plain comparison of two rendered objects.
 *
 * Lifecycle of one key:
 * - first sight → fetch the channel, send the embed, remember the `Message` and what was rendered;
 * - later views → render; identical to what is on screen → nothing; otherwise a **trailing-edge**
 *   throttle: edit now if the last edit is at least `editIntervalMs` old, else arm one timer for
 *   the remainder and edit with whatever the LATEST view is when it fires;
 * - terminal (`done`/`failed`) → one final edit that bypasses the throttle and cancels any pending
 *   timer. Once that edit lands the board is *finalised*: further terminal views are ignored, so a
 *   board whose finished tasks linger in the ledger is never re-edited. It is frozen, not closed —
 *   a later `running` view for the same key (a second sub-agent launched in the same turn) thaws
 *   the phase and resumes ordinary throttled edits on the SAME message. A repeated old terminal
 *   view after that launch cannot overwrite the newer running view;
 * - a final edit that fails → one retry an `editIntervalMs` later, rendering whatever the latest
 *   view is by then; a second failure warns and gives up, leaving the entry for the next view.
 *   The retry has to be the manager's own timer: the setup layer's refresh interval stops as soon
 *   as nothing is running, so nothing else would come back to a settled board;
 * - a send failure → retried once on the next apply, then the key is abandoned with a warn (the
 *   entry is kept so the board is never re-sent);
 * - an edit failure on a running board → warn only; the next change is edited normally;
 * - a key that vanishes from `applyViews` (a ledger reset at boot, or the board ageing out) →
 *   forgotten, with its pending timer cancelled and no final edit, so a genuinely new board with
 *   the same key posts fresh.
 *
 * `applyViews` is synchronous and never throws: every Discord call is fire-and-forget with its
 * own catch, because the caller is a ledger subscriber that must not be broken by Discord. Those
 * fire-and-forget completions can land after their board was forgotten (or the manager stopped,
 * which forgets every key), so each one re-checks that its entry is still the live one for its key
 * before touching Discord or arming a timer again.
 *
 * @module integrations/discord/task-board/manager
 */
import { EmbedBuilder, type Client, type Message, type TextChannel } from 'discord.js';
import type { DiscordRateLimiter } from '../rate-limiter';
import { withDiscordRetry } from '../retry';
import { renderTaskBoardEmbed } from './render.js';
import type { RenderedEmbed, TaskBoardView } from './types.js';
import { ChannelNotAccessibleError } from '@/errors';

/** The logging surface the manager needs; satisfied by the app logger. */
export interface TaskBoardLogger {
    debug: (obj: Record<string, unknown>) => void
    warn:  (obj: Record<string, unknown>) => void
}

/** Construction dependencies for {@link TaskBoardManager}. */
export interface TaskBoardManagerDeps {
    /** Discord client, used only to resolve a board's channel on first sight. */
    client:         Client
    /** Rate limiter; every send and edit is queued on the board's channel. */
    rateLimiter:    DiscordRateLimiter
    logger:         TaskBoardLogger
    /** Injectable clock; drives both the throttle and the footer stamp. */
    now:            () => Date
    /** Trailing-edge throttle window between two edits of one board. */
    editIntervalMs: number
    /** IANA zone for the rendered footer clock. */
    timeZone:       string
}

/** What is currently on screen for one board. */
interface PostedBoard {
    readonly message:   Message
    readonly rendered:  RenderedEmbed
    /** Epoch ms of the last edit; absent until the message has been edited at least once. */
    readonly editedAt?: number
}

/** Transition table: sending → live/retry_pending → sending/abandoned; live ↔ edit_pending;
 * live/edit_pending → finalizing → finalized/live or retry-wait → finalizing/live.
 * finalized → live on new running work; abandoned remains abandoned until forgotten.
 */
type BoardPhase
    = | { kind: 'sending', attempt: 1 | 2 }
      | { kind: 'retry_pending', attempts: 1 }
      | { kind: 'live', posted: PostedBoard }
      | { kind: 'edit_pending', posted: PostedBoard, timer: ReturnType<typeof setTimeout> }
      | { kind: 'finalizing', posted: PostedBoard, attempt: 1 | 2, status: 'in-flight' }
      | { kind: 'finalizing', posted: PostedBoard, attempt: 1, status: 'retry-wait', timer: ReturnType<typeof setTimeout> }
      | { kind: 'finalized', posted: PostedBoard }
      | { kind: 'abandoned' };

/** Everything the manager remembers about one board key. */
interface BoardEntry {
    readonly key:      string
    /** The most recent view seen for this board — what an owed edit will render. */
    latest:            TaskBoardView
    /** The prior terminal view, retained only to discard late repeats after running resumes. */
    previousFinished?: TaskBoardView
    phase:             BoardPhase
}

/**
 * Two rendered embeds are the same iff they serialise identically. `renderTaskBoardEmbed` always
 * builds its result with the same key order, so this is a deep comparison in one operation.
 */
function sameEmbed(a: RenderedEmbed, b: RenderedEmbed): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Maps the renderer's plain object onto the `EmbedBuilder` discord.js wants. */
function toEmbed(rendered: RenderedEmbed): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(rendered.title)
        .setColor(rendered.color)
        .setFooter({ text: rendered.footer })
        .addFields(rendered.fields);
}

/**
 * Keeps one live-edited Discord embed per board key in step with the views composed from the
 * session ledgers. See the module doc for the full lifecycle of a key.
 */
export class TaskBoardManager {
    private readonly deps: TaskBoardManagerDeps;
    /** Live boards, by key. A key leaves this map only when it leaves the views, or on `stop()`. */
    private readonly boards = new Map<string, BoardEntry>();

    constructor(deps: TaskBoardManagerDeps) {
        this.deps = deps;
    }

    /**
     * Reconciles the live boards with `views`: keys that vanished are dropped, and every view is
     * sent, edited, throttled or skipped according to the lifecycle in the module doc.
     *
     * @param views The full set of boards composed this tick — a key's absence is meaningful.
     */
    applyViews(views: readonly TaskBoardView[]): void {
        // Stryker disable next-line llm: views.map(view => view.key) feeds straight into new Set(...), which already dedupes, so wrapping it in a redundant dedupe filter or a defensive .slice() copy changes nothing observable.
        const live = new Set(views.map(view => view.key));

        // Deleting from a Map/Set while iterating it is well defined: the entry just removed is
        // simply not revisited.
        // Stryker disable next-line llm: forget() only deletes from this.boards, never inserts, so a live Map iterator and a materialized Array.from(...) snapshot visit the same keys in the same order.
        for(const key of this.boards.keys()) {
            if(!live.has(key)) {
                this.forget(key);
            }
        }

        for(const view of views) {
            // Stryker disable next-line llm: view comes from a readonly TaskBoardView[], so it is a defined object and an added truthiness guard cannot short-circuit.
            this.applyView(view);
        }
    }

    /** Cancels every pending edit and drops every board. */
    stop(): void {
        for(const key of this.boards.keys()) {
            this.forget(key);
        }
    }

    /**
     * Drops one board and cancels its owed edit, without touching Discord.
     */
    private forget(key: string): void {
        const entry = this.boards.get(key);
        if(entry !== undefined) {
            if(entry.phase.kind === 'edit_pending' || (entry.phase.kind === 'finalizing' && entry.phase.status === 'retry-wait')) {
                clearTimeout(entry.phase.timer);
            }
            this.boards.delete(key);
        }
    }

    /**
     * True while `entry` is still the live entry for its key. A fire-and-forget completion that
     * resolves after the key was forgotten — because it left the views, or because `stop()` dropped
     * every key — must not edit Discord or arm a timer on the strength of state nobody owns.
     */
    private isLive(entry: BoardEntry): boolean {
        return this.boards.get(entry.key) === entry;
    }

    /** Notes an async completion that resolved after its board stopped being the live one. */
    private discardStale(entry: BoardEntry, stage: 'send' | 'final-edit'): void {
        this.deps.logger.debug({
            boardKey: entry.key,
            stage,
            msg:      'Task board update resolved after the board was dropped; discarding',
        });
    }

    /** Routes one view to the send, retry, or edit path. */
    private applyView(view: TaskBoardView): void {
        // Stryker disable next-line llm: TaskBoardView.key is a required string, so the nullish fallback is unreachable.
        const entry = this.boards.get(view.key);
        if(entry === undefined) {
            const created: BoardEntry = { key: view.key, latest: view, phase: { kind: 'sending', attempt: 1 } };
            this.boards.set(view.key, created);
            void this.send(created);
            return;
        }

        switch(entry.phase.kind) {
            case 'abandoned': {
                return;
            }
            case 'sending': {
                entry.latest = view;
                return;
            }
            case 'retry_pending': {
                entry.latest = view;
                entry.phase = { kind: 'sending', attempt: 2 };
                void this.send(entry);
                return;
            }
            case 'finalized': {
                if(view.state !== 'running') {
                    return;
                }
                entry.previousFinished = entry.latest;
                entry.phase = { kind: 'live', posted: entry.phase.posted };
                break;
            }
            case 'live':
            case 'edit_pending':
            case 'finalizing': {
                break;
            }
            default: {
                const impossible: never = entry.phase;
                return impossible;
            }
        }
        // A delayed repeat of the previous completion cannot overwrite newer running work.
        if(view.state !== 'running' && JSON.stringify(view) === JSON.stringify(entry.previousFinished)) {
            return;
        }
        entry.latest = view;
        this.applyToPosted(entry);
    }

    /** Posts `entry.latest` as a new message, or records the failure. */
    private async send(entry: BoardEntry): Promise<void> {
        const view = entry.latest;
        try {
            const posted = await this.postBoard(view);
            this.onSent(entry, view, posted.message, posted.rendered);
        } catch (error) {
            this.onSendFailed(entry, view, error);
        }
    }

    /** Resolves the board's channel and posts the rendered embed to it. */
    private async postBoard(view: TaskBoardView): Promise<{ message: Message, rendered: RenderedEmbed }> {
        const channel = await this.deps.client.channels.fetch(view.channelId);
        if(!channel?.isTextBased()) {
            throw new ChannelNotAccessibleError(view.channelId);
        }

        const rendered = renderTaskBoardEmbed(view, this.deps.now(), { timeZone: this.deps.timeZone });
        const message = await withDiscordRetry(() => this.deps.rateLimiter.sendPayloadToChannel(channel as TextChannel, { embeds: [toEmbed(rendered)] }));

        return { message, rendered };
    }

    /** Records a successful post, and applies any view that arrived while it was in flight. */
    private onSent(entry: BoardEntry, view: TaskBoardView, message: Message, rendered: RenderedEmbed): void {
        if(!this.isLive(entry)) {
            this.discardStale(entry, 'send');
            return;
        }

        entry.phase = { kind: 'live', posted: { message, rendered } };
        this.deps.logger.debug({
            boardKey:  entry.key,
            channelId: view.channelId,
            messageId: message.id,
            msg:       'Task board posted',
        });

        if(entry.latest !== view) {
            // A newer view arrived while the send was in flight; it has not been applied yet.
            this.applyView(entry.latest);
        }
    }

    /** Records a failed post: one retry is allowed, then the key is abandoned. */
    private onSendFailed(entry: BoardEntry, view: TaskBoardView, error: unknown): void {
        const attempt = entry.phase.kind === 'sending' ? entry.phase.attempt : 1;
        if(attempt === 2) {
            entry.phase = { kind: 'abandoned' };
            this.deps.logger.warn({
                boardKey:  entry.key,
                channelId: view.channelId,
                error,
                msg:       'Task board send failed twice; abandoning this board',
            });
            return;
        }

        entry.phase = { kind: 'retry_pending', attempts: 1 };
        this.deps.logger.warn({
            boardKey:  entry.key,
            channelId: view.channelId,
            error,
            msg:       'Task board send failed; will retry on the next update',
        });
    }

    /** Decides what an already-posted board does with its latest view. */
    private applyToPosted(entry: BoardEntry): void {
        const phase = entry.phase;
        if(phase.kind !== 'live' && phase.kind !== 'edit_pending' && phase.kind !== 'finalizing') {
            return;
        }
        const posted = phase.posted;
        const at = this.deps.now();
        const view = entry.latest;
        const rendered = renderTaskBoardEmbed(view, at, { timeZone: this.deps.timeZone });
        if(sameEmbed(rendered, posted.rendered)) {
            return;
        }
        if(view.state !== 'running') {
            if(phase.kind === 'edit_pending' || (phase.kind === 'finalizing' && phase.status === 'retry-wait')) {
                clearTimeout(phase.timer);
            }
            this.editNow(entry, posted.message, rendered, at);
            return;
        }
        if(phase.kind === 'edit_pending') {
            return;
        }
        if(phase.kind === 'finalizing' && phase.status === 'retry-wait') {
            clearTimeout(phase.timer);
        }
        const waitMs = posted.editedAt === undefined ? 0 : (posted.editedAt + this.deps.editIntervalMs) - at.getTime();
        if(waitMs <= 0) {
            this.editNow(entry, posted.message, rendered, at);
            return;
        }
        const timer = setTimeout(() => {
            this.onEditDue(entry);
        }, waitMs);
        entry.phase = { kind: 'edit_pending', posted, timer };
    }

    /**
     * Records `rendered` as what is on screen and pushes it to Discord, down the final-edit path
     * when the view it renders has settled and the ordinary one while it is still running.
     */
    private editNow(entry: BoardEntry, message: Message, rendered: RenderedEmbed, at: Date, attempt: 1 | 2 = 1): void {
        const posted = { message, rendered, editedAt: at.getTime() };
        if(entry.latest.state === 'running') {
            entry.phase = { kind: 'live', posted };
            void this.edit(entry.key, message, rendered);
            return;
        }
        entry.previousFinished = entry.latest;
        entry.phase = { kind: 'finalizing', posted, attempt, status: 'in-flight' };
        void this.editFinal(entry, message, rendered, entry.phase);
    }

    /** Fires a trailing edit or final retry against the latest view. */
    private onEditDue(entry: BoardEntry): void {
        const phase = entry.phase;
        if(phase.kind !== 'edit_pending' && !(phase.kind === 'finalizing' && phase.status === 'retry-wait')) {
            return;
        }
        const at = this.deps.now();
        this.editNow(entry, phase.posted.message, renderTaskBoardEmbed(entry.latest, at, { timeZone: this.deps.timeZone }), at,
            phase.kind === 'finalizing' ? 2 : 1);
    }

    /** Edits one board's message; a failure is logged and the key kept. */
    private async edit(key: string, message: Message, rendered: RenderedEmbed): Promise<void> {
        try {
            await withDiscordRetry(() => this.deps.rateLimiter.editMessage(message, { embeds: [toEmbed(rendered)] }));
        } catch (error) {
            this.deps.logger.warn({
                boardKey:  key,
                messageId: message.id,
                error,
                msg:       'Task board edit failed',
            });
        }
    }

    /**
     * Edits a board with its terminal view. Only a landed edit finalises the board — a failed one
     * would otherwise freeze a stale board forever — and a failure buys one retry.
     */
    private async editFinal(entry: BoardEntry, message: Message, rendered: RenderedEmbed, attempt: Extract<BoardPhase, { kind: 'finalizing', status: 'in-flight' }>): Promise<void> {
        try {
            await withDiscordRetry(() => this.deps.rateLimiter.editMessage(message, { embeds: [toEmbed(rendered)] }));
        } catch (error) {
            this.onFinalEditFailed(entry, message, error, attempt);
            return;
        }
        if(this.isLive(entry) && entry.phase === attempt) {
            entry.previousFinished = entry.latest;
            entry.phase = { kind: 'finalized', posted: attempt.posted };
        }
    }

    /** Arms the one retry of a failed final edit, or gives up after the second. */
    private onFinalEditFailed(entry: BoardEntry, message: Message, error: unknown, attempt: Extract<BoardPhase, { kind: 'finalizing', status: 'in-flight' }>): void {
        if(!this.isLive(entry)) {
            this.discardStale(entry, 'final-edit');
            return;
        }
        if(entry.phase !== attempt) {
            return;
        }
        if(attempt.attempt === 2) {
            entry.phase = { kind: 'live', posted: attempt.posted };
            this.deps.logger.warn({
                boardKey:  entry.key,
                messageId: message.id,
                error,
                msg:       'Task board final edit failed twice; leaving the board as it stands',
            });
            return;
        }
        this.deps.logger.warn({
            boardKey:  entry.key,
            messageId: message.id,
            error,
            msg:       'Task board final edit failed; retrying once',
        });
        const timer = setTimeout(() => {
            this.onEditDue(entry);
        }, this.deps.editIntervalMs);
        entry.phase = { kind: 'finalizing', posted: attempt.posted, attempt: 1, status: 'retry-wait', timer };
    }
}
