/**
 * Tests for the task board's Discord manager: the one stateful piece of the package.
 *
 * Everything here runs against a mocked client / rate limiter and fake timers — the manager's
 * only real dependency is the pure renderer, which is exercised on its own in render.test.ts.
 */
import { describe, test, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import { EmbedBuilder, type Client, type Message, type TextChannel } from 'discord.js';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import { TaskBoardManager } from '@/integrations/discord/task-board/manager';
import type { TaskBoardTask, TaskBoardView } from '@/integrations/discord/task-board/types';

const T0 = new Date('2026-09-09T20:36:43.000Z');

function boardTask(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
    return {
        id:          'task-1',
        kind:        'subagent',
        description: 'do a thing',
        status:      'running',
        startedAt:   T0,
        elapsedMs:   1000,
        totalTokens: 0,
        toolUses:    0,
        ...overrides,
    };
}

function boardView(overrides: Partial<TaskBoardView> = {}): TaskBoardView {
    return {
        key:       'chan-1:turn-1',
        channelId: 'chan-1',
        turnId:    'turn-1',
        tasks:     [boardTask()],
        state:     'running',
        startedAt: T0,
        ...overrides,
    };
}

/** A running view whose render differs from every other `distinct(...)` view. */
function distinct(description: string): TaskBoardView {
    return boardView({ tasks: [boardTask({ description })] });
}

/** A settled view for the same key, whose render differs from every other `settled(...)` view. */
function settled(description: string, finishedAt: Date): TaskBoardView {
    return boardView({ state: 'done', tasks: [boardTask({ description, status: 'completed' })], finishedAt });
}

/** Drains the microtask queue deeply enough for the manager's send/edit chains to settle. */
async function settle(): Promise<void> {
    let chain = Promise.resolve();
    for(let i = 0; i < 16; i++) {
        chain = chain.then(() => undefined);
    }
    await chain;
}

/** The embeds payload passed to the Nth call of a mocked rate-limiter method. */
function embedOf(calls: unknown[][], index: number): EmbedBuilder {
    const payload = calls[index][1] as { embeds: EmbedBuilder[] };
    return payload.embeds[0];
}

describe('TaskBoardManager', () => {
    let clockMs: number;
    let sentMessage: Message;
    let channel: TextChannel;
    let fetchChannel: ReturnType<typeof mock>;
    let sendPayloadToChannel: ReturnType<typeof mock>;
    let editMessage: ReturnType<typeof mock>;
    let logger: { debug: ReturnType<typeof mock>, warn: ReturnType<typeof mock> };

    /** Advances the fake clock and the fake timers together. */
    function advance(ms: number): void {
        clockMs += ms;
        jest.advanceTimersByTime(ms);
    }

    function makeManager(editIntervalMs = 3000, timeZone = 'UTC'): TaskBoardManager {
        return new TaskBoardManager({
            client:      { channels: { fetch: fetchChannel } } as unknown as Client,
            rateLimiter: { sendPayloadToChannel, editMessage } as unknown as DiscordRateLimiter,
            logger,
            now:         () => new Date(clockMs),
            editIntervalMs,
            timeZone,
        });
    }

    beforeEach(() => {
        jest.useFakeTimers();
        clockMs = T0.getTime();
        sentMessage = { id: 'msg-1', channelId: 'chan-1' } as unknown as Message;
        channel = { id: 'chan-1', isTextBased: () => true } as unknown as TextChannel;
        fetchChannel = mock(async () => channel);
        sendPayloadToChannel = mock(async () => sentMessage);
        editMessage = mock(async () => sentMessage);
        logger = { debug: mock(), warn: mock() };
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe('first sight', () => {
        test('fetches the channel and sends one embed built from the rendered board', async () => {
            const manager = makeManager();

            manager.applyViews([boardView()]);
            await settle();

            expect(fetchChannel).toHaveBeenCalledWith('chan-1');
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
            expect(sendPayloadToChannel.mock.calls[0][0]).toBe(channel);

            const embed = embedOf(sendPayloadToChannel.mock.calls, 0);
            expect(embed).toBeInstanceOf(EmbedBuilder);
            expect(embed.data.title).toBe('⏳ Working in the background · 1 running');
            expect(embed.data.color).toBe(0x4E_8F_E6);
            expect(embed.data.footer?.text).toBe('Updates every few seconds · Last update 8:36:43 PM');
            expect(embed.data.fields).toHaveLength(1);
            expect(embed.data.fields?.[0].name).toContain('do a thing');
            expect(editMessage).not.toHaveBeenCalled();
        });

        test('renders in the configured time zone', async () => {
            const manager = makeManager(3000, 'America/Los_Angeles');

            manager.applyViews([boardView()]);
            await settle();

            expect(embedOf(sendPayloadToChannel.mock.calls, 0).data.footer?.text).toBe('Updates every few seconds · Last update 12:36:43 PM');
        });

        test('sends one message per board key', async () => {
            const manager = makeManager();

            manager.applyViews([
                boardView(),
                boardView({ key: 'chan-2:turn-9', channelId: 'chan-2', turnId: 'turn-9' }),
            ]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);
        });

        test('logs the posted board', async () => {
            const manager = makeManager();

            manager.applyViews([boardView()]);
            await settle();

            const debugCalls = logger.debug.mock.calls as [Record<string, unknown>][];
            const posted = debugCalls.filter(call => call[0].msg === 'Task board posted');
            expect(posted).toHaveLength(1);
            expect(posted[0][0].boardKey).toBe('chan-1:turn-1');
            expect(posted[0][0].messageId).toBe('msg-1');
        });

        test('does not send again while the first send is still in flight', async () => {
            const manager = makeManager();

            manager.applyViews([boardView()]);
            manager.applyViews([boardView()]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
        });

        test('applies a view that arrived during the send once the send resolves', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            manager.applyViews([distinct('second')]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
            expect(editMessage).toHaveBeenCalledTimes(1);
            expect(embedOf(editMessage.mock.calls, 0).data.fields?.[0].name).toContain('second');
        });
    });

    describe('the configured time zone', () => {
        test('is used for the dedupe comparison, so an unchanged board is still skipped', async () => {
            const manager = makeManager(3000, 'America/Los_Angeles');

            manager.applyViews([boardView()]);
            await settle();
            manager.applyViews([boardView()]);
            await settle();

            expect(editMessage).not.toHaveBeenCalled();
        });

        test('is used for a trailing edit that fires from the timer', async () => {
            const manager = makeManager(3000, 'America/Los_Angeles');

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();
            advance(100);
            manager.applyViews([distinct('third')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(2900);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(2);
            expect(embedOf(editMessage.mock.calls, 1).data.footer?.text).toBe('Updates every few seconds · Last update 12:36:46 PM');
        });

        test('is used for the throttled edit, not only the first send', async () => {
            const manager = makeManager(3000, 'America/Los_Angeles');

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();

            expect(embedOf(editMessage.mock.calls, 0).data.footer?.text).toBe('Updates every few seconds · Last update 12:36:43 PM');
        });
    });

    describe('dedupe', () => {
        test('never edits straight after a send when no newer view arrived, even though the clock moved', async () => {
            sendPayloadToChannel = mock(async () => {
                clockMs += 1000;
                return sentMessage;
            });
            const manager = makeManager();

            manager.applyViews([boardView()]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
            expect(editMessage).not.toHaveBeenCalled();
        });

        test('skips the edit when the rendered embed is unchanged', async () => {
            const manager = makeManager();

            manager.applyViews([boardView()]);
            await settle();
            manager.applyViews([boardView()]);
            await settle();

            expect(editMessage).not.toHaveBeenCalled();
        });

        test('edits when the rendered embed changes', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(1);
            expect(editMessage.mock.calls[0][0]).toBe(sentMessage);
            expect(embedOf(editMessage.mock.calls, 0).data.fields?.[0].name).toContain('second');
        });
    });

    describe('trailing-edge throttle', () => {
        test('three rapid views produce one immediate edit and one trailing edit carrying the last', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();

            manager.applyViews([distinct('second')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);
            expect(embedOf(editMessage.mock.calls, 0).data.fields?.[0].name).toContain('second');

            advance(100);
            manager.applyViews([distinct('third')]);
            advance(100);
            manager.applyViews([distinct('fourth')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(2799);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(1);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);
            expect(embedOf(editMessage.mock.calls, 1).data.fields?.[0].name).toContain('fourth');
        });

        test('edits immediately once exactly one interval has passed since the last edit', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(3000);
            manager.applyViews([distinct('third')]);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(2);
            expect(embedOf(editMessage.mock.calls, 1).data.fields?.[0].name).toContain('third');
        });

        test('honours a custom edit interval', async () => {
            const manager = makeManager(500);

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();

            advance(100);
            manager.applyViews([distinct('third')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(400);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);
        });
    });

    describe('terminal boards', () => {
        test('edits once with the final view and then ignores the key', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();

            const done = boardView({ state: 'done', tasks: [boardTask({ status: 'completed' })], finishedAt: new Date(clockMs) });
            manager.applyViews([done]);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(1);
            expect(embedOf(editMessage.mock.calls, 0).data.color).toBe(0x3B_A5_5C);

            manager.applyViews([done]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
        });

        test('a failed board edits with the failed stripe', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();

            manager.applyViews([boardView({ state: 'failed', tasks: [boardTask({ status: 'failed' })], finishedAt: new Date(clockMs) })]);
            await settle();

            expect(embedOf(editMessage.mock.calls, 0).data.color).toBe(0xDA_37_3C);
        });

        test('cancels a pending trailing edit and bypasses the throttle', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(100);
            manager.applyViews([distinct('third')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            manager.applyViews([boardView({ state: 'done', tasks: [boardTask({ status: 'completed' })], finishedAt: new Date(clockMs) })]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);

            advance(10_000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);
        });

        // Two sub-agents launched back to back in one turn share a board key: the first one's
        // finish must not close the board for good, or the second launch has nowhere to appear.
        test('resumes throttled edits on the same message when the key runs again', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([settled('first', new Date(clockMs))]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            manager.applyViews([distinct('second')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(3000);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
            expect(editMessage).toHaveBeenCalledTimes(2);
            expect(editMessage.mock.calls[1][0]).toBe(sentMessage);
            expect(embedOf(editMessage.mock.calls, 1).data.fields?.[0].name).toContain('second');
            expect(embedOf(editMessage.mock.calls, 1).data.color).toBe(0x4E_8F_E6);
        });

        test('settles again after resuming, and ignores the key from there', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([settled('first', new Date(clockMs))]);
            await settle();
            manager.applyViews([distinct('second')]);
            advance(3000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);

            manager.applyViews([settled('second', new Date(clockMs))]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(3);
            expect(embedOf(editMessage.mock.calls, 2).data.color).toBe(0x3B_A5_5C);

            manager.applyViews([settled('third', new Date(clockMs))]);
            advance(10_000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(3);
        });

        test('forgets a closed key once it leaves the views, so a later board posts fresh', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([boardView({ state: 'done', tasks: [boardTask({ status: 'completed' })], finishedAt: new Date(clockMs) })]);
            await settle();

            manager.applyViews([]);
            await settle();

            manager.applyViews([distinct('first')]);
            await settle();
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);
        });
    });

    describe('send failures', () => {
        test('retries on the next apply, then abandons the key with a warn', async () => {
            sendPayloadToChannel = mock(async () => {
                throw new Error('discord is sad');
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);

            const firstWarns = (logger.warn.mock.calls as [Record<string, unknown>][]).filter(call => call[0].msg === 'Task board send failed; will retry on the next update');
            expect(firstWarns).toHaveLength(1);
            expect(firstWarns[0][0].boardKey).toBe('chan-1:turn-1');

            manager.applyViews([distinct('second')]);
            await settle();
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);

            const abandonWarns = (logger.warn.mock.calls as [Record<string, unknown>][]).filter(call => call[0].msg === 'Task board send failed twice; abandoning this board');
            expect(abandonWarns).toHaveLength(1);
            expect(abandonWarns[0][0].boardKey).toBe('chan-1:turn-1');

            manager.applyViews([distinct('third')]);
            await settle();
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);
            expect(editMessage).not.toHaveBeenCalled();
        });

        test('does not start a second retry while the first retry is still in flight', async () => {
            sendPayloadToChannel = mock(async () => {
                throw new Error('discord is sad');
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);

            manager.applyViews([distinct('second')]);
            manager.applyViews([distinct('third')]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);
        });

        test('a retry that succeeds posts the board and clears the failure', async () => {
            let attempts = 0;
            sendPayloadToChannel = mock(async () => {
                attempts += 1;
                if(attempts === 1) {
                    throw new Error('transient');
                }
                return sentMessage;
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);
            expect(embedOf(sendPayloadToChannel.mock.calls, 1).data.fields?.[0].name).toContain('second');
        });

        test('a non-text channel never sends and warns instead', async () => {
            fetchChannel = mock(async () => ({ id: 'chan-1', isTextBased: () => false }));
            const manager = makeManager();

            manager.applyViews([boardView()]);
            await settle();

            expect(sendPayloadToChannel).not.toHaveBeenCalled();
            const warns = (logger.warn.mock.calls as [Record<string, unknown>][]).filter(call => call[0].msg === 'Task board send failed; will retry on the next update');
            expect(warns).toHaveLength(1);
        });

        test('a missing channel never sends and warns instead', async () => {
            fetchChannel = mock(async () => null);
            const manager = makeManager();

            manager.applyViews([boardView()]);
            await settle();

            expect(sendPayloadToChannel).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(1);
        });
    });

    describe('final edit failures', () => {
        /** Every warn logged with `msg`. */
        function warnsWith(msg: string): [Record<string, unknown>][] {
            return (logger.warn.mock.calls as [Record<string, unknown>][]).filter(call => call[0].msg === msg);
        }

        test('retries once after an interval, then warns and stops trying', async () => {
            editMessage = mock(async () => {
                throw new Error('edit exploded');
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([settled('first', new Date(clockMs))]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);
            expect(warnsWith('Task board final edit failed; retrying once')).toHaveLength(1);
            expect(warnsWith('Task board final edit failed; retrying once')[0][0].boardKey).toBe('chan-1:turn-1');

            advance(2999);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(1);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);
            expect(warnsWith('Task board final edit failed twice; leaving the board as it stands')).toHaveLength(1);

            advance(10_000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);

            // The board was never finalised, so a genuinely new terminal view is still edited.
            manager.applyViews([settled('second', new Date(clockMs))]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(3);
        });

        test('finalises the board once the retry lands, so a later terminal view is ignored', async () => {
            let attempts = 0;
            editMessage = mock(async () => {
                attempts += 1;
                if(attempts === 1) {
                    throw new Error('transient');
                }
                return sentMessage;
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([settled('first', new Date(clockMs))]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(3000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);

            manager.applyViews([settled('second', new Date(clockMs))]);
            advance(10_000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);
        });

        test('the retry renders whatever the latest view is by then, running again included', async () => {
            let attempts = 0;
            editMessage = mock(async () => {
                attempts += 1;
                if(attempts === 1) {
                    throw new Error('transient');
                }
                return sentMessage;
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([settled('first', new Date(clockMs))]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            advance(3000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(2);
            expect(embedOf(editMessage.mock.calls, 1).data.fields?.[0].name).toContain('second');
            expect(embedOf(editMessage.mock.calls, 1).data.color).toBe(0x4E_8F_E6);

            advance(3000);
            manager.applyViews([distinct('third')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(3);
        });
    });

    describe('completions for a board that is no longer live', () => {
        /** Every discard logged at debug level. */
        function discards(): [Record<string, unknown>][] {
            return (logger.debug.mock.calls as [Record<string, unknown>][])
                .filter(call => call[0].msg === 'Task board update resolved after the board was dropped; discarding');
        }

        test('a send that lands after the board left the views applies nothing', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            manager.applyViews([distinct('second')]);
            manager.applyViews([]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
            expect(editMessage).not.toHaveBeenCalled();
            expect(discards()).toHaveLength(1);
            expect(discards()[0][0].stage).toBe('send');
            expect(discards()[0][0].boardKey).toBe('chan-1:turn-1');
            expect((logger.debug.mock.calls as [Record<string, unknown>][]).filter(call => call[0].msg === 'Task board posted')).toHaveLength(0);
        });

        test('a send that lands after stop() applies nothing', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            manager.applyViews([distinct('second')]);
            manager.stop();
            await settle();

            expect(editMessage).not.toHaveBeenCalled();
            expect(discards()).toHaveLength(1);
        });

        test('a failed final edit for a dropped board arms no retry', async () => {
            editMessage = mock(async () => {
                throw new Error('edit exploded');
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([settled('first', new Date(clockMs))]);
            manager.applyViews([]);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(1);
            expect(discards()).toHaveLength(1);
            expect(discards()[0][0].stage).toBe('final-edit');
            expect((logger.warn.mock.calls as [Record<string, unknown>][]).filter(call => call[0].msg === 'Task board final edit failed; retrying once')).toHaveLength(0);

            advance(10_000);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);
        });
    });

    describe('edit failures', () => {
        test('warns and keeps the key, so the next change still edits', async () => {
            editMessage = mock(async () => {
                throw new Error('edit exploded');
            });
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();

            const warns = (logger.warn.mock.calls as [Record<string, unknown>][]).filter(call => call[0].msg === 'Task board edit failed');
            expect(warns).toHaveLength(1);
            expect(warns[0][0].boardKey).toBe('chan-1:turn-1');
            expect(warns[0][0].messageId).toBe('msg-1');

            advance(3000);
            manager.applyViews([distinct('third')]);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(2);
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(1);
        });
    });

    describe('disappearing keys', () => {
        test('forgets a non-terminal board that leaves the views, without editing', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();

            manager.applyViews([]);
            await settle();

            expect(editMessage).not.toHaveBeenCalled();

            manager.applyViews([distinct('first')]);
            await settle();
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);
        });

        test('cancels a pending trailing edit when the board disappears', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();
            advance(100);
            manager.applyViews([distinct('third')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            manager.applyViews([]);
            advance(10_000);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(1);
        });

        test('keeps a board that is still present alongside one that left', async () => {
            const manager = makeManager();
            const other = boardView({ key: 'chan-2:turn-9', channelId: 'chan-2', turnId: 'turn-9' });

            manager.applyViews([distinct('first'), other]);
            await settle();
            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);

            manager.applyViews([distinct('second')]);
            await settle();

            expect(sendPayloadToChannel).toHaveBeenCalledTimes(2);
            expect(editMessage).toHaveBeenCalledTimes(1);
        });
    });

    describe('stop', () => {
        test('clears a pending trailing edit', async () => {
            const manager = makeManager();

            manager.applyViews([distinct('first')]);
            await settle();
            manager.applyViews([distinct('second')]);
            await settle();
            advance(100);
            manager.applyViews([distinct('third')]);
            await settle();
            expect(editMessage).toHaveBeenCalledTimes(1);

            manager.stop();
            advance(10_000);
            await settle();

            expect(editMessage).toHaveBeenCalledTimes(1);
        });

        test('is safe with no boards at all', () => {
            const manager = makeManager();

            expect(() => {
                manager.stop();
            }).not.toThrow();
        });
    });
});
