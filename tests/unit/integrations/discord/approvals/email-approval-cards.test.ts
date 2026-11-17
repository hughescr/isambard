import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import type { APIButtonComponentWithCustomId, Message, TextChannel } from 'discord.js';
import { mockLogger } from '../../../../setup';
import { createChannelId } from '@/agent/types';
import { ApprovalCardEditGate, approvalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import type { EmailApprovalCard } from '@/integrations/discord/approvals/email-approval-card';
import { EmailApprovalCardPresenter, type ApprovalCardChannel, type ApprovalCardMessage } from '@/integrations/discord/approvals/email-approval-cards';
import type { SendResult } from '@/integrations/discord/capability';
import { createOutboxReplayDeliverFn } from '@/integrations/discord/outbox-replay';
import { EmailOutboundApprovals, type DraftApprovalCardLink, type WildDuckMessage } from '@/integrations/email';
import { CARD_LINK_LOCK_WAIT_MS } from '@/integrations/email/outbound-approvals';
import { OutboxVerificationPendingError, type OutboxItem } from '@/services';

const OLD_UID = 42;
const NEW_UID = 55;
const LINK: DraftApprovalCardLink = { channelId: 'admin-ch', messageId: 'card-1', edits: 2 };
const COMPLETION = { kind: 'email_approval_card', draftUid: NEW_UID, edits: 0 } as const;
const DELIVERED = { channelId: 'admin-ch', messageId: 'card-new' };
const DRAFT_KEY = `email-draft:${NEW_UID}`;

function draft(uid: number, metaData: Record<string, unknown> = {}): WildDuckMessage {
    return { id: uid, draft: true, subject: 'Hello', from: { address: 'izzy@example.com' }, to: [{ address: 'a@example.com' }], text: 'Body', metaData };
}

/** A posted card whose live controls act on `uid` (none when undefined). */
function cardMessage(uid: number | undefined, authorId = 'our-bot', botId: string | null = 'our-bot'): ApprovalCardMessage & { edit: ReturnType<typeof mock<(payload: EmailApprovalCard) => Promise<unknown>>> } {
    return {
        author:     { id: authorId },
        client:     { user: botId === null ? null : { id: botId } },
        components: uid === undefined ? [] : [{ components: [{ customId: `email-send-approve:${uid}` }, { customId: `email-send-reject:${uid}` }] }],
        edit:       mock(async (_payload: EmailApprovalCard): Promise<unknown> => ({})),
    };
}

async function drainMicrotasks(ticks = 30): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

/** The error discord.js raises for a message that no longer exists. */
function unknownMessage(): Error {
    return Object.assign(new Error('Unknown Message'), { code: RESTJSONErrorCodes.UnknownMessage });
}

function titleOf(card: EmailApprovalCard): string | undefined {
    return card.embeds[0].toJSON().title;
}

function customIdsOf(card: EmailApprovalCard): string[] {
    return card.components.flatMap(row => row.toJSON().components.map(c => (c as APIButtonComponentWithCustomId).custom_id));
}

interface Harness {
    presenter:      EmailApprovalCardPresenter
    updateMetadata: ReturnType<typeof mock<(folder: string, uid: number, metaData: Record<string, unknown>) => Promise<void>>>
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

/** The URLs of a card's link buttons. */
function linkUrlsOf(card: EmailApprovalCard): string[] {
    return card.components.flatMap(row => row.toJSON().components.flatMap(c => ('url' in c ? [c.url] : [])));
}

const previewUrlFor = (uid: number, token: string): string => `https://mac.ts.net/d/${uid}/${token}`;

function makeHarness(stored: WildDuckMessage | null, card: ApprovalCardMessage = cardMessage(OLD_UID), previewUrls?: (uid: number, token: string) => string | undefined): Harness {
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
    const updateMetadata = mock(async (_folder: string, _uid: number, _metaData: Record<string, unknown>): Promise<void> => undefined);
    const approvals = new EmailOutboundApprovals({
        wildDuckClient: { getMessage, updateMessageMetadata: updateMetadata, updateMessageFlags: mock() },
        actionWriter:   { create: mock() },
        actionReader:   { get: mock() },
        draftLocks:     gate,
        notify:         mock(() => true),
    });
    const presenter = new EmailApprovalCardPresenter({
        wildDuckClient: { getMessage },
        draftMeta:      {
            linkCard,
            markSupersededLocked: markSuperseded,
            readCardTarget:       uid => approvals.readCardTarget(uid),
            reconcileCardLink:    (uid, link, replace) => approvals.reconcileCardLink(uid, link, replace),
        },
        postCard,
        fetchChannel,
        reply,
        cardEdits:     gate,
        previewUrlFor: previewUrls,
    });
    return { presenter, getMessage, updateMetadata, linkCard, markSuperseded, postCard, fetchChannel, fetchMessage, reply, gate, events };
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

        test('does not report posted until the draft has been linked to the card', async () => {
            const h = makeHarness(draft(NEW_UID));
            const linked = Promise.withResolvers<boolean>();
            h.linkCard.mockImplementation(async () => linked.promise);

            const presenting = h.presenter.present(NEW_UID);
            for(let i = 0; i < 10; i++) {
                // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
                await Promise.resolve();
            }

            expect(h.linkCard).toHaveBeenCalledTimes(1);
            expect(Bun.peek.status(presenting)).toBe('pending');
            linked.resolve(true);
            expect(await presenting).toBe('posted');
        });

        test('reports posted without a link when Discord returns no message', async () => {
            const h = makeHarness(draft(NEW_UID));
            h.postCard.mockImplementation(async () => ({ status: 'sent' }));

            expect(await h.presenter.present(NEW_UID)).toBe('posted');
            expect(h.linkCard).not.toHaveBeenCalled();
        });

        test('a queued card carries the completion intent and is not linked immediately', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.postCard.mockImplementation(async () => ({ status: 'queued', outboxId: 'o1' }));

            expect(await h.presenter.present(NEW_UID)).toBe('queued');
            expect(h.postCard).toHaveBeenCalledWith(expect.anything(), { ...COMPLETION, edits: 2 });
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

    describe('queued approval card replay', () => {
        test('a persisted row replayed after a failed acknowledgement links and posts only once', async () => {
            const stored = draft(NEW_UID);
            const h = makeHarness(stored, cardMessage(NEW_UID));
            h.updateMetadata.mockImplementation(async (_folder, _uid, metadata) => {
                stored.metaData = metadata;
            });
            const send = mock(async () => ({ id: DELIVERED.messageId }));
            const channel = { id: DELIVERED.channelId, send } as unknown as TextChannel;
            const deliver = createOutboxReplayDeliverFn({
                fetchChannel:       mock(async () => channel),
                notify:             mock(() => true),
                emailApprovalCards: h.presenter,
            });
            const row: OutboxItem = {
                id:          'card-outbox-row',
                createdAt:   '2026-11-17T00:00:00.000Z',
                service:     'discord',
                type:        'email_approval',
                destination: createChannelId(DELIVERED.channelId),
                payload:     { embeds: [{ title: 'Pending' }] },
                priority:    'high',
                epoch:       0,
                dedupeKey:   'card-dedupe',
                progress:    { attemptCount: 0 },
                completion:  COMPLETION,
            };

            await deliver({ ...row, progress: { ...row.progress } });
            await deliver(row); // The failed ack left the original row, not the in-memory item.

            expect(stored.metaData).toEqual({ approvalCard: { ...DELIVERED, edits: 0 } });
            expect(h.updateMetadata).toHaveBeenCalledTimes(1);
            expect(send).toHaveBeenCalledTimes(1);
            expect(h.fetchMessage.mock.calls).toEqual([[{ message: DELIVERED.messageId, force: true }]]);
        });

        test.each([
            ['matching', NEW_UID, 'our-bot', 'our-bot', { obsolete: false, delivered: { channelId: LINK.channelId, messageId: LINK.messageId } }],
            ['predecessor', OLD_UID, 'our-bot', 'our-bot', { obsolete: false }],
            ['foreign', NEW_UID, 'other-bot', 'our-bot', { obsolete: false }],
        ] as const)('proves delivery only with live owned controls: %s', async (_label, uid, author, bot, result) => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), cardMessage(uid, author, bot));

            expect(await h.presenter.inspectQueuedCard(COMPLETION)).toStrictEqual(result);
            expect(h.fetchMessage.mock.calls).toEqual([[{ message: LINK.messageId, force: true }]]);
        });

        test.each([
            ['an active', draft(NEW_UID, { approvalCard: LINK }), false],
            ['a superseded', draft(NEW_UID, { supersededBy: 56, approvalCard: LINK }), true],
        ] as const)('a fetched stored card with no bot identity on %s draft is inconclusive, not undelivered', async (_label, stored, obsolete) => {
            const h = makeHarness(stored, cardMessage(NEW_UID, 'our-bot', null));

            expect(await h.presenter.inspectQueuedCard(COMPLETION)).toStrictEqual({ obsolete, inconclusive: true });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('a replay whose stored card cannot be attributed without a bot identity waits for verification instead of posting a duplicate', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), cardMessage(NEW_UID, 'our-bot', null));
            const send = mock(async () => ({ id: DELIVERED.messageId }));
            const channel = { id: DELIVERED.channelId, send } as unknown as TextChannel;
            const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true), emailApprovalCards: h.presenter });
            const row: OutboxItem = {
                id:          'card-outbox-row',
                createdAt:   '2026-11-17T00:00:00.000Z',
                service:     'discord',
                type:        'email_approval',
                destination: createChannelId(DELIVERED.channelId),
                payload:     { embeds: [{ title: 'Pending' }] },
                priority:    'high',
                epoch:       0,
                dedupeKey:   'card-dedupe',
                progress:    { attemptCount: 1, outcome: 'retryable' },
                completion:  COMPLETION,
            };

            await expect(deliver(row)).rejects.toBeInstanceOf(OutboxVerificationPendingError);
            expect(send).not.toHaveBeenCalled();
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(row.progress).toEqual({ attemptCount: 1, outcome: 'retryable' });
        });

        test.each([
            ['missing', null, { obsolete: true }],
            ['superseded without a link', draft(NEW_UID, { supersededBy: 56 }), { obsolete: true }],
            ['no link', draft(NEW_UID), { obsolete: false }],
        ] as const)('checks a %s draft without Discord I/O', async (_label, stored, result) => {
            const h = makeHarness(stored);

            expect(await h.presenter.inspectQueuedCard(COMPLETION)).toEqual(result);
            expect(h.fetchChannel).not.toHaveBeenCalled();
        });

        test('proves delivery from the stored card even after its draft was superseded', async () => {
            const h = makeHarness(draft(NEW_UID, { supersededBy: 56, approvalCard: LINK }), cardMessage(NEW_UID));

            expect(await h.presenter.inspectQueuedCard(COMPLETION)).toEqual({
                obsolete:  true,
                delivered: { channelId: LINK.channelId, messageId: LINK.messageId },
            });
        });

        test('does not infer an obsolete target from an unreadable draft', async () => {
            const h = makeHarness(null);
            h.getMessage.mockRejectedValue(new Error('WildDuck unavailable'));

            expect(await h.presenter.inspectQueuedCard(COMPLETION)).toEqual({ obsolete: false });
            expect(h.fetchChannel).not.toHaveBeenCalled();
        });

        test('links before an amend acquires the draft key and carries the new link forward', async () => {
            const stored = draft(NEW_UID);
            const h = makeHarness(stored);
            h.updateMetadata.mockImplementation(async (_folder, _uid, metadata) => {
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeDefined();
                stored.metaData = metadata;
            });

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            const amendRelease = await h.gate.acquire(DRAFT_KEY);
            amendRelease();
            expect(stored.metaData).toEqual({ approvalCard: { ...DELIVERED, edits: 0 } });
            expect(h.fetchChannel).not.toHaveBeenCalled();
        });

        test('waits for the amend draft key, then retires outside it under the card key', async () => {
            const delivered = cardMessage(NEW_UID);
            const h = makeHarness(null, delivered);
            h.fetchMessage.mockImplementation(async () => {
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeUndefined();
                expect(h.gate.pendingEdit(DELIVERED.messageId)).toBeDefined();
                return delivered;
            });
            delivered.edit.mockImplementation(async () => {
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeUndefined();
                expect(h.gate.pendingEdit(DELIVERED.messageId)).toBeDefined();
            });
            const amendRelease = await h.gate.acquire(DRAFT_KEY);
            const reconcile = h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            await Promise.resolve();
            expect(h.getMessage).not.toHaveBeenCalled();
            expect(h.gate.pendingEdit(DELIVERED.messageId)).toBeUndefined();
            amendRelease();
            await reconcile;

            expect(h.fetchMessage.mock.calls).toEqual([[{ message: DELIVERED.messageId, force: true }]]);
            expect(delivered.edit).toHaveBeenCalledTimes(1);
            expect(delivered.edit.mock.calls[0][0]).toMatchObject({ content: '', components: [] });
            expect(titleOf(delivered.edit.mock.calls[0][0])).toBe('Approval no longer active');
            expect(h.gate.pendingEdit(DELIVERED.messageId)).toBeUndefined();
        });

        test.each([
            ['moved', OLD_UID, 'our-bot'],
            ['already retired', undefined, 'our-bot'],
            ['foreign', NEW_UID, 'other-bot'],
        ] as const)('retirement leaves a %s card alone', async (_label, uid, author) => {
            const delivered = cardMessage(uid, author);
            const h = makeHarness(null, delivered);

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(delivered.edit).not.toHaveBeenCalled();
        });

        test('retires a confirmed duplicate without changing the link', async () => {
            const delivered = cardMessage(NEW_UID);
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.fetchMessage.mockImplementation(async ({ message }) => {
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeUndefined();
                expect(h.gate.pendingEdit(message)).toBeDefined();
                return message === LINK.messageId ? cardMessage(NEW_UID) : delivered;
            });

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(delivered.edit).toHaveBeenCalledTimes(1);
            expect(h.gate.pendingEdit(LINK.messageId)).toBeUndefined();
        });

        test.each(['predecessor', 'deleted'] as const)('replaces an inherited link to a %s card', async (kind) => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.fetchMessage.mockImplementation(async () => {
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeUndefined();
                expect(h.gate.pendingEdit(LINK.messageId)).toBeDefined();
                if(kind === 'deleted') {
                    throw Object.assign(new Error('Unknown Message'), { code: RESTJSONErrorCodes.UnknownMessage });
                }
                return cardMessage(OLD_UID);
            });
            h.updateMetadata.mockImplementation(async () => {
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeDefined();
                expect(h.gate.pendingEdit(LINK.messageId)).toBeDefined();
            });

            await h.presenter.reconcileQueuedCard({ ...COMPLETION, edits: 3 }, DELIVERED);
            expect(h.updateMetadata.mock.calls).toEqual([['Drafts', NEW_UID, { approvalCard: { ...DELIVERED, edits: 3 } }]]);
            expect(h.fetchMessage.mock.calls).toEqual([[{ message: LINK.messageId, force: true }]]);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('does not overwrite a competing link that changed during the Discord read', async () => {
            const stored = draft(NEW_UID, { approvalCard: LINK });
            const h = makeHarness(stored);
            h.fetchMessage.mockImplementation(async () => {
                stored.metaData = { approvalCard: { ...LINK, messageId: 'another-card' } };
                return cardMessage(OLD_UID);
            });

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.fetchMessage).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: NEW_UID, ...DELIVERED, edits: 0, msg: 'Approval card link changed during replay reconciliation' });
        });

        test.each([new Error('Discord unavailable'), 'network error', null, undefined])('keeps both cards when the competing card cannot be verified (%p)', async (failure) => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.fetchMessage.mockRejectedValue(failure);

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.fetchMessage).toHaveBeenCalledTimes(1);
            expect(h.gate.pendingEdit(LINK.messageId)).toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, ...LINK, msg: 'Could not read the approval card' });
        });

        test('does not replace a card when Discord has no bot identity to verify its owner', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), cardMessage(NEW_UID, 'our-bot', null));

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(h.fetchMessage.mock.calls).toEqual([[{ message: LINK.messageId, force: true }]]);
        });

        test('does not count a link to a deleted card as delivery', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.fetchMessage.mockRejectedValue({ code: RESTJSONErrorCodes.UnknownMessage });

            expect(await h.presenter.inspectQueuedCard(COMPLETION)).toEqual({ obsolete: false });
        });

        test('does not edit a card it cannot force-fetch for retirement', async () => {
            const delivered = cardMessage(NEW_UID);
            const h = makeHarness(null, delivered);
            h.fetchMessage.mockRejectedValue({ code: RESTJSONErrorCodes.UnknownMessage });

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(delivered.edit).not.toHaveBeenCalled();
            expect(h.gate.pendingEdit(DELIVERED.messageId)).toBeUndefined();
        });

        test('releases the card key after a retirement edit fails', async () => {
            const delivered = cardMessage(NEW_UID);
            const h = makeHarness(null, delivered);
            delivered.edit.mockRejectedValue(new Error('edit refused'));

            await expect(h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED)).rejects.toThrow('edit refused');
            expect(h.gate.pendingEdit(DELIVERED.messageId)).toBeUndefined();
        });

        test('retires when the draft became obsolete during a conflicting card read', async () => {
            const delivered = cardMessage(NEW_UID);
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.getMessage.mockResolvedValueOnce(draft(NEW_UID, { approvalCard: LINK })).mockResolvedValue(null);
            h.fetchMessage.mockImplementation(async ({ message }) => (message === LINK.messageId ? cardMessage(OLD_UID) : delivered));

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(h.updateMetadata).not.toHaveBeenCalled();
            expect(delivered.edit).toHaveBeenCalledTimes(1);
        });

        test('leaves controls alone when the metadata write fails', async () => {
            const h = makeHarness(draft(NEW_UID));
            h.updateMetadata.mockRejectedValue(new Error('WildDuck unavailable'));

            await h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
            expect(h.fetchChannel).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        describe('a draft key held by a hung amend', () => {
            beforeEach(() => {
                jest.useFakeTimers();
            });

            afterEach(() => {
                jest.useRealTimers();
            });

            test('the first link attempt gives up after 30s, leaving the card alone', async () => {
                const delivered = cardMessage(NEW_UID);
                const h = makeHarness(draft(NEW_UID), delivered);
                const amendRelease = await h.gate.acquire(DRAFT_KEY);

                const reconciling = h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
                await drainMicrotasks();
                jest.advanceTimersByTime(CARD_LINK_LOCK_WAIT_MS);
                await reconciling;

                expect(h.getMessage).not.toHaveBeenCalled();
                expect(h.fetchChannel).not.toHaveBeenCalled();
                expect(delivered.edit).not.toHaveBeenCalled();
                expect(mockLogger.warn.mock.calls).toEqual([[{ uid: NEW_UID, msg: 'Could not reconcile the draft\'s approval card link: its key stayed held for 30s' }]]);
                amendRelease();
                await drainMicrotasks();
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeUndefined();
            });

            test('the compare-and-replace under the existing card\'s key gives up after 30s, keeps both cards and releases both keys', async () => {
                const delivered = cardMessage(NEW_UID);
                const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
                let amendRelease: (() => void) | undefined;
                h.fetchMessage.mockImplementation(async ({ message }) => {
                    if(message === LINK.messageId) {
                        amendRelease = await h.gate.acquire(DRAFT_KEY); // The amend starts while the existing card is read.
                        return cardMessage(OLD_UID);
                    }
                    return delivered;
                });

                const reconciling = h.presenter.reconcileQueuedCard(COMPLETION, DELIVERED);
                await drainMicrotasks();
                expect(h.gate.pendingEdit(LINK.messageId)).toBeDefined();
                expect(Bun.peek.status(reconciling)).toBe('pending');
                jest.advanceTimersByTime(CARD_LINK_LOCK_WAIT_MS);
                await reconciling;

                expect(h.updateMetadata).not.toHaveBeenCalled();
                expect(delivered.edit).not.toHaveBeenCalled();
                expect(h.fetchMessage).toHaveBeenCalledTimes(1);
                expect(h.gate.pendingEdit(LINK.messageId)).toBeUndefined();
                expect(mockLogger.warn).toHaveBeenCalledWith({ uid: NEW_UID, msg: 'Could not reconcile the draft\'s approval card link: its key stayed held for 30s' });
                amendRelease?.();
                await drainMicrotasks();
                expect(h.gate.pendingEdit(DRAFT_KEY)).toBeUndefined();
            });
        });
    });

    describe('present — the preview link', () => {
        const TOKEN = 't'.repeat(43);

        test('links a new card to the draft\'s preview when preview is on and the draft has a token', async () => {
            const h = makeHarness(draft(NEW_UID, { previewToken: TOKEN }), cardMessage(OLD_UID), previewUrlFor);

            await h.presenter.present(NEW_UID);

            expect(linkUrlsOf(h.postCard.mock.calls[0][0])).toEqual([`https://mac.ts.net/d/55/${TOKEN}`]);
        });

        test('has no link when the draft has no token', async () => {
            const h = makeHarness(draft(NEW_UID), cardMessage(OLD_UID), previewUrlFor);

            await h.presenter.present(NEW_UID);

            expect(linkUrlsOf(h.postCard.mock.calls[0][0])).toEqual([]);
        });

        test('has no link when preview is off', async () => {
            const h = makeHarness(draft(NEW_UID, { previewToken: TOKEN }));

            await h.presenter.present(NEW_UID);

            expect(linkUrlsOf(h.postCard.mock.calls[0][0])).toEqual([]);
        });

        test('has no link while the preview is not yet (or never) published on the tailnet', async () => {
            const h = makeHarness(draft(NEW_UID, { previewToken: TOKEN }), cardMessage(OLD_UID), () => undefined);

            await h.presenter.present(NEW_UID);

            expect(linkUrlsOf(h.postCard.mock.calls[0][0])).toEqual([]);
        });

        test('an in-place edit links to the new uid and its new token', async () => {
            const card = cardMessage(OLD_UID);
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK, previewToken: 'n'.repeat(43) }), card, previewUrlFor);

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('updated');

            expect(linkUrlsOf(card.edit.mock.calls[0][0])).toEqual([`https://mac.ts.net/d/55/${'n'.repeat(43)}`]);
        });

        test('a card posted in place of an unusable link also carries the preview link', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK, previewToken: TOKEN }), cardMessage(undefined), previewUrlFor);

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');

            expect(linkUrlsOf(h.postCard.mock.calls[0][0])).toEqual([`https://mac.ts.net/d/55/${TOKEN}`]);
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

        test('does not report updated until the reply under the card has been sent', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            const replied = Promise.withResolvers<undefined>();
            h.reply.mockImplementation(async () => replied.promise);

            const presenting = h.presenter.present(NEW_UID, OLD_UID);
            for(let i = 0; i < 20; i++) {
                // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
                await Promise.resolve();
            }

            expect(h.reply).toHaveBeenCalledTimes(1);
            expect(Bun.peek.status(presenting)).toBe('pending');
            replied.resolve(undefined);
            expect(await presenting).toBe('updated');
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

        test('posts and links a new card, silently, when the linked card was deleted', async () => {
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }));
            h.fetchMessage.mockRejectedValue(unknownMessage());

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');

            expect(titleOf(h.postCard.mock.calls[0][0])).toBe('Outbound Email Approval Required');
            expect(h.linkCard.mock.calls).toEqual([[NEW_UID, { channelId: 'admin-ch', messageId: 'card-new', edits: 0 }]]);
            expect(h.reply).not.toHaveBeenCalled();
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('a failed edit whose re-read finds the card deleted posts a new card, logging only the failed edit', async () => {
            const card = cardMessage(OLD_UID);
            const failure = new Error('edit refused');
            card.edit.mockRejectedValue(failure);
            const h = makeHarness(draft(NEW_UID, { approvalCard: LINK }), card);
            h.fetchMessage.mockImplementationOnce(async () => card).mockRejectedValueOnce(unknownMessage());

            expect(await h.presenter.present(NEW_UID, OLD_UID)).toBe('posted');

            expect(h.fetchMessage).toHaveBeenCalledTimes(2);
            expect(h.reply).not.toHaveBeenCalled();
            expect(mockLogger.warn.mock.calls).toEqual([[{ err: failure, uid: NEW_UID, previousUid: OLD_UID, ...LINK, msg: 'Editing the approval card in place failed — checking whether it landed' }]]);
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

        test('leaves an already-deleted card alone, silently', async () => {
            const h = makeHarness(null);
            h.fetchMessage.mockRejectedValue(unknownMessage());

            await h.presenter.markDeleted(draft(OLD_UID, { approvalCard: LINK }), OLD_UID);

            expect(h.fetchMessage).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(h.gate.pendingEdit('card-1')).toBeUndefined();
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

    test('markSuperseded delegates to the draft metaData owner\'s held-lock write', async () => {
        const h = makeHarness(null);
        h.markSuperseded.mockImplementation(async () => false);

        expect(await h.presenter.markSuperseded(OLD_UID, NEW_UID)).toBe(false);
        expect(h.markSuperseded.mock.calls).toEqual([[OLD_UID, NEW_UID]]);
    });

    test('defaults to the process-wide card gate', async () => {
        const fetchChannel = mock(async (_channelId: string): Promise<ApprovalCardChannel | null> => null);
        const presenter = new EmailApprovalCardPresenter({
            wildDuckClient: { getMessage: mock(async () => draft(NEW_UID, { approvalCard: LINK })) },
            draftMeta:      { linkCard: mock(async () => true), markSupersededLocked: mock(async () => true), readCardTarget: mock(), reconcileCardLink: mock() },
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
