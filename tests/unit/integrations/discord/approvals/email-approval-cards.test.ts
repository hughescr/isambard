import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { APIButtonComponentWithCustomId, Message } from 'discord.js';
import { mockLogger } from '../../../../setup';
import { ApprovalCardEditGate, approvalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import type { EmailApprovalCard } from '@/integrations/discord/approvals/email-approval-card';
import { EmailApprovalCardPresenter, type ApprovalCardChannel, type ApprovalCardMessage } from '@/integrations/discord/approvals/email-approval-cards';
import type { SendResult } from '@/integrations/discord/capability';
import type { DraftApprovalCardLink, WildDuckMessage } from '@/integrations/email';

const OLD_UID = 42;
const NEW_UID = 55;
const LINK: DraftApprovalCardLink = { channelId: 'admin-ch', messageId: 'card-1', edits: 2 };

function draft(uid: number, metaData: Record<string, unknown> = {}): WildDuckMessage {
    return { id: uid, draft: true, subject: 'Hello', from: { address: 'izzy@example.com' }, to: [{ address: 'a@example.com' }], text: 'Body', metaData };
}

/** A posted card whose live controls act on `uid` (none when undefined). */
function cardMessage(uid: number | undefined): ApprovalCardMessage & { edit: ReturnType<typeof mock<(payload: EmailApprovalCard) => Promise<unknown>>> } {
    return {
        components: uid === undefined ? [] : [{ components: [{ customId: `email-send-approve:${uid}` }, { customId: `email-send-reject:${uid}` }] }],
        edit:       mock(async (_payload: EmailApprovalCard): Promise<unknown> => ({})),
    };
}

function titleOf(card: EmailApprovalCard): string | undefined {
    return card.embeds[0].toJSON().title;
}

function customIdsOf(card: EmailApprovalCard): string[] {
    return card.components.flatMap(row => row.toJSON().components.map(c => (c as APIButtonComponentWithCustomId).custom_id));
}

interface Harness {
    presenter:      EmailApprovalCardPresenter
    getMessage:     ReturnType<typeof mock<(folder: string, uid: number) => Promise<WildDuckMessage | null>>>
    linkCard:       ReturnType<typeof mock<(uid: number, link: DraftApprovalCardLink) => Promise<boolean>>>
    markSuperseded: ReturnType<typeof mock<(oldUid: number, newUid: number) => Promise<boolean>>>
    postCard:       ReturnType<typeof mock<(card: EmailApprovalCard) => Promise<SendResult>>>
    fetchChannel:   ReturnType<typeof mock<(channelId: string) => Promise<ApprovalCardChannel | null>>>
    fetchMessage:   ReturnType<typeof mock<(options: { message: string, force: boolean }) => Promise<ApprovalCardMessage>>>
    reply:          ReturnType<typeof mock<(card: { channelId: string, messageId: string }, text: string) => Promise<void>>>
    gate:           ApprovalCardEditGate
    events:         string[]
}

function makeHarness(stored: WildDuckMessage | null, card: ApprovalCardMessage = cardMessage(OLD_UID)): Harness {
    const events: string[] = [];
    const gate = new ApprovalCardEditGate();
    const getMessage = mock(async (_folder: string, _uid: number): Promise<WildDuckMessage | null> => stored);
    const linkCard = mock(async (_uid: number, _link: DraftApprovalCardLink): Promise<boolean> => {
        events.push('link');
        return true;
    });
    const markSuperseded = mock(async (_oldUid: number, _newUid: number): Promise<boolean> => true);
    const postCard = mock(async (_card: EmailApprovalCard): Promise<SendResult> => {
        events.push(gate.pendingEdit(LINK.messageId) === undefined ? 'post:card-free' : 'post:card-held');
        return { status: 'sent', message: { channelId: 'admin-ch', id: 'card-new' } as unknown as Message };
    });
    const fetchMessage = mock(async (_options: { message: string, force: boolean }): Promise<ApprovalCardMessage> => {
        events.push('fetch');
        return card;
    });
    const fetchChannel = mock(async (_channelId: string): Promise<ApprovalCardChannel | null> => ({ messages: { fetch: fetchMessage } }));
    const reply = mock(async (_card: { channelId: string, messageId: string }, _text: string): Promise<void> => {
        events.push('reply');
    });
    const presenter = new EmailApprovalCardPresenter({
        wildDuckClient: { getMessage },
        draftMeta:      { linkCard, markSuperseded },
        postCard,
        fetchChannel,
        reply,
        cardEdits:      gate,
    });
    return { presenter, getMessage, linkCard, markSuperseded, postCard, fetchChannel, fetchMessage, reply, gate, events };
}

describe('EmailApprovalCardPresenter', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
    });

    describe('present — a new card', () => {
        test('renders the stored draft, posts it, links the draft to the posted card and reports posted', async () => {
            const h = makeHarness(draft(NEW_UID));

            expect(await h.presenter.present(NEW_UID)).toBe('posted');

            expect(h.getMessage.mock.calls).toEqual([['Drafts', NEW_UID]]);
            const posted = h.postCard.mock.calls[0][0];
            expect(titleOf(posted)).toBe('Outbound Email Approval Required');
            expect(customIdsOf(posted)).toEqual(['email-send-approve:55', 'email-send-approveallowlist:55', 'email-send-reject:55']);
            expect(h.linkCard.mock.calls).toEqual([[NEW_UID, { channelId: 'admin-ch', messageId: 'card-new', edits: 0 }]]);
            expect(h.fetchChannel).not.toHaveBeenCalled();
        });

        test('still reports posted when the link write fails', async () => {
            const h = makeHarness(draft(NEW_UID));
            h.linkCard.mockImplementation(async () => false);

            expect(await h.presenter.present(NEW_UID)).toBe('posted');
        });

        test('reports posted without a link when Discord returns no message', async () => {
            const h = makeHarness(draft(NEW_UID));
            h.postCard.mockImplementation(async () => ({ status: 'sent' }));

            expect(await h.presenter.present(NEW_UID)).toBe('posted');
            expect(h.linkCard).not.toHaveBeenCalled();
        });

        test('a card queued to the outbox is reported queued and never linked', async () => {
            const h = makeHarness(draft(NEW_UID));
            h.postCard.mockImplementation(async () => ({ status: 'queued', outboxId: 'o1' }));

            expect(await h.presenter.present(NEW_UID)).toBe('queued');
            expect(h.linkCard).not.toHaveBeenCalled();
        });

        test('an unavailable Discord is reported failed', async () => {
            const h = makeHarness(draft(NEW_UID));
            h.postCard.mockImplementation(async () => ({ status: 'unavailable' }));

            expect(await h.presenter.present(NEW_UID)).toBe('failed');
            expect(h.linkCard).not.toHaveBeenCalled();
        });

        test('a thrown post is logged and reported failed', async () => {
            const h = makeHarness(draft(NEW_UID));
            const failure = new Error('channel gone');
            h.postCard.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.presenter.present(NEW_UID)).toBe('failed');
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: NEW_UID, msg: 'Failed to post the outbound email approval card' });
        });

        test('reports missing, posting nothing, when the draft is not found', async () => {
            const h = makeHarness(null);

            expect(await h.presenter.present(NEW_UID)).toBe('missing');
            expect(h.postCard).not.toHaveBeenCalled();
        });

        test('a draft read failure propagates', async () => {
            const h = makeHarness(draft(NEW_UID));
            h.getMessage.mockImplementation(async () => {
                throw new Error('wildduck down');
            });

            await expect(h.presenter.present(NEW_UID)).rejects.toThrow('wildduck down');
        });

        test('without a previous uid, posts a linked draft\'s card with its edit count and never edits in place', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));

            expect(await h.presenter.present(NEW_UID)).toBe('posted');

            expect(titleOf(h.postCard.mock.calls[0][0])).toBe('Outbound Email Approval Required · Edited (2)');
            expect(h.linkCard.mock.calls[0][1]).toEqual({ channelId: 'admin-ch', messageId: 'card-new', edits: 2 });
            expect(h.fetchChannel).not.toHaveBeenCalled();
        });

        test('with a previous uid but no link, posts a new card', async () => {
            const h = makeHarness(draft(NEW_UID));

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');
            expect(h.fetchChannel).not.toHaveBeenCalled();
        });
    });

    describe('present — editing the amended draft\'s card in place', () => {
        test('edits the linked card, read fresh, to the new draft with buttons keyed to the new uid, then replies under it', async () => {
            const card = cardMessage(OLD_UID);
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), card);

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('updated');

            expect(h.fetchChannel.mock.calls).toEqual([['admin-ch']]);
            expect(h.fetchMessage.mock.calls).toEqual([[{ message: 'card-1', force: true }]]);
            const edited = card.edit.mock.calls[0][0];
            expect(titleOf(edited)).toBe('Outbound Email Approval Required · Edited (2)');
            expect(customIdsOf(edited)).toEqual(['email-send-approve:55', 'email-send-approveallowlist:55', 'email-send-reject:55']);
            expect(h.reply.mock.calls).toEqual([[LINK, 'Draft edited (2): now Drafts:55. The card above shows the new version; its buttons act on it.']]);
            expect(h.postCard).not.toHaveBeenCalled();
            expect(h.linkCard).not.toHaveBeenCalled();
            expect(h.gate.pendingEdit('card-1')).toBeUndefined();
        });

        test('still reports updated when the reply fails', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            const failure = new Error('reply refused');
            h.reply.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('updated');
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: NEW_UID, ...LINK, msg: 'Could not reply under the edited approval card' });
        });

        test.each([
            ['acts on another uid', cardMessage(7)],
            ['has no live controls (decided or deleted)', cardMessage(undefined)],
        ])('never paints over a card that %s: posts and links a new card, edits 0', async (_label, card) => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), card);

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');

            expect(card.edit).not.toHaveBeenCalled();
            expect(titleOf(h.postCard.mock.calls[0][0])).toBe('Outbound Email Approval Required');
            expect(h.linkCard.mock.calls).toEqual([[NEW_UID, { channelId: 'admin-ch', messageId: 'card-new', edits: 0 }]]);
            expect(h.reply).not.toHaveBeenCalled();
        });

        test('posts a new card when the card\'s channel is unavailable', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.fetchChannel.mockImplementation(async () => null);

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');
            expect(mockLogger.warn).toHaveBeenCalledWith({ ...LINK, msg: 'Approval card channel unavailable' });
        });

        test('posts a new card when the card cannot be read', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            const failure = new Error('Unknown Message');
            h.fetchMessage.mockImplementation(async () => {
                throw failure;
            });

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, ...LINK, msg: 'Could not read the approval card' });
        });

        test('an edit whose response was lost but which landed counts as updated, with no second card', async () => {
            const card = cardMessage(OLD_UID);
            const failure = new Error('response lost');
            card.edit.mockImplementation(async () => {
                throw failure;
            });
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), card);
            h.fetchMessage.mockImplementationOnce(async () => card).mockImplementationOnce(async () => cardMessage(NEW_UID));

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('updated');

            expect(h.fetchMessage).toHaveBeenCalledTimes(2);
            expect(h.fetchMessage.mock.calls[1]).toEqual([{ message: 'card-1', force: true }]);
            expect(h.postCard).not.toHaveBeenCalled();
            expect(h.reply).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: NEW_UID, previousUid: OLD_UID, ...LINK, msg: 'Editing the approval card in place failed — checking whether it landed' });
        });

        test('a failed edit that did not land posts a new card', async () => {
            const card = cardMessage(OLD_UID);
            card.edit.mockImplementation(async () => {
                throw new Error('edit refused');
            });
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), card);

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');
            expect(h.fetchMessage).toHaveBeenCalledTimes(2);
            expect(h.reply).not.toHaveBeenCalled();
        });

        test('a failed edit whose re-read also fails posts a new card', async () => {
            const card = cardMessage(OLD_UID);
            card.edit.mockImplementation(async () => {
                throw new Error('edit refused');
            });
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), card);
            h.fetchMessage.mockImplementationOnce(async () => card).mockImplementationOnce(async () => {
                throw new Error('read failed');
            });

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');
        });

        test('releases the card key before posting', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), cardMessage(7));

            await h.presenter.present(NEW_UID, OLD_UID);

            expect(h.events).toEqual(['fetch', 'post:card-free', 'link']);
        });

        test('waits for a click holding the card before reading it', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            const releaseClick = h.gate.hold('card-1');

            const presenting = h.presenter.present(NEW_UID, OLD_UID);
            for(let i = 0; i < 10; i++) {
                // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
                await Promise.resolve();
            }
            expect(h.fetchMessage).not.toHaveBeenCalled();

            releaseClick();
            expect(await presenting).toBe('updated');
        });
    });

    describe('markDeleted', () => {
        test('edits a live card for the uid to the deleted state, with no buttons', async () => {
            const card = cardMessage(OLD_UID);
            const h = makeHarness(null, card);

            await h.presenter.markDeleted(draft(OLD_UID, { approvalCard: LINK }), OLD_UID);

            expect(h.fetchMessage.mock.calls).toEqual([[{ message: 'card-1', force: true }]]);
            const edited = card.edit.mock.calls[0][0];
            expect(titleOf(edited)).toBe('Draft deleted — nothing will be sent');
            expect(edited.embeds[0].toJSON().fields?.at(-1)).toEqual({ name: 'Draft', value: 'Drafts:42' });
            expect(edited.components).toEqual([]);
            expect(h.gate.pendingEdit('card-1')).toBeUndefined();
        });

        test('leaves a card whose controls act on another uid', async () => {
            const card = cardMessage(7);
            const h = makeHarness(null, card);

            await h.presenter.markDeleted(draft(OLD_UID, { approvalCard: LINK }), OLD_UID);

            expect(card.edit).not.toHaveBeenCalled();
        });

        test.each([
            ['no card link', {}],
            ['an approval marker', { approvalCard: LINK, approval: { actionId: 'a', at: 'b' } }],
            ['a rejection', { approvalCard: LINK, rejectedAt: 'then' }],
        ])('does nothing for a draft with %s', async (_label, metaData) => {
            const h = makeHarness(null);

            await h.presenter.markDeleted(draft(OLD_UID, metaData), OLD_UID);

            expect(h.fetchChannel).not.toHaveBeenCalled();
        });

        test('does nothing when the card cannot be read', async () => {
            const h = makeHarness(null);
            h.fetchChannel.mockImplementation(async () => null);

            await h.presenter.markDeleted(draft(OLD_UID, { approvalCard: LINK }), OLD_UID);

            expect(h.fetchMessage).not.toHaveBeenCalled();
        });

        test('a failed edit is logged, swallowed, and releases the card', async () => {
            const card = cardMessage(OLD_UID);
            const failure = new Error('edit refused');
            card.edit.mockImplementation(async () => {
                throw failure;
            });
            const h = makeHarness(null, card);

            await h.presenter.markDeleted(draft(OLD_UID, { approvalCard: LINK }), OLD_UID);

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: OLD_UID, ...LINK, msg: 'Could not mark the deleted draft’s approval card' });
            expect(h.gate.pendingEdit('card-1')).toBeUndefined();
        });
    });

    test('markSuperseded delegates to the draft metaData owner', async () => {
        const h = makeHarness(null);
        h.markSuperseded.mockImplementation(async () => false);

        expect(await h.presenter.markSuperseded(OLD_UID, NEW_UID)).toBe(false);
        expect(h.markSuperseded.mock.calls).toEqual([[OLD_UID, NEW_UID]]);
    });

    test('defaults to the process-wide card gate', async () => {
        const fetchChannel = mock(async (_channelId: string): Promise<ApprovalCardChannel | null> => null);
        const presenter = new EmailApprovalCardPresenter({
            wildDuckClient: { getMessage: mock(async () => draft(NEW_UID, { approvalCard: LINK })) },
            draftMeta:      { linkCard: mock(async () => true), markSuperseded: mock(async () => true) },
            postCard:       mock(async (): Promise<SendResult> => ({ status: 'unavailable' })),
            fetchChannel,
            reply:          mock(async () => undefined),
        });
        const releaseClick = approvalCardEditGate.hold('card-1');

        const presenting = presenter.present(NEW_UID, OLD_UID);
        for(let i = 0; i < 10; i++) {
            // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
            await Promise.resolve();
        }
        expect(fetchChannel).not.toHaveBeenCalled();

        releaseClick();
        expect(await presenting).toBe('failed');
        expect(fetchChannel).toHaveBeenCalledTimes(1);
    });
});
