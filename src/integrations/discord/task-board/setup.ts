/**
 * Task board wiring: subscribes to the session ledgers, composes a board per (channel, turn), and
 * hands the result to a {@link TaskBoardManager}.
 *
 * Ledger events alone are not enough. A board's elapsed times and footer clock keep moving while
 * nothing at all is happening on the SDK stream — a sub-agent that thinks for two minutes emits
 * `task_progress` about every thirty seconds — so while ANY composed board is still running a
 * `refreshIntervalMs` interval re-ticks. It is armed only while something runs and cleared as soon
 * as everything has settled, so an idle process holds no timer.
 *
 * @module integrations/discord/task-board/setup
 */
import type { Client } from 'discord.js';
import type { DiscordRateLimiter } from '../rate-limiter';
import { composeTaskBoards } from './compose.js';
import { TaskBoardManager, type TaskBoardLogger } from './manager.js';
import type { LedgerStore } from '@/agent';
import type { TaskBoardConfig } from '@/config';

/** Wall clock used when the caller injects none. */
function systemNow(): Date {
    return new Date();
}

/** Construction inputs for {@link setupTaskBoard}. */
export interface SetupTaskBoardParams {
    readyClient: Client
    rateLimiter: DiscordRateLimiter
    /** Session ledgers to compose from — conventionally `[conversation, perch]`. */
    ledgers:     readonly LedgerStore[]
    config:      TaskBoardConfig
    /** IANA zone for the rendered footer clock. */
    timeZone:    string
    logger:      TaskBoardLogger
    /** Injectable clock; defaults to the system clock. */
    now?:        () => Date
}

/** Result of {@link setupTaskBoard}. */
export interface TaskBoardSetupResult {
    /** Unsubscribes every ledger, clears the refresh interval and stops the manager. */
    stop: () => void
}

/**
 * Wires the live task board to the session ledgers. See the module doc for why the refresh
 * interval exists and when it runs.
 *
 * @param params See {@link SetupTaskBoardParams}.
 * @returns See {@link TaskBoardSetupResult}.
 */
export function setupTaskBoard(params: SetupTaskBoardParams): TaskBoardSetupResult {
    const {
        readyClient,
        rateLimiter,
        ledgers,
        config,
        timeZone,
        logger,
        now = systemNow,
    } = params;

    const manager = new TaskBoardManager({
        client:         readyClient,
        rateLimiter,
        logger,
        now,
        editIntervalMs: config.editIntervalMs,
        timeZone,
    });

    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    /** Composes every board from every ledger, applies them, and arms or clears the refresh. */
    function tick(): void {
        const views = composeTaskBoards(ledgers.map(store => store.get()), now());
        manager.applyViews(views);

        if(views.some(view => view.state === 'running')) {
            refreshTimer ??= setInterval(tick, config.refreshIntervalMs);
        } else {
            // `clearInterval(undefined)` is a no-op, so no armed guard is needed here.
            clearInterval(refreshTimer);
            refreshTimer = undefined;
        }
    }

    const unsubscribes = ledgers.map(store => store.subscribe(() => {
        tick();
    }));
    tick();

    return {
        stop: (): void => {
            for(const unsubscribe of unsubscribes) {
                unsubscribe();
            }
            clearInterval(refreshTimer);
            manager.stop();
        },
    };
}
