import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Channel } from 'discord.js';
import { mockLogger } from '../../../../setup';
import type { NotifyParams } from '@/agent';
import type { ChannelId } from '@/config';
import { ApprovalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import { createApprovedActionOutcomeDelivery } from '@/integrations/discord/approvals/outcome-delivery';
import type { ApprovedOutboundAction, ApprovedOutboundActionBackend } from '@/services';
import { createApprovedActionOutcomeReporter } from '@/services/approved-outbound-action/outcome-reporter';
import type { AdminPing, ApprovalCardRef } from '@/services/approved-outbound-action/types';
import type { ServiceLogger } from '@/services/types';

const ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const REVISION = '2026-09-24T12:00:00.000Z';
const CARD = { channelId: 'admin-ch', messageId: 'card-msg' };

function row(overrides: Partial<ApprovedOutboundAction> = {}): ApprovedOutboundAction {
    return {
        id:                   ID,
        state:                'executed',
        type:                 'email_send',
        params:               { uid: 42 },
        approvalCard:         CARD,
        outcomeReportPending: true,
        createdAt:            '2026-09-24T11:00:00.000Z',
        updatedAt:            REVISION,
        ...overrides,
    };
}

const ADMIN_CHANNEL = 'admin-review' as ChannelId;
const ADMIN_USER = '1234567890';
const CARD_URL = 'https://discord.com/channels/guild/admin-ch/card-msg';

/** What Discord answers for a sent ping: the ping message, in the admin channel's snowflake id. */
const PING = { channelId: '1283746501928374650', messageId: '1419283746501928374' };

interface Harness {
    deliver:             (action: ApprovedOutboundAction) => Promise<boolean>
    notify:              ReturnType<typeof mock<(params: NotifyParams) => boolean>>
    fetchChannel:        ReturnType<typeof mock<(channelId: ChannelId) => Promise<Channel | null>>>
    edit:                ReturnType<typeof mock<(messageId: string, options: unknown) => Promise<unknown>>>
    send:                ReturnType<typeof mock<(options: unknown) => Promise<unknown>>>
    ready:               { value: boolean }
    cardEdits:           ApprovalCardEditGate
    markOutcomeNotified: ReturnType<typeof mock<(action: ApprovedOutboundAction) => Promise<boolean>>>
    markAdminNotified:   ReturnType<typeof mock<(action: ApprovedOutboundAction, message?: ApprovalCardRef) => Promise<void>>>
    getAdminPing:        ReturnType<typeof mock<(id: string) => Promise<AdminPing | undefined>>>
    get:                 ReturnType<typeof mock<(id: string) => Promise<ApprovedOutboundAction | undefined>>>
}

function makeHarness(): Harness {
    const edit = mock(async (_messageId: string, _options: unknown): Promise<unknown> => ({ url: CARD_URL }));
    const send = mock(async (_options: unknown): Promise<unknown> => ({ channelId: PING.channelId, id: PING.messageId }));
    const channel = { isTextBased: () => true, isSendable: () => true, messages: { edit }, send } as unknown as Channel;
    const fetchChannel = mock(async (_channelId: ChannelId): Promise<Channel | null> => channel);
    const notify = mock((_params: NotifyParams): boolean => true);
    const ready = { value: true };
    const cardEdits = new ApprovalCardEditGate();
    const markOutcomeNotified = mock(async (_action: ApprovedOutboundAction): Promise<boolean> => true);
    const markAdminNotified = mock(async (_action: ApprovedOutboundAction, _message?: ApprovalCardRef): Promise<void> => undefined);
    const getAdminPing = mock(async (_id: string): Promise<AdminPing | undefined> => undefined);
    const get = mock(async (_id: string): Promise<ApprovedOutboundAction | undefined> => undefined);
    const deliver = createApprovedActionOutcomeDelivery({
        fetchChannel,
        isDiscordReady: () => ready.value,
        notify,
        backend:        { markOutcomeNotified, markAdminNotified, getAdminPing, get },
        cardEdits,
        adminChannelId: ADMIN_CHANNEL,
        adminUserId:    ADMIN_USER,
    });
    return { deliver, notify, fetchChannel, edit, send, ready, cardEdits, markOutcomeNotified, markAdminNotified, getAdminPing, get };
}

function editedEmbeds(h: Harness): unknown[] {
    const options = h.edit.mock.calls[0]?.[1] as { embeds: { toJSON: () => unknown }[] };
    return options.embeds.map(embed => embed.toJSON());
}

describe('createApprovedActionOutcomeDelivery', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('notifies Izzy with the described source, key, text and wake', async () => {
        const h = makeHarness();

        await h.deliver(row());

        expect(h.notify.mock.calls).toEqual([[{
            source: 'email-approval',
            key:    `${ID}:executed:${REVISION}`,
            text:   'Outbound email (uid 42) was sent.',
            wake:   true,
        }]]);
    });

    test('edits the approval card with the green sent embed and no components', async () => {
        const h = makeHarness();

        expect(await h.deliver(row())).toBe(true);

        expect(h.fetchChannel.mock.calls).toEqual([['admin-ch' as ChannelId]]);
        expect(h.edit).toHaveBeenCalledTimes(1);
        expect(h.edit.mock.calls[0]?.[0]).toBe('card-msg');
        expect((h.edit.mock.calls[0]?.[1] as { components: unknown[] }).components).toEqual([]);
        // Strict: a sent card has no description key at all.
        expect(editedEmbeds(h)).toStrictEqual([{ title: 'Sent ✓', color: 0x00_AA_00 }]);
        // An ordinary outcome on a card neither re-reads the row nor looks for an admin ping.
        expect(h.get).not.toHaveBeenCalled();
        expect(h.getAdminPing).not.toHaveBeenCalled();
    });

    test('holds the card while editing it, so another exclusive writer waits for the edit', async () => {
        const h = makeHarness();
        let finishEdit!: () => void;
        h.edit.mockImplementation(async () => new Promise((resolve) => {
            finishEdit = () => resolve({ url: CARD_URL });
        }));

        const delivery = h.deliver(row());
        for(let turn = 0; turn < 10; turn++) {
            // eslint-disable-next-line no-await-in-loop -- drain the delivery's microtask hops up to the pending edit.
            await Promise.resolve();
        }
        expect(h.edit).toHaveBeenCalledTimes(1);
        expect(h.cardEdits.pendingEdit('card-msg')).toBeDefined();

        finishEdit();
        expect(await delivery).toBe(true);
        expect(h.cardEdits.pendingEdit('card-msg')).toBeUndefined();
    });

    test('releases the card when Discord is not ready', async () => {
        const h = makeHarness();
        h.ready.value = false;

        expect(await h.deliver(row())).toBe(false);
        expect(h.cardEdits.pendingEdit('card-msg')).toBeUndefined();
    });

    test('shows a transient failure on the card in amber with the error', async () => {
        const h = makeHarness();

        await h.deliver(row({ state: 'failed', lastError: 'socket hang up', failureKind: 'transient' }));

        expect(editedEmbeds(h)).toEqual([{ title: 'Send failed — will retry when email reconnects', description: 'socket hang up', color: 0xFF_AA_00 }]);
    });

    test('shows a permanent failure on the card in red with the error', async () => {
        const h = makeHarness();

        await h.deliver(row({ state: 'failed', lastError: 'uid not found', failureKind: 'permanent' }));

        expect(editedEmbeds(h)).toEqual([{ title: 'Send failed — will not be retried', description: 'uid not found', color: 0xFF_00_00 }]);
    });

    test('skips the card edit when the row has no approvalCard and still reports delivery', async () => {
        const h = makeHarness();
        const { approvalCard: _card, ...legacy } = row();

        expect(await h.deliver(legacy)).toBe(true);

        expect(h.fetchChannel).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(h.getAdminPing.mock.calls).toEqual([[ID]]);
    });

    test('draws a card-less row\'s outcome on the admin ping that carried its controls, clearing them', async () => {
        const h = makeHarness();
        h.getAdminPing.mockImplementation(async () => ({ message: PING }));
        const { approvalCard: _card, ...legacy } = row();

        expect(await h.deliver(legacy)).toBe(true);

        expect(h.fetchChannel.mock.calls).toEqual([[PING.channelId as ChannelId]]);
        expect(h.edit.mock.calls[0]?.[0]).toBe(PING.messageId);
        expect((h.edit.mock.calls[0]?.[1] as { components: unknown[] }).components).toEqual([]);
        expect(editedEmbeds(h)).toStrictEqual([{ title: 'Sent ✓', color: 0x00_AA_00 }]);
    });

    test('reports undelivered when Izzy could not be told, even though the card was updated', async () => {
        const h = makeHarness();
        h.notify.mockImplementation(() => false);

        expect(await h.deliver(row())).toBe(false);
        expect(h.edit).toHaveBeenCalledTimes(1);
    });

    test('reports undelivered without touching Discord while Discord is not ready, and still notifies', async () => {
        const h = makeHarness();
        h.ready.value = false;

        expect(await h.deliver(row())).toBe(false);
        expect(h.fetchChannel).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenCalledTimes(1);
    });

    test('an outcome left undelivered while Discord was down is delivered once Discord is back', async () => {
        const h = makeHarness();
        h.ready.value = false;
        expect(await h.deliver(row())).toBe(false);

        h.ready.value = true;
        expect(await h.deliver(row({ outcomeNotified: true }))).toBe(true);
        expect(h.edit).toHaveBeenCalledTimes(1);
        expect(h.notify.mock.calls.map(([params]) => params.key)).toEqual([`${ID}:executed:${REVISION}`]);
        expect(h.markOutcomeNotified.mock.calls).toEqual([[row()]]);
    });

    test('a notification refused by the conductor is delivered on a later attempt with the same key', async () => {
        const h = makeHarness();
        h.notify.mockImplementationOnce(() => false);
        expect(await h.deliver(row())).toBe(false);

        expect(await h.deliver(row())).toBe(true);
        expect(h.notify.mock.calls.map(([params]) => params.key)).toEqual([`${ID}:executed:${REVISION}`, `${ID}:executed:${REVISION}`]);
    });

    test('persists notification acceptance before editing the card', async () => {
        const h = makeHarness();
        const events: string[] = [];
        h.markOutcomeNotified.mockImplementation(async () => {
            events.push('persist');
            return true;
        });
        h.edit.mockImplementation(async () => {
            events.push('edit');
            return {};
        });
        expect(await h.deliver(row())).toBe(true);
        expect(events).toEqual(['persist', 'edit']);
    });

    test('does not persist a refused notification and retries it later', async () => {
        const h = makeHarness();
        h.notify.mockImplementationOnce(() => false);
        expect(await h.deliver(row())).toBe(false);
        expect(h.markOutcomeNotified).not.toHaveBeenCalled();
        expect(await h.deliver(row())).toBe(true);
        expect(h.notify).toHaveBeenCalledTimes(2);
        expect(h.markOutcomeNotified.mock.calls).toEqual([[row()]]);
    });

    test('a stale marker write skips the stale card edit and leaves the report pending', async () => {
        const h = makeHarness();
        h.markOutcomeNotified.mockImplementation(async () => false);
        expect(await h.deliver(row())).toBe(false);
        expect(h.edit).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenCalledTimes(1);
    });

    test('a failed marker write leaves the report retryable without editing the card', async () => {
        const h = makeHarness();
        h.markOutcomeNotified.mockImplementation(async () => {
            throw new Error('ddb unavailable');
        });
        await expect(h.deliver(row())).rejects.toThrow('ddb unavailable');
        expect(h.edit).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenCalledTimes(1);
    });

    test('a restarted reporter and fresh bridge retry only the card then clear both markers', async () => {
        let persisted = row();
        const first = makeHarness();
        first.markOutcomeNotified.mockImplementation(async () => {
            persisted = { ...persisted, outcomeNotified: true };
            return true;
        });
        first.ready.value = false;
        const second = makeHarness();
        second.markOutcomeNotified.mockImplementation(async () => {
            throw new Error('must not mark twice');
        });
        const markOutcomeReported = mock(async () => {
            persisted = { ...persisted, outcomeReportPending: undefined, outcomeNotified: undefined };
            return true;
        });
        const backend: Pick<ApprovedOutboundActionBackend, 'listOutcomeReportWork' | 'escalate' | 'markOutcomeReported'> = {
            listOutcomeReportWork: mock(async () => (persisted.outcomeReportPending ? [persisted] : [])),
            escalate:              mock(async () => undefined),
            markOutcomeReported,
        };
        const logger = { warn: mock(() => undefined), info: mock(() => undefined), debug: mock(() => undefined), error: mock(() => undefined) } satisfies ServiceLogger;
        expect(await createApprovedActionOutcomeReporter({ backend, deliver: first.deliver, logger }).reportOnce()).toEqual({ delivered: 0, pending: 1 });
        expect(persisted).toEqual(row({ outcomeNotified: true }));
        expect(await createApprovedActionOutcomeReporter({ backend, deliver: second.deliver, logger }).reportOnce()).toEqual({ delivered: 1, pending: 0 });
        expect(first.notify).toHaveBeenCalledTimes(1);
        expect(second.notify).not.toHaveBeenCalled();
        expect(first.edit).not.toHaveBeenCalled();
        expect(second.edit).toHaveBeenCalledTimes(1);
        expect(backend.markOutcomeReported).toHaveBeenCalledWith(row({ outcomeNotified: true }));
        expect(persisted.outcomeReportPending).toBeUndefined();
        expect(persisted.outcomeNotified).toBeUndefined();
    });

    test('a persisted notification skips fresh bridge notification but edits the card', async () => {
        const fresh = makeHarness();
        expect(await fresh.deliver(row({ outcomeNotified: true }))).toBe(true);
        expect(fresh.notify).not.toHaveBeenCalled();
        expect(fresh.markOutcomeNotified).not.toHaveBeenCalled();
        expect(fresh.edit).toHaveBeenCalledTimes(1);
    });

    test('a later revision notifies again despite the earlier revision having been recorded', async () => {
        const h = makeHarness();
        expect(await h.deliver(row({ outcomeNotified: true }))).toBe(true);
        expect(await h.deliver(row({ state: 'failed', failureKind: 'permanent', updatedAt: '2026-09-24T12:01:00.000Z' }))).toBe(true);
        expect(h.notify.mock.calls.map(([params]) => params.key)).toEqual([`${ID}:failed:2026-09-24T12:01:00.000Z`]);
        expect(h.markOutcomeNotified.mock.calls).toEqual([[row({ state: 'failed', failureKind: 'permanent', updatedAt: '2026-09-24T12:01:00.000Z' })]]);
    });

    test('logs a warning and gives up on the card when its channel is unavailable', async () => {
        const h = makeHarness();
        h.fetchChannel.mockImplementation(async () => null);

        expect(await h.deliver(row())).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            actionId:  ID,
            channelId: 'admin-ch',
            msg:       'Approval card channel unavailable — outcome not shown on card',
        });
    });

    test('logs a warning and gives up on the card when its channel is not text-based', async () => {
        const h = makeHarness();
        h.fetchChannel.mockImplementation(async () => ({ isTextBased: () => false }) as unknown as Channel);

        expect(await h.deliver(row())).toBe(true);
        expect(h.edit).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            actionId:  ID,
            channelId: 'admin-ch',
            msg:       'Approval card channel unavailable — outcome not shown on card',
        });
    });

    test('leaves the card for a later pass when the channel lookup fails transiently', async () => {
        const h = makeHarness();
        const failure = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        h.fetchChannel.mockImplementation(async () => {
            throw failure;
        });

        expect(await h.deliver(row())).toBe(false);
        expect(h.edit).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            err:      failure,
            actionId: ID,
            msg:      'Failed to update approval card with the outbound action outcome — will retry',
        });
    });

    test('gives up on the card when the channel lookup fails permanently', async () => {
        const h = makeHarness();
        const failure = new Error('Unknown Channel');
        h.fetchChannel.mockImplementation(async () => {
            throw failure;
        });

        expect(await h.deliver(row())).toBe(true);
        expect(h.edit).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            err:      failure,
            actionId: ID,
            msg:      'Approval card cannot be updated with the outbound action outcome — giving up on the card',
        });
    });

    test('waits for an in-flight pending-card edit on the same card before looking up the channel', async () => {
        const h = makeHarness();
        const release = h.cardEdits.hold('card-msg');

        const delivery = h.deliver(row());
        await Promise.resolve();
        await Promise.resolve();
        expect(h.fetchChannel).not.toHaveBeenCalled();
        expect(h.edit).not.toHaveBeenCalled();

        release();
        expect(await delivery).toBe(true);
        expect(h.edit).toHaveBeenCalledTimes(1);
    });

    test('does not wait for a hold on a different card', async () => {
        const h = makeHarness();
        const release = h.cardEdits.hold('other-card');

        expect(await h.deliver(row())).toBe(true);
        expect(h.edit).toHaveBeenCalledTimes(1);
        release();
    });

    test('logs a warning and gives up on the card when the edit fails permanently', async () => {
        const h = makeHarness();
        const failure = new Error('Unknown Message');
        h.edit.mockImplementation(async () => {
            throw failure;
        });

        expect(await h.deliver(row())).toBe(true);
        expect(h.edit).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            err:      failure,
            actionId: ID,
            msg:      'Approval card cannot be updated with the outbound action outcome — giving up on the card',
        });
    });

    test('logs a warning and leaves the card for a later pass when the edit fails transiently', async () => {
        // withDiscordRetry is replaced by a single-attempt mock in tests/setup, so this is the
        // error that survived its retries in production.
        const h = makeHarness();
        const failure = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        h.edit.mockImplementation(async () => {
            throw failure;
        });

        expect(await h.deliver(row())).toBe(false);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            err:      failure,
            actionId: ID,
            msg:      'Failed to update approval card with the outbound action outcome — will retry',
        });
    });

    test('still notifies when the card edit fails', async () => {
        const h = makeHarness();
        h.edit.mockImplementation(async () => {
            throw new Error('boom');
        });

        await h.deliver(row());

        expect(h.notify).toHaveBeenCalledTimes(1);
    });

    test('a Bluesky reply outcome is notified without waking and shown as posted', async () => {
        const h = makeHarness();

        await h.deliver(row({ type: 'bsky_reply', params: { text: 'Thanks!' } }));

        expect(h.notify.mock.calls[0]?.[0]).toEqual({
            source: 'bsky-approval',
            key:    `${ID}:executed:${REVISION}`,
            text:   'Bluesky reply "Thanks!" was posted.',
            wake:   false,
        });
        expect(editedEmbeds(h)).toStrictEqual([{ title: 'Posted ✓', color: 0x00_AA_00 }]);
    });

    describe('an escalated unknown outcome (#125)', () => {
        const ESCALATED = row({ state: 'unverified', lastError: 'fetch failed', outcomeNotified: true, escalated: true });
        const ALERT = 'Outbound email (uid 42): outcome still unknown after 24 h. Still checking Sent Mail; press Mark sent if you know it arrived, or Resend to send it again.';
        const CONTROLS = [{
            type:       1,
            components: [
                { type: 2, style: 3, label: 'Mark sent', custom_id: `approved-action-mark-sent:${ID}:${REVISION}` },
                { type: 2, style: 4, label: 'Resend', custom_id: `approved-action-resend:${ID}:${REVISION}` },
            ],
        }];

        function componentsJson(options: unknown): unknown[] {
            return (options as { components: { toJSON: () => unknown }[] }).components.map(component => component.toJSON());
        }

        /** A harness whose row is still at the escalated episode when the card is redrawn. */
        function escalatedHarness(): Harness {
            const h = makeHarness();
            h.get.mockImplementation(async () => ESCALATED);
            return h;
        }

        test('redraws the card in amber with Mark sent and Resend buttons bound to the episode revision', async () => {
            const h = escalatedHarness();

            expect(await h.deliver(ESCALATED)).toBe(true);

            expect(editedEmbeds(h)).toEqual([{ title: 'Outcome still unknown after 24 h — still checking Sent Mail; Mark sent or Resend below', description: 'fetch failed', color: 0xFF_AA_00 }]);
            expect(componentsJson(h.edit.mock.calls[0]?.[1])).toEqual(CONTROLS);
            expect(h.get.mock.calls).toEqual([[ID]]);
            expect(h.getAdminPing.mock.calls).toEqual([[ID]]);
        });

        test('re-reads the row only once it holds the card, after an admin click on it released it', async () => {
            const h = escalatedHarness();
            const releaseClick = h.cardEdits.hold('card-msg');

            const delivery = h.deliver(ESCALATED);
            for(let turn = 0; turn < 10; turn++) {
                // eslint-disable-next-line no-await-in-loop -- drain the delivery's microtask hops up to the held card.
                await Promise.resolve();
            }
            expect(h.get).not.toHaveBeenCalled();

            h.get.mockImplementation(async () => ({ ...ESCALATED, state: 'approved', updatedAt: '2026-09-25T12:00:00.000Z' }));
            releaseClick();
            expect(await delivery).toBe(false);
            expect(h.edit).not.toHaveBeenCalled();
            expect(h.send).not.toHaveBeenCalled();
        });

        test('does not redraw a card whose row left the unknown state, even at the same revision', async () => {
            const h = escalatedHarness();
            h.get.mockImplementation(async () => ({ ...ESCALATED, state: 'executed' }));

            expect(await h.deliver(ESCALATED)).toBe(false);
            expect(h.fetchChannel).not.toHaveBeenCalled();
            expect(h.cardEdits.pendingEdit('card-msg')).toBeUndefined();
        });

        test('does not redraw a card whose row is unknown again in a later episode', async () => {
            const h = escalatedHarness();
            h.get.mockImplementation(async () => ({ ...ESCALATED, updatedAt: '2026-09-25T12:00:00.000Z' }));

            expect(await h.deliver(ESCALATED)).toBe(false);
            expect(h.edit).not.toHaveBeenCalled();
        });

        test('does not redraw a card whose row is gone', async () => {
            const h = makeHarness();

            expect(await h.deliver(ESCALATED)).toBe(false);
            expect(h.edit).not.toHaveBeenCalled();
        });

        test('a failed re-read rejects the delivery without touching Discord, and releases the card', async () => {
            const h = makeHarness();
            h.get.mockImplementation(async () => {
                throw new Error('throughput exceeded');
            });

            await expect(h.deliver(ESCALATED)).rejects.toThrow('throughput exceeded');
            expect(h.fetchChannel).not.toHaveBeenCalled();
            expect(h.cardEdits.pendingEdit('card-msg')).toBeUndefined();
        });

        test('pings the admin even while Izzy has not taken the interim notification, and leaves the report pending', async () => {
            const h = escalatedHarness();
            h.notify.mockImplementation(() => false);

            expect(await h.deliver({ ...ESCALATED, outcomeNotified: undefined })).toBe(false);
            expect(h.edit).toHaveBeenCalledTimes(1);
            expect(h.send).toHaveBeenCalledTimes(1);
        });

        test('waits for the admin ping even when Izzy refused the interim notification', async () => {
            const h = escalatedHarness();
            const sendDone = Promise.withResolvers<unknown>();
            h.send.mockImplementation(() => sendDone.promise);
            h.notify.mockImplementation(() => false);
            let settled = false;
            const delivery = h.deliver({ ...ESCALATED, outcomeNotified: undefined }).then((result) => {
                settled = true;
                return result;
            });
            for(let turn = 0; turn < 20; turn++) {
                // eslint-disable-next-line no-await-in-loop -- drain delivery's microtask hops up to the pending send.
                await Promise.resolve();
            }
            expect(h.send).toHaveBeenCalledTimes(1);
            expect(settled).toBe(false);
            expect(h.markAdminNotified).not.toHaveBeenCalled();

            sendDone.resolve({ channelId: PING.channelId, id: PING.messageId });
            expect(await delivery).toBe(false);
            expect(h.markAdminNotified).toHaveBeenCalledTimes(1);
        });

        test('then pings only the admin once, linking the card, records the ping and does not tell Izzy again', async () => {
            const h = escalatedHarness();
            const events: string[] = [];
            h.edit.mockImplementation(async () => {
                events.push('edit');
                return { url: CARD_URL };
            });
            h.send.mockImplementation(async () => {
                events.push('ping');
                return {};
            });

            expect(await h.deliver(ESCALATED)).toBe(true);

            expect(events).toEqual(['edit', 'ping']);
            expect(h.fetchChannel.mock.calls).toEqual([['admin-ch' as ChannelId], [ADMIN_CHANNEL]]);
            expect(h.send.mock.calls).toEqual([[{
                content:         `<@${ADMIN_USER}> ${ALERT}\n${CARD_URL}`,
                allowedMentions: { users: [ADMIN_USER] },
                components:      [],
            }]]);
            expect(h.markAdminNotified.mock.calls).toEqual([[ESCALATED, undefined]]);
            expect(h.notify).not.toHaveBeenCalled();
        });

        test('a row already pinged in an earlier episode only regains the controls', async () => {
            const h = escalatedHarness();
            h.getAdminPing.mockImplementation(async () => ({}));

            expect(await h.deliver(ESCALATED)).toBe(true);

            expect(componentsJson(h.edit.mock.calls[0]?.[1])).toEqual(CONTROLS);
            expect(h.send).not.toHaveBeenCalled();
            expect(h.markAdminNotified).not.toHaveBeenCalled();
        });

        test('a row with no card carries the controls on the ping itself, and records the ping as their message', async () => {
            const h = makeHarness();
            const { approvalCard: _card, ...cardless } = ESCALATED;

            expect(await h.deliver(cardless)).toBe(true);

            expect(h.edit).not.toHaveBeenCalled();
            expect(h.fetchChannel.mock.calls).toEqual([[ADMIN_CHANNEL]]);
            const options = h.send.mock.calls[0]?.[0] as { content: string, allowedMentions: unknown };
            expect(options.content).toBe(`<@${ADMIN_USER}> ${ALERT}`);
            expect(options.allowedMentions).toEqual({ users: [ADMIN_USER] });
            expect(componentsJson(options)).toEqual(CONTROLS);
            expect(h.markAdminNotified.mock.calls).toEqual([[cardless, PING]]);
        });

        test('a card-less row pinged in an earlier episode regains the controls on that ping, without a second ping', async () => {
            const h = escalatedHarness();
            h.getAdminPing.mockImplementation(async () => ({ message: PING }));
            const { approvalCard: _card, ...cardless } = ESCALATED;

            expect(await h.deliver(cardless)).toBe(true);

            expect(h.fetchChannel.mock.calls).toEqual([[PING.channelId as ChannelId]]);
            expect(h.edit.mock.calls[0]?.[0]).toBe(PING.messageId);
            expect(componentsJson(h.edit.mock.calls[0]?.[1])).toEqual(CONTROLS);
            expect(h.send).not.toHaveBeenCalled();
            expect(h.markAdminNotified).not.toHaveBeenCalled();
        });

        test('a card that can never be edited moves the controls onto the ping', async () => {
            const h = escalatedHarness();
            h.edit.mockImplementation(async () => {
                throw new Error('Unknown Message');
            });

            expect(await h.deliver(ESCALATED)).toBe(true);

            const options = h.send.mock.calls[0]?.[0] as { content: string };
            expect(options.content).toBe(`<@${ADMIN_USER}> ${ALERT}`);
            expect(componentsJson(options)).toEqual(CONTROLS);
            expect(h.markAdminNotified.mock.calls).toEqual([[ESCALATED, PING]]);
        });

        test('sends no ping while the card edit is left for a later pass', async () => {
            const h = escalatedHarness();
            h.edit.mockImplementation(async () => {
                throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
            });

            expect(await h.deliver(ESCALATED)).toBe(false);
            expect(h.send).not.toHaveBeenCalled();
        });

        test('sends no ping for a card-less row while Discord is not ready', async () => {
            const h = makeHarness();
            h.ready.value = false;
            const { approvalCard: _card, ...cardless } = ESCALATED;

            expect(await h.deliver(cardless)).toBe(false);
            expect(h.fetchChannel).not.toHaveBeenCalled();
        });

        test('a transient ping failure is retried later and the ping is not recorded', async () => {
            const h = escalatedHarness();
            const failure = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
            h.send.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.deliver(ESCALATED)).toBe(false);
            expect(h.markAdminNotified).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, actionId: ID, msg: 'Failed to ping the admin about an outcome still unknown — will retry' });
        });

        test('a permanent ping failure is logged and given up without recording a ping', async () => {
            const h = escalatedHarness();
            const failure = new Error('Missing Access');
            h.send.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.deliver(ESCALATED)).toBe(true);
            expect(h.markAdminNotified).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, actionId: ID, msg: 'Admin cannot be pinged about an outcome still unknown — giving up on the ping' });
        });

        test('an admin channel that cannot take messages is logged and given up', async () => {
            const h = escalatedHarness();
            const card = await h.fetchChannel('admin-ch' as ChannelId);
            h.fetchChannel.mockClear();
            h.fetchChannel.mockImplementation(async channelId => (channelId === ADMIN_CHANNEL ? ({ isSendable: () => false }) as unknown as Channel : card));

            expect(await h.deliver(ESCALATED)).toBe(true);
            expect(h.send).not.toHaveBeenCalled();
            expect(h.markAdminNotified).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ actionId: ID, channelId: ADMIN_CHANNEL, msg: 'Admin channel unavailable — escalation ping not sent' });
        });

        test('a missing admin channel is logged and given up', async () => {
            const h = escalatedHarness();
            const card = await h.fetchChannel('admin-ch' as ChannelId);
            h.fetchChannel.mockClear();
            h.fetchChannel.mockImplementation(async channelId => (channelId === ADMIN_CHANNEL ? null : card));

            expect(await h.deliver(ESCALATED)).toBe(true);
            expect(h.markAdminNotified).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith({ actionId: ID, channelId: ADMIN_CHANNEL, msg: 'Admin channel unavailable — escalation ping not sent' });
        });

        test('a failed ping record rejects the delivery, leaving the report to retry', async () => {
            const h = escalatedHarness();
            h.markAdminNotified.mockImplementation(async () => {
                throw new Error('throughput exceeded');
            });

            await expect(h.deliver(ESCALATED)).rejects.toThrow('throughput exceeded');
            expect(h.send).toHaveBeenCalledTimes(1);
        });
    });
});
