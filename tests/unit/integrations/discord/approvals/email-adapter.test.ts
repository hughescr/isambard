import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { mockLogger } from '../../../../setup';
import type { NotifyFn, NotifyParams } from '@/agent';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { ApprovalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import { EmailApprovalInteractionAdapter } from '@/integrations/discord/approvals/email-adapter';
import { DiscordOutboundApprovalInteractionHandler } from '@/integrations/discord/approvals/interaction-handler';
import { DRAFT_STATE_FLAG } from '@/integrations/email/draft-review-state';
import { EmailOutboundApprovals } from '@/integrations/email/outbound-approvals';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import type { ApprovedOutboundActionBackend } from '@/services';

/**
 * The collaborators behind the adapter: the email operations' dependencies plus the Discord
 * allowlist starter. These suites drive the adapter end to end through real
 * EmailOutboundApprovals, asserting on the WildDuck/writer/notify mocks.
 */
interface EmailOutboundApprovalHandlerDeps {
    wildDuckClient:              WildDuckClient
    sagaBackend:                 ApprovedOutboundActionBackend
    activityLogger?:             { log: (entry: { type: string, summary: string }) => Promise<void> }
    allowlistInteractionHandler: AllowlistInteractionHandler
    notify:                      NotifyFn
}

/** A card as Discord returns it: live controls acting on `uid`, or none. */
function liveCard(uid: number | undefined): { components: unknown[] } {
    return {
        components: uid === undefined
            ? []
            : [{ components: [{ customId: `email-send-approve:${uid}` }, { customId: `email-send-approveallowlist:${uid}` }, { customId: `email-send-reject:${uid}` }] }],
    };
}

async function drainMicrotasks(ticks = 10): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

function makeAdapter(deps: EmailOutboundApprovalHandlerDeps, cardEdits: ApprovalCardEditGate = new ApprovalCardEditGate()): EmailApprovalInteractionAdapter {
    return new EmailApprovalInteractionAdapter({
        approvals: new EmailOutboundApprovals({
            wildDuckClient: deps.wildDuckClient,
            actionWriter:   deps.sagaBackend,
            actionReader:   deps.sagaBackend,
            draftLocks:     cardEdits,
            activityLogger: deps.activityLogger,
            notify:         deps.notify,
        }),
        allowlist: deps.allowlistInteractionHandler,
        cardEdits,
    });
}

const ADMIN_USER_ID = '222222222222222222';
const CARD_CHANNEL_ID = 'admin-review-channel';
const CARD_MESSAGE_ID = 'approval-card-message';
/** The pending card every approve path shows before recording the approval. */
const PENDING_EMBED = { title: 'Approved ✓ — sending…', color: 0x58_65_F2 };
const STALE_CARD = 'This button belongs to an earlier version of this draft, or the card was already decided — nothing was approved or rejected. Use the current card.';
const CARD_UNREADABLE = 'Couldn\'t read this approval card from Discord — nothing was approved or rejected; try again.';

/** The draft WildDuck stores for uid 42 unless a test says otherwise. */
function storedDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id:        42,
        draft:     true,
        messageId: '<draft-42@example.com>',
        date:      '2026-09-23T11:59:00.000Z',
        to:        [{ address: 'recipient@example.com' }],
        metaData:  { approvalCard: { channelId: CARD_CHANNEL_ID, messageId: CARD_MESSAGE_ID, edits: 0 } },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

type CardFetch = ReturnType<typeof mock<(force: boolean) => Promise<{ components: unknown[] }>>>;

/** The clicked card: Discord's fresh read shows controls acting on uid 42 unless a test says otherwise. */
function makeCardMessage(uid: number | undefined = 42): { id: string, channelId: string, fetch: CardFetch } {
    return { id: CARD_MESSAGE_ID, channelId: CARD_CHANNEL_ID, fetch: mock(async (_force: boolean) => liveCard(uid)) };
}

function makeButtonInteraction(customId: string, userId: string = ADMIN_USER_ID): {
    interaction: ButtonInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    reply:       ReturnType<typeof mock>
    showModal:   ReturnType<typeof mock>
    followUp:    ReturnType<typeof mock>
    cardFetch:   CardFetch
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const reply       = mock(async () => ({}));
    const showModal   = mock(async () => ({}));
    const followUp    = mock(async () => ({}));
    const message     = makeCardMessage();
    const interaction = {
        customId,
        user: { id: userId },
        message,
        deferUpdate,
        editReply,
        reply,
        showModal,
        followUp,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply, reply, showModal, followUp, cardFetch: message.fetch };
}

function makeModalInteraction(customId: string, reason = 'Not appropriate', messageData?: {
    embeds?:     unknown[]
    components?: unknown[]
}): {
    interaction: ModalSubmitInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    followUp:    ReturnType<typeof mock>
    cardFetch:   CardFetch
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const followUp    = mock(async () => ({}));
    const message     = {
        ...makeCardMessage(),
        embeds:     messageData?.embeds ?? [],
        components: messageData?.components ?? [{ type: 1, components: [] }],
    };
    const interaction = {
        customId,
        user:   { id: ADMIN_USER_ID },
        message,
        fields: {
            getTextInputValue: mock((_fieldId: string) => reason),
        },
        deferUpdate,
        editReply,
        followUp,
    } as unknown as ModalSubmitInteraction;
    return { interaction, deferUpdate, editReply, followUp, cardFetch: message.fetch };
}

function makeSelectMenuInteraction(customId: string, selectedValues: string[] = []): {
    interaction: StringSelectMenuInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    followUp:    ReturnType<typeof mock>
    cardFetch:   CardFetch
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const followUp    = mock(async () => ({}));
    const message     = makeCardMessage();
    const interaction = {
        customId,
        values: selectedValues,
        message,
        deferUpdate,
        editReply,
        followUp,
    } as unknown as StringSelectMenuInteraction;
    return { interaction, deferUpdate, editReply, followUp, cardFetch: message.fetch };
}

function makeDeps(overrides: Partial<EmailOutboundApprovalHandlerDeps> = {}): EmailOutboundApprovalHandlerDeps {
    const mockWildDuck: WildDuckClient = {
        submitMessage:         mock(async () => { /* intentionally empty */ }),
        updateMessageMetadata: mock(async () => { /* intentionally empty */ }),
        updateMessageFlags:    mock(async () => { /* intentionally empty */ }),
        getMessage:            mock(async () => storedDraft()),
    } as unknown as WildDuckClient;

    const mockSagaBackend: ApprovedOutboundActionBackend = {
        create: mock(async () => { /* intentionally empty */ }),
        get:    mock(async () => undefined),
    } as unknown as ApprovedOutboundActionBackend;

    const mockAllowlistInteractionHandler = {
        startFromApproval: mock(async () => ({ allowlistSuffix: '' })),
        handleButton:      mock(async () => {}),
        handleModalSubmit: mock(async () => {}),
    } as unknown as AllowlistInteractionHandler;

    const mockNotify = mock((_params: unknown) => true);

    return {
        wildDuckClient:              mockWildDuck,
        sagaBackend:                 mockSagaBackend,
        allowlistInteractionHandler: mockAllowlistInteractionHandler,
        notify:                      mockNotify,
        ...overrides,
    };
}

function makeDeferred(): { promise: Promise<void>, resolve: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, resolve: release };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailApprovalInteractionAdapter', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
    });

    test('is both an EmailApprovalInteractionAdapter and a DiscordOutboundApprovalInteractionHandler', () => {
        const handler = makeAdapter(makeDeps());

        expect(handler).toBeInstanceOf(EmailApprovalInteractionAdapter);
        expect(handler).toBeInstanceOf(DiscordOutboundApprovalInteractionHandler);
    });

    describe('async completion contracts', () => {
        test('does not acknowledge rejection before the rejection flag is persisted', async () => {
            const gate = makeDeferred();
            const started = makeDeferred();
            const deps = makeDeps();
            (deps.wildDuckClient.updateMessageFlags as ReturnType<typeof mock>).mockImplementation(async () => {
                started.resolve();
                await gate.promise;
            });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42');
            const operation = handler.handleModalSubmit(interaction);

            try {
                await Promise.race([started.promise, operation]);
                await drainMicrotasks();
                expect(editReply).not.toHaveBeenCalled();
                expect(Bun.peek.status(operation)).toBe('pending');
            } finally {
                gate.resolve();
                await operation;
            }

            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('does not start select-menu persistence before acknowledgement completes', async () => {
            const gate = makeDeferred();
            const started = makeDeferred();
            const deps = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            deferUpdate.mockImplementation(async () => {
                started.resolve();
                await gate.promise;
                return {};
            });
            const operation = handler.handleSelectMenu(interaction);

            try {
                await Promise.race([started.promise, operation]);
                await drainMicrotasks();
                expect(deps.sagaBackend.create).not.toHaveBeenCalled();
                expect(Bun.peek.status(operation)).toBe('pending');
            } finally {
                gate.resolve();
                await operation;
            }

            expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
        });

        test('waits for the selected recipient allowlist handoff', async () => {
            const gate = makeDeferred();
            const started = makeDeferred();
            const startFromApproval = mock(async () => {
                started.resolve();
                await gate.promise;
                return { allowlistSuffix: '' };
            });
            const deps = makeDeps({
                allowlistInteractionHandler: {
                    startFromApproval,
                    handleButton:      mock(async () => {}),
                    handleModalSubmit: mock(async () => {}),
                } as unknown as AllowlistInteractionHandler,
            });
            const handler = makeAdapter(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['target@example.com']);
            const operation = handler.handleSelectMenu(interaction);

            try {
                await Promise.race([started.promise, operation]);
                await drainMicrotasks();
                expect(Bun.peek.status(operation)).toBe('pending');
            } finally {
                gate.resolve();
                await operation;
            }
        });

        test('waits for the select-menu success acknowledgement before notifying', async () => {
            const gate = makeDeferred();
            const started = makeDeferred();
            const notify = mock((_params: NotifyParams) => true);
            const deps = makeDeps({ notify });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            editReply.mockImplementation(async () => {
                started.resolve();
                await gate.promise;
                return {};
            });
            const operation = handler.handleSelectMenu(interaction);

            try {
                await Promise.race([started.promise, operation]);
                await drainMicrotasks();
                expect(notify).not.toHaveBeenCalled();
                expect(Bun.peek.status(operation)).toBe('pending');
            } finally {
                gate.resolve();
                await operation;
            }

            expect(notify).toHaveBeenCalledTimes(1);
        });

        test('waits for fallback approval persistence when the draft has no address', async () => {
            const gate = makeDeferred();
            const started = makeDeferred();
            const create = mock(async () => {
                started.resolve();
                await gate.promise;
            });
            const deps = makeDeps({ sagaBackend: { create, get: mock(async () => undefined) } as unknown as ApprovedOutboundActionBackend });
            (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({ to: [], cc: [] }));
            const handler = makeAdapter(deps);
            const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');
            const operation = handler.handleButton(interaction);

            try {
                await Promise.race([started.promise, operation]);
                await drainMicrotasks();
                expect(Bun.peek.status(operation)).toBe('pending');
            } finally {
                gate.resolve();
                await operation;
            }
        });

        test('waits for the recipient selection prompt to be displayed', async () => {
            const gate = makeDeferred();
            const started = makeDeferred();
            const deps = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');
            editReply.mockImplementation(async () => {
                started.resolve();
                await gate.promise;
                return {};
            });
            const operation = handler.handleButton(interaction);

            try {
                await Promise.race([started.promise, operation]);
                await drainMicrotasks();
                expect(Bun.peek.status(operation)).toBe('pending');
            } finally {
                gate.resolve();
                await operation;
            }
        });
    });

    test('handleButton waits for Discord acknowledgement before approval work', async () => {
        const acknowledgement = Promise.withResolvers<void>();
        const acknowledgementStarted = Promise.withResolvers<void>();
        const deps = makeDeps();
        const handler = makeAdapter(deps);
        const { interaction, deferUpdate } = makeButtonInteraction('email-send-approve:42');
        deferUpdate.mockImplementation(async () => {
            acknowledgementStarted.resolve();
            await acknowledgement.promise;
            return {};
        });
        const operation = handler.handleButton(interaction);

        try {
            await Promise.race([acknowledgementStarted.promise, operation]);
            await drainMicrotasks();
            expect(Bun.peek.status(operation)).toBe('pending');
            expect(deps.sagaBackend.create).not.toHaveBeenCalled();
        } finally {
            acknowledgement.resolve();
            await operation;
        }
    });

    describe('handleButton()', () => {
        test('should return early for unknown prefix', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const parseId = spyOn(handler as unknown as { parseId: (raw: string) => number | null }, 'parseId');
            const { interaction, deferUpdate } = makeButtonInteraction('email-other:42');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
            expect(parseId).not.toHaveBeenCalled();
        });

        test('should return early for malformed customId with no colon', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const parseId = spyOn(handler as unknown as { parseId: (raw: string) => number | null }, 'parseId');
            const { interaction, deferUpdate } = makeButtonInteraction('email-send-approve');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
            expect(parseId).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate } = makeButtonInteraction('email-send-approve:notanumber');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should read the customId uid as decimal, never as a 0x-prefixed hexadecimal number', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, cardFetch } = makeButtonInteraction('email-send-approve:0x2a');
            cardFetch.mockImplementation(async () => liveCard(0));

            await handler.handleButton(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
                params: Record<string, unknown>
            };
            // parseInt('0x2a', 10) stops at 'x' and yields 0; a radix of 0 would read it as hex (42)
            // and approve a draft the admin never selected.
            expect(createArg.params.uid).toBe(0);
        });

        describe('approve (email-send-approve)', () => {
            test('should deferUpdate, create saga, show success embed', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, deferUpdate, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(deferUpdate).toHaveBeenCalledTimes(1);
                expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
                expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should log a rejected fire-and-forget activity write on the direct approval path', async () => {
                const activityError = new Error('activity unavailable');
                const activityLogger = { log: mock(async () => {
                    throw activityError;
                }) };
                const deps    = makeDeps({ activityLogger });
                const handler = makeAdapter(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);
                await Promise.resolve();

                expect(activityLogger.log).toHaveBeenCalledWith({
                    type:    'email-send-approved',
                    summary: 'Email approved for sending',
                });
                expect(mockLogger.warn).toHaveBeenCalledWith({
                    err: activityError,
                    msg: 'Activity log failed for email send (direct path)',
                });
            });

            test('should create saga with correct type and uid param', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, cardFetch } = makeButtonInteraction('email-send-approve:99');
                cardFetch.mockImplementation(async () => liveCard(99));

                await handler.handleButton(interaction);

                const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
                    type:   string
                    state:  string
                    params: Record<string, unknown>
                };
                expect(createArg.type).toBe('email_send');
                expect(createArg.state).toBe('approved');
                expect(createArg.params).toEqual({ uid: 99, messageId: '<draft-42@example.com>', draftDate: '2026-09-23T11:59:00.000Z' });
            });

            test('should NOT call allowlist interaction handler on plain approve', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(deps.allowlistInteractionHandler.startFromApproval).not.toHaveBeenCalled();
            });

            test('approve edits the card to the blurple sending embed with no buttons', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(editReply).toHaveBeenCalledTimes(1);
                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { toJSON: () => unknown }[], components: unknown[] };
                expect(replyArg.embeds.map(embed => embed.toJSON())).toEqual([PENDING_EMBED]);
                expect(replyArg.components).toEqual([]);
            });

            test('approve records the approval before editing the card to pending, then notes it for Izzy without waking', async () => {
                const order: string[] = [];
                const notify = mock((_params: NotifyParams) => {
                    order.push('notify');
                    return true;
                });
                const create = mock(async () => {
                    order.push('create');
                });
                const deps    = makeDeps({ notify, sagaBackend: { create } as unknown as ApprovedOutboundActionBackend });
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                editReply.mockImplementation(async () => {
                    order.push('editReply');
                    return {};
                });

                await handler.handleButton(interaction);

                expect(order).toEqual(['create', 'editReply', 'notify']);
                expect(notify.mock.calls).toEqual([[{
                    source: 'email-approval',
                    wake:   false,
                    key:    '42:approved',
                    text:   'Outbound email (uid 42) approved by admin; sending now. You will be notified when it has been sent or has failed.',
                }]]);
            });

            test('approve holds the card on the edit gate while recording and showing pending, then releases it', async () => {
                const cardEdits = new ApprovalCardEditGate();
                const heldDuring: string[] = [];
                const create = mock(async () => {
                    heldDuring.push(cardEdits.pendingEdit(CARD_MESSAGE_ID) === undefined ? 'create:free' : 'create:held');
                });
                const deps    = makeDeps({ sagaBackend: { create } as unknown as ApprovedOutboundActionBackend });
                const handler = makeAdapter(deps, cardEdits);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                editReply.mockImplementation(async () => {
                    heldDuring.push(cardEdits.pendingEdit(CARD_MESSAGE_ID) === undefined ? 'editReply:free' : 'editReply:held');
                    return {};
                });

                await handler.handleButton(interaction);

                expect(heldDuring).toEqual(['create:held', 'editReply:held']);
                expect(cardEdits.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
            });

            test('approve releases the card on the edit gate when recording the approval fails', async () => {
                const cardEdits = new ApprovalCardEditGate();
                const deps    = makeDeps();
                (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB write failed'));
                const handler = makeAdapter(deps, cardEdits);
                const { interaction } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(cardEdits.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
            });

            test('approve passes the card ref from interaction.message', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as { approvalCard: unknown };
                expect(createArg.approvalCard).toEqual({ channelId: CARD_CHANNEL_ID, messageId: CARD_MESSAGE_ID });
            });

            test('should still resolve and leave editReply outcome intact when notify throws', async () => {
                const notify = mock((_params: NotifyParams): boolean => {
                    throw new Error('notify boom');
                });
                const deps    = makeDeps({ notify });
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();

                expect(editReply).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    uid: 42,
                    msg: 'Notify failed for email approval',
                }));
            });

            test('a failed pending edit after the approval is recorded is logged, offers no retry, and still notes the approval', async () => {
                const notify = mock((_params: NotifyParams) => true);
                const deps    = makeDeps({ notify });
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                const editError = new Error('Discord timeout');
                editReply.mockRejectedValueOnce(editError);

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();

                expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
                expect(notify).toHaveBeenCalledTimes(1);
                expect(editReply).toHaveBeenCalledTimes(1);
                expect(mockLogger.error).not.toHaveBeenCalled();
                expect(mockLogger.warn).toHaveBeenCalledWith({
                    err:       editError,
                    channelId: CARD_CHANNEL_ID,
                    messageId: CARD_MESSAGE_ID,
                    msg:       'Failed to show the pending approval card — the send outcome will replace it',
                });
            });
        });

        describe('approve+allowlist (email-send-approveallowlist) — shows select menu', () => {
            test('should show select menu with all recipients when draft has to and cc message fields', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({
                    to: [{ address: 'target@example.com' }],
                    cc: [{ address: 'cc1@example.com' }, { address: 'cc2@example.com' }],
                }));
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                // Should show select menu via editReply, NOT submit
                expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
                expect(editReply).toHaveBeenCalledTimes(1);
                const replyArg = editReply.mock.calls[0]?.[0];
                expect(replyArg.components).toBeDefined();
                expect(replyArg.components).toHaveLength(1);
            });

            test('should call getMessage to get draft recipients for select menu', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                expect(deps.wildDuckClient.getMessage).toHaveBeenCalledWith('Drafts', 42, expect.any(AbortSignal));
            });

            test('marks the card of a vanished draft and approves nothing', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(null);
                const handler = makeAdapter(deps);
                const { interaction, editReply, followUp } = makeButtonInteraction('email-send-approveallowlist:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();

                expect(deps.sagaBackend.create).not.toHaveBeenCalled();
                expect(followUp).not.toHaveBeenCalled();
                const replyArg = editReply.mock.calls[0]?.[0] as { content: null, embeds: { toJSON: () => unknown }[], components: unknown[] };
                expect(replyArg.content).toBeNull();
                expect(replyArg.embeds.map(embed => embed.toJSON())).toEqual([{ title: 'Draft no longer exists — nothing was sent', color: 0x99_AA_B5 }]);
                expect(replyArg.components).toEqual([]);
            });

            test('an unreadable draft is refused privately — no fallback approve', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('fetch failed'));
                const handler = makeAdapter(deps);
                const { interaction, editReply, followUp } = makeButtonInteraction('email-send-approveallowlist:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();

                expect(deps.sagaBackend.create).not.toHaveBeenCalled();
                expect(editReply).not.toHaveBeenCalled();
                expect(followUp.mock.calls).toEqual([[{ content: 'Couldn\'t read the draft from WildDuck (fetch failed) — nothing was changed; try again.', flags: MessageFlags.Ephemeral }]]);
            });

            test('should fall back to simple approve when draft has no to and no cc message fields', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({ to: [], cc: [] }));
                const handler = makeAdapter(deps);
                const { interaction, cardFetch } = makeButtonInteraction('email-send-approveallowlist:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();
                // Falls back to simple approve — saga is created, after a second fresh card check
                expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
                expect(cardFetch).toHaveBeenCalledTimes(2);
            });

            test('should deduplicate recipients when to appears in cc — only one Select Menu option created', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({
                    // 'duplicate@example.com' appears in both to and cc
                    to: [{ address: 'duplicate@example.com' }],
                    cc: [{ address: 'duplicate@example.com' }, { address: 'other@example.com' }],
                }));
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                // Should show select menu (not fall back to simple approve)
                expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
                expect(editReply).toHaveBeenCalledTimes(1);

                const replyArg = editReply.mock.calls[0]?.[0];
                // The select menu component should have deduplicated options
                const menuOptions = (replyArg as { components: { components: { options: { data: { value: string } }[] }[] }[] })
                    .components[0].components[0].options;
                expect(menuOptions).toBeDefined();
                // 'duplicate@example.com' should appear only once; 'other@example.com' once → total 2
                expect(menuOptions).toHaveLength(2);
                const values = menuOptions.map((o: { data: { value: string } }) => o.data.value);
                expect(values).toContain('duplicate@example.com');
                expect(values).toContain('other@example.com');
                // No duplicates
                expect(new Set(values).size).toBe(2);
            });

            test('should omit missing recipient fields instead of presenting a synthetic recipient', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({
                    to: [{ address: 'recipient@example.com' }],
                }));
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { components: { components: { options: { data: { value: string } }[] }[] }[] };
                const options = replyArg.components[0].components[0].options;
                expect(options.map(option => option.data.value)).toEqual(['recipient@example.com']);
            });

            test('should preserve recipient addresses and allowlist prompt text in the select menu', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({
                    to: [{ address: 'recipient@example.com' }],
                    cc: [],
                }));
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as {
                    content:    string
                    components: { components: { data: { placeholder: string, min_values: number }, options: { data: { value: string } }[] }[] }[]
                };
                expect(replyArg.content).toBe('Select recipients to add to allowlist, then click Submit:');
                expect(replyArg.components[0].components[0].data.placeholder).toBe('Select recipients to add to allowlist');
                expect(replyArg.components[0].components[0].data.min_values).toBe(0);
                expect(replyArg.components[0].components[0].options[0].data.value).toBe('recipient@example.com');
            });

            test('should omit to/cc entries that carry no address instead of offering them as recipients', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({
                    // Address-less entries are what a draft with a malformed recipient looks like —
                    // they must not become selectable allowlist options.
                    to: [{ address: 'to@example.com' }, { name: 'To Without Address' }],
                    cc: [{ address: 'cc@example.com' }, { name: 'Cc Without Address' }],
                }));
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { components: { components: { options: { data: { value: string } }[] }[] }[] };
                const options = replyArg.components[0]?.components[0]?.options ?? [];
                expect(options.map(option => option.data.value)).toEqual(['to@example.com', 'cc@example.com']);
            });

            test('should offer to-recipients before cc-recipients in the select menu', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({
                    to: [{ address: 'to1@example.com' }, { address: 'to2@example.com' }],
                    cc: [{ address: 'cc1@example.com' }],
                }));
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { components: { components: { options: { data: { value: string } }[] }[] }[] };
                const options = replyArg.components[0]?.components[0]?.options ?? [];
                expect(options.map(option => option.data.value)).toEqual(['to1@example.com', 'to2@example.com', 'cc1@example.com']);
            });

            test('offers all 25 recipients when the draft has exactly Discord\'s select-menu maximum', async () => {
                const deps = makeDeps();
                const to = Array.from({ length: 25 }, (_, i) => ({ address: `r${i}@example.com` }));
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({ to, cc: [] }));
                const handler = makeAdapter(deps);
                const { interaction, editReply, followUp } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                expect(followUp).not.toHaveBeenCalled();
                const replyArg = editReply.mock.calls[0]?.[0] as { components: { components: { data: { max_values: number }, options: unknown[] }[] }[] };
                expect(replyArg.components[0].components[0].data.max_values).toBe(25);
                expect(replyArg.components[0].components[0].options).toHaveLength(25);
            });

            test('refuses the allowlist route privately, leaving the card untouched, when the draft has more than 25 recipients', async () => {
                const deps = makeDeps();
                const to = Array.from({ length: 20 }, (_, i) => ({ address: `to${i}@example.com` }));
                const cc = Array.from({ length: 6 }, (_, i) => ({ address: `cc${i}@example.com` }));
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({ to, cc }));
                const handler = makeAdapter(deps);
                const { interaction, editReply, followUp } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                expect(editReply).not.toHaveBeenCalled();
                expect(deps.sagaBackend.create).not.toHaveBeenCalled();
                expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
                expect(followUp.mock.calls).toEqual([[{
                    content: 'This draft has 26 recipients, more than the 25 a Discord menu can offer, so they can\'t be allowlisted from this card — nothing was approved. Use Approve, or allowlist them another way first.',
                    flags:   MessageFlags.Ephemeral,
                }]]);
            });

            test('refuses privately, reading nothing, when the card no longer acts on the uid', async () => {
                const deps = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, editReply, followUp, cardFetch } = makeButtonInteraction('email-send-approveallowlist:42');
                cardFetch.mockImplementation(async () => liveCard(55));

                await handler.handleButton(interaction);

                expect(cardFetch.mock.calls).toEqual([[true]]);
                expect(deps.wildDuckClient.getMessage).not.toHaveBeenCalled();
                expect(editReply).not.toHaveBeenCalled();
                expect(followUp.mock.calls).toEqual([[{ content: STALE_CARD, flags: MessageFlags.Ephemeral }]]);
            });

            test('refuses privately when the draft was already decided', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({ metaData: { rejectedAt: 'earlier' } }));
                const handler = makeAdapter(deps);
                const { interaction, editReply, followUp } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                expect(editReply).not.toHaveBeenCalled();
                expect(followUp.mock.calls).toEqual([[{ content: 'This draft was already approved or rejected.', flags: MessageFlags.Ephemeral }]]);
            });

            test('holds the card while reading the recipients and showing the menu, then releases it', async () => {
                const cardEdits = new ApprovalCardEditGate();
                const deps = makeDeps();
                const heldDuring: string[] = [];
                const handler = makeAdapter(deps, cardEdits);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');
                editReply.mockImplementation(async () => {
                    heldDuring.push(cardEdits.pendingEdit(CARD_MESSAGE_ID) === undefined ? 'free' : 'held');
                    return {};
                });

                await handler.handleButton(interaction);

                expect(heldDuring).toEqual(['held']);
                expect(cardEdits.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
            });
        });

        describe('reject (email-send-reject)', () => {
            test('should show a modal for rejection reason without deferUpdate', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, deferUpdate, showModal } = makeButtonInteraction('email-send-reject:42');

                await handler.handleButton(interaction);

                expect(deferUpdate).not.toHaveBeenCalled();
                expect(showModal).toHaveBeenCalledTimes(1);
                expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
            });

            test('should show modal with customId containing uid', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, showModal } = makeButtonInteraction('email-send-reject:99');

                await handler.handleButton(interaction);

                expect(showModal).toHaveBeenCalledTimes(1);
                const modalArg = showModal.mock.calls[0]?.[0] as { data: { custom_id: string } };
                expect(modalArg.data.custom_id).toContain('99');
            });

            test('should set rejection reason text input as not required', async () => {
                const deps    = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, showModal } = makeButtonInteraction('email-send-reject:42');

                await handler.handleButton(interaction);

                expect(showModal).toHaveBeenCalledTimes(1);
                // Use toJSON() to access the serialized modal data including component properties
                // LabelBuilder (Components V2) produces { components: [{ component: { required } }] }
                const modalArg = showModal.mock.calls[0]?.[0] as { toJSON: () => {
                    components: { component: { custom_id?: string, required?: boolean } }[]
                } };
                const modalJson = modalArg.toJSON();
                // The text input should be optional (not required)
                const textInput = modalJson.components[0].component;
                expect(textInput.custom_id).toBe('reject-reason');
                expect(textInput.required).toBe(false);
            });
        });

        describe('error handling', () => {
            test('a failed row write is explained privately, never shows the pending card, and leaves the card for a retry', async () => {
                const deps = makeDeps();
                (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB write failed'));
                const cardEdits = new ApprovalCardEditGate();
                const handler = makeAdapter(deps, cardEdits);
                const { interaction, editReply, followUp } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(editReply).not.toHaveBeenCalled();
                expect(followUp.mock.calls).toEqual([[{
                    content: 'Couldn\'t record the approval (DynamoDB write failed) — nothing will be sent until it is; try again.',
                    flags:   MessageFlags.Ephemeral,
                }]]);
                expect(deps.notify).not.toHaveBeenCalled();
                expect(cardEdits.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
            });

            test('should call editReply with embeds and components cleared on an unexpected error', async () => {
                const deps = makeDeps({ activityLogger: { log: () => {
                    throw new Error('activity logger broken');
                } } });
                const handler = makeAdapter(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                const editReplyArg = editReply.mock.calls[0]?.[0];
                expect(editReplyArg.embeds).toEqual([]);
                expect(editReplyArg.components).toEqual([]);
                expect(editReplyArg.content).toBe('An error occurred processing your request. Please try again.');
                expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
                    prefix: 'email-send-approve',
                    msg:    'Outbound approval button handler failed',
                }));
            });

            test('should log error if editReply fails after error', async () => {
                const deps = makeDeps({ activityLogger: { log: () => {
                    throw new Error('activity logger broken');
                } } });
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                editReply.mockRejectedValue(new Error('Discord error'));
                const handler = makeAdapter(deps);

                await handler.handleButton(interaction);

                expect(mockLogger.error).toHaveBeenCalledTimes(2);
                expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
                    msg: 'Failed to send error editReply',
                }));
            });

            test('should NOT call editReply when reject path (showModal) throws', async () => {
                // Reject path does not defer, so editReply must not be called on error
                const deps = makeDeps();
                const handler = makeAdapter(deps);
                const { interaction, editReply, showModal } = makeButtonInteraction('email-send-reject:42');
                showModal.mockRejectedValue(new Error('modal failed'));

                await handler.handleButton(interaction);

                // editReply should NOT be called — interaction was not deferred
                expect(editReply).not.toHaveBeenCalled();
                expect(mockLogger.error).toHaveBeenCalled();
            });
        });
    });

    describe('handleModalSubmit()', () => {
        test('should return early for unknown prefix', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate } = makeModalInteraction('email-other-modal:42');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
        });

        test('should return early for malformed customId with no colon', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const parseId = spyOn(handler as unknown as { parseId: (raw: string) => number | null }, 'parseId');
            const { interaction, deferUpdate } = makeModalInteraction('email-send-reject-reason');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
            expect(parseId).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate } = makeModalInteraction('email-send-reject-reason:notanumber');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should deferUpdate, call updateMessageMetadata with reason, set flag via wildDuck, update embed, log info', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(interaction.fields.getTextInputValue).toHaveBeenCalledWith('reject-reason');
            expect(deps.wildDuckClient.updateMessageMetadata).toHaveBeenCalledTimes(1);
            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect(updateArgs[0]).toBe('Drafts');
            expect(updateArgs[1]).toBe(42);
            expect((updateArgs[2] as Record<string, unknown>).reason).toBe('Not appropriate');
            expect(deps.wildDuckClient.updateMessageFlags).toHaveBeenCalledWith('Drafts', 42, { addFlags: [DRAFT_STATE_FLAG.rejected_by_admin] });
            expect(editReply).toHaveBeenCalledTimes(1);
            expect(mockLogger.info).toHaveBeenCalledTimes(1);
            const infoArg = (mockLogger.info as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
            expect(infoArg.uid).toBe(42);
            expect(infoArg.reason).toBe('Not appropriate');
            expect(infoArg.discordUpdated).toBe(true);
            expect(infoArg.msg).toBe('Discord admin rejected outbound email');
        });

        test('should log a rejected fire-and-forget activity write on the rejection path', async () => {
            const activityError = new Error('activity unavailable');
            const activityLogger = { log: mock(async () => {
                throw activityError;
            }) };
            const deps    = makeDeps({ activityLogger });
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42');

            await handler.handleModalSubmit(interaction);
            await Promise.resolve();

            expect(activityLogger.log).toHaveBeenCalledWith({
                type:    'email-rejected',
                summary: 'Email rejected',
            });
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: activityError,
                msg: 'Activity log failed for email rejection',
            });
        });

        test('should include rejectedAt timestamp in updateMessageMetadata call', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs[2] as Record<string, unknown>).rejectedAt).toBeDefined();
        });

        test('should NOT include to or subject in updateMessageMetadata call (stored as message fields)', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs[2] as Record<string, unknown>).to).toBeUndefined();
            expect((updateArgs[2] as Record<string, unknown>).subject).toBeUndefined();
        });

        test('merges the rejection into the draft\'s metaData, keeping its card link', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.getMessage).toHaveBeenCalledWith('Drafts', 42, expect.any(AbortSignal));
            const written = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0][2] as Record<string, unknown>;
            expect(written.approvalCard).toEqual({ channelId: CARD_CHANNEL_ID, messageId: CARD_MESSAGE_ID, edits: 0 });
            expect(written.reason).toBe('Bad content');
        });

        test('reads the card fresh inside the card\'s exclusive hold before rejecting, then releases it', async () => {
            const cardEdits = new ApprovalCardEditGate();
            const deps    = makeDeps();
            const handler = makeAdapter(deps, cardEdits);
            const heldDuring: string[] = [];
            const { interaction, cardFetch } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');
            cardFetch.mockImplementation(async () => {
                heldDuring.push(cardEdits.pendingEdit(CARD_MESSAGE_ID) === undefined ? 'fetch:free' : 'fetch:held');
                return liveCard(42);
            });

            await handler.handleModalSubmit(interaction);

            expect(heldDuring).toEqual(['fetch:held']);
            expect(cardFetch.mock.calls).toEqual([[true]]);
            expect(cardEdits.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
        });

        test.each([
            ['acts on another uid', async () => liveCard(55), STALE_CARD],
            ['has no live controls', async () => liveCard(undefined), STALE_CARD],
            ['cannot be read', async () => {
                throw new Error('Unknown Message');
            }, CARD_UNREADABLE],
        ])('refuses privately, rejecting nothing and leaving the card, when the card %s', async (_label, fetchCard, expected) => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, editReply, followUp, cardFetch } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');
            cardFetch.mockImplementation(fetchCard);

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.getMessage).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
            expect(deps.notify).not.toHaveBeenCalled();
            expect(followUp.mock.calls).toEqual([[{ content: expected, flags: MessageFlags.Ephemeral }]]);
        });

        test('refuses privately when the modal has no message to check', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, followUp } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');
            (interaction as unknown as { message: null }).message = null;

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
            expect(followUp.mock.calls).toEqual([[{ content: CARD_UNREADABLE, flags: MessageFlags.Ephemeral }]]);
        });

        test('refuses privately when the draft was already approved (its row exists)', async () => {
            const deps    = makeDeps();
            (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(storedDraft({ metaData: { approval: { actionId: 'act-1', at: 'x' } } }));
            (deps.sagaBackend.get as ReturnType<typeof mock>).mockResolvedValue({ id: 'act-1' });
            const handler = makeAdapter(deps);
            const { interaction, editReply, followUp } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
            expect(deps.notify).not.toHaveBeenCalled();
            expect(followUp.mock.calls).toEqual([[{ content: 'This draft was already approved or rejected.', flags: MessageFlags.Ephemeral }]]);
        });

        test('marks the card of a vanished draft instead of rejecting', async () => {
            const deps    = makeDeps();
            (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(null);
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
            expect(deps.notify).not.toHaveBeenCalled();
            const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { toJSON: () => unknown }[], components: unknown[] };
            expect(replyArg.embeds.map(embed => embed.toJSON())).toEqual([{ title: 'Draft no longer exists — nothing was sent', color: 0x99_AA_B5 }]);
            expect(replyArg.components).toEqual([]);
        });

        test('a failure to mark a vanished draft\'s card is only logged', async () => {
            const deps    = makeDeps();
            (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(null);
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');
            const failure = new Error('edit refused');
            editReply.mockRejectedValueOnce(failure);

            await expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: 42, msg: 'Failed to mark the approval card of a vanished draft' });
        });

        test('should show "Rejected" title with reason in description after reject', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Off topic');

            await handler.handleModalSubmit(interaction);

            const replyArg = editReply.mock.calls[0]?.[0] as {
                embeds:     { data: { title: string, description: string } }[]
                components: unknown[]
            };
            expect(replyArg.embeds).toHaveLength(1);
            expect(replyArg.components).toHaveLength(0);
            expect(replyArg.embeds[0].data.title).toBe('Rejected');
            expect(replyArg.embeds[0].data.description).toBe('Off topic');
        });

        test('should use "No reason given" when reason is empty', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', '');

            await expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs[2] as Record<string, unknown>).reason).toBe('No reason given');
        });

        test('should set flag via wildDuckClient.updateMessageFlags after rejection', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.updateMessageFlags).toHaveBeenCalledWith('Drafts', 42, { addFlags: [DRAFT_STATE_FLAG.rejected_by_admin] });
        });

        test('should NOT submit message after rejection (draft stays in Drafts)', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
        });

        test('should log error and show error embed with original buttons when updateMessageMetadata fails', async () => {
            const deps = makeDeps();
            (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mockRejectedValue(new Error('WildDuck error'));
            const handler = makeAdapter(deps);
            const originalComponents = [{ type: 1, components: [] }];
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate', {
                embeds:     [{ data: { title: 'Pending Approval', description: 'please approve' } }],
                components: originalComponents,
            });

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to persist email rejection to WildDuck — Discord message left active for retry',
            }));
            // Should NOT update Discord to "Rejected"
            expect(mockLogger.info).not.toHaveBeenCalled();
            // editReply called with error embed appended + original buttons
            expect(editReply).toHaveBeenCalledTimes(1);
            const replyArg = editReply.mock.calls[0]?.[0] as {
                embeds:     unknown[]
                components: unknown[]
            };
            expect(replyArg.embeds.length).toBeGreaterThan(0);
            expect(replyArg.embeds).toHaveLength(2);
            const lastEmbed = replyArg.embeds[replyArg.embeds.length - 1] as { data: { title: string } };
            expect(lastEmbed.data.title).toContain('Rejection failed');
            expect(replyArg.components).toBe(originalComponents);
        });

        test('should log error twice when WildDuck fails and error editReply also fails', async () => {
            const deps = makeDeps();
            (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mockRejectedValue(new Error('WildDuck error'));
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42');
            editReply.mockRejectedValue(new Error('Discord also down'));

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.error).toHaveBeenCalledTimes(2);
            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to send error editReply for rejection',
            }));
        });

        test('should notify wake:true with key <uid>:rejected after the Discord editReply block', async () => {
            const order: string[] = [];
            const notify = mock((_params: NotifyParams) => {
                order.push('notify');
                return true;
            });
            const deps    = makeDeps({ notify });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');
            editReply.mockImplementation(async () => {
                order.push('editReply');
                return {};
            });

            await handler.handleModalSubmit(interaction);

            expect(order).toEqual(['editReply', 'notify']);
            expect(notify).toHaveBeenCalledTimes(1);
            const call = notify.mock.calls[0]?.[0];
            expect(call.source).toBe('email-approval');
            expect(call.wake).toBe(true);
            expect(call.key).toBe('42:rejected');
            expect(call.text).toBe('Outbound email (uid 42) rejected by admin. Reason: Not appropriate');
        });

        test('should leave the rejection resolved and persisted when notify throws', async () => {
            const notify = mock((_params: NotifyParams): boolean => {
                throw new Error('notify boom');
            });
            const deps    = makeDeps({ notify });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            expect(deps.wildDuckClient.updateMessageMetadata).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                uid: 42,
                msg: 'Notify failed for email rejection',
            }));
        });

        test('should not fail the rejection when notify returns false', async () => {
            const notify = mock((_params: NotifyParams) => false);
            const deps    = makeDeps({ notify });
            const handler = makeAdapter(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            expect(mockLogger.info).toHaveBeenCalledTimes(1);
        });

        test('should log warn and info with discordUpdated:false when editReply fails after WildDuck persist succeeds', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');
            editReply.mockRejectedValue(new Error('Discord timeout'));

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to update Discord embed after email rejection',
            }));
            expect(mockLogger.info).toHaveBeenCalledTimes(1);
            const infoArg = (mockLogger.info as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
            expect(infoArg.discordUpdated).toBe(false);
            expect(infoArg.msg).toBe('Discord admin rejected outbound email');
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });

    describe('handleSelectMenu()', () => {
        test('should return early for unknown prefix', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-other-select:42', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.sagaBackend.create).not.toHaveBeenCalled();
        });

        test('should return early for malformed customId with no colon', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-allowlist-select', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.sagaBackend.create).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-allowlist-select:notanumber', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should deferUpdate, create saga, update embed to Approved when recipients selected', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, deferUpdate, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', ['addr@example.com']);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('should log a rejected fire-and-forget activity write on the allowlist approval path', async () => {
            const activityError = new Error('activity unavailable');
            const activityLogger = { log: mock(async () => {
                throw activityError;
            }) };
            const deps    = makeDeps({ activityLogger });
            const handler = makeAdapter(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['addr@example.com']);

            await handler.handleSelectMenu(interaction);
            await Promise.resolve();

            expect(activityLogger.log).toHaveBeenCalledWith({
                type:    'email-send-approved',
                summary: 'Email approved for sending',
            });
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: activityError,
                msg: 'Activity log failed for email send (allowlist path)',
            });
        });

        test('should create saga with correct type and uid param', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, cardFetch } = makeSelectMenuInteraction('email-allowlist-select:99', ['a@example.com']);
            cardFetch.mockImplementation(async () => liveCard(99));

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
                type:   string
                state:  string
                params: Record<string, unknown>
            };
            expect(createArg.type).toBe('email_send');
            expect(createArg.state).toBe('approved');
            expect(createArg.params.uid).toBe(99);
        });

        test('should read the customId uid as decimal, never as a 0x-prefixed hexadecimal number', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, cardFetch } = makeSelectMenuInteraction('email-allowlist-select:0x2a', []);
            cardFetch.mockImplementation(async () => liveCard(0));

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
                params: Record<string, unknown>
            };
            // parseInt('0x2a', 10) stops at 'x' and yields 0; a radix of 0 would read it as hex (42).
            expect(createArg.params.uid).toBe(0);
        });

        test('should create the saga with a fresh UUID id, not the id parsed from the customId', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']);

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as { id: string };
            // Every saga row is keyed by this id; reusing the draft uid would collide across approvals.
            expect(createArg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        });

        test('should stamp the saga createdAt and updatedAt as ISO-8601 timestamps', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']);

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as { createdAt: string, updatedAt: string };
            expect(createArg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(createArg.updatedAt).toBe(createArg.createdAt);
        });

        test('should create saga and kick off allowlist saga for each selected recipient (person-based saga flow)', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com', 'b@example.com']);

            await handler.handleSelectMenu(interaction);

            expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
            expect(deps.allowlistInteractionHandler.startFromApproval).toHaveBeenCalledTimes(2);
        });

        test('should create saga and not call startFromApproval when no recipients selected', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await handler.handleSelectMenu(interaction);

            expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
            expect(deps.allowlistInteractionHandler.startFromApproval).not.toHaveBeenCalled();
        });

        test('a failed row write is explained privately, and nothing is allowlisted or announced', async () => {
            const deps = makeDeps();
            (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB failed'));
            const handler = makeAdapter(deps);
            const { interaction, editReply, followUp } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']);

            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();

            expect(editReply).not.toHaveBeenCalled();
            expect(deps.allowlistInteractionHandler.startFromApproval).not.toHaveBeenCalled();
            expect(deps.notify).not.toHaveBeenCalled();
            expect(followUp.mock.calls).toEqual([[{
                content: 'Couldn\'t record the approval (DynamoDB failed) — nothing will be sent until it is; try again.',
                flags:   MessageFlags.Ephemeral,
            }]]);
        });

        test('a select from a card that no longer acts on the uid is refused privately, approving and allowlisting nothing', async () => {
            const deps = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, followUp, cardFetch } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']);
            cardFetch.mockImplementation(async () => liveCard(55));

            await handler.handleSelectMenu(interaction);

            expect(deps.wildDuckClient.getMessage).not.toHaveBeenCalled();
            expect(deps.sagaBackend.create).not.toHaveBeenCalled();
            expect(deps.allowlistInteractionHandler.startFromApproval).not.toHaveBeenCalled();
            expect(followUp.mock.calls).toEqual([[{ content: STALE_CARD, flags: MessageFlags.Ephemeral }]]);
        });

        test('should show error editReply on an unexpected error', async () => {
            const deps = makeDeps({ activityLogger: { log: () => {
                throw new Error('activity logger broken');
            } } });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();
            expect(mockLogger.error).toHaveBeenCalledWith({
                err: expect.any(Error),
                uid: 42,
                msg: 'Failed to process allowlist select menu',
            });
            expect(editReply).toHaveBeenCalledTimes(1);
            const replyArg = editReply.mock.calls[0]?.[0];
            expect(replyArg.content).toContain('error occurred');
        });

        test('a failed pending edit on the select menu after the approval is recorded still allowlists and notes the approval', async () => {
            const deps = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']);
            editReply.mockRejectedValueOnce(new Error('Discord timeout'));

            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();

            expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
            expect(deps.allowlistInteractionHandler.startFromApproval).toHaveBeenCalledTimes(1);
            expect(deps.notify).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        test('select menu holds the card on the edit gate while recording and showing pending, then releases it', async () => {
            const cardEdits = new ApprovalCardEditGate();
            const heldDuring: string[] = [];
            const create = mock(async () => {
                heldDuring.push(cardEdits.pendingEdit(CARD_MESSAGE_ID) === undefined ? 'create:free' : 'create:held');
            });
            const deps    = makeDeps({ sagaBackend: { create } as unknown as ApprovedOutboundActionBackend });
            const handler = makeAdapter(deps, cardEdits);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            editReply.mockImplementation(async () => {
                heldDuring.push(cardEdits.pendingEdit(CARD_MESSAGE_ID) === undefined ? 'editReply:free' : 'editReply:held');
                return {};
            });

            await handler.handleSelectMenu(interaction);

            expect(heldDuring).toEqual(['create:held', 'editReply:held']);
            expect(cardEdits.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
        });

        test('select menu approve passes the card ref from interaction.message', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as { approvalCard: unknown };
            expect(createArg.approvalCard).toEqual({ channelId: CARD_CHANNEL_ID, messageId: CARD_MESSAGE_ID });
        });

        test('should log error when editReply fails after an unexpected error', async () => {
            const deps = makeDeps({ activityLogger: { log: () => {
                throw new Error('activity logger broken');
            } } });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            editReply.mockRejectedValue(new Error('Discord error'));

            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();
            expect(mockLogger.error).toHaveBeenCalledTimes(2);
            expect(mockLogger.error).toHaveBeenCalledWith({
                err: expect.any(Error),
                msg: 'Failed to send error editReply for select menu',
            });
        });

        test('should show the pending sending embed, no components and no content on success', async () => {
            const deps    = makeDeps();
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await handler.handleSelectMenu(interaction);

            const replyArg = editReply.mock.calls[0]?.[0] as { content: unknown, embeds: { toJSON: () => unknown }[], components: unknown[] };
            expect(replyArg.embeds.map(embed => embed.toJSON())).toEqual([PENDING_EMBED]);
            expect(replyArg.components).toEqual([]);
            expect(replyArg.content).toBeNull();
        });

        test('select menu records the approval, then edits the card to pending, then allowlists, and notes it once without waking', async () => {
            const order: string[] = [];
            const notify = mock((_params: NotifyParams) => {
                order.push('notify');
                return true;
            });
            const create = mock(async () => {
                order.push('create');
            });
            const startFromApproval = mock(async () => {
                order.push('allowlist');
                return { allowlistSuffix: '' };
            });
            const deps    = makeDeps({
                notify,
                sagaBackend:                 { create } as unknown as ApprovedOutboundActionBackend,
                allowlistInteractionHandler: { startFromApproval } as unknown as AllowlistInteractionHandler,
            });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com', 'b@example.com']);
            editReply.mockImplementation(async () => {
                order.push('editReply');
                return {};
            });

            await handler.handleSelectMenu(interaction);

            expect(order).toEqual(['create', 'editReply', 'allowlist', 'allowlist', 'notify']);
            expect(notify.mock.calls).toEqual([[{
                source: 'email-approval',
                wake:   false,
                key:    '42:approved',
                text:   'Outbound email (uid 42) approved by admin; sending now. You will be notified when it has been sent or has failed.',
            }]]);
        });

        test('should still resolve and leave editReply outcome intact when notify throws', async () => {
            const notify = mock((_params: NotifyParams): boolean => {
                throw new Error('notify boom');
            });
            const deps    = makeDeps({ notify });
            const handler = makeAdapter(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();

            expect(editReply).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                uid: 42,
                msg: 'Notify failed for email approval',
            }));
        });
    });
});

describe('EmailApprovalInteractionAdapter over mocked operations', () => {
    function makeOpsAdapter(recipients: string[] | undefined, cardEdits?: ApprovalCardEditGate): {
        adapter: EmailApprovalInteractionAdapter
        events:  string[]
    } {
        const events: string[] = [];
        const approvals = {
            approveSend: mock(async (uid: number, via: string) => {
                events.push(`approveSend:${uid}:${via}`);
                return { status: 'recorded' };
            }),
            rejectSend: mock(async (uid: number, reason: string) => {
                events.push(`rejectSend:${uid}:${reason}`);
                return { status: 'rejected' };
            }),
            allowlistCandidates: mock(async (uid: number) => {
                events.push(`allowlistCandidates:${uid}`);
                return recipients === undefined
                    ? { status: 'refused', reason: 'unreadable', detail: 'Couldn\'t read the draft from WildDuck (down)' }
                    : { status: 'ok', recipients };
            }),
            announceApproved: mock((uid: number) => {
                events.push(`announceApproved:${uid}`);
            }),
            announceRejected: mock((uid: number, reason: string) => {
                events.push(`announceRejected:${uid}:${reason}`);
            }),
        } as unknown as EmailOutboundApprovals;
        const allowlist = {
            startFromApproval: mock(async (_interaction: unknown, platform: string, identifier: string) => {
                events.push(`startFromApproval:${platform}:${identifier}`);
                return { allowlistSuffix: '' };
            }),
        };
        return { adapter: new EmailApprovalInteractionAdapter({ approvals, allowlist, cardEdits }), events };
    }

    function trackInteraction<T extends { deferUpdate: ReturnType<typeof mock>, editReply: ReturnType<typeof mock>, followUp: ReturnType<typeof mock>, cardFetch: CardFetch }>(parts: T, events: string[]): T {
        parts.deferUpdate.mockImplementation(async () => {
            events.push('deferUpdate');
            return {};
        });
        parts.editReply.mockImplementation(async () => {
            events.push('editReply');
            return {};
        });
        parts.followUp.mockImplementation(async () => {
            events.push('followUp');
            return {};
        });
        parts.cardFetch.mockImplementation(async () => {
            events.push('cardFetch');
            return liveCard(42);
        });
        return parts;
    }

    test('an approve button acknowledges, then approves the parsed uid directly, then shows the pending card, then announces', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const { interaction } = trackInteraction(makeButtonInteraction('email-send-approve:42'), events);

        await adapter.handleButton(interaction);

        expect(events).toEqual(['deferUpdate', 'cardFetch', 'approveSend:42:direct', 'editReply', 'announceApproved:42']);
    });

    test.each([
        ['gone', 'edits the card', ['deferUpdate', 'cardFetch', 'approveSend:42:direct', 'editReply']],
        ['decided', 'replies privately', ['deferUpdate', 'cardFetch', 'approveSend:42:direct', 'followUp']],
        ['unreadable', 'replies privately', ['deferUpdate', 'cardFetch', 'approveSend:42:direct', 'followUp']],
        ['unrecorded', 'replies privately', ['deferUpdate', 'cardFetch', 'approveSend:42:direct', 'followUp']],
    ] as const)('a %s refusal %s, never shows the pending card and never announces', async (reason, _does, expected) => {
        mockLogger.info.mockClear();
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const approvals = (adapter as unknown as { approvals: { approveSend: ReturnType<typeof mock> } }).approvals;
        approvals.approveSend.mockImplementation(async (uid: number, via: string) => {
            events.push(`approveSend:${uid}:${via}`);
            return { status: 'refused', reason, detail: `detail for ${reason}` };
        });
        const parts = trackInteraction(makeButtonInteraction('email-send-approve:42'), events);

        await adapter.handleButton(parts.interaction);

        expect(events).toEqual([...expected]);
        const content = (parts.followUp.mock.calls[0]?.[0] as { content?: string } | undefined)?.content;
        const expectedContent = {
            gone:       undefined,
            decided:    'This draft was already approved or rejected.',
            unreadable: 'detail for unreadable — nothing was changed; try again.',
            unrecorded: 'detail for unrecorded',
        }[reason];
        expect(content).toBe(expectedContent);
        expect(mockLogger.info.mock.calls).toEqual([[{ uid: 42, reason, detail: `detail for ${reason}`, msg: 'Email approval decision refused' }]]);
    });

    test('a private reply is cut to Discord\'s 2000-character limit, and a failed one is only logged', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const approvals = (adapter as unknown as { approvals: { approveSend: ReturnType<typeof mock> } }).approvals;
        approvals.approveSend.mockImplementation(async () => ({ status: 'refused', reason: 'unrecorded', detail: 'x'.repeat(2500) }));
        const parts = trackInteraction(makeButtonInteraction('email-send-approve:42'), events);
        const failure = new Error('followUp failed');
        parts.followUp.mockRejectedValueOnce(failure);

        await expect(adapter.handleButton(parts.interaction)).resolves.toBeUndefined();

        const content = (parts.followUp.mock.calls[0]?.[0] as { content: string }).content;
        expect(content).toBe(`${'x'.repeat(1997)}...`);
        expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, msg: 'Failed to send a private reply to an email approval click' });
    });

    test('takes the card key before the draft key, and holds it across the decision', async () => {
        const acquired: string[] = [];
        class RecordingGate extends ApprovalCardEditGate {
            override async acquire(key: string): Promise<() => void> {
                acquired.push(key);
                return super.acquire(key);
            }
        }
        const gate = new RecordingGate();
        const deps = makeDeps();
        const handler = makeAdapter(deps, gate);
        const { interaction } = makeButtonInteraction('email-send-approve:42');

        await handler.handleButton(interaction);

        expect(acquired).toEqual([CARD_MESSAGE_ID, 'email-draft:42']);
        expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
    });

    test('a click waiting behind a repaint of its card reads the repainted card and refuses the stale uid', async () => {
        const gate = new ApprovalCardEditGate();
        const deps = makeDeps();
        const handler = makeAdapter(deps, gate);
        const { interaction, cardFetch, followUp } = makeButtonInteraction('email-send-approve:42');
        const releaseRepaint = gate.hold(CARD_MESSAGE_ID);

        const clicking = handler.handleButton(interaction);
        await drainMicrotasks();
        expect(cardFetch).not.toHaveBeenCalled();

        cardFetch.mockImplementation(async () => liveCard(55));
        releaseRepaint();
        await clicking;

        expect(deps.sagaBackend.create).not.toHaveBeenCalled();
        expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
        expect(followUp.mock.calls).toEqual([[{ content: STALE_CARD, flags: MessageFlags.Ephemeral }]]);
    });

    test.each([
        ['acts on another uid', async () => liveCard(55), STALE_CARD, 'stale'],
        ['has no live controls', async () => liveCard(undefined), STALE_CARD, 'stale'],
        ['cannot be read', async () => {
            throw new Error('Unknown Message');
        }, CARD_UNREADABLE, 'unreadable'],
    ])('an approve on a card that %s is refused privately and records nothing', async (_label, fetchCard, expected, check) => {
        mockLogger.info.mockClear();
        const deps = makeDeps();
        const handler = makeAdapter(deps);
        const { interaction, cardFetch, followUp, editReply } = makeButtonInteraction('email-send-approve:42');
        cardFetch.mockImplementation(fetchCard);

        await handler.handleButton(interaction);

        expect(deps.wildDuckClient.getMessage).not.toHaveBeenCalled();
        expect(deps.sagaBackend.create).not.toHaveBeenCalled();
        expect(editReply).not.toHaveBeenCalled();
        expect(deps.notify).not.toHaveBeenCalled();
        expect(followUp.mock.calls).toEqual([[{ content: expected, flags: MessageFlags.Ephemeral }]]);
        expect(mockLogger.info.mock.calls).toEqual([[{ uid: 42, check, msg: 'Email approval click refused: the card does not act on this draft now' }]]);
    });

    test('a card read failure is logged', async () => {
        const deps = makeDeps();
        const handler = makeAdapter(deps);
        const { interaction, cardFetch } = makeButtonInteraction('email-send-approve:42');
        const failure = new Error('Unknown Message');
        cardFetch.mockRejectedValue(failure);

        await handler.handleButton(interaction);

        expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, uid: 42, msg: 'Could not read the approval card before acting on a click' });
    });

    test('the reject button shows the modal without acknowledging or calling an operation', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const { interaction, showModal } = trackInteraction(makeButtonInteraction('email-send-reject:42'), events);

        await adapter.handleButton(interaction);

        expect(showModal).toHaveBeenCalledTimes(1);
        expect(events).toEqual([]);
    });

    test('the reject modal acknowledges, rejects with the reason, updates the card, then announces', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const { interaction } = trackInteraction(makeModalInteraction('email-send-reject-reason:42', 'Too blunt'), events);

        await adapter.handleModalSubmit(interaction);

        expect(events).toEqual(['deferUpdate', 'cardFetch', 'rejectSend:42:Too blunt', 'editReply', 'announceRejected:42:Too blunt']);
    });

    test('an empty reject reason is sent as No reason given', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const { interaction } = trackInteraction(makeModalInteraction('email-send-reject-reason:42', ''), events);

        await adapter.handleModalSubmit(interaction);

        expect(events).toContain('rejectSend:42:No reason given');
    });

    test('the allowlist select menu acknowledges before approving and before every allowlist follow-up, in order', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const { interaction } = trackInteraction(makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com', 'b@example.com']), events);

        await adapter.handleSelectMenu(interaction);

        expect(events).toEqual([
            'deferUpdate',
            'cardFetch',
            'approveSend:42:allowlist',
            'editReply',
            'startFromApproval:email:a@example.com',
            'startFromApproval:email:b@example.com',
            'announceApproved:42',
        ]);
    });

    test('a refused allowlist select allowlists nothing and announces nothing', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const approvals = (adapter as unknown as { approvals: { approveSend: ReturnType<typeof mock> } }).approvals;
        approvals.approveSend.mockImplementation(async (uid: number, via: string) => {
            events.push(`approveSend:${uid}:${via}`);
            return { status: 'refused', reason: 'decided', detail: 'x' };
        });
        const { interaction } = trackInteraction(makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']), events);

        await adapter.handleSelectMenu(interaction);

        expect(events).toEqual(['deferUpdate', 'cardFetch', 'approveSend:42:allowlist', 'followUp']);
    });

    test('approve+allowlist with an unreadable draft refuses privately — no fallback approve', async () => {
        const { adapter, events } = makeOpsAdapter(undefined);
        const parts = trackInteraction(makeButtonInteraction('email-send-approveallowlist:42'), events);

        await adapter.handleButton(parts.interaction);

        expect(events).toEqual(['deferUpdate', 'cardFetch', 'allowlistCandidates:42', 'followUp']);
        expect(parts.followUp.mock.calls).toEqual([[{ content: 'Couldn\'t read the draft from WildDuck (down) — nothing was changed; try again.', flags: MessageFlags.Ephemeral }]]);
    });

    test('approve+allowlist with no recipients releases the card and falls back to a plain approve, checking the card again', async () => {
        const gate = new ApprovalCardEditGate();
        const { adapter, events } = makeOpsAdapter([], gate);
        const { interaction } = trackInteraction(makeButtonInteraction('email-send-approveallowlist:42'), events);

        await adapter.handleButton(interaction);

        expect(events).toEqual(['deferUpdate', 'cardFetch', 'allowlistCandidates:42', 'cardFetch', 'approveSend:42:direct', 'editReply', 'announceApproved:42']);
        expect(gate.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
    });

    test('approve+allowlist with recipients shows the select menu and approves nothing yet', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const { interaction } = trackInteraction(makeButtonInteraction('email-send-approveallowlist:42'), events);

        await adapter.handleButton(interaction);

        expect(events).toEqual(['deferUpdate', 'cardFetch', 'allowlistCandidates:42', 'editReply']);
    });

    test('approve+allowlist on a stale card refuses privately and reads no recipients', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const parts = trackInteraction(makeButtonInteraction('email-send-approveallowlist:42'), events);
        parts.cardFetch.mockImplementation(async () => {
            events.push('cardFetch');
            return liveCard(55);
        });

        await adapter.handleButton(parts.interaction);

        expect(events).toEqual(['deferUpdate', 'cardFetch', 'followUp']);
    });

    test('a NaN uid calls no operation and does not acknowledge', async () => {
        const { adapter, events } = makeOpsAdapter(['a@example.com']);
        const { interaction } = trackInteraction(makeButtonInteraction('email-send-approve:not-a-number'), events);

        await adapter.handleButton(interaction);

        expect(events).toEqual([]);
    });

    interface Refusal { status: 'refused', reason: string, detail: string }
    const refusal = (reason: string): Refusal => ({ status: 'refused', reason, detail: `detail for ${reason}` });
    interface ReplyCase {
        route:       'approve' | 'approveallowlist' | 'reject'
        cardUid?:    number
        noMessage?:  true
        recipients?: string[]
        refused?:    Refusal
        expected:    string
    }
    const MANY = Array.from({ length: 26 }, (_, i) => `r${i}@example.com`);

    test.each([
        ['a reject on a card it cannot read', { route: 'reject', noMessage: true, expected: CARD_UNREADABLE }],
        ['a reject on a stale card', { route: 'reject', cardUid: 55, expected: STALE_CARD }],
        ['a refused reject', { route: 'reject', refused: refusal('decided'), expected: 'This draft was already approved or rejected.' }],
        ['an approve on a stale card', { route: 'approve', cardUid: 55, expected: STALE_CARD }],
        ['an approve refused as unreadable', { route: 'approve', refused: refusal('unreadable'), expected: 'detail for unreadable — nothing was changed; try again.' }],
        ['an approve refused as unrecorded', { route: 'approve', refused: refusal('unrecorded'), expected: 'detail for unrecorded' }],
        ['an approve+allowlist on a stale card', { route: 'approveallowlist', cardUid: 55, expected: STALE_CARD }],
        ['an approve+allowlist whose draft cannot be read', { route: 'approveallowlist', recipients: undefined, expected: 'Couldn\'t read the draft from WildDuck (down) — nothing was changed; try again.' }],
        ['an approve+allowlist with too many recipients', { route: 'approveallowlist', recipients: MANY, expected: 'This draft has 26 recipients, more than the 25 a Discord menu can offer, so they can\'t be allowlisted from this card — nothing was approved. Use Approve, or allowlist them another way first.' }],
    ] as [string, ReplyCase][])('%s does not finish, or free the card, until its private reply is taken', async (_label, c) => {
        const cardEdits = new ApprovalCardEditGate();
        const { adapter, events } = makeOpsAdapter('recipients' in c ? c.recipients : ['a@example.com'], cardEdits);
        const approvals = (adapter as unknown as { approvals: { approveSend: ReturnType<typeof mock>, rejectSend: ReturnType<typeof mock> } }).approvals;
        if(c.refused) {
            approvals.approveSend.mockImplementation(async () => c.refused);
            approvals.rejectSend.mockImplementation(async () => c.refused);
        }
        const parts = c.route === 'reject'
            ? trackInteraction(makeModalInteraction('email-send-reject-reason:42', 'Too blunt'), events)
            : trackInteraction(makeButtonInteraction(`email-send-${c.route}:42`), events);
        parts.cardFetch.mockImplementation(async () => liveCard(c.cardUid ?? 42));
        if(c.noMessage) {
            (parts.interaction as unknown as { message: null }).message = null;
        }
        const gate = makeDeferred();
        const started = makeDeferred();
        parts.followUp.mockImplementation(async () => {
            started.resolve();
            await gate.promise;
            return {};
        });
        const operation = c.route === 'reject'
            ? adapter.handleModalSubmit(parts.interaction as ModalSubmitInteraction)
            : adapter.handleButton(parts.interaction as ButtonInteraction);

        try {
            await Promise.race([started.promise, operation]);
            await drainMicrotasks();
            expect(Bun.peek.status(operation)).toBe('pending');
            expect(cardEdits.pendingEdit(CARD_MESSAGE_ID) === undefined).toBe(c.noMessage === true);
        } finally {
            gate.resolve();
            await operation;
        }

        expect(parts.followUp.mock.calls).toEqual([[{ content: c.expected, flags: MessageFlags.Ephemeral }]]);
        expect(cardEdits.pendingEdit(CARD_MESSAGE_ID)).toBeUndefined();
    });
});
