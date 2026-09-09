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
 *   a later `running` view for the same key (a second sub-agent launched in the same turn) clears
 *   the flag and resumes ordinary throttled edits on the SAME message;
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

/** Everything the manager remembers about one board key. */
interface BoardEntry {
    readonly key:  string
    /** The most recent view seen for this board — what an owed edit will render. */
    latest:        TaskBoardView
    /** Set once the board's message exists. */
    posted?:       PostedBoard
    /** Armed while an edit is owed: a throttled trailing edit, or a failed final edit's one retry. */
    timer?:        ReturnType<typeof setTimeout>
    /** True while a send is in flight. */
    sending:       boolean
    /** True once one send attempt failed; the next attempt is the last. */
    failedOnce:    boolean
    /** True once two sends failed: the entry is kept so the board is never re-sent. */
    abandoned:     boolean
    /** True once a terminal view's edit landed; cleared when the same key runs again. */
    finalized:     boolean
    /** Edits attempted for the current terminal view; {@link FINAL_EDIT_ATTEMPTS} is the limit. */
    finalAttempts: number
}

/** How many times one terminal view's edit is attempted before the board is left as it stands. */
const FINAL_EDIT_ATTEMPTS = 2;

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
        const live = new Set(views.map(view => view.key));

        // Deleting from a Map/Set while iterating it is well defined: the entry just removed is
        // simply not revisited.
        for(const key of this.boards.keys()) {
            if(!live.has(key)) {
                this.forget(key);
            }
        }

        for(const view of views) {
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
     * `clearTimeout(undefined)` is a no-op, so no armed-timer guard is needed.
     */
    private forget(key: string): void {
        const entry = this.boards.get(key);
        if(entry !== undefined) {
            clearTimeout(entry.timer);
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
        const entry = this.boards.get(view.key);
        if(entry === undefined) {
            const created: BoardEntry = {
                key:           view.key,
                latest:        view,
                sending:       true,
                failedOnce:    false,
                abandoned:     false,
                finalized:     false,
                finalAttempts: 0,
            };
            this.boards.set(view.key, created);
            void this.send(created);
            return;
        }

        if(entry.abandoned) {
            return;
        }

        entry.latest = view;
        if(entry.finalized) {
            if(view.state !== 'running') {
                // Settled, and its final state is already on screen: nothing left to say.
                return;
            }
            // A second launch under the same key — the board is live again, on the same message.
            entry.finalized = false;
        }

        if(entry.sending) {
            return;
        }

        const posted = entry.posted;
        if(posted === undefined) {
            // A previous send failed; this apply is its one retry.
            entry.sending = true;
            void this.send(entry);
            return;
        }

        this.applyToPosted(entry, posted);
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
        entry.sending = false;
        if(!this.isLive(entry)) {
            this.discardStale(entry, 'send');
            return;
        }

        entry.posted = { message, rendered };
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
        entry.sending = false;
        if(entry.failedOnce) {
            entry.abandoned = true;
            this.deps.logger.warn({
                boardKey:  entry.key,
                channelId: view.channelId,
                error,
                msg:       'Task board send failed twice; abandoning this board',
            });
            return;
        }

        entry.failedOnce = true;
        this.deps.logger.warn({
            boardKey:  entry.key,
            channelId: view.channelId,
            error,
            msg:       'Task board send failed; will retry on the next update',
        });
    }

    /** Decides what an already-posted board does with `entry.latest`. */
    private applyToPosted(entry: BoardEntry, posted: PostedBoard): void {
        const at = this.deps.now();
        const view = entry.latest;
        const rendered = renderTaskBoardEmbed(view, at, { timeZone: this.deps.timeZone });

        if(sameEmbed(rendered, posted.rendered)) {
            return;
        }

        if(view.state !== 'running') {
            // Terminal: one final edit, no throttle, cancelling whatever was owed. The entry and
            // its message survive, so a second launch under this key resumes on the same board.
            clearTimeout(entry.timer);
            entry.timer = undefined;
            entry.finalAttempts = 0;
            this.editNow(entry, posted.message, rendered, at);
            return;
        }

        if(entry.timer !== undefined) {
            // An edit is already owed and will render `entry.latest` when it fires.
            return;
        }

        const waitMs = posted.editedAt === undefined ? 0 : (posted.editedAt + this.deps.editIntervalMs) - at.getTime();
        if(waitMs <= 0) {
            this.editNow(entry, posted.message, rendered, at);
            return;
        }

        const message = posted.message;
        entry.timer = setTimeout(() => {
            this.onEditDue(entry, message);
        }, waitMs);
    }

    /**
     * Records `rendered` as what is on screen and pushes it to Discord, down the final-edit path
     * when the view it renders has settled and the ordinary one while it is still running.
     */
    private editNow(entry: BoardEntry, message: Message, rendered: RenderedEmbed, at: Date): void {
        entry.posted = { message, rendered, editedAt: at.getTime() };
        if(entry.latest.state === 'running') {
            void this.edit(entry.key, message, rendered);
            return;
        }

        entry.finalAttempts += 1;
        void this.editFinal(entry, message, rendered);
    }

    /**
     * Fires when an owed edit comes due — a throttled trailing edit, or a failed final edit's one
     * retry. Either way it renders whatever the latest view is by now, which may well have gone
     * back to running since the timer was armed.
     */
    private onEditDue(entry: BoardEntry, message: Message): void {
        entry.timer = undefined;
        const at = this.deps.now();
        this.editNow(entry, message, renderTaskBoardEmbed(entry.latest, at, { timeZone: this.deps.timeZone }), at);
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
    private async editFinal(entry: BoardEntry, message: Message, rendered: RenderedEmbed): Promise<void> {
        try {
            await withDiscordRetry(() => this.deps.rateLimiter.editMessage(message, { embeds: [toEmbed(rendered)] }));
        } catch (error) {
            this.onFinalEditFailed(entry, message, error);
            return;
        }

        // No liveness guard needed: a board forgotten while this was in flight is no longer in
        // `boards`, so the flag dies with the entry and nothing reads it again.
        entry.finalized = true;
    }

    /** Arms the one retry of a failed final edit, or gives up with a warn after the second. */
    private onFinalEditFailed(entry: BoardEntry, message: Message, error: unknown): void {
        if(!this.isLive(entry)) {
            this.discardStale(entry, 'final-edit');
            return;
        }

        if(entry.finalAttempts >= FINAL_EDIT_ATTEMPTS) {
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
        entry.timer = setTimeout(() => {
            this.onEditDue(entry, message);
        }, this.deps.editIntervalMs);
    }
}
