import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
import type { AllowlistInteractionHandler } from '../../../../src/integrations/discord/allowlist-interaction-handler';
import { DRAFT_STATE_FLAG } from '../../../../src/integrations/email/draft-review-state';
import { OutboundApprovalHandler, type OutboundApprovalHandlerDeps  } from '../../../../src/integrations/email/outbound-approval-handler';
import type { WildDuckClient } from '../../../../src/integrations/email/wildduck-client';
import type { ApprovalSagaBackend } from '../../../../src/services/approval-saga/backend';
import { mockLogger } from '../../../setup';
import type { NotifyParams } from '@/agent';

const ADMIN_USER_ID = '222222222222222222';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeButtonInteraction(customId: string, userId: string = ADMIN_USER_ID): {
    interaction: ButtonInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    reply:       ReturnType<typeof mock>
    showModal:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const reply       = mock(async () => ({}));
    const showModal   = mock(async () => ({}));
    const interaction = {
        customId,
        user: { id: userId },
        deferUpdate,
        editReply,
        reply,
        showModal,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply, reply, showModal };
}

function makeModalInteraction(customId: string, reason = 'Not appropriate', messageData?: {
    embeds?:     unknown[]
    components?: unknown[]
}): {
    interaction: ModalSubmitInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const interaction = {
        customId,
        user:    { id: ADMIN_USER_ID },
        message: messageData
            ? { embeds: messageData.embeds ?? [], components: messageData.components ?? [{ type: 1, components: [] }] }
            : undefined,
        fields: {
            getTextInputValue: mock((_fieldId: string) => reason),
        },
        deferUpdate,
        editReply,
    } as unknown as ModalSubmitInteraction;
    return { interaction, deferUpdate, editReply };
}

function makeSelectMenuInteraction(customId: string, selectedValues: string[] = []): {
    interaction: StringSelectMenuInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const interaction = {
        customId,
        values: selectedValues,
        deferUpdate,
        editReply,
    } as unknown as StringSelectMenuInteraction;
    return { interaction, deferUpdate, editReply };
}

function makeDeps(overrides: Partial<OutboundApprovalHandlerDeps> = {}): OutboundApprovalHandlerDeps {
    const mockWildDuck: WildDuckClient = {
        submitMessage:         mock(async () => { /* intentionally empty */ }),
        updateMessageMetadata: mock(async () => { /* intentionally empty */ }),
        updateMessageFlags:    mock(async () => { /* intentionally empty */ }),
        getMessage:            mock(async () => ({ id: 42, to: [{ address: 'recipient@example.com' }] })),
    } as unknown as WildDuckClient;

    const mockSagaBackend: ApprovalSagaBackend = {
        create: mock(async () => { /* intentionally empty */ }),
    } as unknown as ApprovalSagaBackend;

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

describe('OutboundApprovalHandler', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42');
            const operation = handler.handleModalSubmit(interaction);

            try {
                await started.promise;
                await Bun.sleep(0);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            deferUpdate.mockImplementation(async () => {
                started.resolve();
                await gate.promise;
                return {};
            });
            const operation = handler.handleSelectMenu(interaction);

            try {
                await started.promise;
                await Bun.sleep(0);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['target@example.com']);
            const operation = handler.handleSelectMenu(interaction);

            try {
                await started.promise;
                await Bun.sleep(0);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            editReply.mockImplementation(async () => {
                started.resolve();
                await gate.promise;
                return {};
            });
            const operation = handler.handleSelectMenu(interaction);

            try {
                await started.promise;
                await Bun.sleep(0);
                expect(notify).not.toHaveBeenCalled();
                expect(Bun.peek.status(operation)).toBe('pending');
            } finally {
                gate.resolve();
                await operation;
            }

            expect(notify).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['draft lookup fails',   'reject' as const],
            ['draft has no address', 'empty' as const],
        ])('waits for fallback approval persistence when %s', async (_name, outcome) => {
            const gate = makeDeferred();
            const started = makeDeferred();
            const create = mock(async () => {
                started.resolve();
                await gate.promise;
            });
            const deps = makeDeps({ sagaBackend: { create } as unknown as ApprovalSagaBackend });
            if(outcome === 'reject') {
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('lookup unavailable'));
            } else {
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({ id: 42, to: [], cc: [] });
            }
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');
            const operation = handler.handleButton(interaction);

            try {
                await started.promise;
                await Bun.sleep(0);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');
            editReply.mockImplementation(async () => {
                started.resolve();
                await gate.promise;
                return {};
            });
            const operation = handler.handleButton(interaction);

            try {
                await started.promise;
                await Bun.sleep(0);
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
        const handler = new OutboundApprovalHandler(deps);
        const { interaction, deferUpdate } = makeButtonInteraction('email-send-approve:42');
        deferUpdate.mockImplementation(async () => {
            acknowledgementStarted.resolve();
            await acknowledgement.promise;
            return {};
        });
        const operation = handler.handleButton(interaction);

        try {
            await acknowledgementStarted.promise;
            await Bun.sleep(0);
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
            const handler = new OutboundApprovalHandler(deps);
            const parseId = spyOn(handler as unknown as { parseId: (raw: string) => number | null }, 'parseId');
            const { interaction, deferUpdate } = makeButtonInteraction('email-other:42');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
            expect(parseId).not.toHaveBeenCalled();
        });

        test('should return early for malformed customId with no colon', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const parseId = spyOn(handler as unknown as { parseId: (raw: string) => number | null }, 'parseId');
            const { interaction, deferUpdate } = makeButtonInteraction('email-send-approve');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
            expect(parseId).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeButtonInteraction('email-send-approve:notanumber');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should read the customId uid as decimal, never as a 0x-prefixed hexadecimal number', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeButtonInteraction('email-send-approve:0x2a');

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
                const handler = new OutboundApprovalHandler(deps);
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
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);
                await Promise.resolve();

                expect(activityLogger.log).toHaveBeenCalledWith({
                    type:    'email-sent',
                    summary: 'Email approved for sending',
                });
                expect(mockLogger.warn).toHaveBeenCalledWith({
                    err: activityError,
                    msg: 'Activity log failed for email send (direct path)',
                });
            });

            test('should create saga with correct type and uid param', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:99');

                await handler.handleButton(interaction);

                const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
                    type:   string
                    state:  string
                    params: Record<string, unknown>
                };
                expect(createArg.type).toBe('email_send');
                expect(createArg.state).toBe('approved');
                expect(createArg.params.uid).toBe(99);
            });

            test('should NOT call allowlist interaction handler on plain approve', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(deps.allowlistInteractionHandler.startFromApproval).not.toHaveBeenCalled();
            });

            test('should show "Approved ✓" embed in green after successful approve', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as {
                    embeds:     unknown[]
                    components: unknown[]
                };
                expect(replyArg.embeds).toHaveLength(1);
                expect(replyArg.components).toHaveLength(0);
            });

            test('should notify wake:true with dedupeKey email:<uid>:approved after editReply', async () => {
                const order: string[] = [];
                const notify = mock((_params: NotifyParams) => {
                    order.push('notify');
                    return true;
                });
                const deps    = makeDeps({ notify });
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                editReply.mockImplementation(async () => {
                    order.push('editReply');
                    return {};
                });

                await handler.handleButton(interaction);

                expect(order).toEqual(['editReply', 'notify']);
                expect(notify).toHaveBeenCalledTimes(1);
                const call = notify.mock.calls[0]?.[0];
                expect(call.source).toBe('email-approval');
                expect(call.wake).toBe(true);
                expect(call.dedupeKey).toBe('email:42:approved');
                expect(call.text).toBe('Outbound email (uid 42) approved for sending');
            });

            test('should still resolve and leave editReply outcome intact when notify throws', async () => {
                const notify = mock((_params: NotifyParams): boolean => {
                    throw new Error('notify boom');
                });
                const deps    = makeDeps({ notify });
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();

                expect(editReply).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    uid: 42,
                    msg: 'Notify failed for email approval',
                }));
            });

            test('should still notify wake:true when the Discord editReply fails (approval is already persisted)', async () => {
                const notify = mock((_params: NotifyParams) => true);
                const deps    = makeDeps({ notify });
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                editReply.mockRejectedValue(new Error('Discord timeout'));

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();

                expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
                expect(notify).toHaveBeenCalledTimes(1);
                const call = notify.mock.calls[0]?.[0];
                expect(call.source).toBe('email-approval');
                expect(call.wake).toBe(true);
                expect(call.dedupeKey).toBe('email:42:approved');
                expect(call.text).toBe('Outbound email (uid 42) approved for sending');
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                    uid: 42,
                    msg: 'Failed to update Discord embed after email approval',
                }));
            });
        });

        describe('approve+allowlist (email-send-approveallowlist) — shows select menu', () => {
            test('should show select menu with all recipients when draft has to and cc message fields', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({
                    id: 42,
                    to: [{ address: 'target@example.com' }],
                    cc: [{ address: 'cc1@example.com' }, { address: 'cc2@example.com' }],
                });
                const handler = new OutboundApprovalHandler(deps);
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
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                expect(deps.wildDuckClient.getMessage).toHaveBeenCalledWith('Drafts', 42);
            });

            test('should fall back to simple approve when getMessage returns null (no recipients)', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue(null);
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();
                // Falls back to simple approve — saga is created
                expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should fall back to simple approve when getMessage throws', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('fetch failed'));
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();
                // Falls back to simple approve — saga is created
                expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn).toHaveBeenCalled();
            });

            test('should fall back to simple approve when draft has no to and no cc message fields', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({
                    id: 42,
                    to: [],
                    cc: [],
                });
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');

                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();
                // Falls back to simple approve — saga is created
                expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
            });

            test('should deduplicate recipients when to appears in cc — only one Select Menu option created', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({
                    id: 42,
                    // 'duplicate@example.com' appears in both to and cc
                    to: [{ address: 'duplicate@example.com' }],
                    cc: [{ address: 'duplicate@example.com' }, { address: 'other@example.com' }],
                });
                const handler = new OutboundApprovalHandler(deps);
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
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({
                    id: 42,
                    to: [{ address: 'recipient@example.com' }],
                });
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { components: { components: { options: { data: { value: string } }[] }[] }[] };
                const options = replyArg.components[0].components[0].options;
                expect(options.map(option => option.data.value)).toEqual(['recipient@example.com']);
            });

            test('should preserve recipient addresses and allowlist prompt text in the select menu', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({
                    id: 42,
                    to: [{ address: 'recipient@example.com' }],
                    cc: [],
                });
                const handler = new OutboundApprovalHandler(deps);
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
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({
                    id: 42,
                    // Address-less entries are what a draft with a malformed recipient looks like —
                    // they must not become selectable allowlist options.
                    to: [{ address: 'to@example.com' }, { name: 'To Without Address' }],
                    cc: [{ address: 'cc@example.com' }, { name: 'Cc Without Address' }],
                });
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { components: { components: { options: { data: { value: string } }[] }[] }[] };
                const options = replyArg.components[0]?.components[0]?.options ?? [];
                expect(options.map(option => option.data.value)).toEqual(['to@example.com', 'cc@example.com']);
            });

            test('should offer to-recipients before cc-recipients in the select menu', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockResolvedValue({
                    id: 42,
                    to: [{ address: 'to1@example.com' }, { address: 'to2@example.com' }],
                    cc: [{ address: 'cc1@example.com' }],
                });
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { components: { components: { options: { data: { value: string } }[] }[] }[] };
                const options = replyArg.components[0]?.components[0]?.options ?? [];
                expect(options.map(option => option.data.value)).toEqual(['to1@example.com', 'to2@example.com', 'cc1@example.com']);
            });

            test('should log the failed draft lookup before falling back to plain approval', async () => {
                const error = new Error('fetch failed');
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockRejectedValue(error);
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');

                await handler.handleButton(interaction);

                expect(mockLogger.warn).toHaveBeenCalledWith({
                    err: error,
                    uid: 42,
                    msg: 'Failed to fetch draft message before allowlist select — falling back to simple approve',
                });
            });
        });

        describe('reject (email-send-reject)', () => {
            test('should show a modal for rejection reason without deferUpdate', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, deferUpdate, showModal } = makeButtonInteraction('email-send-reject:42');

                await handler.handleButton(interaction);

                expect(deferUpdate).not.toHaveBeenCalled();
                expect(showModal).toHaveBeenCalledTimes(1);
                expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
            });

            test('should show modal with customId containing uid', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, showModal } = makeButtonInteraction('email-send-reject:99');

                await handler.handleButton(interaction);

                expect(showModal).toHaveBeenCalledTimes(1);
                const modalArg = showModal.mock.calls[0]?.[0] as { data: { custom_id: string } };
                expect(modalArg.data.custom_id).toContain('99');
            });

            test('should set rejection reason text input as not required', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
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
            test('should call editReply with error message when sagaBackend.create fails', async () => {
                const deps = makeDeps();
                (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB write failed'));
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(editReply).toHaveBeenCalledTimes(1);
                expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
                    prefix: 'email-send-approve',
                    msg:    'Outbound approval button handler failed',
                }));
            });

            test('should call editReply with embeds and components cleared on error', async () => {
                const deps = makeDeps();
                (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB failed'));
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                const editReplyArg = editReply.mock.calls[0]?.[0];
                expect(editReplyArg.embeds).toEqual([]);
                expect(editReplyArg.components).toEqual([]);
                expect(editReplyArg.content).toContain('error occurred');
            });

            test('should log error if editReply fails after error', async () => {
                const deps = makeDeps();
                (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB failed'));
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                editReply.mockRejectedValue(new Error('Discord error'));
                const handler = new OutboundApprovalHandler(deps);

                await handler.handleButton(interaction);

                expect(mockLogger.error).toHaveBeenCalledTimes(2);
                expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
                    msg: 'Failed to send error editReply',
                }));
            });

            test('should NOT call editReply when reject path (showModal) throws', async () => {
                // Reject path does not defer, so editReply must not be called on error
                const deps = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('email-other-modal:42');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
        });

        test('should return early for malformed customId with no colon', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const parseId = spyOn(handler as unknown as { parseId: (raw: string) => number | null }, 'parseId');
            const { interaction, deferUpdate } = makeModalInteraction('email-send-reject-reason');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.updateMessageMetadata).not.toHaveBeenCalled();
            expect(parseId).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('email-send-reject-reason:notanumber');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should deferUpdate, call updateMessageMetadata with reason, set flag via wildDuck, update embed, log info', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs[2] as Record<string, unknown>).rejectedAt).toBeDefined();
        });

        test('should NOT include to or subject in updateMessageMetadata call (stored as message fields)', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs[2] as Record<string, unknown>).to).toBeUndefined();
            expect((updateArgs[2] as Record<string, unknown>).subject).toBeUndefined();
        });

        test('should NOT call getMessage during rejection (no metadata preservation needed)', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.getMessage).not.toHaveBeenCalled();
        });

        test('should show "Rejected" title with reason in description after reject', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', '');

            await expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs[2] as Record<string, unknown>).reason).toBe('No reason given');
        });

        test('should set flag via wildDuckClient.updateMessageFlags after rejection', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.updateMessageFlags).toHaveBeenCalledWith('Drafts', 42, { addFlags: [DRAFT_STATE_FLAG.rejected_by_admin] });
        });

        test('should NOT submit message after rejection (draft stays in Drafts)', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
        });

        test('should log error and show error embed with original buttons when updateMessageMetadata fails', async () => {
            const deps = makeDeps();
            (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mockRejectedValue(new Error('WildDuck error'));
            const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42');
            editReply.mockRejectedValue(new Error('Discord also down'));

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.error).toHaveBeenCalledTimes(2);
            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to send error editReply for rejection',
            }));
        });

        test('should notify wake:true with dedupeKey email:<uid>:rejected after the Discord editReply block', async () => {
            const order: string[] = [];
            const notify = mock((_params: NotifyParams) => {
                order.push('notify');
                return true;
            });
            const deps    = makeDeps({ notify });
            const handler = new OutboundApprovalHandler(deps);
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
            expect(call.dedupeKey).toBe('email:42:rejected');
            expect(call.text).toBe('Outbound email (uid 42) rejected by admin. Reason: Not appropriate');
        });

        test('should leave the rejection resolved and persisted when notify throws', async () => {
            const notify = mock((_params: NotifyParams): boolean => {
                throw new Error('notify boom');
            });
            const deps    = makeDeps({ notify });
            const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            expect(mockLogger.info).toHaveBeenCalledTimes(1);
        });

        test('should log warn and info with discordUpdated:false when editReply fails after WildDuck persist succeeds', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-other-select:42', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.sagaBackend.create).not.toHaveBeenCalled();
        });

        test('should return early for malformed customId with no colon', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-allowlist-select', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.sagaBackend.create).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-allowlist-select:notanumber', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should deferUpdate, create saga, update embed to Approved when recipients selected', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['addr@example.com']);

            await handler.handleSelectMenu(interaction);
            await Promise.resolve();

            expect(activityLogger.log).toHaveBeenCalledWith({
                type:    'email-sent',
                summary: 'Email approved for sending',
            });
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: activityError,
                msg: 'Activity log failed for email send (allowlist path)',
            });
        });

        test('should create saga with correct type and uid param', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:99', ['a@example.com']);

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
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:0x2a', []);

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
                params: Record<string, unknown>
            };
            // parseInt('0x2a', 10) stops at 'x' and yields 0; a radix of 0 would read it as hex (42).
            expect(createArg.params.uid).toBe(0);
        });

        test('should create the saga with a fresh UUID id, not the id parsed from the customId', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']);

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as { id: string };
            // Every saga row is keyed by this id; reusing the draft uid would collide across approvals.
            expect(createArg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        });

        test('should stamp the saga createdAt and updatedAt as ISO-8601 timestamps', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com']);

            await handler.handleSelectMenu(interaction);

            const createArg = (deps.sagaBackend.create as ReturnType<typeof mock>).mock.calls[0]?.[0] as { createdAt: string, updatedAt: string };
            expect(createArg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(createArg.updatedAt).toBe(createArg.createdAt);
        });

        test('should create saga and kick off allowlist saga for each selected recipient (person-based saga flow)', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com', 'b@example.com']);

            await handler.handleSelectMenu(interaction);

            expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
            expect(deps.allowlistInteractionHandler.startFromApproval).toHaveBeenCalledTimes(2);
        });

        test('should create saga and not call startFromApproval when no recipients selected', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await handler.handleSelectMenu(interaction);

            expect(deps.sagaBackend.create).toHaveBeenCalledTimes(1);
            expect(deps.allowlistInteractionHandler.startFromApproval).not.toHaveBeenCalled();
        });

        test('should show error editReply when sagaBackend.create throws', async () => {
            const deps = makeDeps();
            (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB failed'));
            const handler = new OutboundApprovalHandler(deps);
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

        test('should log error when editReply fails after sagaBackend.create error', async () => {
            const deps = makeDeps();
            (deps.sagaBackend.create as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB failed'));
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            editReply.mockRejectedValue(new Error('Discord error'));

            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();
            expect(mockLogger.error).toHaveBeenCalledTimes(2);
            expect(mockLogger.error).toHaveBeenCalledWith({
                err: expect.any(Error),
                msg: 'Failed to send error editReply for select menu',
            });
        });

        test('should show Sent embed with no components on success', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await handler.handleSelectMenu(interaction);

            const replyArg = editReply.mock.calls[0]?.[0];
            expect(replyArg.embeds).toHaveLength(1);
            expect(replyArg.components).toHaveLength(0);
            expect(replyArg.content).toBeNull();
        });

        test('should notify wake:true with dedupeKey email:<uid>:approved exactly once after editReply, even with multiple recipients', async () => {
            const order: string[] = [];
            const notify = mock((_params: NotifyParams) => {
                order.push('notify');
                return true;
            });
            const deps    = makeDeps({ notify });
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com', 'b@example.com']);
            editReply.mockImplementation(async () => {
                order.push('editReply');
                return {};
            });

            await handler.handleSelectMenu(interaction);

            expect(order).toEqual(['editReply', 'notify']);
            expect(notify).toHaveBeenCalledTimes(1);
            const call = notify.mock.calls[0]?.[0];
            expect(call.source).toBe('email-approval');
            expect(call.wake).toBe(true);
            expect(call.dedupeKey).toBe('email:42:approved');
            expect(call.text).toBe('Outbound email (uid 42) approved for sending');
        });

        test('should still resolve and leave editReply outcome intact when notify throws', async () => {
            const notify = mock((_params: NotifyParams): boolean => {
                throw new Error('notify boom');
            });
            const deps    = makeDeps({ notify });
            const handler = new OutboundApprovalHandler(deps);
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
