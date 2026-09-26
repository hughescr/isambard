import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { mockLogger } from '../../../../setup';
import { ApprovalCardEditGate, approvalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import { ApprovedActionEscalationHandler } from '@/integrations/discord/approvals/escalation-interaction-handler';
import type { ApprovedOutboundAction } from '@/services';

const ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const REVISION = '2026-09-24T12:00:00.000Z';
const ADMIN = '1234567890';

const ESCALATED: ApprovedOutboundAction = {
    id:           ID,
    state:        'unverified',
    type:         'email_send',
    params:       { uid: 42 },
    lastError:    'fetch failed',
    approvalCard: { channelId: '111', messageId: '222' },
    escalated:    true,
    createdAt:    '2026-09-23T11:00:00.000Z',
    updatedAt:    REVISION,
};

type Get = (id: string) => Promise<ApprovedOutboundAction | undefined>;
type Resolve = (action: ApprovedOutboundAction, to: 'executed' | 'approved', resolvedBy?: 'admin') => Promise<ApprovedOutboundAction | undefined>;

interface Harness {
    handler:      ApprovedActionEscalationHandler
    get:          ReturnType<typeof mock<Get>>
    resolve:      ReturnType<typeof mock<Resolve>>
    wakeReporter: ReturnType<typeof mock<() => void>>
    wakeExecutor: ReturnType<typeof mock<() => void>>
    cardEdits:    ApprovalCardEditGate
}

function makeHarness(): Harness {
    let stored: ApprovedOutboundAction | undefined = ESCALATED;
    const get = mock<Get>(async () => stored);
    const resolve = mock<Resolve>(async (action, to, resolvedBy) => {
        const { escalated: _escalated, ...rest } = action;
        stored = { ...rest, state: to, updatedAt: '2026-09-25T13:00:00.000Z', ...(to === 'executed' ? { outcomeReportPending: true } : {}), ...(resolvedBy === undefined ? {} : { resolvedBy }) };
        return stored;
    });
    const wakeReporter = mock(() => undefined);
    const wakeExecutor = mock(() => undefined);
    const cardEdits = new ApprovalCardEditGate();
    const handler = new ApprovedActionEscalationHandler({
        backend:     { get, resolveUnverified: resolve },
        adminUserId: ADMIN,
        wakeReporter,
        wakeExecutor,
        cardEdits,
    });
    return { handler, get, resolve, wakeReporter, wakeExecutor, cardEdits };
}

interface FakeInteraction {
    interaction: ButtonInteraction
    reply:       ReturnType<typeof mock<(options: unknown) => Promise<unknown>>>
    update:      ReturnType<typeof mock<(options: unknown) => Promise<unknown>>>
}

function click(customId: string, userId = ADMIN): FakeInteraction {
    const reply = mock(async (_options: unknown): Promise<unknown> => ({}));
    const update = mock(async (_options: unknown): Promise<unknown> => ({}));
    const interaction = { customId, user: { id: userId }, message: { id: 'card-msg' }, reply, update } as unknown as ButtonInteraction;
    return { interaction, reply, update };
}

function updatedTo(fake: FakeInteraction): unknown {
    const options = fake.update.mock.calls[0]?.[0] as { embeds: { toJSON: () => unknown }[], components: unknown[] };
    return { embeds: options.embeds.map(embed => embed.toJSON()), components: options.components };
}

const MARK_SENT = `approved-action-mark-sent:${ID}:${REVISION}`;
const RESEND = `approved-action-resend:${ID}:${REVISION}`;
const STALE = { content: 'This action has already moved on — nothing was changed.', flags: MessageFlags.Ephemeral };

describe('ApprovedActionEscalationHandler', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('refuses anyone but the admin privately, before reading or writing anything', async () => {
        const h = makeHarness();
        const fake = click(RESEND, '999');

        await h.handler.handleButton(fake.interaction);

        expect(fake.reply.mock.calls).toEqual([[{ content: 'Only the admin can resolve this action.', flags: MessageFlags.Ephemeral }]]);
        expect(h.get).not.toHaveBeenCalled();
        expect(h.resolve).not.toHaveBeenCalled();
        expect(h.wakeExecutor).not.toHaveBeenCalled();
    });

    test('refuses a malformed button id privately, without reading the row', async () => {
        const h = makeHarness();
        const fake = click('garbage');

        await h.handler.handleButton(fake.interaction);

        expect(fake.reply.mock.calls).toEqual([[{ content: 'This button is not recognised.', flags: MessageFlags.Ephemeral }]]);
        expect(h.get).not.toHaveBeenCalled();
    });

    test('refuses a button with no revision privately, without reading the row', async () => {
        const h = makeHarness();
        const fake = click(`approved-action-resend:${ID}`);

        await h.handler.handleButton(fake.interaction);

        expect(fake.reply.mock.calls).toEqual([[{ content: 'This button is not recognised.', flags: MessageFlags.Ephemeral }]]);
        expect(h.get).not.toHaveBeenCalled();
    });

    test('Mark sent resolves the current episode as executed by the admin, never sends, and shows it on the card', async () => {
        const h = makeHarness();
        const fake = click(MARK_SENT);

        await h.handler.handleButton(fake.interaction);

        expect(h.get.mock.calls).toEqual([[ID]]);
        expect(h.resolve.mock.calls).toEqual([[ESCALATED, 'executed', 'admin']]);
        expect(updatedTo(fake)).toEqual({ embeds: [{ title: 'Marked sent by admin — not confirmed in Sent Mail', color: 0x00_AA_00 }], components: [] });
        expect(h.wakeReporter).toHaveBeenCalledTimes(1);
        expect(h.wakeExecutor).not.toHaveBeenCalled();
        expect(fake.reply).not.toHaveBeenCalled();
    });

    test('Resend resets the current episode to approved for the executor to claim and send, and clears the dead buttons', async () => {
        const h = makeHarness();
        const fake = click(RESEND);

        await h.handler.handleButton(fake.interaction);

        expect(h.resolve.mock.calls).toEqual([[ESCALATED, 'approved']]);
        expect(updatedTo(fake)).toEqual({ embeds: [{ title: 'Resend authorised by admin — sending again…', color: 0x58_65_F2 }], components: [] });
        expect(h.wakeExecutor).toHaveBeenCalledTimes(1);
        expect(h.wakeReporter).not.toHaveBeenCalled();
    });

    test('a double click resolves once; the second click finds the episode moved on', async () => {
        const h = makeHarness();
        const first = click(RESEND);
        const second = click(RESEND);

        await h.handler.handleButton(first.interaction);
        await h.handler.handleButton(second.interaction);

        expect(h.resolve).toHaveBeenCalledTimes(1);
        expect(h.wakeExecutor).toHaveBeenCalledTimes(1);
        expect(second.reply.mock.calls).toEqual([[STALE]]);
        expect(second.update).not.toHaveBeenCalled();
    });

    test('a button from an earlier episode changes nothing', async () => {
        const h = makeHarness();
        const fake = click(`approved-action-mark-sent:${ID}:2026-09-20T00:00:00.000Z`);

        await h.handler.handleButton(fake.interaction);

        expect(h.resolve).not.toHaveBeenCalled();
        expect(fake.reply.mock.calls).toEqual([[STALE]]);
        expect(h.wakeReporter).not.toHaveBeenCalled();
    });

    test('a row a check already decided changes nothing, even at the same revision', async () => {
        const h = makeHarness();
        h.get.mockImplementation(async () => ({ ...ESCALATED, state: 'executed' }));
        const fake = click(RESEND);

        await h.handler.handleButton(fake.interaction);

        expect(h.resolve).not.toHaveBeenCalled();
        expect(fake.reply.mock.calls).toEqual([[STALE]]);
    });

    test('a row that no longer exists changes nothing', async () => {
        const h = makeHarness();
        h.get.mockImplementation(async () => undefined);
        const fake = click(RESEND);

        await h.handler.handleButton(fake.interaction);

        expect(h.resolve).not.toHaveBeenCalled();
        expect(fake.reply.mock.calls).toEqual([[STALE]]);
    });

    test('losing the conditional write to a check that just decided sends nothing and wakes nothing', async () => {
        const h = makeHarness();
        h.resolve.mockImplementation(async () => undefined);
        const fake = click(RESEND);

        await h.handler.handleButton(fake.interaction);

        expect(fake.reply.mock.calls).toEqual([[STALE]]);
        expect(fake.update).not.toHaveBeenCalled();
        expect(h.wakeExecutor).not.toHaveBeenCalled();
    });

    test('a database failure is logged, reported privately and never taken as authority to send', async () => {
        const h = makeHarness();
        const failure = new Error('throughput exceeded');
        h.resolve.mockImplementation(async () => {
            throw failure;
        });
        const fake = click(RESEND);

        await h.handler.handleButton(fake.interaction);

        expect(mockLogger.error).toHaveBeenCalledWith({ err: failure, actionId: ID, msg: 'Approved action escalation button could not be recorded' });
        expect(fake.reply.mock.calls).toEqual([[{ content: 'Could not record that — nothing was changed. Please try again.', flags: MessageFlags.Ephemeral }]]);
        expect(fake.update).not.toHaveBeenCalled();
        expect(h.wakeExecutor).not.toHaveBeenCalled();
    });

    test('a failed card update after the decision is recorded is only logged, and the decision still takes effect', async () => {
        const h = makeHarness();
        const failure = new Error('Unknown interaction');
        const fake = click(RESEND);
        fake.update.mockImplementation(async () => {
            throw failure;
        });

        await h.handler.handleButton(fake.interaction);

        expect(h.wakeExecutor).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, actionId: ID, msg: 'Failed to show the admin decision on the card — the next outcome will replace it' });
        expect(fake.reply).not.toHaveBeenCalled();
    });

    test('holds the card while deciding, so an outcome edit waits for the admin decision to show, then releases it', async () => {
        const h = makeHarness();
        const read = Promise.withResolvers<ApprovedOutboundAction | undefined>();
        h.get.mockImplementation(async () => read.promise);
        const fake = click(RESEND);

        const handled = h.handler.handleButton(fake.interaction);
        await Promise.resolve();
        expect(h.cardEdits.pendingEdit('card-msg')).toBeDefined();

        read.resolve(ESCALATED);
        await handled;
        expect(h.cardEdits.pendingEdit('card-msg')).toBeUndefined();
    });

    test('waits for an outcome edit already holding the card before reading the row, so its decision is drawn last', async () => {
        const h = makeHarness();
        const releaseOutcomeEdit = h.cardEdits.hold('card-msg');
        const fake = click(RESEND);

        const handled = h.handler.handleButton(fake.interaction);
        for(let turn = 0; turn < 10; turn++) {
            // eslint-disable-next-line no-await-in-loop -- drain the click's microtask hops up to the held card.
            await Promise.resolve();
        }
        expect(h.get).not.toHaveBeenCalled();
        expect(fake.update).not.toHaveBeenCalled();

        releaseOutcomeEdit();
        await handled;
        expect(h.get).toHaveBeenCalledTimes(1);
        expect(fake.update).toHaveBeenCalledTimes(1);
    });

    test('holds the card on the process-wide gate the outcome delivery waits on by default', async () => {
        const read = Promise.withResolvers<ApprovedOutboundAction | undefined>();
        const handler = new ApprovedActionEscalationHandler({
            backend:      { get: async () => read.promise, resolveUnverified: async () => undefined },
            adminUserId:  ADMIN,
            wakeReporter: () => undefined,
            wakeExecutor: () => undefined,
        });

        const handled = handler.handleButton(click(RESEND).interaction);
        await Promise.resolve();
        expect(approvalCardEditGate.pendingEdit('card-msg')).toBeDefined();

        read.resolve(undefined);
        await handled;
        expect(approvalCardEditGate.pendingEdit('card-msg')).toBeUndefined();
    });

    test('releases the card when the click turns out stale', async () => {
        const h = makeHarness();
        h.get.mockImplementation(async () => undefined);

        await h.handler.handleButton(click(RESEND).interaction);

        expect(h.cardEdits.pendingEdit('card-msg')).toBeUndefined();
    });
});
